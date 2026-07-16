import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

// Full economic loop with the REAL ProviderStaking and SettlementEscrow wired
// into a real AgentWallet (mock policy still stands in for PolicyGovernor until
// M4). Exercises: stake -> spend -> windowed release -> provider withdraw, plus
// governance slashing and the understaked-provider rejection end to end.

const usd = (d: number) => BigInt(Math.round(d * 1e8));
const apt = (n: string) => ethers.parseEther(n);

const ETH_USD = 3000n * 10n ** 8n;
const APT_PER_ETH = 3000n; // APT = $1
const SELECTOR = 1n;
const MAX_PER_TX = usd(2);
const DEFAULT_DAILY = usd(100);
const MIN_STAKE = apt("100");
const DISPUTE_WINDOW = 60n * 60n; // 1h
const SLASH_BPS = 1000n; // 10%

describe("Integration: economics (staking + escrow + wallet)", () => {
  async function deploy() {
    const [deployer, governor, owner, agent, provider, treasury] =
      await ethers.getSigners();

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
    await policy.setDisputeWindow(DISPUTE_WINDOW);
    await policy.setSlashBps(SLASH_BPS);
    await policy.setTreasury(treasury.address);

    // Real staking (owned by the governance authority) + real escrow.
    const Staking = await ethers.getContractFactory("ProviderStaking");
    const staking = await Staking.deploy(
      await token.getAddress(),
      await policy.getAddress(),
      governor.address,
    );

    // Escrow and factory are mutually dependent (escrow authorizes payers via the
    // factory; the factory wires the escrow into each wallet). The escrow's
    // one-time setAuthorizer breaks the cycle — no address prediction needed.
    const Escrow = await ethers.getContractFactory("SettlementEscrow");
    const escrow = await Escrow.deploy(
      await token.getAddress(),
      await policy.getAddress(),
      governor.address,
    );

    const Factory = await ethers.getContractFactory("AgentWalletFactory");
    const factory = await Factory.deploy(
      await token.getAddress(),
      await policy.getAddress(),
      await priceFeed.getAddress(),
      await registry.getAddress(),
      await staking.getAddress(),
      await escrow.getAddress(),
      SELECTOR,
      ethers.ZeroAddress, // cross-chain router not used in this suite
    );
    await escrow.connect(governor).setAuthorizer(await factory.getAddress());

    // Create a wallet.
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

    // Provider registers a $0.50 local service.
    await registry.connect(provider).registerService(
      50, // $0.50
      ethers.keccak256(ethers.toUtf8Bytes("terms")),
      "ipfs://svc",
      SELECTOR,
    );

    // Fund + approve everyone.
    await token.transfer(provider.address, apt("1000"));
    await token.connect(provider).approve(await staking.getAddress(), ethers.MaxUint256);
    await token.transfer(walletAddr, apt("1000"));
    await wallet.connect(owner).setServiceAllowed(1n, true);

    return {
      token, feed, priceFeed, registry, policy, staking, escrow, factory, wallet,
      deployer, governor, owner, agent, provider, treasury,
    };
  }

  it("rejects a spend until the provider stakes the minimum", async () => {
    const f = await loadFixture(deploy);
    await expect(
      f.wallet.connect(f.agent).spend(1n),
    ).to.be.revertedWithCustomError(f.wallet, "ProviderUnderstaked");

    await f.staking.connect(f.provider).stake(MIN_STAKE);
    await expect(f.wallet.connect(f.agent).spend(1n)).to.emit(
      f.wallet,
      "SpendExecuted",
    );
  });

  it("runs the full loop: stake -> spend -> windowed release -> withdraw", async () => {
    const f = await loadFixture(deploy);
    await f.staking.connect(f.provider).stake(MIN_STAKE);

    const priced = apt("0.5"); // $0.50 at APT=$1
    await expect(f.wallet.connect(f.agent).spend(1n)).to.changeTokenBalance(
      f.token,
      f.escrow,
      priced,
    );

    // Windowed: not withdrawable yet.
    expect(await f.escrow.withdrawable(f.provider.address)).to.equal(0n);
    await expect(
      f.escrow.connect(f.provider).withdraw(),
    ).to.be.revertedWithCustomError(f.escrow, "NothingToWithdraw");

    // After the window, anyone releases, provider withdraws.
    await time.increase(DISPUTE_WINDOW);
    await f.escrow.release(1n);
    await expect(f.escrow.connect(f.provider).withdraw()).to.changeTokenBalance(
      f.token,
      f.provider,
      priced,
    );
    expect(await f.escrow.solvent()).to.equal(true);
    expect(await f.escrow.totalOwed()).to.equal(0n);
  });

  it("lets governance slash a provider's stake to the treasury", async () => {
    const f = await loadFixture(deploy);
    await f.staking.connect(f.provider).stake(MIN_STAKE);
    // 10% of 100 APT = 10 APT to treasury.
    await expect(
      f.staking.connect(f.governor).slash(f.provider.address),
    ).to.changeTokenBalance(f.token, f.treasury, apt("10"));
    expect(await f.staking.stakedOf(f.provider.address)).to.equal(apt("90"));

    // Post-slash the provider is now understaked and spends are rejected.
    await expect(
      f.wallet.connect(f.agent).spend(1n),
    ).to.be.revertedWithCustomError(f.wallet, "ProviderUnderstaked");
  });

  it("only genuine factory wallets can credit the escrow", async () => {
    const f = await loadFixture(deploy);
    // A random EOA cannot credit — provenance is enforced by the factory.
    await expect(
      f.escrow.connect(f.deployer).credit(f.provider.address, 1n, apt("1")),
    ).to.be.revertedWithCustomError(f.escrow, "NotAuthorizedPayer");
    // The real wallet is recognised.
    expect(await f.factory.isWallet(await f.wallet.getAddress())).to.equal(true);
  });
});
