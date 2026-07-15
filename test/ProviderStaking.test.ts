import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const apt = (n: string) => ethers.parseEther(n);
const DISPUTE_WINDOW = 24n * 60n * 60n; // 1 day cooldown
const SLASH_BPS = 1000n; // 10%

describe("ProviderStaking", () => {
  async function deploy() {
    const [deployer, governor, provider, treasury, other] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory("AgentPayToken");
    const token = await Token.deploy(apt("1000000"), deployer.address);

    const Policy = await ethers.getContractFactory("MockPolicyParameters");
    // maxPerTx / defaultDaily unused here; minStake unused. Set dispute + slash.
    const policy = await Policy.deploy(0, 0, 0);
    await policy.setDisputeWindow(DISPUTE_WINDOW);
    await policy.setSlashBps(SLASH_BPS);
    await policy.setTreasury(treasury.address);

    const Staking = await ethers.getContractFactory("ProviderStaking");
    // Owner = governor (the slashing authority; becomes PolicyGovernor in M4).
    const staking = await Staking.deploy(
      await token.getAddress(),
      await policy.getAddress(),
      governor.address,
    );

    // Fund the provider and pre-approve.
    await token.transfer(provider.address, apt("1000"));
    await token
      .connect(provider)
      .approve(await staking.getAddress(), ethers.MaxUint256);

    return { token, policy, staking, deployer, governor, provider, treasury, other };
  }

  describe("stake", () => {
    it("moves APT in and counts toward stakedOf", async () => {
      const f = await loadFixture(deploy);
      await expect(f.staking.connect(f.provider).stake(apt("100")))
        .to.emit(f.staking, "Staked")
        .withArgs(f.provider.address, apt("100"), apt("100"));
      expect(await f.staking.stakedOf(f.provider.address)).to.equal(apt("100"));
      expect(await f.staking.totalCollateralOf(f.provider.address)).to.equal(
        apt("100"),
      );
    });

    it("rejects a zero stake", async () => {
      const f = await loadFixture(deploy);
      await expect(
        f.staking.connect(f.provider).stake(0),
      ).to.be.revertedWithCustomError(f.staking, "ZeroAmount");
    });

    it("accumulates across multiple stakes", async () => {
      const f = await loadFixture(deploy);
      await f.staking.connect(f.provider).stake(apt("60"));
      await f.staking.connect(f.provider).stake(apt("40"));
      expect(await f.staking.stakedOf(f.provider.address)).to.equal(apt("100"));
    });
  });

  describe("unstake cooldown", () => {
    it("removes from stakedOf immediately but keeps it as collateral", async () => {
      const f = await loadFixture(deploy);
      await f.staking.connect(f.provider).stake(apt("100"));
      const tx = await f.staking.connect(f.provider).requestUnstake(apt("30"));
      const unlockAt = BigInt(await time.latest()) + DISPUTE_WINDOW;
      await expect(tx)
        .to.emit(f.staking, "UnstakeRequested")
        .withArgs(f.provider.address, apt("30"), unlockAt);

      expect(await f.staking.stakedOf(f.provider.address)).to.equal(apt("70"));
      // still collateral (slashable) until withdrawn
      expect(await f.staking.totalCollateralOf(f.provider.address)).to.equal(
        apt("100"),
      );
      const [amount, at] = await f.staking.cooldownOf(f.provider.address);
      expect(amount).to.equal(apt("30"));
      expect(at).to.equal(unlockAt);
    });

    it("cannot unstake more than the active stake", async () => {
      const f = await loadFixture(deploy);
      await f.staking.connect(f.provider).stake(apt("10"));
      await expect(f.staking.connect(f.provider).requestUnstake(apt("11")))
        .to.be.revertedWithCustomError(f.staking, "InsufficientActiveStake")
        .withArgs(apt("11"), apt("10"));
    });

    it("rejects a zero unstake", async () => {
      const f = await loadFixture(deploy);
      await f.staking.connect(f.provider).stake(apt("10"));
      await expect(
        f.staking.connect(f.provider).requestUnstake(0),
      ).to.be.revertedWithCustomError(f.staking, "ZeroAmount");
    });

    it("blocks withdraw until the cooldown elapses, then pays out", async () => {
      const f = await loadFixture(deploy);
      await f.staking.connect(f.provider).stake(apt("100"));
      await f.staking.connect(f.provider).requestUnstake(apt("40"));

      await expect(
        f.staking.connect(f.provider).withdraw(),
      ).to.be.revertedWithCustomError(f.staking, "CooldownNotElapsed");

      await time.increase(DISPUTE_WINDOW);
      await expect(
        f.staking.connect(f.provider).withdraw(),
      ).to.changeTokenBalance(f.token, f.provider, apt("40"));

      const [amount] = await f.staking.cooldownOf(f.provider.address);
      expect(amount).to.equal(0n);
    });

    it("reverts withdraw when nothing is in cooldown", async () => {
      const f = await loadFixture(deploy);
      await f.staking.connect(f.provider).stake(apt("100"));
      await expect(
        f.staking.connect(f.provider).withdraw(),
      ).to.be.revertedWithCustomError(f.staking, "NothingInCooldown");
    });

    it("a second request adds to cooldown and resets the clock", async () => {
      const f = await loadFixture(deploy);
      await f.staking.connect(f.provider).stake(apt("100"));
      await f.staking.connect(f.provider).requestUnstake(apt("20"));
      await time.increase(DISPUTE_WINDOW / 2n);
      await f.staking.connect(f.provider).requestUnstake(apt("10"));
      const [amount, unlockAt] = await f.staking.cooldownOf(f.provider.address);
      expect(amount).to.equal(apt("30"));
      expect(unlockAt).to.equal(BigInt(await time.latest()) + DISPUTE_WINDOW);
    });

    it("cancelUnstake returns collateral to active", async () => {
      const f = await loadFixture(deploy);
      await f.staking.connect(f.provider).stake(apt("100"));
      await f.staking.connect(f.provider).requestUnstake(apt("30"));
      await expect(f.staking.connect(f.provider).cancelUnstake())
        .to.emit(f.staking, "UnstakeCancelled")
        .withArgs(f.provider.address, apt("30"), apt("100"));
      expect(await f.staking.stakedOf(f.provider.address)).to.equal(apt("100"));
      const [amount] = await f.staking.cooldownOf(f.provider.address);
      expect(amount).to.equal(0n);
    });

    it("cancelUnstake reverts with nothing in cooldown", async () => {
      const f = await loadFixture(deploy);
      await expect(
        f.staking.connect(f.provider).cancelUnstake(),
      ).to.be.revertedWithCustomError(f.staking, "NothingInCooldown");
    });
  });

  describe("slashing", () => {
    it("only the owner (governance authority) can slash", async () => {
      const f = await loadFixture(deploy);
      await f.staking.connect(f.provider).stake(apt("100"));
      await expect(
        f.staking.connect(f.other).slash(f.provider.address),
      ).to.be.revertedWithCustomError(f.staking, "OwnableUnauthorizedAccount");
    });

    it("slashes slashBps of total collateral to the treasury", async () => {
      const f = await loadFixture(deploy);
      await f.staking.connect(f.provider).stake(apt("100"));
      // 10% of 100 = 10 APT to treasury, active drops to 90
      await expect(f.staking.connect(f.governor).slash(f.provider.address))
        .to.emit(f.staking, "Slashed")
        .withArgs(f.provider.address, apt("10"), apt("10"), 0, f.treasury.address);
      expect(await f.staking.stakedOf(f.provider.address)).to.equal(apt("90"));
      expect(await f.token.balanceOf(f.treasury.address)).to.equal(apt("10"));
    });

    it("reaches cooldown collateral when active is insufficient", async () => {
      const f = await loadFixture(deploy);
      await f.staking.connect(f.provider).stake(apt("100"));
      // Move almost everything into cooldown: active=5, cooldown=95, total=100
      await f.staking.connect(f.provider).requestUnstake(apt("95"));
      // slash 10% of 100 = 10; 5 from active, 5 from cooldown
      await expect(f.staking.connect(f.governor).slash(f.provider.address))
        .to.emit(f.staking, "Slashed")
        .withArgs(f.provider.address, apt("10"), apt("5"), apt("5"), f.treasury.address);
      expect(await f.staking.stakedOf(f.provider.address)).to.equal(0n);
      const [amount] = await f.staking.cooldownOf(f.provider.address);
      expect(amount).to.equal(apt("90"));
    });

    it("still slashes collateral that is in cooldown (cannot be dodged by unstaking)", async () => {
      const f = await loadFixture(deploy);
      await f.staking.connect(f.provider).stake(apt("100"));
      await f.staking.connect(f.provider).requestUnstake(apt("100")); // all in cooldown
      expect(await f.staking.stakedOf(f.provider.address)).to.equal(0n);
      await expect(f.staking.connect(f.governor).slash(f.provider.address))
        .to.emit(f.staking, "Slashed")
        .withArgs(f.provider.address, apt("10"), 0, apt("10"), f.treasury.address);
      expect(await f.token.balanceOf(f.treasury.address)).to.equal(apt("10"));
    });

    it("reverts when there is nothing to slash", async () => {
      const f = await loadFixture(deploy);
      await expect(
        f.staking.connect(f.governor).slash(f.provider.address),
      ).to.be.revertedWithCustomError(f.staking, "NothingToSlash");
    });

    it("reverts when the computed slash rounds to zero", async () => {
      const f = await loadFixture(deploy);
      // 5 wei * 1000 / 10000 = 0 (integer) => NothingToSlash
      await f.staking.connect(f.provider).stake(5n);
      await expect(
        f.staking.connect(f.governor).slash(f.provider.address),
      ).to.be.revertedWithCustomError(f.staking, "NothingToSlash");
    });
  });

  describe("invariant: collateral is conserved across stake/unstake/withdraw", () => {
    it("token balance of the contract equals total outstanding collateral", async () => {
      const f = await loadFixture(deploy);
      const stakingAddr = await f.staking.getAddress();
      await f.staking.connect(f.provider).stake(apt("100"));
      await f.staking.connect(f.provider).requestUnstake(apt("40"));
      expect(await f.token.balanceOf(stakingAddr)).to.equal(
        await f.staking.totalCollateralOf(f.provider.address),
      );
      await time.increase(DISPUTE_WINDOW);
      await f.staking.connect(f.provider).withdraw();
      expect(await f.token.balanceOf(stakingAddr)).to.equal(
        await f.staking.totalCollateralOf(f.provider.address),
      );
      expect(await f.token.balanceOf(stakingAddr)).to.equal(apt("60"));
    });
  });
});
