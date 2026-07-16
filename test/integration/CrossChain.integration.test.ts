import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// End-to-end cross-chain spend, simulating BOTH chains inside one EVM:
//
//   HOME  (Sepolia):       token, registry, staking, policy, escrow, factory,
//                          AgentWallet, CrossChainSpendRouter + MockCCIPRouter
//   REMOTE(Base Sepolia):  its own token, RemotePolicyParameters, escrow,
//                          AllowlistAuthorizer, CrossChainSpendRouter + MockCCIPRouter
//
// The two sides share no state — exactly as two real chains would not. The only
// thing crossing between them is the CCIP message, which we capture on the home
// mock router and replay into the remote one.
//
// The property this suite exists to prove: EVERY policy check runs on the HOME
// chain before a single message is sent. The remote leg settles value; it can
// never widen an agent's spending authority.

const usd = (d: number) => BigInt(Math.round(d * 1e8));
const apt = (n: string) => ethers.parseEther(n);

const HOME_SELECTOR = 16015286601757825753n; // Sepolia (verified from CCIP directory)
const REMOTE_SELECTOR = 10344971235874465080n; // Base Sepolia (verified)

const ETH_USD = 3000n * 10n ** 8n;
const APT_PER_ETH = 3000n; // APT = $1
const MAX_PER_TX = usd(2);
const DEFAULT_DAILY = usd(100);
const MIN_STAKE = apt("100");
const PRICE_CENTS = 50n; // $0.50 service
const EXPECTED_APT = apt("0.5"); // $0.50 at APT = $1

