import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const usd = (d: number) => BigInt(Math.round(d * 1e8));
const apt = (n: string) => ethers.parseEther(n);

const VOTING_DELAY = 1n; // blocks
const VOTING_PERIOD = 10n; // blocks
const PROPOSAL_THRESHOLD = 0n;
const QUORUM_PCT = 4n;
const TIMELOCK_DELAY = 60n; // seconds

const INIT = {
  maxPerTxUsd: usd(1),
  defaultDailyBudgetUsd: usd(100),
  slashBps: 1000n,
  disputeWindow: 3600n,
  providerMinStake: apt("100"),
};

describe("PolicyGovernor", () => {
  async function deploy() {
    const [deployer, treasury, other] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("AgentPayToken");
    const token = await Token.deploy(apt("1000000"), deployer.address);

    const Timelock = await ethers.getContractFactory("TimelockController");
    const timelock = await Timelock.deploy(
      TIMELOCK_DELAY,
      [],
      [],
      deployer.address,
    );

    const Governor = await ethers.getContractFactory("PolicyGovernor");
    const governor = await Governor.deploy(
      await token.getAddress(),
      await timelock.getAddress(),
      VOTING_DELAY,
      VOTING_PERIOD,
      PROPOSAL_THRESHOLD,
      QUORUM_PCT,
      { ...INIT, treasury: treasury.address },
    );

    return { token, timelock, governor, deployer, treasury, other };
  }

  describe("deployment", () => {
    it("exposes the initial policy parameters via IPolicyParameters", async () => {
      const { governor, treasury } = await loadFixture(deploy);
      expect(await governor.maxPerTxUsd()).to.equal(INIT.maxPerTxUsd);
      expect(await governor.defaultDailyBudgetUsd()).to.equal(
        INIT.defaultDailyBudgetUsd,
      );
      expect(await governor.slashBps()).to.equal(INIT.slashBps);
      expect(await governor.disputeWindow()).to.equal(INIT.disputeWindow);
      expect(await governor.providerMinStake()).to.equal(INIT.providerMinStake);
      expect(await governor.treasury()).to.equal(treasury.address);
      expect(await governor.globalPause()).to.equal(false);
    });

    it("wires the Governor settings", async () => {
      const { governor } = await loadFixture(deploy);
      expect(await governor.votingDelay()).to.equal(VOTING_DELAY);
      expect(await governor.votingPeriod()).to.equal(VOTING_PERIOD);
      expect(await governor.proposalThreshold()).to.equal(PROPOSAL_THRESHOLD);
    });

    it("rejects an invalid slashBps at construction", async () => {
      const { token, timelock, treasury } = await loadFixture(deploy);
      const Governor = await ethers.getContractFactory("PolicyGovernor");
      await expect(
        Governor.deploy(
          await token.getAddress(),
          await timelock.getAddress(),
          VOTING_DELAY,
          VOTING_PERIOD,
          PROPOSAL_THRESHOLD,
          QUORUM_PCT,
          { ...INIT, slashBps: 10_001n, treasury: treasury.address },
        ),
      ).to.be.revertedWithCustomError(Governor, "InvalidSlashBps");
    });

    it("rejects a zero treasury at construction", async () => {
      const { token, timelock } = await loadFixture(deploy);
      const Governor = await ethers.getContractFactory("PolicyGovernor");
      await expect(
        Governor.deploy(
          await token.getAddress(),
          await timelock.getAddress(),
          VOTING_DELAY,
          VOTING_PERIOD,
          PROPOSAL_THRESHOLD,
          QUORUM_PCT,
          { ...INIT, treasury: ethers.ZeroAddress },
        ),
      ).to.be.revertedWithCustomError(Governor, "ZeroTreasury");
    });
  });

  describe("parameter store is governance-only", () => {
    it("rejects every setter called directly (not through governance)", async () => {
      const { governor, other } = await loadFixture(deploy);
      const g = governor.connect(other);
      await expect(g.setMaxPerTxUsd(1)).to.be.revertedWithCustomError(
        governor,
        "GovernorOnlyExecutor",
      );
      await expect(g.setDefaultDailyBudgetUsd(1)).to.be.revertedWithCustomError(
        governor,
        "GovernorOnlyExecutor",
      );
      await expect(g.setSlashBps(1)).to.be.revertedWithCustomError(
        governor,
        "GovernorOnlyExecutor",
      );
      await expect(g.setDisputeWindow(1)).to.be.revertedWithCustomError(
        governor,
        "GovernorOnlyExecutor",
      );
      await expect(
        g.setTreasury(other.address),
      ).to.be.revertedWithCustomError(governor, "GovernorOnlyExecutor");
      await expect(g.setProviderMinStake(1)).to.be.revertedWithCustomError(
        governor,
        "GovernorOnlyExecutor",
      );
      await expect(g.setGlobalPause(true)).to.be.revertedWithCustomError(
        governor,
        "GovernorOnlyExecutor",
      );
    });
  });
});
