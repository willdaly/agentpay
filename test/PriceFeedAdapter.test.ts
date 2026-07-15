import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

// Chainlink USD feeds are 8-decimal fixed point.
const ETH_USD_3000 = 3000n * 10n ** 8n; // $3000.00000000
const MAX_STALENESS = 3600n; // 1 hour
const APT_PER_ETH = 3000n; // demo peg => APT ~= $1 at ETH = $3000

describe("PriceFeedAdapter", () => {
  async function deployWithFeed(decimals = 8, initialAnswer = ETH_USD_3000) {
    const Mock = await ethers.getContractFactory("MockV3Aggregator");
    const feed = await Mock.deploy(decimals, initialAnswer);
    await feed.waitForDeployment();

    const Adapter = await ethers.getContractFactory("PriceFeedAdapter");
    const adapter = await Adapter.deploy(
      await feed.getAddress(),
      MAX_STALENESS,
      APT_PER_ETH,
    );
    await adapter.waitForDeployment();
    return { feed, adapter };
  }

  function fixture() {
    return deployWithFeed();
  }

  describe("constructor", () => {
    it("stores config and reads feed decimals", async () => {
      const { adapter } = await loadFixture(fixture);
      expect(await adapter.maxStaleness()).to.equal(MAX_STALENESS);
      expect(await adapter.aptPerEth()).to.equal(APT_PER_ETH);
      expect(await adapter.feedDecimals()).to.equal(8);
      expect(await adapter.USD_DECIMALS()).to.equal(8);
    });

    it("reverts on a zero feed address", async () => {
      const Adapter = await ethers.getContractFactory("PriceFeedAdapter");
      await expect(
        Adapter.deploy(ethers.ZeroAddress, MAX_STALENESS, APT_PER_ETH),
      ).to.be.revertedWithCustomError(Adapter, "ZeroAddress");
    });

    it("reverts on zero staleness or zero peg", async () => {
      const Mock = await ethers.getContractFactory("MockV3Aggregator");
      const feed = await Mock.deploy(8, ETH_USD_3000);
      const feedAddr = await feed.getAddress();
      const Adapter = await ethers.getContractFactory("PriceFeedAdapter");
      await expect(
        Adapter.deploy(feedAddr, 0, APT_PER_ETH),
      ).to.be.revertedWithCustomError(Adapter, "ZeroConfig");
      await expect(
        Adapter.deploy(feedAddr, MAX_STALENESS, 0),
      ).to.be.revertedWithCustomError(Adapter, "ZeroConfig");
    });
  });

  describe("latestUsdPrice", () => {
    it("returns the fresh feed price", async () => {
      const { adapter } = await loadFixture(fixture);
      expect(await adapter.latestUsdPrice()).to.equal(ETH_USD_3000);
    });

    it("reverts StalePrice once the answer ages past maxStaleness", async () => {
      const { adapter } = await loadFixture(fixture);
      await time.increase(MAX_STALENESS + 1n);
      await expect(adapter.latestUsdPrice()).to.be.revertedWithCustomError(
        adapter,
        "StalePrice",
      );
    });

    it("does not revert exactly at the staleness boundary", async () => {
      const { adapter, feed } = await loadFixture(fixture);
      // Refresh the answer, then advance to exactly maxStaleness (still valid).
      await feed.updateAnswer(ETH_USD_3000);
      const updatedAt = BigInt(await time.latest());
      await time.setNextBlockTimestamp(updatedAt + MAX_STALENESS);
      await ethers.provider.send("evm_mine", []);
      expect(await adapter.latestUsdPrice()).to.equal(ETH_USD_3000);
    });

    it("reverts NonPositiveAnswer on a zero answer", async () => {
      const { adapter, feed } = await loadFixture(fixture);
      await feed.updateAnswer(0);
      await expect(adapter.latestUsdPrice()).to.be.revertedWithCustomError(
        adapter,
        "NonPositiveAnswer",
      );
    });

    it("reverts NonPositiveAnswer on a negative answer", async () => {
      const { adapter, feed } = await loadFixture(fixture);
      await feed.updateAnswer(-1);
      await expect(adapter.latestUsdPrice()).to.be.revertedWithCustomError(
        adapter,
        "NonPositiveAnswer",
      );
    });

    it("reverts IncompleteRound when updatedAt is zero", async () => {
      const { adapter, feed } = await loadFixture(fixture);
      // roundId=2, positive answer, but updatedAt=0 => incomplete round.
      await feed.updateRoundData(2, ETH_USD_3000, 0, 0);
      await expect(adapter.latestUsdPrice()).to.be.revertedWithCustomError(
        adapter,
        "IncompleteRound",
      );
    });

    it("reverts IncompleteRound when answeredInRound is behind roundId", async () => {
      // The canonical mock always sets answeredInRound == roundId; use the
      // manipulable feed to force a stale-round answer.
      const Feed = await ethers.getContractFactory("ManipulableFeed");
      const feed = await Feed.deploy(8);
      const now = BigInt(await time.latest());
      // roundId=5, answered in an earlier round 4, fresh timestamp, positive answer.
      await feed.set(5, ETH_USD_3000, now, 4);
      const Adapter = await ethers.getContractFactory("PriceFeedAdapter");
      const adapter = await Adapter.deploy(
        await feed.getAddress(),
        MAX_STALENESS,
        APT_PER_ETH,
      );
      await expect(adapter.latestUsdPrice()).to.be.revertedWithCustomError(
        adapter,
        "IncompleteRound",
      );
    });
  });

  describe("USD <-> APT conversion", () => {
    it("converts a USD cap into APT at the demo peg", async () => {
      const { adapter } = await loadFixture(fixture);
      // $5 at APT=$1 => 5 APT
      const fiveUsd = 5n * 10n ** 8n;
      expect(await adapter.usdToToken(fiveUsd)).to.equal(ethers.parseEther("5"));
    });

    it("round-trips APT -> USD -> APT", async () => {
      const { adapter } = await loadFixture(fixture);
      const fiveUsd = 5n * 10n ** 8n;
      expect(await adapter.tokenToUsd(ethers.parseEther("5"))).to.equal(fiveUsd);
    });

    it("lets the live oracle move how much APT a USD cap buys", async () => {
      const { adapter, feed } = await loadFixture(fixture);
      // ETH halves in USD => APT is cheaper => $5 buys more APT.
      await feed.updateAnswer(2000n * 10n ** 8n);
      const fiveUsd = 5n * 10n ** 8n;
      // 5 * 3000 / 2000 = 7.5 APT
      expect(await adapter.usdToToken(fiveUsd)).to.equal(
        ethers.parseEther("7.5"),
      );
    });
  });

  describe("feed decimal normalization", () => {
    it("scales an 18-decimal feed down to 8 decimals", async () => {
      const { adapter } = await deployWithFeed(18, 3000n * 10n ** 18n);
      expect(await adapter.latestUsdPrice()).to.equal(ETH_USD_3000);
    });

    it("scales a 6-decimal feed up to 8 decimals", async () => {
      const { adapter } = await deployWithFeed(6, 3000n * 10n ** 6n);
      expect(await adapter.latestUsdPrice()).to.equal(ETH_USD_3000);
    });
  });
});