describe("Integration: cross-chain spend (Sepolia -> Base Sepolia over CCIP)", () => {
  async function deploy() {
    const [deployer, owner, agent, provider, treasury] = await ethers.getSigners();

    // ================= HOME CHAIN =================
    const Token = await ethers.getContractFactory("AgentPayToken");
    const token = await Token.deploy(apt("1000000"), deployer.address);

    const Feed = await ethers.getContractFactory("MockV3Aggregator");
    const feed = await Feed.deploy(8, ETH_USD);
    const Adapter = await ethers.getContractFactory("PriceFeedAdapter");
    const priceFeed = await Adapter.deploy(await feed.getAddress(), 3600, APT_PER_ETH);

    const Registry = await ethers.getContractFactory("ServiceRegistry");
    const registry = await Registry.deploy();

    const Policy = await ethers.getContractFactory("MockPolicyParameters");
    const policy = await Policy.deploy(MAX_PER_TX, DEFAULT_DAILY, MIN_STAKE);
    await policy.setDisputeWindow(0);
    await policy.setTreasury(treasury.address);

    const Staking = await ethers.getContractFactory("ProviderStaking");
    const staking = await Staking.deploy(
      await token.getAddress(),
      await policy.getAddress(),
      deployer.address,
    );

    const Escrow = await ethers.getContractFactory("SettlementEscrow");
    const escrow = await Escrow.deploy(
      await token.getAddress(),
      await policy.getAddress(),
      deployer.address,
    );

    const Ccip = await ethers.getContractFactory("MockCCIPRouter");
    const ccipHome = await Ccip.deploy();

    const Router = await ethers.getContractFactory("CrossChainSpendRouter");
    const routerHome = await Router.deploy(
      await token.getAddress(),
      await ccipHome.getAddress(),
      await escrow.getAddress(),
      deployer.address,
    );

    const Factory = await ethers.getContractFactory("AgentWalletFactory");
    const factory = await Factory.deploy(
      await token.getAddress(),
      await policy.getAddress(),
      await priceFeed.getAddress(),
      await registry.getAddress(),
      await staking.getAddress(),
      await escrow.getAddress(),
      HOME_SELECTOR,
      await routerHome.getAddress(),
    );
    // The factory vouches for genuine wallets, for both the escrow and the router.
    await escrow.setAuthorizer(await factory.getAddress());
    await routerHome.setAuthorizer(await factory.getAddress());

    // ================= REMOTE CHAIN =================
    // A SEPARATE APT deployment — the two tokens are independent, which is the
    // core trust assumption of this lock-and-credit bridge.
    const remoteToken = await Token.deploy(apt("1000000"), deployer.address);

    const RemotePolicy = await ethers.getContractFactory("RemotePolicyParameters");
    const remotePolicy = await RemotePolicy.deploy(
      deployer.address,
      MAX_PER_TX,
      DEFAULT_DAILY,
      1000n,
      0n, // disputeWindow = 0 => immediate settlement on the remote side
      treasury.address,
      MIN_STAKE,
    );

    const remoteEscrow = await Escrow.deploy(
      await remoteToken.getAddress(),
      await remotePolicy.getAddress(),
      deployer.address,
    );

    const ccipRemote = await Ccip.deploy();
    const routerRemote = await Router.deploy(
      await remoteToken.getAddress(),
      await ccipRemote.getAddress(),
      await remoteEscrow.getAddress(),
      deployer.address,
    );

    // No factory on the remote chain (agent wallets live on the home chain), so
    // an explicit allowlist vouches for the router as the escrow's only payer.
    const Allow = await ethers.getContractFactory("AllowlistAuthorizer");
    const allow = await Allow.deploy(deployer.address);
    await allow.setAuthorized(await routerRemote.getAddress(), true);
    await remoteEscrow.setAuthorizer(await allow.getAddress());

    // ================= WIRE THE LANE =================
    await routerHome.setDestinationRouter(
      REMOTE_SELECTOR,
      await routerRemote.getAddress(),
    );
    await routerHome.fundNative({ value: ethers.parseEther("1") });
    await routerRemote
      .setAllowlistedSourceChain(HOME_SELECTOR, true);
    await routerRemote
      .setAllowlistedSender(HOME_SELECTOR, await routerHome.getAddress(), true);
    // Pre-fund the remote router's settlement liquidity.
    await remoteToken.transfer(await routerRemote.getAddress(), apt("1000"));

    // ================= ACTORS =================
    // Provider registers a service that SETTLES ON THE REMOTE CHAIN, but stakes
    // collateral on the HOME chain — that is where policy is enforced and where
    // governance can slash.
    await registry
      .connect(provider)
      .registerService(
        PRICE_CENTS,
        ethers.keccak256(ethers.toUtf8Bytes("remote inference v1")),
        "ipfs://remote-service",
        REMOTE_SELECTOR,
      );
    await token.transfer(provider.address, MIN_STAKE);
    await token.connect(provider).approve(await staking.getAddress(), MIN_STAKE);
    await staking.connect(provider).stake(MIN_STAKE);

    const tx = await factory.createWallet(owner.address, agent.address);
    const rcpt = await tx.wait();
    const walletAddr = rcpt!.logs
      .map((l) => {
        try {
          return factory.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "WalletCreated")!.args.wallet as string;
    const wallet = await ethers.getContractAt("AgentWallet", walletAddr);

    await token.transfer(walletAddr, apt("100"));
    await wallet.connect(owner).setServiceAllowed(1n, true);

    return {
      token, registry, staking, policy, escrow, factory, wallet, priceFeed, feed,
      ccipHome, routerHome,
      remoteToken, remotePolicy, remoteEscrow, ccipRemote, routerRemote, allow,
      deployer, owner, agent, provider, treasury,
    };
  }

  /** Relay whatever the home router last sent into the remote router. */
  async function relay(f: any) {
    const sent = await f.ccipHome.lastSent();
    return f.ccipRemote.deliver(
      await f.routerRemote.getAddress(),
      sent.messageId,
      HOME_SELECTOR,
      await f.routerHome.getAddress(),
      sent.data,
    );
  }

  describe("the happy path", () => {
    it("routes a remote spend over CCIP and pays the provider on the remote chain", async () => {
      const f = await loadFixture(deploy);

      // 1. Agent spends on the home chain; the service settles remotely.
      await expect(f.wallet.connect(f.agent).spend(1n))
        .to.emit(f.wallet, "SpendExecuted")
        .and.to.emit(f.routerHome, "CrossChainSpendSent");

      // 2. Home side: APT is LOCKED in the router (never burned), nothing in escrow.
      expect(await f.token.balanceOf(await f.routerHome.getAddress())).to.equal(
        EXPECTED_APT,
      );
      expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(0n);
      expect(await f.ccipHome.sentCount()).to.equal(1n);

      // 3. Relay the CCIP message to the remote chain.
      await expect(relay(f)).to.emit(f.routerRemote, "CrossChainSpendReceived");

      // 4. Remote side: the provider is credited from the router's liquidity.
      expect(await f.remoteEscrow.withdrawable(f.provider.address)).to.equal(
        EXPECTED_APT,
      );

      // 5. The provider pulls the funds on the remote chain.
      await f.remoteEscrow.connect(f.provider).withdraw();
      expect(await f.remoteToken.balanceOf(f.provider.address)).to.equal(EXPECTED_APT);
    });

    it("records the settlement chain in the home-chain audit trail", async () => {
      const f = await loadFixture(deploy);
      const tx = await f.wallet.connect(f.agent).spend(1n);
      const rcpt = await tx.wait();
      const ev = rcpt!.logs
        .map((l) => {
          try {
            return f.wallet.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e: any) => e && e.name === "SpendExecuted")!;
      expect(ev.args.chainSelector).to.equal(REMOTE_SELECTOR);
      expect(ev.args.provider).to.equal(f.provider.address);
      expect(ev.args.tokenAmount).to.equal(EXPECTED_APT);
      expect(ev.args.usdValue).to.equal(usd(0.5));
    });

    it("carries the originating wallet across for the remote audit trail", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.agent).spend(1n);
      await expect(relay(f))
        .to.emit(f.routerRemote, "CrossChainSpendReceived")
        .withArgs(
          (await f.ccipHome.lastSent()).messageId,
          HOME_SELECTOR,
          f.provider.address,
          1n,
          EXPECTED_APT,
          await f.wallet.getAddress(),
        );
    });
  });

  describe("home-chain policy gates the remote leg (nothing is sent unless authorized)", () => {
    it("per-tx cap: reverts before any CCIP message is sent", async () => {
      const f = await loadFixture(deploy);
      // Tighten the global cap below the $0.50 service price.
      await f.policy.setMaxPerTxUsd(usd(0.1));
      await expect(f.wallet.connect(f.agent).spend(1n))
        .to.be.revertedWithCustomError(f.wallet, "ExceedsPerTxCap")
        .withArgs(usd(0.5), usd(0.1));
      expect(await f.ccipHome.sentCount()).to.equal(0n);
    });

    it("global pause: reverts before any CCIP message is sent", async () => {
      const f = await loadFixture(deploy);
      await f.policy.setGlobalPause(true);
      await expect(
        f.wallet.connect(f.agent).spend(1n),
      ).to.be.revertedWithCustomError(f.wallet, "Paused");
      expect(await f.ccipHome.sentCount()).to.equal(0n);
    });

    it("understaked provider: reverts before any CCIP message is sent", async () => {
      const f = await loadFixture(deploy);
      await f.policy.setProviderMinStake(apt("1000")); // provider staked only 100
      await expect(
        f.wallet.connect(f.agent).spend(1n),
      ).to.be.revertedWithCustomError(f.wallet, "ProviderUnderstaked");
      expect(await f.ccipHome.sentCount()).to.equal(0n);
    });

    it("allowlist: reverts before any CCIP message is sent", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.owner).setServiceAllowed(1n, false);
      await expect(
        f.wallet.connect(f.agent).spend(1n),
      ).to.be.revertedWithCustomError(f.wallet, "CounterpartyNotAllowed");
      expect(await f.ccipHome.sentCount()).to.equal(0n);
    });

    it("stale oracle: reverts before any CCIP message is sent", async () => {
      const f = await loadFixture(deploy);
      await ethers.provider.send("evm_increaseTime", [7200]);
      await ethers.provider.send("evm_mine", []);
      await expect(
        f.wallet.connect(f.agent).spend(1n),
      ).to.be.revertedWithCustomError(f.priceFeed, "StalePrice");
      expect(await f.ccipHome.sentCount()).to.equal(0n);
    });

    it("daily budget still counts remote spends", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.owner).setLocalDailyBudgetUsd(usd(0.5));
      await f.wallet.connect(f.agent).spend(1n); // exactly consumes the budget
      await expect(f.wallet.connect(f.agent).spend(1n))
        .to.be.revertedWithCustomError(f.wallet, "ExceedsDailyBudget")
        .withArgs(usd(0.5), usd(0.5), usd(0.5));
      expect(await f.ccipHome.sentCount()).to.equal(1n);
    });
  });

  describe("receiver hygiene", () => {
    it("a message from a non-allowlisted sender is rejected on the remote chain", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.agent).spend(1n);
      const sent = await f.ccipHome.lastSent();
      // Same payload, but attributed to an impostor sender.
      await expect(
        f.ccipRemote.deliver(
          await f.routerRemote.getAddress(),
          sent.messageId,
          HOME_SELECTOR,
          f.deployer.address, // not the allowlisted home router
          sent.data,
        ),
      ).to.be.revertedWithCustomError(f.routerRemote, "SenderNotAllowlisted");
      expect(await f.remoteEscrow.withdrawable(f.provider.address)).to.equal(0n);
    });

    it("a message from a non-allowlisted source chain is rejected", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.agent).spend(1n);
      const sent = await f.ccipHome.lastSent();
      await expect(
        f.ccipRemote.deliver(
          await f.routerRemote.getAddress(),
          sent.messageId,
          999n, // unknown source chain
          await f.routerHome.getAddress(),
          sent.data,
        ),
      ).to.be.revertedWithCustomError(f.routerRemote, "SourceChainNotAllowlisted");
    });
  });

  describe("cross-chain disabled", () => {
    it("a wallet with no router rejects remote services outright", async () => {
      const f = await loadFixture(deploy);
      const Factory = await ethers.getContractFactory("AgentWalletFactory");
      const noXchain = await Factory.deploy(
        await f.token.getAddress(),
        await f.policy.getAddress(),
        await f.priceFeed.getAddress(),
        await f.registry.getAddress(),
        await f.staking.getAddress(),
        await f.escrow.getAddress(),
        HOME_SELECTOR,
        ethers.ZeroAddress, // cross-chain disabled
      );
      const tx = await noXchain.createWallet(f.owner.address, f.agent.address);
      const rcpt = await tx.wait();
      const addr = rcpt!.logs
        .map((l) => {
          try {
            return noXchain.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e: any) => e && e.name === "WalletCreated")!.args.wallet as string;
      const w = await ethers.getContractAt("AgentWallet", addr);
      await f.token.transfer(addr, apt("10"));
      await w.connect(f.owner).setServiceAllowed(1n, true);

      await expect(w.connect(f.agent).spend(1n))
        .to.be.revertedWithCustomError(w, "RemoteServiceUnsupported")
        .withArgs(REMOTE_SELECTOR, HOME_SELECTOR);
    });
  });
});
