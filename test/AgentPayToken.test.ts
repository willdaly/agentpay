import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const INITIAL_SUPPLY = ethers.parseEther("1000000"); // 1,000,000 APT

describe("AgentPayToken", () => {
  async function deploy() {
    const [deployer, alice, bob] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("AgentPayToken");
    const token = await Token.deploy(INITIAL_SUPPLY, deployer.address);
    await token.waitForDeployment();
    return { token, deployer, alice, bob };
  }

  describe("deployment", () => {
    it("sets name, symbol, and 18 decimals", async () => {
      const { token } = await loadFixture(deploy);
      expect(await token.name()).to.equal("AgentPay Token");
      expect(await token.symbol()).to.equal("APT");
      expect(await token.decimals()).to.equal(18);
    });

    it("mints the fixed initial supply to the initial holder", async () => {
      const { token, deployer } = await loadFixture(deploy);
      expect(await token.totalSupply()).to.equal(INITIAL_SUPPLY);
      expect(await token.balanceOf(deployer.address)).to.equal(INITIAL_SUPPLY);
    });
  });

  describe("faucet (demo-only)", () => {
    it("mints FAUCET_AMOUNT to the caller and grows supply", async () => {
      const { token, alice } = await loadFixture(deploy);
      const amount = await token.FAUCET_AMOUNT();
      await expect(token.connect(alice).faucet()).to.changeTokenBalance(
        token,
        alice,
        amount,
      );
      expect(await token.totalSupply()).to.equal(INITIAL_SUPPLY + amount);
    });

    it("is callable repeatedly by different accounts", async () => {
      const { token, alice, bob } = await loadFixture(deploy);
      await token.connect(alice).faucet();
      await token.connect(bob).faucet();
      const amount = await token.FAUCET_AMOUNT();
      expect(await token.balanceOf(alice.address)).to.equal(amount);
      expect(await token.balanceOf(bob.address)).to.equal(amount);
    });
  });

  describe("ERC20 transfers", () => {
    it("moves balances between accounts", async () => {
      const { token, deployer, alice } = await loadFixture(deploy);
      const amount = ethers.parseEther("100");
      await expect(
        token.connect(deployer).transfer(alice.address, amount),
      ).to.changeTokenBalances(token, [deployer, alice], [-amount, amount]);
    });
  });

  describe("ERC20Votes governance weight", () => {
    it("gives zero voting power until self-delegation", async () => {
      const { token, deployer } = await loadFixture(deploy);
      expect(await token.getVotes(deployer.address)).to.equal(0n);
      await token.connect(deployer).delegate(deployer.address);
      expect(await token.getVotes(deployer.address)).to.equal(INITIAL_SUPPLY);
    });

    it("moves voting power when delegated tokens transfer", async () => {
      const { token, deployer, alice } = await loadFixture(deploy);
      await token.connect(deployer).delegate(deployer.address);
      await token.connect(alice).delegate(alice.address);
      const amount = ethers.parseEther("100");
      await token.connect(deployer).transfer(alice.address, amount);
      expect(await token.getVotes(alice.address)).to.equal(amount);
      expect(await token.getVotes(deployer.address)).to.equal(
        INITIAL_SUPPLY - amount,
      );
    });

    it("exposes checkpointed past votes", async () => {
      const { token, deployer } = await loadFixture(deploy);
      await token.connect(deployer).delegate(deployer.address);
      const mineBlock = await ethers.provider.getBlockNumber();
      await ethers.provider.send("evm_mine", []); // advance so the checkpoint is in the past
      expect(await token.getPastVotes(deployer.address, mineBlock)).to.equal(
        INITIAL_SUPPLY,
      );
    });
  });

  describe("ERC20Permit", () => {
    it("starts nonces at zero and exposes a domain separator", async () => {
      const { token, alice } = await loadFixture(deploy);
      expect(await token.nonces(alice.address)).to.equal(0n);
      expect(await token.DOMAIN_SEPARATOR()).to.not.equal(ethers.ZeroHash);
    });
  });
});
