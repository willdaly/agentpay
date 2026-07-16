import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

// --- Scale helpers (USD is 8-decimal fixed point; APT is 18-decimal wei) ---
const usd = (dollars: number) => BigInt(Math.round(dollars * 1e8)); // $ -> 8dec
const apt = (n: string) => ethers.parseEther(n);

const ETH_USD = 3000n * 10n ** 8n; // $3000
const APT_PER_ETH = 3000n; // => APT = $1
const MAX_STALENESS = 3600n;

const LOCAL_SELECTOR = 1n;
const REMOTE_SELECTOR = 2n;

const MAX_PER_TX = usd(2); // $2 global per-tx cap
const DEFAULT_DAILY = usd(100); // $100 default daily budget
const MIN_STAKE = apt("100"); // 100 APT minimum provider stake

const CID = "ipfs://bafyDemo";
const TERMS_HASH = ethers.keccak256(ethers.toUtf8Bytes("terms"));

describe("AgentWallet", () => {
  async function deploy() {
    const [deployer, owner, agent, provider, stranger] =
      await ethers.getSigners();

    // Token
    const Token = await ethers.getContractFactory("AgentPayToken");
    const token = await Token.deploy(apt("1000000"), deployer.address);

    // Price feed ($1 APT)
    const Feed = await ethers.getContractFactory("MockV3Aggregator");
    const feed = await Feed.deploy(8, ETH_USD);
    const Adapter = await ethers.getContractFactory("PriceFeedAdapter");
    const priceFeed = await Adapter.deploy(
      await feed.getAddress(),
      MAX_STALENESS,
      APT_PER_ETH,
    );

    // Registry (real)
    const Registry = await ethers.getContractFactory("ServiceRegistry");
    const registry = await Registry.deploy();

    // Policy + staking + escrow (mocks in M2)
    const Policy = await ethers.getContractFactory("MockPolicyParameters");
    const policy = await Policy.deploy(MAX_PER_TX, DEFAULT_DAILY, MIN_STAKE);
    const Staking = await ethers.getContractFactory("MockProviderStaking");
    const staking = await Staking.deploy();
    const Escrow = await ethers.getContractFactory("MockSettlementEscrow");
    const escrow = await Escrow.deploy();

    // Factory + a wallet
    const Factory = await ethers.getContractFactory("AgentWalletFactory");
    const factory = await Factory.deploy(
      await token.getAddress(),
      await policy.getAddress(),
      await priceFeed.getAddress(),
      await registry.getAddress(),
      await staking.getAddress(),
      await escrow.getAddress(),
      LOCAL_SELECTOR,
      ethers.ZeroAddress, // no cross-chain router in this suite
    );
    const tx = await factory.createWallet(owner.address, agent.address);
    const rcpt = await tx.wait();
    const ev = rcpt!.logs
      .map((l) => {
        try {
          return factory.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "WalletCreated");
    const walletAddr = ev!.args.wallet as string;
    const wallet = await ethers.getContractAt("AgentWallet", walletAddr);

    // Register a local service priced at $0.05, provider staked at the minimum,
    // allowlisted, and fund the wallet.
    await registry
      .connect(provider)
      .registerService(5, TERMS_HASH, CID, LOCAL_SELECTOR); // id 1, $0.05
    await staking.setStake(provider.address, MIN_STAKE);
    await wallet.connect(owner).setServiceAllowed(1n, true);
    await token.transfer(walletAddr, apt("1000"));

    return {
      token, feed, priceFeed, registry, policy, staking, escrow, factory,
      wallet, deployer, owner, agent, provider, stranger,
    };
  }

  // Register an extra service and allowlist it; returns its id.
  async function addService(
    f: Awaited<ReturnType<typeof deploy>>,
    priceCents: number,
    selector = LOCAL_SELECTOR,
  ) {
    await f.registry
      .connect(f.provider)
      .registerService(priceCents, TERMS_HASH, CID, selector);
    const id = await f.registry.totalServices();
    await f.wallet.connect(f.owner).setServiceAllowed(id, true);
    await f.staking.setStake(f.provider.address, MIN_STAKE);
    return id;
  }

  describe("authorization", () => {
    it("lets the agent spend", async () => {
      const f = await loadFixture(deploy);
      await expect(f.wallet.connect(f.agent).spend(1n)).to.emit(
        f.wallet,
        "SpendExecuted",
      );
    });

    it("lets the owner spend", async () => {
      const f = await loadFixture(deploy);
      await expect(f.wallet.connect(f.owner).spend(1n)).to.emit(
        f.wallet,
        "SpendExecuted",
      );
    });

    it("rejects a stranger", async () => {
      const f = await loadFixture(deploy);
      await expect(f.wallet.connect(f.stranger).spend(1n))
        .to.be.revertedWithCustomError(f.wallet, "NotAuthorizedAgent")
        .withArgs(f.stranger.address);
    });

    it("only the owner can set the agent", async () => {
      const f = await loadFixture(deploy);
      await expect(
        f.wallet.connect(f.agent).setAgent(f.stranger.address),
      ).to.be.revertedWithCustomError(f.wallet, "OwnableUnauthorizedAccount");
      await expect(f.wallet.connect(f.owner).setAgent(f.stranger.address))
        .to.emit(f.wallet, "AgentUpdated")
        .withArgs(f.agent.address, f.stranger.address);
      // new agent can now spend; old one cannot
      await expect(f.wallet.connect(f.stranger).spend(1n)).to.emit(
        f.wallet,
        "SpendExecuted",
      );
      await expect(
        f.wallet.connect(f.agent).spend(1n),
      ).to.be.revertedWithCustomError(f.wallet, "NotAuthorizedAgent");
    });
  });

  describe("happy path", () => {
    it("moves the priced APT to escrow and credits the provider", async () => {
      const f = await loadFixture(deploy);
      const priced = apt("0.05"); // $0.05 at APT=$1
      await expect(f.wallet.connect(f.agent).spend(1n)).to.changeTokenBalances(
        f.token,
        [f.wallet, f.escrow],
        [-priced, priced],
      );
      expect(await f.escrow.creditedTo(f.provider.address)).to.equal(priced);
      expect(await f.escrow.lastServiceId()).to.equal(1n);
      expect(await f.escrow.lastProvider()).to.equal(f.provider.address);
    });

    it("emits a rich SpendExecuted with a meaningful policy snapshot", async () => {
      const f = await loadFixture(deploy);
      const usdValue = usd(0.05);
      const priced = apt("0.05");
      const snapshot = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256", "bool", "uint256", "uint256", "uint256", "uint256"],
          [MAX_PER_TX, DEFAULT_DAILY, false, MIN_STAKE, MAX_PER_TX, DEFAULT_DAILY, usdValue],
        ),
      );
      await expect(f.wallet.connect(f.agent).spend(1n))
        .to.emit(f.wallet, "SpendExecuted")
        .withArgs(
          await f.wallet.getAddress(),
          1n,
          f.provider.address,
          priced,
          usdValue,
          LOCAL_SELECTOR,
          snapshot,
        );
    });

    it("accumulates the daily counter", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.agent).spend(1n);
      await f.wallet.connect(f.agent).spend(1n);
      expect(await f.wallet.spentTodayUsd()).to.equal(usd(0.1));
      expect(await f.wallet.remainingDailyBudgetUsd()).to.equal(
        DEFAULT_DAILY - usd(0.1),
      );
    });
  });

  describe("pause layering", () => {
    it("reverts on local pause", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.owner).setLocalPaused(true);
      await expect(
        f.wallet.connect(f.agent).spend(1n),
      ).to.be.revertedWithCustomError(f.wallet, "Paused");
    });

    it("reverts on global pause", async () => {
      const f = await loadFixture(deploy);
      await f.policy.setGlobalPause(true);
      await expect(
        f.wallet.connect(f.agent).spend(1n),
      ).to.be.revertedWithCustomError(f.wallet, "Paused");
    });

    it("resumes when both are cleared", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.owner).setLocalPaused(true);
      await f.wallet.connect(f.owner).setLocalPaused(false);
      await expect(f.wallet.connect(f.agent).spend(1n)).to.emit(
        f.wallet,
        "SpendExecuted",
      );
    });
  });

  describe("allowlist", () => {
    it("reverts for a non-allowlisted service", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.owner).setServiceAllowed(1n, false);
      await expect(f.wallet.connect(f.agent).spend(1n))
        .to.be.revertedWithCustomError(f.wallet, "CounterpartyNotAllowed")
        .withArgs(1n);
    });
  });

  describe("service registration / activity", () => {
    it("reverts for an inactive service", async () => {
      const f = await loadFixture(deploy);
      await f.registry.connect(f.provider).setActive(1n, false);
      await expect(f.wallet.connect(f.agent).spend(1n))
        .to.be.revertedWithCustomError(f.wallet, "ServiceNotActive")
        .withArgs(1n);
    });

    it("reverts for an allowlisted-but-unregistered service", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.owner).setServiceAllowed(99n, true);
      await expect(f.wallet.connect(f.agent).spend(99n))
        .to.be.revertedWithCustomError(f.wallet, "ServiceNotActive")
        .withArgs(99n);
    });

    it("reverts for a service on a remote chain", async () => {
      const f = await loadFixture(deploy);
      const id = await addService(f, 5, REMOTE_SELECTOR);
      await expect(f.wallet.connect(f.agent).spend(id))
        .to.be.revertedWithCustomError(f.wallet, "RemoteServiceUnsupported")
        .withArgs(REMOTE_SELECTOR, LOCAL_SELECTOR);
    });
  });

  describe("provider staking gate", () => {
    it("reverts when the provider is understaked", async () => {
      const f = await loadFixture(deploy);
      await f.staking.setStake(f.provider.address, MIN_STAKE - 1n);
      await expect(f.wallet.connect(f.agent).spend(1n))
        .to.be.revertedWithCustomError(f.wallet, "ProviderUnderstaked")
        .withArgs(f.provider.address, MIN_STAKE - 1n, MIN_STAKE);
    });

    it("passes at exactly the minimum stake", async () => {
      const f = await loadFixture(deploy);
      await f.staking.setStake(f.provider.address, MIN_STAKE);
      await expect(f.wallet.connect(f.agent).spend(1n)).to.emit(
        f.wallet,
        "SpendExecuted",
      );
    });
  });

  describe("per-transaction cap", () => {
    it("passes exactly at the cap and reverts one cent over", async () => {
      const f = await loadFixture(deploy);
      const atCap = await addService(f, 200); // $2.00 == global cap
      await expect(f.wallet.connect(f.agent).spend(atCap)).to.emit(
        f.wallet,
        "SpendExecuted",
      );
      const overCap = await addService(f, 201); // $2.01
      await expect(f.wallet.connect(f.agent).spend(overCap))
        .to.be.revertedWithCustomError(f.wallet, "ExceedsPerTxCap")
        .withArgs(usd(2.01), MAX_PER_TX);
    });

    it("applies a stricter local cap", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.owner).setLocalMaxPerTxUsd(usd(0.04)); // < $0.05
      expect(await f.wallet.effectiveMaxPerTxUsd()).to.equal(usd(0.04));
      await expect(f.wallet.connect(f.agent).spend(1n))
        .to.be.revertedWithCustomError(f.wallet, "ExceedsPerTxCap")
        .withArgs(usd(0.05), usd(0.04));
    });

    it("never lets a higher local cap exceed the global cap", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.owner).setLocalMaxPerTxUsd(usd(5)); // > global $2
      expect(await f.wallet.effectiveMaxPerTxUsd()).to.equal(MAX_PER_TX);
      const svc = await addService(f, 250); // $2.50 > $2 global
      await expect(f.wallet.connect(f.agent).spend(svc))
        .to.be.revertedWithCustomError(f.wallet, "ExceedsPerTxCap")
        .withArgs(usd(2.5), MAX_PER_TX);
    });
  });

  describe("rolling daily budget", () => {
    it("reverts when a spend would breach the local daily budget", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.owner).setLocalDailyBudgetUsd(usd(0.08));
      await f.wallet.connect(f.agent).spend(1n); // 0.05 spent, ok
      await expect(f.wallet.connect(f.agent).spend(1n)) // would be 0.10 > 0.08
        .to.be.revertedWithCustomError(f.wallet, "ExceedsDailyBudget")
        .withArgs(usd(0.05), usd(0.05), usd(0.08));
    });

    it("allows spending up to exactly the budget", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.owner).setLocalDailyBudgetUsd(usd(0.1));
      await f.wallet.connect(f.agent).spend(1n); // 0.05
      await f.wallet.connect(f.agent).spend(1n); // 0.10 == budget, ok
      await expect(
        f.wallet.connect(f.agent).spend(1n),
      ).to.be.revertedWithCustomError(f.wallet, "ExceedsDailyBudget");
    });

    it("resets on day rollover", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.owner).setLocalDailyBudgetUsd(usd(0.05));
      await f.wallet.connect(f.agent).spend(1n); // fills the budget
      await expect(
        f.wallet.connect(f.agent).spend(1n),
      ).to.be.revertedWithCustomError(f.wallet, "ExceedsDailyBudget");
      await time.increase(24n * 60n * 60n); // next day
      expect(await f.wallet.spentTodayUsd()).to.equal(0n);
      // Refresh the feed so it isn't stale after the time jump, then spend.
      await f.feed.updateAnswer(ETH_USD);
      await expect(f.wallet.connect(f.agent).spend(1n)).to.emit(
        f.wallet,
        "SpendExecuted",
      );
    });
  });

  describe("oracle gating", () => {
    it("reverts a spend when the price feed is stale", async () => {
      const f = await loadFixture(deploy);
      await time.increase(MAX_STALENESS + 1n);
      await expect(
        f.wallet.connect(f.agent).spend(1n),
      ).to.be.revertedWithCustomError(f.priceFeed, "StalePrice");
    });
  });

  describe("balance", () => {
    it("reverts when the wallet cannot cover the token amount", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.owner).withdraw(f.owner.address, apt("1000"));
      await expect(
        f.wallet.connect(f.agent).spend(1n),
      ).to.be.revertedWithCustomError(f.wallet, "InsufficientBalance");
    });
  });

  describe("funding & recovery", () => {
    it("fund() pulls APT into the wallet", async () => {
      const f = await loadFixture(deploy);
      await f.token.transfer(f.stranger.address, apt("10"));
      await f.token
        .connect(f.stranger)
        .approve(await f.wallet.getAddress(), apt("10"));
      await expect(f.wallet.connect(f.stranger).fund(apt("10")))
        .to.emit(f.wallet, "Funded")
        .withArgs(f.stranger.address, apt("10"));
    });

    it("only the owner can withdraw", async () => {
      const f = await loadFixture(deploy);
      await expect(
        f.wallet.connect(f.agent).withdraw(f.agent.address, apt("1")),
      ).to.be.revertedWithCustomError(f.wallet, "OwnableUnauthorizedAccount");
    });

    it("withdraw to the zero address reverts", async () => {
      const f = await loadFixture(deploy);
      await expect(
        f.wallet.connect(f.owner).withdraw(ethers.ZeroAddress, apt("1")),
      ).to.be.revertedWithCustomError(f.wallet, "ZeroAddress");
    });
  });

  describe("config setters emit and take effect", () => {
    it("emits on each setter", async () => {
      const f = await loadFixture(deploy);
      await expect(f.wallet.connect(f.owner).setLocalMaxPerTxUsd(usd(1)))
        .to.emit(f.wallet, "LocalMaxPerTxUsdSet")
        .withArgs(usd(1));
      await expect(f.wallet.connect(f.owner).setLocalDailyBudgetUsd(usd(9)))
        .to.emit(f.wallet, "LocalDailyBudgetUsdSet")
        .withArgs(usd(9));
      await expect(f.wallet.connect(f.owner).setServiceAllowed(7n, true))
        .to.emit(f.wallet, "ServiceAllowanceSet")
        .withArgs(7n, true);
      await expect(f.wallet.connect(f.owner).setLocalPaused(true))
        .to.emit(f.wallet, "LocalPauseSet")
        .withArgs(true);
    });

    it("every admin setter rejects a non-owner caller", async () => {
      const f = await loadFixture(deploy);
      const w = f.wallet.connect(f.agent); // agent is not the owner
      await expect(w.setLocalPaused(true)).to.be.revertedWithCustomError(
        f.wallet,
        "OwnableUnauthorizedAccount",
      );
      await expect(w.setLocalMaxPerTxUsd(usd(1))).to.be.revertedWithCustomError(
        f.wallet,
        "OwnableUnauthorizedAccount",
      );
      await expect(w.setLocalDailyBudgetUsd(usd(1))).to.be.revertedWithCustomError(
        f.wallet,
        "OwnableUnauthorizedAccount",
      );
      await expect(w.setServiceAllowed(1n, false)).to.be.revertedWithCustomError(
        f.wallet,
        "OwnableUnauthorizedAccount",
      );
    });

    it("effective daily budget falls back to the governance default", async () => {
      const f = await loadFixture(deploy);
      expect(await f.wallet.effectiveDailyBudgetUsd()).to.equal(DEFAULT_DAILY);
      await f.wallet.connect(f.owner).setLocalDailyBudgetUsd(usd(7));
      expect(await f.wallet.effectiveDailyBudgetUsd()).to.equal(usd(7));
    });

    it("remainingDailyBudgetUsd never underflows", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.owner).setLocalDailyBudgetUsd(usd(0.05));
      await f.wallet.connect(f.agent).spend(1n);
      expect(await f.wallet.remainingDailyBudgetUsd()).to.equal(0n);
    });
  });

  describe("previewSpend (pre-flight policy check)", () => {
    it("returns the decision for a spend that would succeed, without spending", async () => {
      const f = await loadFixture(deploy);
      const ctx = await f.wallet.connect(f.agent).previewSpend.staticCall(1n);
      expect(ctx.provider).to.equal(f.provider.address);
      expect(ctx.isRemote).to.equal(false);
      expect(ctx.usdValue).to.equal(usd(0.05)); // the fixture service is $0.05
      expect(ctx.tokenAmount).to.equal(ethers.parseEther("0.05")); // APT = $1
      // Nothing moved: it is a view.
      expect(await f.wallet.spentTodayUsd()).to.equal(0n);
    });

    it("reverts with the same typed error a real spend would", async () => {
      const f = await loadFixture(deploy);
      await f.wallet.connect(f.owner).setServiceAllowed(1n, false);
      await expect(f.wallet.connect(f.agent).previewSpend(1n))
        .to.be.revertedWithCustomError(f.wallet, "CounterpartyNotAllowed")
        .withArgs(1n);
    });
  });

  describe("constructor guards", () => {
    // Each of the six dependencies must be individually guarded against zero.
    const depNames = ["token", "policy", "priceFeed", "registry", "staking", "escrow"];
    depNames.forEach((name, depIndex) => {
      it(`reverts when ${name} is the zero address`, async () => {
        const f = await loadFixture(deploy);
        const deps = [
          await f.token.getAddress(),
          await f.policy.getAddress(),
          await f.priceFeed.getAddress(),
          await f.registry.getAddress(),
          await f.staking.getAddress(),
          await f.escrow.getAddress(),
        ];
        deps[depIndex] = ethers.ZeroAddress;
        const Wallet = await ethers.getContractFactory("AgentWallet");
        await expect(
          Wallet.deploy(
            f.owner.address,
            f.agent.address,
            deps[0], deps[1], deps[2], deps[3], deps[4], deps[5],
            LOCAL_SELECTOR,
            ethers.ZeroAddress,
          ),
        ).to.be.revertedWithCustomError(Wallet, "ZeroAddress");
      });
    });
  });
});
