import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const LOCAL_SELECTOR = 1n;

describe("AgentWalletFactory", () => {
  async function deploy() {
    const [deployer, owner, agent, other] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("AgentPayToken");
    const token = await Token.deploy(
      ethers.parseEther("1000000"),
      deployer.address,
    );
    const Feed = await ethers.getContractFactory("MockV3Aggregator");
    const feed = await Feed.deploy(8, 3000n * 10n ** 8n);
    const Adapter = await ethers.getContractFactory("PriceFeedAdapter");
    const priceFeed = await Adapter.deploy(await feed.getAddress(), 3600, 3000);
    const Registry = await ethers.getContractFactory("ServiceRegistry");
    const registry = await Registry.deploy();
    const Policy = await ethers.getContractFactory("MockPolicyParameters");
    const policy = await Policy.deploy(
      100n * 10n ** 8n,
      100n * 10n ** 8n,
      ethers.parseEther("100"),
    );
    const Staking = await ethers.getContractFactory("MockProviderStaking");
    const staking = await Staking.deploy();
    const Escrow = await ethers.getContractFactory("MockSettlementEscrow");
    const escrow = await Escrow.deploy();

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

    return { factory, token, policy, priceFeed, registry, staking, escrow, deployer, owner, agent, other };
  }

  it("creates a wallet, tracks provenance, and wires immutables", async () => {
    const { factory, owner, agent, token, policy } = await loadFixture(deploy);

    const tx = await factory.createWallet(owner.address, agent.address);
    const rcpt = await tx.wait();
    const parsed = rcpt!.logs
      .map((l) => {
        try {
          return factory.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "WalletCreated");
    const walletAddr = parsed!.args.wallet as string;

    expect(await factory.walletCount()).to.equal(1n);
    expect(await factory.isWallet(walletAddr)).to.equal(true);
    expect(await factory.allWallets(0)).to.equal(walletAddr);
    expect(await factory.walletsOf(owner.address)).to.deep.equal([walletAddr]);

    const wallet = await ethers.getContractAt("AgentWallet", walletAddr);
    expect(await wallet.owner()).to.equal(owner.address);
    expect(await wallet.agent()).to.equal(agent.address);
    expect(await wallet.token()).to.equal(await token.getAddress());
    expect(await wallet.policy()).to.equal(await policy.getAddress());
    expect(await wallet.localChainSelector()).to.equal(LOCAL_SELECTOR);
  });

  it("tracks multiple wallets per owner and reports non-wallets as false", async () => {
    const { factory, owner, agent, other } = await loadFixture(deploy);
    await factory.createWallet(owner.address, agent.address);
    await factory.createWallet(owner.address, agent.address);
    expect(await factory.walletCount()).to.equal(2n);
    expect((await factory.walletsOf(owner.address)).length).to.equal(2);
    expect(await factory.isWallet(other.address)).to.equal(false);
  });

  it("reverts when the owner is the zero address", async () => {
    const { factory, agent } = await loadFixture(deploy);
    await expect(
      factory.createWallet(ethers.ZeroAddress, agent.address),
    ).to.be.revertedWithCustomError(factory, "ZeroAddress");
  });

  const depNames = ["token", "policy", "priceFeed", "registry", "staking", "escrow"];
  depNames.forEach((name, depIndex) => {
    it(`reverts when constructed with ${name} zeroed`, async () => {
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
      const Factory = await ethers.getContractFactory("AgentWalletFactory");
      await expect(
        Factory.deploy(
          deps[0], deps[1], deps[2], deps[3], deps[4], deps[5],
          LOCAL_SELECTOR,
          ethers.ZeroAddress,
        ),
      ).to.be.revertedWithCustomError(Factory, "ZeroAddress");
    });
  });
});
