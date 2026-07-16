import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const COMMIT_WINDOW = 3600n; // 1h
const REVEAL_WINDOW = 3600n; // 1h

// Mirrors ScoreRegistry.computeCommitment: binds round + score + salt + rater.
function commitment(
  roundId: bigint,
  score: number,
  salt: string,
  rater: string,
): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint8", "bytes32", "address"],
      [roundId, score, salt, rater],
    ),
  );
}

const SALT_A = ethers.id("rater-a-secret");
const SALT_B = ethers.id("rater-b-secret");

describe("ScoreRegistry", () => {
  async function deploy() {
    const [deployer, provider, raterA, raterB, outsider] =
      await ethers.getSigners();
    const R = await ethers.getContractFactory("ScoreRegistry");
    const registry = await R.deploy();
    return { registry, deployer, provider, raterA, raterB, outsider };
  }

  async function openRound(f: any) {
    await f.registry.openRound(f.provider.address, COMMIT_WINDOW, REVEAL_WINDOW);
    return 1n;
  }

  describe("openRound", () => {
    it("assigns ids from 1 and records the windows", async () => {
      const f = await loadFixture(deploy);
      await expect(
        f.registry
          .connect(f.raterA)
          .openRound(f.provider.address, COMMIT_WINDOW, REVEAL_WINDOW),
      ).to.emit(f.registry, "RoundOpened");

      expect(await f.registry.totalRounds()).to.equal(1n);
      const r = await f.registry.getRound(1n);
      expect(r.provider).to.equal(f.provider.address);
      expect(r.revealEnd - r.commitEnd).to.equal(REVEAL_WINDOW);
      expect(await f.registry.phaseOf(1n)).to.equal(0); // commit phase
    });

    it("rejects a zero provider or a zero-length window", async () => {
      const f = await loadFixture(deploy);
      await expect(
        f.registry.openRound(ethers.ZeroAddress, COMMIT_WINDOW, REVEAL_WINDOW),
      ).to.be.revertedWithCustomError(f.registry, "ZeroProvider");
      await expect(
        f.registry.openRound(f.provider.address, 0, REVEAL_WINDOW),
      ).to.be.revertedWithCustomError(f.registry, "ZeroWindow");
      await expect(
        f.registry.openRound(f.provider.address, COMMIT_WINDOW, 0),
      ).to.be.revertedWithCustomError(f.registry, "ZeroWindow");
    });

    it("reverts for an unknown round id", async () => {
      const f = await loadFixture(deploy);
      await expect(f.registry.getRound(1n)).to.be.revertedWithCustomError(
        f.registry,
        "UnknownRound",
      );
      await expect(f.registry.phaseOf(99n)).to.be.revertedWithCustomError(
        f.registry,
        "UnknownRound",
      );
      expect(await f.registry.exists(0n)).to.equal(false);
    });
  });

  describe("commit phase", () => {
    it("stores a commitment without revealing the score", async () => {
      const f = await loadFixture(deploy);
      const id = await openRound(f);
      const c = commitment(id, 90, SALT_A, f.raterA.address);

      await expect(f.registry.connect(f.raterA).commit(id, c))
        .to.emit(f.registry, "ScoreCommitted")
        .withArgs(id, f.raterA.address);

      // The chain holds only the commitment — the score is not on-chain yet.
      expect(await f.registry.commitmentOf(id, f.raterA.address)).to.equal(c);
      expect(await f.registry.roundAverageScoreX100(id)).to.equal(0n);
      expect(
        await f.registry.providerAverageScoreX100(f.provider.address),
      ).to.equal(0n);
    });

    it("rejects a second commitment from the same rater (no re-deciding)", async () => {
      const f = await loadFixture(deploy);
      const id = await openRound(f);
      await f.registry
        .connect(f.raterA)
        .commit(id, commitment(id, 90, SALT_A, f.raterA.address));
      await expect(
        f.registry
          .connect(f.raterA)
          .commit(id, commitment(id, 10, SALT_A, f.raterA.address)),
      )
        .to.be.revertedWithCustomError(f.registry, "AlreadyCommitted")
        .withArgs(id, f.raterA.address);
    });

    it("rejects an empty commitment", async () => {
      const f = await loadFixture(deploy);
      const id = await openRound(f);
      await expect(
        f.registry.connect(f.raterA).commit(id, ethers.ZeroHash),
      ).to.be.revertedWithCustomError(f.registry, "EmptyCommitment");
    });

    it("rejects a commit after the window closes", async () => {
      const f = await loadFixture(deploy);
      const id = await openRound(f);
      await time.increase(COMMIT_WINDOW);
      await expect(
        f.registry
          .connect(f.raterA)
          .commit(id, commitment(id, 90, SALT_A, f.raterA.address)),
      ).to.be.revertedWithCustomError(f.registry, "CommitClosed");
    });
  });

  describe("reveal phase", () => {
    async function committed() {
      const f = await loadFixture(deploy);
      const id = await openRound(f);
      await f.registry
        .connect(f.raterA)
        .commit(id, commitment(id, 90, SALT_A, f.raterA.address));
      await f.registry
        .connect(f.raterB)
        .commit(id, commitment(id, 80, SALT_B, f.raterB.address));
      return { ...f, id };
    }

    it("cannot reveal while the commit window is still open", async () => {
      const f = await committed();
      await expect(f.registry.connect(f.raterA).reveal(f.id, 90, SALT_A))
        .to.be.revertedWithCustomError(f.registry, "CommitStillOpen");
    });

    it("accepts a correct reveal once commits close and aggregates it", async () => {
      const f = await committed();
      await time.increase(COMMIT_WINDOW);
      expect(await f.registry.phaseOf(f.id)).to.equal(1); // reveal phase

      await expect(f.registry.connect(f.raterA).reveal(f.id, 90, SALT_A))
        .to.emit(f.registry, "ScoreRevealed")
        .withArgs(f.id, f.raterA.address, 90);
      await f.registry.connect(f.raterB).reveal(f.id, 80, SALT_B);

      // (90 + 80) / 2 = 85.00
      expect(await f.registry.roundAverageScoreX100(f.id)).to.equal(8500n);
      expect(
        await f.registry.providerAverageScoreX100(f.provider.address),
      ).to.equal(8500n);
      const r = await f.registry.getRound(f.id);
      expect(r.revealCount).to.equal(2n);
      expect(r.scoreSum).to.equal(170n);
    });

    it("rejects a wrong salt", async () => {
      const f = await committed();
      await time.increase(COMMIT_WINDOW);
      await expect(
        f.registry.connect(f.raterA).reveal(f.id, 90, SALT_B), // wrong salt
      )
        .to.be.revertedWithCustomError(f.registry, "CommitmentMismatch")
        .withArgs(f.id, f.raterA.address);
    });

    it("rejects a different score than committed", async () => {
      const f = await committed();
      await time.increase(COMMIT_WINDOW);
      await expect(
        f.registry.connect(f.raterA).reveal(f.id, 55, SALT_A), // committed 90
      ).to.be.revertedWithCustomError(f.registry, "CommitmentMismatch");
    });

    it("rejects a reveal from a rater who never committed", async () => {
      const f = await committed();
      await time.increase(COMMIT_WINDOW);
      await expect(
        f.registry.connect(f.outsider).reveal(f.id, 90, SALT_A),
      ).to.be.revertedWithCustomError(f.registry, "NoCommitment");
    });

    it("rejects a double reveal", async () => {
      const f = await committed();
      await time.increase(COMMIT_WINDOW);
      await f.registry.connect(f.raterA).reveal(f.id, 90, SALT_A);
      await expect(
        f.registry.connect(f.raterA).reveal(f.id, 90, SALT_A),
      ).to.be.revertedWithCustomError(f.registry, "AlreadyRevealed");
    });

    it("rejects a score outside [MIN_SCORE, MAX_SCORE]", async () => {
      const f = await loadFixture(deploy);
      const id = await openRound(f);
      // Commit to an out-of-range score; the range check fires at reveal.
      await f.registry
        .connect(f.raterA)
        .commit(id, commitment(id, 0, SALT_A, f.raterA.address));
      await f.registry
        .connect(f.raterB)
        .commit(id, commitment(id, 101, SALT_B, f.raterB.address));
      await time.increase(COMMIT_WINDOW);

      await expect(f.registry.connect(f.raterA).reveal(id, 0, SALT_A))
        .to.be.revertedWithCustomError(f.registry, "ScoreOutOfRange")
        .withArgs(0);
      await expect(f.registry.connect(f.raterB).reveal(id, 101, SALT_B))
        .to.be.revertedWithCustomError(f.registry, "ScoreOutOfRange")
        .withArgs(101);
    });

    it("rejects a reveal after the reveal window closes", async () => {
      const f = await committed();
      await time.increase(COMMIT_WINDOW + REVEAL_WINDOW);
      expect(await f.registry.phaseOf(f.id)).to.equal(2); // closed
      await expect(
        f.registry.connect(f.raterA).reveal(f.id, 90, SALT_A),
      ).to.be.revertedWithCustomError(f.registry, "RevealClosed");
    });

    it("reverts for an unknown round on commit and reveal", async () => {
      const f = await loadFixture(deploy);
      await expect(
        f.registry.commit(42n, ethers.id("x")),
      ).to.be.revertedWithCustomError(f.registry, "UnknownRound");
      await expect(
        f.registry.reveal(42n, 90, SALT_A),
      ).to.be.revertedWithCustomError(f.registry, "UnknownRound");
    });
  });

  describe("commitment binding (privacy properties)", () => {
    it("a commitment cannot be replayed by a different rater", async () => {
      const f = await loadFixture(deploy);
      const id = await openRound(f);
      // raterB copies raterA's commitment verbatim...
      const c = commitment(id, 90, SALT_A, f.raterA.address);
      await f.registry.connect(f.raterB).commit(id, c);
      await time.increase(COMMIT_WINDOW);
      // ...but cannot open it, because the hash binds raterA's address.
      await expect(
        f.registry.connect(f.raterB).reveal(id, 90, SALT_A),
      ).to.be.revertedWithCustomError(f.registry, "CommitmentMismatch");
    });

    it("a commitment cannot be replayed into a different round", async () => {
      const f = await loadFixture(deploy);
      await openRound(f); // round 1
      await f.registry.openRound(f.provider.address, COMMIT_WINDOW, REVEAL_WINDOW); // round 2

      // Commitment computed for round 1, submitted into round 2.
      const c = commitment(1n, 90, SALT_A, f.raterA.address);
      await f.registry.connect(f.raterA).commit(2n, c);
      await time.increase(COMMIT_WINDOW);
      await expect(
        f.registry.connect(f.raterA).reveal(2n, 90, SALT_A),
      ).to.be.revertedWithCustomError(f.registry, "CommitmentMismatch");
    });

    it("matches the off-chain commitment helper (selective disclosure)", async () => {
      const f = await loadFixture(deploy);
      const id = await openRound(f);
      // An auditor handed (score, salt) can recompute the on-chain commitment.
      expect(
        await f.registry.computeCommitment(id, 90, SALT_A, f.raterA.address),
      ).to.equal(commitment(id, 90, SALT_A, f.raterA.address));
    });
  });

  describe("lifetime aggregate across rounds", () => {
    it("averages every revealed score for a provider", async () => {
      const f = await loadFixture(deploy);

      // Round 1: a single 100.
      await f.registry.openRound(f.provider.address, COMMIT_WINDOW, REVEAL_WINDOW);
      await f.registry
        .connect(f.raterA)
        .commit(1n, commitment(1n, 100, SALT_A, f.raterA.address));
      await time.increase(COMMIT_WINDOW);
      await f.registry.connect(f.raterA).reveal(1n, 100, SALT_A);
      expect(
        await f.registry.providerAverageScoreX100(f.provider.address),
      ).to.equal(10000n);

      // Round 2: a single 50 => lifetime average 75.00.
      await f.registry.openRound(f.provider.address, COMMIT_WINDOW, REVEAL_WINDOW);
      await f.registry
        .connect(f.raterB)
        .commit(2n, commitment(2n, 50, SALT_B, f.raterB.address));
      await time.increase(COMMIT_WINDOW);
      await f.registry.connect(f.raterB).reveal(2n, 50, SALT_B);

      expect(
        await f.registry.providerAverageScoreX100(f.provider.address),
      ).to.equal(7500n);
      expect(await f.registry.lifetimeRevealCount(f.provider.address)).to.equal(2n);
      expect(await f.registry.lifetimeScoreSum(f.provider.address)).to.equal(150n);
    });

    it("reports zero for an unrated provider", async () => {
      const f = await loadFixture(deploy);
      expect(
        await f.registry.providerAverageScoreX100(f.outsider.address),
      ).to.equal(0n);
    });
  });
});
