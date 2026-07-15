import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const SEPOLIA_SELECTOR = 16015286601757825753n; // Chainlink Sepolia CCIP selector
const TERMS = ethers.toUtf8Bytes("AgentPay demo inference service — terms v1");
const TERMS_HASH = ethers.keccak256(TERMS);
const CID = "ipfs://bafyDemoServiceTerms";
const PRICE_CENTS = 5n; // $0.05

describe("ServiceRegistry", () => {
  async function deploy() {
    const [deployer, provider, other] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("ServiceRegistry");
    const registry = await Registry.deploy();
    await registry.waitForDeployment();
    return { registry, deployer, provider, other };
  }

  async function registerOne(registry: any, provider: any) {
    const tx = await registry
      .connect(provider)
      .registerService(PRICE_CENTS, TERMS_HASH, CID, SEPOLIA_SELECTOR);
    await tx.wait();
    return 1n; // first id
  }

  describe("registerService", () => {
    it("assigns ids from 1 and stores the record", async () => {
      const { registry, provider } = await loadFixture(deploy);
      await expect(
        registry
          .connect(provider)
          .registerService(PRICE_CENTS, TERMS_HASH, CID, SEPOLIA_SELECTOR),
      )
        .to.emit(registry, "ServiceRegistered")
        .withArgs(
          1n,
          provider.address,
          PRICE_CENTS,
          SEPOLIA_SELECTOR,
          TERMS_HASH,
          CID,
        );

      expect(await registry.totalServices()).to.equal(1n);
      const s = await registry.getService(1n);
      expect(s.provider).to.equal(provider.address);
      expect(s.priceUsdCents).to.equal(PRICE_CENTS);
      expect(s.termsHash).to.equal(TERMS_HASH);
      expect(s.metadataURI).to.equal(CID);
      expect(s.homeChainSelector).to.equal(SEPOLIA_SELECTOR);
      expect(s.active).to.equal(true);
    });

    it("is permissionless: multiple providers, incrementing ids", async () => {
      const { registry, provider, other } = await loadFixture(deploy);
      await registerOne(registry, provider);
      await registry
        .connect(other)
        .registerService(0, TERMS_HASH, CID, SEPOLIA_SELECTOR);
      expect(await registry.totalServices()).to.equal(2n);
      expect(await registry.providerOf(2n)).to.equal(other.address);
    });

    it("reverts on empty metadata", async () => {
      const { registry, provider } = await loadFixture(deploy);
      await expect(
        registry
          .connect(provider)
          .registerService(PRICE_CENTS, TERMS_HASH, "", SEPOLIA_SELECTOR),
      ).to.be.revertedWithCustomError(registry, "EmptyMetadata");
    });

    it("reverts on a zero chain selector", async () => {
      const { registry, provider } = await loadFixture(deploy);
      await expect(
        registry.connect(provider).registerService(PRICE_CENTS, TERMS_HASH, CID, 0),
      ).to.be.revertedWithCustomError(registry, "ZeroChainSelector");
    });
  });

  describe("updateService", () => {
    it("lets the provider update mutable fields", async () => {
      const { registry, provider } = await loadFixture(deploy);
      await registerOne(registry, provider);
      const newHash = ethers.keccak256(ethers.toUtf8Bytes("terms v2"));
      await expect(
        registry
          .connect(provider)
          .updateService(1n, 10n, newHash, "ipfs://v2"),
      )
        .to.emit(registry, "ServiceUpdated")
        .withArgs(1n, 10n, newHash, "ipfs://v2");
      const s = await registry.getService(1n);
      expect(s.priceUsdCents).to.equal(10n);
      expect(s.termsHash).to.equal(newHash);
      expect(s.metadataURI).to.equal("ipfs://v2");
    });

    it("reverts for a non-provider caller", async () => {
      const { registry, provider, other } = await loadFixture(deploy);
      await registerOne(registry, provider);
      await expect(
        registry.connect(other).updateService(1n, 10n, TERMS_HASH, CID),
      )
        .to.be.revertedWithCustomError(registry, "NotServiceProvider")
        .withArgs(1n, other.address);
    });

    it("reverts on empty metadata", async () => {
      const { registry, provider } = await loadFixture(deploy);
      await registerOne(registry, provider);
      await expect(
        registry.connect(provider).updateService(1n, 10n, TERMS_HASH, ""),
      ).to.be.revertedWithCustomError(registry, "EmptyMetadata");
    });

    it("reverts for an unknown service", async () => {
      const { registry, provider } = await loadFixture(deploy);
      await expect(
        registry.connect(provider).updateService(99n, 10n, TERMS_HASH, CID),
      )
        .to.be.revertedWithCustomError(registry, "UnknownService")
        .withArgs(99n);
    });
  });

  describe("setActive", () => {
    it("lets the provider toggle availability", async () => {
      const { registry, provider } = await loadFixture(deploy);
      await registerOne(registry, provider);
      await expect(registry.connect(provider).setActive(1n, false))
        .to.emit(registry, "ServiceActiveSet")
        .withArgs(1n, false);
      expect(await registry.isActive(1n)).to.equal(false);
      await registry.connect(provider).setActive(1n, true);
      expect(await registry.isActive(1n)).to.equal(true);
    });

    it("reverts for a non-provider caller", async () => {
      const { registry, provider, other } = await loadFixture(deploy);
      await registerOne(registry, provider);
      await expect(
        registry.connect(other).setActive(1n, false),
      ).to.be.revertedWithCustomError(registry, "NotServiceProvider");
    });
  });

  describe("views", () => {
    it("exists() and isActive() report correctly", async () => {
      const { registry, provider } = await loadFixture(deploy);
      expect(await registry.exists(0n)).to.equal(false);
      expect(await registry.exists(1n)).to.equal(false);
      await registerOne(registry, provider);
      expect(await registry.exists(1n)).to.equal(true);
      expect(await registry.isActive(1n)).to.equal(true);
      expect(await registry.isActive(2n)).to.equal(false); // unknown => not active
    });

    it("getService and providerOf revert for unknown ids", async () => {
      const { registry } = await loadFixture(deploy);
      await expect(registry.getService(1n)).to.be.revertedWithCustomError(
        registry,
        "UnknownService",
      );
      await expect(registry.providerOf(1n)).to.be.revertedWithCustomError(
        registry,
        "UnknownService",
      );
    });

    it("verifyTerms matches only the exact registered document", async () => {
      const { registry, provider } = await loadFixture(deploy);
      await registerOne(registry, provider);
      expect(await registry.verifyTerms(1n, TERMS)).to.equal(true);
      expect(
        await registry.verifyTerms(1n, ethers.toUtf8Bytes("tampered terms")),
      ).to.equal(false);
    });

    it("verifyTerms reverts for an unknown service", async () => {
      const { registry } = await loadFixture(deploy);
      await expect(
        registry.verifyTerms(1n, TERMS),
      ).to.be.revertedWithCustomError(registry, "UnknownService");
    });
  });
});
