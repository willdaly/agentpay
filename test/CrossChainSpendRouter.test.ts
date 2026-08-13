import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const usd = (d: number) => BigInt(Math.round(d * 1e8));
const apt = (n: string) => ethers.parseEther(n);

const REMOTE_SELECTOR = 10344971235874465080n; // Base Sepolia (verified)
const HOME_SELECTOR = 16015286601757825753n; // Sepolia (verified)
const FEE = ethers.parseEther("0.01");

describe("CrossChainSpendRouter", () => {
  async function deploy() {
    const [deployer, owner, walletSigner, provider, remoteRouter, outsider] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory("AgentPayToken");
    const token = await Token.deploy(apt("1000000"), deployer.address);

    const Policy = await ethers.getContractFactory("MockPolicyParameters");
    const policy = await Policy.deploy(usd(10), usd(100), apt("100"));
    await policy.setDisputeWindow(0); // immediate settlement keeps assertions direct

    const Escrow = await ethers.getContractFactory("SettlementEscrow");
    const escrow = await Escrow.deploy(
      await token.getAddress(),
      await policy.getAddress(),
      owner.address,
    );

    const Ccip = await ethers.getContractFactory("MockCCIPRouter");
    const ccip = await Ccip.deploy();

    const Router = await ethers.getContractFactory("CrossChainSpendRouter");
    const router = await Router.deploy(
      await token.getAddress(),
      await ccip.getAddress(),
      await escrow.getAddress(),
      owner.address,
    );

    // One authorizer vouches for the wallet (calling routeSpend) and for the
    // router itself (calling escrow.credit when receiving).
    const Auth = await ethers.getContractFactory("MockWalletAuthorizer");
    const auth = await Auth.deploy();
    await auth.setWallet(walletSigner.address, true);
    await auth.setWallet(await router.getAddress(), true);

    await escrow.connect(owner).setAuthorizer(await auth.getAddress());
    await router.connect(owner).setAuthorizer(await auth.getAddress());
    await router
      .connect(owner)
      .setDestinationRouter(REMOTE_SELECTOR, remoteRouter.address);

    // Fee budget (native ETH) + the wallet's APT.
    await router.connect(deployer).fundNative({ value: ethers.parseEther("1") });
    await token.transfer(walletSigner.address, apt("1000"));

    return {
      token, policy, escrow, ccip, router, auth,
      deployer, owner, walletSigner, provider, remoteRouter, outsider,
    };
  }

  // The wallet's convention: transfer APT to the router, then call routeSpend.
  async function sendSpend(f: any, amount = apt("5")) {
    await f.token.connect(f.walletSigner).transfer(await f.router.getAddress(), amount);
    return f.router
      .connect(f.walletSigner)
      .routeSpend(REMOTE_SELECTOR, f.provider.address, 1n, amount, usd(5));
  }

  describe("deployment", () => {
    it("wires token, ccip router, and escrow", async () => {
      const { router, token, ccip, escrow, owner } = await loadFixture(deploy);
      expect(await router.token()).to.equal(await token.getAddress());
      expect(await router.ccipRouter()).to.equal(await ccip.getAddress());
      expect(await router.escrow()).to.equal(await escrow.getAddress());
      expect(await router.owner()).to.equal(owner.address);
      expect(await router.destGasLimit()).to.equal(300_000n);
    });

    // Regression guard for a bug a LIVE CCIP deploy caught: a real OffRamp checks
    // ERC165 support for IAny2EVMMessageReceiver before calling ccipReceive, and
    // SKIPS the callback (marking the message success anyway) if it's missing.
    // Without supportsInterface, cross-chain spends silently never settle.
    it("declares ERC165 support for the CCIP receiver interface", async () => {
      const { router } = await loadFixture(deploy);
      const IANY2EVM = "0x85572ffb"; // type(IAny2EVMMessageReceiver).interfaceId
      const IERC165 = "0x01ffc9a7";
      const INVALID = "0xffffffff"; // ERC165 requires this to be false
      expect(await router.supportsInterface(IANY2EVM)).to.equal(true);
      expect(await router.supportsInterface(IERC165)).to.equal(true);
      expect(await router.supportsInterface(INVALID)).to.equal(false);
      expect(await router.supportsInterface("0xdeadbeef")).to.equal(false);
    });

    const deps = ["token", "ccipRouter", "escrow"];
    deps.forEach((name, i) => {
      it(`reverts when ${name} is zero`, async () => {
        const f = await loadFixture(deploy);
        const args = [
          await f.token.getAddress(),
          await f.ccip.getAddress(),
          await f.escrow.getAddress(),
        ];
        args[i] = ethers.ZeroAddress;
        const Router = await ethers.getContractFactory("CrossChainSpendRouter");
        await expect(
          Router.deploy(args[0], args[1], args[2], f.owner.address),
        ).to.be.revertedWithCustomError(Router, "ZeroAddress");
      });
    });
  });

  describe("setAuthorizer", () => {
    it("is one-time and owner-only", async () => {
      const { token, ccip, escrow, owner, auth, outsider } = await loadFixture(deploy);
      const Router = await ethers.getContractFactory("CrossChainSpendRouter");
      const fresh = await Router.deploy(
        await token.getAddress(),
        await ccip.getAddress(),
        await escrow.getAddress(),
        owner.address,
      );
      await expect(
        fresh.connect(outsider).setAuthorizer(await auth.getAddress()),
      ).to.be.revertedWithCustomError(fresh, "OwnableUnauthorizedAccount");
      await expect(
        fresh.connect(owner).setAuthorizer(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(fresh, "ZeroAddress");

      await expect(fresh.connect(owner).setAuthorizer(await auth.getAddress()))
        .to.emit(fresh, "AuthorizerSet")
        .withArgs(await auth.getAddress());

      await expect(
        fresh.connect(owner).setAuthorizer(await auth.getAddress()),
      ).to.be.revertedWithCustomError(fresh, "AuthorizerAlreadySet");
    });

    it("routeSpend reverts before an authorizer is set", async () => {
      const { token, ccip, escrow, owner, walletSigner, provider } =
        await loadFixture(deploy);
      const Router = await ethers.getContractFactory("CrossChainSpendRouter");
      const fresh = await Router.deploy(
        await token.getAddress(),
        await ccip.getAddress(),
        await escrow.getAddress(),
        owner.address,
      );
      await expect(
        fresh
          .connect(walletSigner)
          .routeSpend(REMOTE_SELECTOR, provider.address, 1n, apt("1"), usd(1)),
      ).to.be.revertedWithCustomError(fresh, "AuthorizerNotSet");
    });
  });

  describe("routeSpend (sender side)", () => {
    it("sends a data-only CCIP message and emits the audit event", async () => {
      const f = await loadFixture(deploy);
      await expect(sendSpend(f)).to.emit(f.router, "CrossChainSpendSent");

      expect(await f.ccip.sentCount()).to.equal(1n);
      const sent = await f.ccip.lastSent();
      expect(sent.destChainSelector).to.equal(REMOTE_SELECTOR);
      expect(sent.receiver).to.equal(f.remoteRouter.address);
      expect(sent.feeToken).to.equal(ethers.ZeroAddress); // native ETH fees
      expect(sent.feePaid).to.equal(FEE);
    });

    it("locks the APT in the router on the source chain", async () => {
      const f = await loadFixture(deploy);
      await sendSpend(f, apt("5"));
      expect(await f.token.balanceOf(await f.router.getAddress())).to.equal(apt("5"));
    });

    it("pays the CCIP fee from the router's native balance", async () => {
      const f = await loadFixture(deploy);
      const before = await ethers.provider.getBalance(await f.router.getAddress());
      await sendSpend(f);
      const after = await ethers.provider.getBalance(await f.router.getAddress());
      expect(before - after).to.equal(FEE);
    });

    it("rejects a caller the authorizer does not vouch for", async () => {
      const f = await loadFixture(deploy);
      await expect(
        f.router
          .connect(f.outsider)
          .routeSpend(REMOTE_SELECTOR, f.provider.address, 1n, apt("1"), usd(1)),
      )
        .to.be.revertedWithCustomError(f.router, "NotAuthorizedWallet")
        .withArgs(f.outsider.address);
    });

    it("rejects a zero provider or zero amount", async () => {
      const f = await loadFixture(deploy);
      await expect(
        f.router
          .connect(f.walletSigner)
          .routeSpend(REMOTE_SELECTOR, ethers.ZeroAddress, 1n, apt("1"), usd(1)),
      ).to.be.revertedWithCustomError(f.router, "ZeroAddress");
      await expect(
        f.router
          .connect(f.walletSigner)
          .routeSpend(REMOTE_SELECTOR, f.provider.address, 1n, 0n, usd(1)),
      ).to.be.revertedWithCustomError(f.router, "ZeroAmount");
    });

    it("rejects a lane that has not been opened", async () => {
      const f = await loadFixture(deploy);
      await expect(
        f.router
          .connect(f.walletSigner)
          .routeSpend(999n, f.provider.address, 1n, apt("1"), usd(1)),
      )
        .to.be.revertedWithCustomError(f.router, "LaneNotOpen")
        .withArgs(999n);
    });

    it("reverts when the router cannot cover the CCIP fee", async () => {
      const f = await loadFixture(deploy);
      // Drain the fee budget.
      const bal = await ethers.provider.getBalance(await f.router.getAddress());
      await f.router.connect(f.owner).withdrawNative(f.owner.address, bal);
      await f.token
        .connect(f.walletSigner)
        .transfer(await f.router.getAddress(), apt("1"));
      await expect(
        f.router
          .connect(f.walletSigner)
          .routeSpend(REMOTE_SELECTOR, f.provider.address, 1n, apt("1"), usd(1)),
      ).to.be.revertedWithCustomError(f.router, "InsufficientNativeForFee");
    });

    it("quotes the native fee for a prospective spend", async () => {
      const f = await loadFixture(deploy);
      expect(
        await f.router.quoteSpendFee(
          REMOTE_SELECTOR,
          f.provider.address,
          1n,
          apt("1"),
          usd(1),
        ),
      ).to.equal(FEE);
      await expect(
        f.router.quoteSpendFee(999n, f.provider.address, 1n, apt("1"), usd(1)),
      ).to.be.revertedWithCustomError(f.router, "LaneNotOpen");
    });
  });

  describe("ccipReceive (receiver side)", () => {
    // Produce a genuine payload by sending one, then replay it inbound.
    async function captured(f: any) {
      await sendSpend(f, apt("5"));
      const sent = await f.ccip.lastSent();
      return { messageId: sent.messageId, data: sent.data };
    }

    async function allowInbound(f: any, sender: string) {
      await f.router.connect(f.owner).setAllowlistedSourceChain(HOME_SELECTOR, true);
      await f.router.connect(f.owner).setAllowlistedSender(HOME_SELECTOR, sender, true);
    }

    it("credits the provider in the local escrow from router liquidity", async () => {
      const f = await loadFixture(deploy);
      const { messageId, data } = await captured(f);
      await allowInbound(f, f.remoteRouter.address);

      // The router already holds the 5 APT locked by the send; that is its
      // liquidity for this test.
      await expect(
        f.ccip.deliver(
          await f.router.getAddress(),
          messageId,
          HOME_SELECTOR,
          f.remoteRouter.address,
          data,
        ),
      ).to.emit(f.router, "CrossChainSpendReceived");

      expect(await f.escrow.withdrawable(f.provider.address)).to.equal(apt("5"));
      expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(apt("5"));
    });

    it("only the local CCIP router may deliver", async () => {
      const f = await loadFixture(deploy);
      const { data } = await captured(f);
      await allowInbound(f, f.remoteRouter.address);
      const message = {
        messageId: ethers.ZeroHash,
        sourceChainSelector: HOME_SELECTOR,
        sender: ethers.AbiCoder.defaultAbiCoder().encode(
          ["address"],
          [f.remoteRouter.address],
        ),
        data,
        destTokenAmounts: [],
      };
      await expect(f.router.connect(f.outsider).ccipReceive(message))
        .to.be.revertedWithCustomError(f.router, "OnlyCcipRouter")
        .withArgs(f.outsider.address);
    });

    it("rejects a non-allowlisted source chain", async () => {
      const f = await loadFixture(deploy);
      const { messageId, data } = await captured(f);
      // Source chain never allowlisted.
      await expect(
        f.ccip.deliver(
          await f.router.getAddress(),
          messageId,
          HOME_SELECTOR,
          f.remoteRouter.address,
          data,
        ),
      )
        .to.be.revertedWithCustomError(f.router, "SourceChainNotAllowlisted")
        .withArgs(HOME_SELECTOR);
    });

    it("rejects an allowlisted chain but non-allowlisted sender", async () => {
      const f = await loadFixture(deploy);
      const { messageId, data } = await captured(f);
      await f.router.connect(f.owner).setAllowlistedSourceChain(HOME_SELECTOR, true);
      // Sender NOT allowlisted.
      await expect(
        f.ccip.deliver(
          await f.router.getAddress(),
          messageId,
          HOME_SELECTOR,
          f.outsider.address,
          data,
        ),
      )
        .to.be.revertedWithCustomError(f.router, "SenderNotAllowlisted")
        .withArgs(HOME_SELECTOR, f.outsider.address);
    });

    it("reverts when remote liquidity is insufficient", async () => {
      const f = await loadFixture(deploy);
      const { messageId, data } = await captured(f);
      await allowInbound(f, f.remoteRouter.address);
      // Drain the router's APT so it cannot settle.
      await f.router
        .connect(f.owner)
        .rescueLockedTokens(f.owner.address, apt("5"));
      await expect(
        f.ccip.deliver(
          await f.router.getAddress(),
          messageId,
          HOME_SELECTOR,
          f.remoteRouter.address,
          data,
        ),
      ).to.be.revertedWithCustomError(f.router, "InsufficientLiquidity");
    });
  });

  describe("admin", () => {
    it("restricts every configuration setter to the owner", async () => {
      const f = await loadFixture(deploy);
      const r = f.router.connect(f.outsider);
      await expect(
        r.setDestinationRouter(REMOTE_SELECTOR, f.outsider.address),
      ).to.be.revertedWithCustomError(f.router, "OwnableUnauthorizedAccount");
      await expect(r.setDestGasLimit(1)).to.be.revertedWithCustomError(
        f.router,
        "OwnableUnauthorizedAccount",
      );
      await expect(
        r.setAllowlistedSourceChain(HOME_SELECTOR, true),
      ).to.be.revertedWithCustomError(f.router, "OwnableUnauthorizedAccount");
      await expect(
        r.setAllowlistedSender(HOME_SELECTOR, f.outsider.address, true),
      ).to.be.revertedWithCustomError(f.router, "OwnableUnauthorizedAccount");
      await expect(
        r.withdrawNative(f.outsider.address, 1n),
      ).to.be.revertedWithCustomError(f.router, "OwnableUnauthorizedAccount");
      await expect(
        r.rescueLockedTokens(f.outsider.address, 1n),
      ).to.be.revertedWithCustomError(f.router, "OwnableUnauthorizedAccount");
    });

    it("emits configuration events and applies them", async () => {
      const f = await loadFixture(deploy);
      await expect(f.router.connect(f.owner).setDestGasLimit(500_000))
        .to.emit(f.router, "DestGasLimitSet")
        .withArgs(500_000);
      expect(await f.router.destGasLimit()).to.equal(500_000n);

      await expect(
        f.router.connect(f.owner).setAllowlistedSourceChain(HOME_SELECTOR, true),
      )
        .to.emit(f.router, "SourceChainAllowlisted")
        .withArgs(HOME_SELECTOR, true);
      expect(await f.router.allowlistedSourceChains(HOME_SELECTOR)).to.equal(true);

      await expect(
        f.router
          .connect(f.owner)
          .setAllowlistedSender(HOME_SELECTOR, f.remoteRouter.address, true),
      )
        .to.emit(f.router, "SenderAllowlisted")
        .withArgs(HOME_SELECTOR, f.remoteRouter.address, true);
      expect(
        await f.router.allowlistedSenders(HOME_SELECTOR, f.remoteRouter.address),
      ).to.equal(true);

      await expect(
        f.router.connect(f.owner).setDestinationRouter(5n, f.remoteRouter.address),
      )
        .to.emit(f.router, "DestinationRouterSet")
        .withArgs(5n, f.remoteRouter.address);
    });

    it("accepts native funding via fundNative and plain transfer", async () => {
      const f = await loadFixture(deploy);
      const addr = await f.router.getAddress();
      const before = await ethers.provider.getBalance(addr);
      await expect(f.router.connect(f.deployer).fundNative({ value: 100n }))
        .to.emit(f.router, "NativeFunded")
        .withArgs(f.deployer.address, 100n);
      await expect(
        f.deployer.sendTransaction({ to: addr, value: 50n }),
      ).to.emit(f.router, "NativeFunded");
      expect(await ethers.provider.getBalance(addr)).to.equal(before + 150n);
    });

    it("lets the owner recover native and locked APT", async () => {
      const f = await loadFixture(deploy);
      await sendSpend(f, apt("5"));
      await expect(
        f.router.connect(f.owner).rescueLockedTokens(f.owner.address, apt("5")),
      )
        .to.emit(f.router, "LockedTokensRescued")
        .withArgs(f.owner.address, apt("5"));
      expect(await f.token.balanceOf(f.owner.address)).to.equal(apt("5"));

      await expect(
        f.router.connect(f.owner).withdrawNative(f.owner.address, 1n),
      ).to.emit(f.router, "NativeWithdrawn");
      await expect(
        f.router.connect(f.owner).withdrawNative(ethers.ZeroAddress, 1n),
      ).to.be.revertedWithCustomError(f.router, "ZeroAddress");
      await expect(
        f.router.connect(f.owner).rescueLockedTokens(ethers.ZeroAddress, 1n),
      ).to.be.revertedWithCustomError(f.router, "ZeroAddress");
    });
  });
});
