import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine, time } from "@nomicfoundation/hardhat-network-helpers";

// ===========================================================================
// THE SIGNATURE TEST (build brief §7 / §10 step 5).
//
// A passed governance proposal changes system-wide behavior with NO REDEPLOY and
// NO MIGRATION: the very same AgentWallet.spend() that reverts on a per-tx cap
// check SUCCEEDS after the DAO raises the cap, because the wallet re-reads the
// live IPolicyParameters (the PolicyGovernor) on the next call. This is the
// architectural centerpiece inherited from the Module 7 midterm.
// ===========================================================================

const usd = (d: number) => BigInt(Math.round(d * 1e8));
const apt = (n: string) => ethers.parseEther(n);

const ETH_USD = 3000n * 10n ** 8n;
const APT_PER_ETH = 3000n; // APT = $1
const SELECTOR = 1n;

const VOTING_DELAY = 1n; // blocks
const VOTING_PERIOD = 10n; // blocks
const TIMELOCK_DELAY = 60n; // seconds

describe("Integration: governance (live parameter store)", () => {
  async function deploy() {
    const [deployer, voter, owner, agent, provider, treasury] =
      await ethers.getSigners();

    // --- Token; give the voter the whole supply and self-delegate voting power ---
    const Token = await ethers.getContractFactory("AgentPayToken");
    const token = await Token.deploy(apt("1000000"), voter.address);
    await token.connect(voter).delegate(voter.address);

    // --- Timelock + PolicyGovernor ---
    const Timelock = await ethers.getContractFactory("TimelockController");
    const timelock = await Timelock.deploy(TIMELOCK_DELAY, [], [], deployer.address);

    const Governor = await ethers.getContractFactory("PolicyGovernor");
    const governor = await Governor.deploy(
      await token.getAddress(),
      await timelock.getAddress(),
      VOTING_DELAY,
      VOTING_PERIOD,
      0n, // proposal threshold
      4n, // quorum %
      {
        maxPerTxUsd: usd(0.1), // deliberately LOW: a $0.50 spend will fail
        defaultDailyBudgetUsd: usd(100),
        slashBps: 1000n,
        disputeWindow: 0n, // immediate escrow settlement for a simpler assertion
        treasury: treasury.address,
        providerMinStake: apt("100"),
      },
    );

    // Wire timelock roles: governor proposes/cancels; anyone executes.
    const PROPOSER = await timelock.PROPOSER_ROLE();
    const CANCELLER = await timelock.CANCELLER_ROLE();
    const EXECUTOR = await timelock.EXECUTOR_ROLE();
    await timelock.grantRole(PROPOSER, await governor.getAddress());
    await timelock.grantRole(CANCELLER, await governor.getAddress());
    await timelock.grantRole(EXECUTOR, ethers.ZeroAddress);

    // --- Platform stack, using the GOVERNOR as the live IPolicyParameters ---
    const Feed = await ethers.getContractFactory("MockV3Aggregator");
    const feed = await Feed.deploy(8, ETH_USD);
    const Adapter = await ethers.getContractFactory("PriceFeedAdapter");
    const priceFeed = await Adapter.deploy(await feed.getAddress(), 3600, APT_PER_ETH);

    const Registry = await ethers.getContractFactory("ServiceRegistry");
    const registry = await Registry.deploy();

    // Staking is owned by the TIMELOCK, so slashing is possible only via a
    // passed proposal.
    const Staking = await ethers.getContractFactory("ProviderStaking");
    const staking = await Staking.deploy(
      await token.getAddress(),
      await governor.getAddress(),
      await timelock.getAddress(),
    );

    // Break the escrow<->factory constructor cycle via CREATE-address prediction.
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const predictedFactory = ethers.getCreateAddress({
      from: deployer.address,
      nonce: nonce + 1,
    });
    const Escrow = await ethers.getContractFactory("SettlementEscrow");
    const escrow = await Escrow.deploy(
      await token.getAddress(),
      await governor.getAddress(),
      predictedFactory,
      await timelock.getAddress(),
    );
    const Factory = await ethers.getContractFactory("AgentWalletFactory");
    const factory = await Factory.deploy(
      await token.getAddress(),
      await governor.getAddress(),
      await priceFeed.getAddress(),
      await registry.getAddress(),
      await staking.getAddress(),
      await escrow.getAddress(),
      SELECTOR,
    );

    // Create a wallet, register a $0.50 service, stake the provider, fund + allow.
    const tx = await factory.createWallet(owner.address, agent.address);
    const rcpt = await tx.wait();
    const walletAddr = rcpt!.logs
      .map((l) => {
        try {
          return factory.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "WalletCreated")!.args.wallet as string;
    const wallet = await ethers.getContractAt("AgentWallet", walletAddr);

    await registry
      .connect(provider)
      .registerService(50, ethers.keccak256(ethers.toUtf8Bytes("t")), "ipfs://s", SELECTOR);
    await token.connect(voter).transfer(provider.address, apt("1000"));
    await token.connect(provider).approve(await staking.getAddress(), ethers.MaxUint256);
    await staking.connect(provider).stake(apt("100"));
    await token.connect(voter).transfer(walletAddr, apt("1000"));
    await wallet.connect(owner).setServiceAllowed(1n, true);

    return {
      token, timelock, governor, feed, priceFeed, registry, staking, escrow,
      factory, wallet, deployer, voter, owner, agent, provider, treasury,
    };
  }

  // Run a (possibly multi-action) proposal through the full lifecycle & execute.
  async function passActions(
    f: Awaited<ReturnType<typeof deploy>>,
    targets: string[],
    calldatas: string[],
    description: string,
  ) {
    const values = targets.map(() => 0n);
    const descHash = ethers.id(description);

    await f.governor.connect(f.voter).propose(targets, values, calldatas, description);
    const proposalId = await f.governor.hashProposal(targets, values, calldatas, descHash);

    await mine(VOTING_DELAY + 1n);
    await f.governor.connect(f.voter).castVote(proposalId, 1); // 1 = For
    await mine(VOTING_PERIOD + 1n);

    await f.governor.queue(targets, values, calldatas, descHash);
    await time.increase(TIMELOCK_DELAY + 1n);
    await f.governor.execute(targets, values, calldatas, descHash);
    return proposalId;
  }

  // Single-action convenience wrapper.
  function passProposal(
    f: Awaited<ReturnType<typeof deploy>>,
    target: string,
    calldata: string,
    description: string,
  ) {
    return passActions(f, [target], [calldata], description);
  }

  it("SIGNATURE: a passed proposal raises the cap and the same spend now succeeds — no redeploy", async () => {
    const f = await loadFixture(deploy);

    // Before: the $0.50 service exceeds the $0.10 global per-tx cap.
    await expect(f.wallet.connect(f.agent).spend(1n))
      .to.be.revertedWithCustomError(f.wallet, "ExceedsPerTxCap")
      .withArgs(usd(0.5), usd(0.1));

    // Governance raises maxPerTxUsd to $1.00.
    const calldata = f.governor.interface.encodeFunctionData("setMaxPerTxUsd", [
      usd(1),
    ]);
    await passProposal(f, await f.governor.getAddress(), calldata, "raise cap to $1");

    expect(await f.governor.maxPerTxUsd()).to.equal(usd(1));

    // After: the EXACT SAME wallet (no redeploy) now succeeds.
    await expect(f.wallet.connect(f.agent).spend(1n)).to.emit(
      f.wallet,
      "SpendExecuted",
    );
  });

  it("governance can globally pause and unpause all agent spends", async () => {
    const f = await loadFixture(deploy);
    // Raise the cap first so the only thing under test is the pause.
    await passProposal(
      f,
      await f.governor.getAddress(),
      f.governor.interface.encodeFunctionData("setMaxPerTxUsd", [usd(1)]),
      "raise cap",
    );
    await expect(f.wallet.connect(f.agent).spend(1n)).to.emit(f.wallet, "SpendExecuted");

    // Pause via governance -> spends halt.
    await passProposal(
      f,
      await f.governor.getAddress(),
      f.governor.interface.encodeFunctionData("setGlobalPause", [true]),
      "pause",
    );
    expect(await f.governor.globalPause()).to.equal(true);
    await expect(
      f.wallet.connect(f.agent).spend(1n),
    ).to.be.revertedWithCustomError(f.wallet, "Paused");

    // Unpause via governance -> spends resume.
    await passProposal(
      f,
      await f.governor.getAddress(),
      f.governor.interface.encodeFunctionData("setGlobalPause", [false]),
      "unpause",
    );
    await expect(f.wallet.connect(f.agent).spend(1n)).to.emit(f.wallet, "SpendExecuted");
  });

  it("every risk parameter is DAO-mutable in a single multi-action proposal", async () => {
    const f = await loadFixture(deploy);
    const gov = await f.governor.getAddress();
    const iface = f.governor.interface;
    const [, , , , , , newTreasury] = await ethers.getSigners();

    await passActions(
      f,
      [gov, gov, gov, gov, gov],
      [
        iface.encodeFunctionData("setDefaultDailyBudgetUsd", [usd(50)]),
        iface.encodeFunctionData("setSlashBps", [2000n]),
        iface.encodeFunctionData("setDisputeWindow", [7200n]),
        iface.encodeFunctionData("setTreasury", [newTreasury.address]),
        iface.encodeFunctionData("setProviderMinStake", [apt("200")]),
      ],
      "retune all risk parameters",
    );

    expect(await f.governor.defaultDailyBudgetUsd()).to.equal(usd(50));
    expect(await f.governor.slashBps()).to.equal(2000n);
    expect(await f.governor.disputeWindow()).to.equal(7200n);
    expect(await f.governor.treasury()).to.equal(newTreasury.address);
    expect(await f.governor.providerMinStake()).to.equal(apt("200"));
  });

  it("a proposer can cancel a pending proposal", async () => {
    const f = await loadFixture(deploy);
    const targets = [await f.governor.getAddress()];
    const values = [0n];
    const calldatas = [
      f.governor.interface.encodeFunctionData("setMaxPerTxUsd", [usd(1)]),
    ];
    const description = "cancel me";
    const descHash = ethers.id(description);

    await f.governor.connect(f.voter).propose(targets, values, calldatas, description);
    const proposalId = await f.governor.hashProposal(
      targets,
      values,
      calldatas,
      descHash,
    );
    // A timelock-controlled proposal needs queuing before execution.
    expect(await f.governor.proposalNeedsQueuing(proposalId)).to.equal(true);
    await f.governor.connect(f.voter).cancel(targets, values, calldatas, descHash);
    // 2 == Canceled in OZ Governor's ProposalState enum.
    expect(await f.governor.state(proposalId)).to.equal(2);
  });

  it("governance can slash a provider's stake (slashing is DAO-only)", async () => {
    const f = await loadFixture(deploy);
    // Direct slash is impossible: staking is owned by the timelock.
    await expect(
      f.staking.connect(f.deployer).slash(f.provider.address),
    ).to.be.revertedWithCustomError(f.staking, "OwnableUnauthorizedAccount");

    const before = await f.token.balanceOf(f.treasury.address);
    await passProposal(
      f,
      await f.staking.getAddress(),
      f.staking.interface.encodeFunctionData("slash", [f.provider.address]),
      "slash provider",
    );
    // 10% of 100 APT to the treasury.
    expect(await f.token.balanceOf(f.treasury.address)).to.equal(
      before + apt("10"),
    );
    expect(await f.staking.stakedOf(f.provider.address)).to.equal(apt("90"));
  });
});
