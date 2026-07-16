import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const apt = (n: string) => ethers.parseEther(n);
const WINDOW = 60n * 60n; // 1 hour dispute window

describe("SettlementEscrow", () => {
  // Base fixture: a mock authorizer so a plain signer can act as an AgentWallet.
  async function deployWith(disputeWindow: bigint) {
    const [deployer, owner, walletSigner, provider, stranger] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory("AgentPayToken");
    const token = await Token.deploy(apt("1000000"), deployer.address);

    const Policy = await ethers.getContractFactory("MockPolicyParameters");
    const policy = await Policy.deploy(0, 0, 0);
    await policy.setDisputeWindow(disputeWindow);

    const Auth = await ethers.getContractFactory("MockWalletAuthorizer");
    const authorizer = await Auth.deploy();
    await authorizer.setWallet(walletSigner.address, true);

    const Escrow = await ethers.getContractFactory("SettlementEscrow");
    const escrow = await Escrow.deploy(
      await token.getAddress(),
      await policy.getAddress(),
      owner.address,
    );
    await escrow.connect(owner).setAuthorizer(await authorizer.getAddress());

    // The "wallet" is funded; it transfers to escrow then credits (as AgentWallet does).
    await token.transfer(walletSigner.address, apt("1000"));

    return { token, policy, authorizer, escrow, deployer, owner, walletSigner, provider, stranger };
  }

  // Named fixtures (loadFixture rejects anonymous functions).
  function deployImmediate() {
    return deployWith(0n);
  }
  function deployWindowed() {
    return deployWith(WINDOW);
  }

  // Simulate a spend: wallet pushes tokens to escrow, then credits the provider.
  async function creditAs(
    f: Awaited<ReturnType<typeof deployWith>>,
    provider: string,
    serviceId: bigint,
    amount: bigint,
  ) {
    await f.token
      .connect(f.walletSigner)
      .transfer(await f.escrow.getAddress(), amount);
    return f.escrow.connect(f.walletSigner).credit(provider, serviceId, amount);
  }

  describe("authorization", () => {
    it("rejects credit from a non-wallet", async () => {
      const f = await loadFixture(deployImmediate);
      await f.token.transfer(await f.escrow.getAddress(), apt("1"));
      await expect(
        f.escrow.connect(f.stranger).credit(f.provider.address, 1n, apt("1")),
      )
        .to.be.revertedWithCustomError(f.escrow, "NotAuthorizedPayer")
        .withArgs(f.stranger.address);
    });

    it("rejects zero provider or zero amount", async () => {
      const f = await loadFixture(deployImmediate);
      await expect(
        f.escrow.connect(f.walletSigner).credit(ethers.ZeroAddress, 1n, apt("1")),
      ).to.be.revertedWithCustomError(f.escrow, "ZeroAddress");
      await expect(
        f.escrow.connect(f.walletSigner).credit(f.provider.address, 1n, 0),
      ).to.be.revertedWithCustomError(f.escrow, "ZeroAmount");
    });

    const depNames = ["token", "policy"];
    depNames.forEach((name, depIndex) => {
      it(`reverts constructor when ${name} is zero`, async () => {
        const f = await loadFixture(deployImmediate);
        const deps = [
          await f.token.getAddress(),
          await f.policy.getAddress(),
        ];
        deps[depIndex] = ethers.ZeroAddress;
        const Escrow = await ethers.getContractFactory("SettlementEscrow");
        await expect(
          Escrow.deploy(deps[0], deps[1], f.owner.address),
        ).to.be.revertedWithCustomError(Escrow, "ZeroAddress");
      });
    });
  });

  describe("immediate settlement (window == 0)", () => {
    it("credits withdrawable straight away", async () => {
      const f = await loadFixture(deployImmediate);
      await expect(creditAs(f, f.provider.address, 7n, apt("5")))
        .to.emit(f.escrow, "PaymentSettled")
        .withArgs(f.provider.address, 7n, apt("5"));
      expect(await f.escrow.withdrawable(f.provider.address)).to.equal(apt("5"));
      expect(await f.escrow.totalOwed()).to.equal(apt("5"));
      expect(await f.escrow.solvent()).to.equal(true);
    });

    it("lets the provider pull funds and clears the ledger", async () => {
      const f = await loadFixture(deployImmediate);
      await creditAs(f, f.provider.address, 7n, apt("5"));
      await expect(f.escrow.connect(f.provider).withdraw())
        .to.emit(f.escrow, "Withdrawn")
        .withArgs(f.provider.address, apt("5"));
      expect(await f.escrow.withdrawable(f.provider.address)).to.equal(0n);
      expect(await f.escrow.totalOwed()).to.equal(0n);
    });

    it("reverts withdraw when there is nothing to pull", async () => {
      const f = await loadFixture(deployImmediate);
      await expect(
        f.escrow.connect(f.provider).withdraw(),
      ).to.be.revertedWithCustomError(f.escrow, "NothingToWithdraw");
    });

    it("aggregates multiple credits before withdrawal", async () => {
      const f = await loadFixture(deployImmediate);
      await creditAs(f, f.provider.address, 1n, apt("2"));
      await creditAs(f, f.provider.address, 2n, apt("3"));
      expect(await f.escrow.withdrawable(f.provider.address)).to.equal(apt("5"));
    });
  });

  describe("windowed settlement (window > 0)", () => {
    it("creates a pending payment, not immediately withdrawable", async () => {
      const f = await loadFixture(deployWindowed);
      const tx = await creditAs(f, f.provider.address, 9n, apt("4"));
      const releaseAt = BigInt(await time.latest()) + WINDOW;
      await expect(tx)
        .to.emit(f.escrow, "PaymentPending")
        .withArgs(1n, f.provider.address, f.walletSigner.address, 9n, apt("4"), releaseAt);
      expect(await f.escrow.withdrawable(f.provider.address)).to.equal(0n);
      expect(await f.escrow.paymentCount()).to.equal(1n);
      const p = await f.escrow.getPayment(1n);
      expect(p.amount).to.equal(apt("4"));
      expect(p.released).to.equal(false);
    });

    it("cannot be released before the window elapses", async () => {
      const f = await loadFixture(deployWindowed);
      await creditAs(f, f.provider.address, 9n, apt("4"));
      await expect(
        f.escrow.release(1n),
      ).to.be.revertedWithCustomError(f.escrow, "ReleaseNotReady");
    });

    it("releases to withdrawable after the window (permissionless crank)", async () => {
      const f = await loadFixture(deployWindowed);
      await creditAs(f, f.provider.address, 9n, apt("4"));
      await time.increase(WINDOW);
      await expect(f.escrow.connect(f.stranger).release(1n))
        .to.emit(f.escrow, "PaymentReleased")
        .withArgs(1n, f.provider.address, apt("4"));
      expect(await f.escrow.withdrawable(f.provider.address)).to.equal(apt("4"));
      await expect(f.escrow.connect(f.provider).withdraw()).to.changeTokenBalance(
        f.token,
        f.provider,
        apt("4"),
      );
    });

    it("cannot double-release", async () => {
      const f = await loadFixture(deployWindowed);
      await creditAs(f, f.provider.address, 9n, apt("4"));
      await time.increase(WINDOW);
      await f.escrow.release(1n);
      await expect(
        f.escrow.release(1n),
      ).to.be.revertedWithCustomError(f.escrow, "AlreadyReleased");
    });

    it("reverts release / getPayment for an unknown id", async () => {
      const f = await loadFixture(deployWindowed);
      await expect(
        f.escrow.release(99n),
      ).to.be.revertedWithCustomError(f.escrow, "UnknownPayment");
      await expect(
        f.escrow.getPayment(99n),
      ).to.be.revertedWithCustomError(f.escrow, "UnknownPayment");
    });
  });

  describe("pull-over-push safety", () => {
    it("a spend credit to a hostile (reverting) provider still succeeds", async () => {
      const f = await loadFixture(deployImmediate);
      const Reverting = await ethers.getContractFactory("RevertingReceiver");
      const hostile = await Reverting.deploy();
      // Crediting never calls the provider, so the reverting fallback is irrelevant.
      await expect(
        creditAs(f, await hostile.getAddress(), 1n, apt("5")),
      ).to.emit(f.escrow, "PaymentSettled");
      expect(await f.escrow.withdrawable(await hostile.getAddress())).to.equal(
        apt("5"),
      );
    });

    it("blocks a reentrant withdraw via a malicious token callback", async () => {
      const [deployer, owner, walletSigner] = await ethers.getSigners();

      // Escrow denominated in a malicious ERC-777-style token.
      const RT = await ethers.getContractFactory("ReentrantToken");
      const token = await RT.deploy();
      const Policy = await ethers.getContractFactory("MockPolicyParameters");
      const policy = await Policy.deploy(0, 0, 0);
      await policy.setDisputeWindow(0); // immediate withdrawable, so withdraw actually transfers
      const Auth = await ethers.getContractFactory("MockWalletAuthorizer");
      const authorizer = await Auth.deploy();
      await authorizer.setWallet(walletSigner.address, true);
      const Escrow = await ethers.getContractFactory("SettlementEscrow");
      const escrow = await Escrow.deploy(
        await token.getAddress(),
        await policy.getAddress(),
        owner.address,
      );
      await escrow.connect(owner).setAuthorizer(await authorizer.getAddress());

      const Attacker = await ethers.getContractFactory("ReentrantAttacker");
      const attacker = await Attacker.deploy(await escrow.getAddress());

      // Fund escrow with extra tokens so a successful drain would be possible.
      await token.mint(await escrow.getAddress(), apt("100"));
      // Credit the attacker as provider (wallet pushed tokens are already there).
      await token.mint(walletSigner.address, apt("5"));
      await token
        .connect(walletSigner)
        .transfer(await escrow.getAddress(), apt("5"));
      await escrow
        .connect(walletSigner)
        .credit(await attacker.getAddress(), 1n, apt("5"));

      // Arm the token hook to fire on transfer to the attacker, then attack.
      await token.setHookTarget(await attacker.getAddress());
      const escrowBalBefore = await token.balanceOf(await escrow.getAddress());

      // The re-entrant withdraw is caught by the nonReentrant guard, so the whole
      // attack reverts and no funds leave the escrow. (checks-effects-interactions
      // ordering is a second line of defence.)
      await expect(attacker.attack()).to.be.revertedWithCustomError(
        escrow,
        "ReentrancyGuardReentrantCall",
      );
      expect(await token.balanceOf(await attacker.getAddress())).to.equal(0n);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(
        escrowBalBefore,
      );
      expect(await escrow.withdrawable(await attacker.getAddress())).to.equal(
        apt("5"),
      );
    });
  });
});
