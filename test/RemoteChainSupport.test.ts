import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// The two small contracts that let a REMOTE chain participate without hosting
// governance or an agent-wallet factory.

const usd = (d: number) => BigInt(Math.round(d * 1e8));
const apt = (n: string) => ethers.parseEther(n);

describe("AllowlistAuthorizer", () => {
  async function deploy() {
    const [owner, router, outsider] = await ethers.getSigners();
    const Allow = await ethers.getContractFactory("AllowlistAuthorizer");
    const allow = await Allow.deploy(owner.address);
    return { allow, owner, router, outsider };
  }

  it("vouches for nobody by default", async () => {
    const { allow, router } = await loadFixture(deploy);
    expect(await allow.isWallet(router.address)).to.equal(false);
  });

  it("lets the owner authorize and revoke a payer", async () => {
    const { allow, owner, router } = await loadFixture(deploy);
    await expect(allow.connect(owner).setAuthorized(router.address, true))
      .to.emit(allow, "AuthorizationSet")
      .withArgs(router.address, true);
    expect(await allow.isWallet(router.address)).to.equal(true);

    await allow.connect(owner).setAuthorized(router.address, false);
    expect(await allow.isWallet(router.address)).to.equal(false);
  });

  it("rejects non-owner callers and the zero address", async () => {
    const { allow, owner, router, outsider } = await loadFixture(deploy);
    await expect(
      allow.connect(outsider).setAuthorized(router.address, true),
    ).to.be.revertedWithCustomError(allow, "OwnableUnauthorizedAccount");
    await expect(
      allow.connect(owner).setAuthorized(ethers.ZeroAddress, true),
    ).to.be.revertedWithCustomError(allow, "ZeroAddress");
  });
});

describe("RemotePolicyParameters", () => {
  const INIT = {
    maxPerTxUsd: usd(10),
    defaultDailyBudgetUsd: usd(100),
    slashBps: 1000n,
    disputeWindow: 3600n,
    providerMinStake: apt("100"),
  };

  async function deploy() {
    const [owner, treasury, outsider] = await ethers.getSigners();
    const P = await ethers.getContractFactory("RemotePolicyParameters");
    const policy = await P.deploy(
      owner.address,
      INIT.maxPerTxUsd,
      INIT.defaultDailyBudgetUsd,
      INIT.slashBps,
      INIT.disputeWindow,
      treasury.address,
      INIT.providerMinStake,
    );
    return { policy, owner, treasury, outsider };
  }

  it("exposes the mirrored parameters via IPolicyParameters", async () => {
    const { policy, treasury } = await loadFixture(deploy);
    expect(await policy.maxPerTxUsd()).to.equal(INIT.maxPerTxUsd);
    expect(await policy.defaultDailyBudgetUsd()).to.equal(INIT.defaultDailyBudgetUsd);
    expect(await policy.slashBps()).to.equal(INIT.slashBps);
    expect(await policy.disputeWindow()).to.equal(INIT.disputeWindow);
    expect(await policy.treasury()).to.equal(treasury.address);
    expect(await policy.providerMinStake()).to.equal(INIT.providerMinStake);
    expect(await policy.globalPause()).to.equal(false);
  });

  it("validates slashBps and treasury at construction", async () => {
    const { owner, treasury } = await loadFixture(deploy);
    const P = await ethers.getContractFactory("RemotePolicyParameters");
    await expect(
      P.deploy(owner.address, 0, 0, 10_001n, 0, treasury.address, 0),
    ).to.be.revertedWithCustomError(P, "InvalidSlashBps");
    await expect(
      P.deploy(owner.address, 0, 0, 0, 0, ethers.ZeroAddress, 0),
    ).to.be.revertedWithCustomError(P, "ZeroTreasury");
  });

  it("lets the owner mirror updated parameters", async () => {
    const { policy, owner, treasury } = await loadFixture(deploy);
    await expect(
      policy
        .connect(owner)
        .setParameters(usd(1), usd(2), 500n, 60n, treasury.address, apt("5")),
    )
      .to.emit(policy, "ParametersUpdated")
      .withArgs(usd(1), usd(2), 500n, 60n, treasury.address, apt("5"));
    expect(await policy.maxPerTxUsd()).to.equal(usd(1));
    expect(await policy.disputeWindow()).to.equal(60n);
  });

  it("validates on update too", async () => {
    const { policy, owner, treasury } = await loadFixture(deploy);
    await expect(
      policy
        .connect(owner)
        .setParameters(0, 0, 10_001n, 0, treasury.address, 0),
    ).to.be.revertedWithCustomError(policy, "InvalidSlashBps");
    await expect(
      policy.connect(owner).setParameters(0, 0, 0, 0, ethers.ZeroAddress, 0),
    ).to.be.revertedWithCustomError(policy, "ZeroTreasury");
  });

  it("supports a remote-only pause", async () => {
    const { policy, owner } = await loadFixture(deploy);
    await expect(policy.connect(owner).setGlobalPause(true))
      .to.emit(policy, "GlobalPauseSet")
      .withArgs(true);
    expect(await policy.globalPause()).to.equal(true);
  });

  it("restricts admin functions to the owner", async () => {
    const { policy, outsider, treasury } = await loadFixture(deploy);
    await expect(
      policy
        .connect(outsider)
        .setParameters(0, 0, 0, 0, treasury.address, 0),
    ).to.be.revertedWithCustomError(policy, "OwnableUnauthorizedAccount");
    await expect(
      policy.connect(outsider).setGlobalPause(true),
    ).to.be.revertedWithCustomError(policy, "OwnableUnauthorizedAccount");
  });
});
