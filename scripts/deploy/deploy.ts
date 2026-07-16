import { ethers, network } from "hardhat";
import { getConfig } from "../../config/networks";
import {
  loadDeployments,
  existing,
  record,
  DeploymentFile,
} from "../util/deployments";

// Idempotent, network-aware deployment of the AgentPay stack. Re-running reuses
// everything already recorded in deployments/<network>.json and deploys only what
// is missing, so a crash mid-run is resumable.
//
// The shape depends on the network's role (config/networks.ts):
//   home   — full stack: token, oracle, registry, DAO, staking, escrow, factory,
//            cross-chain router. Agent wallets and governance live here.
//   remote — settlement only: token, oracle, registry, mirrored parameters,
//            escrow, allowlist authorizer, cross-chain router.
//
//   npx hardhat run scripts/deploy/deploy.ts --network sepolia      # home
//   npx hardhat run scripts/deploy/deploy.ts --network baseSepolia  # remote
//   npx hardhat run scripts/deploy/deploy.ts --network localhost    # home (mock feed)
//
// After BOTH sides are deployed, open the lane with scripts/deploy/wire-lane.ts.

async function main() {
  const cfg = getConfig(network.name);
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const data = loadDeployments(network.name, chainId);

  console.log(`\n== Deploying AgentPay to ${cfg.label} (chainId ${chainId}) ==`);
  console.log(`Role:     ${cfg.role}`);
  console.log(`Deployer: ${deployer.address}`);
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:  ${ethers.formatEther(bal)} ETH\n`);

  // Deploy `name` if not already recorded; otherwise reuse. Returns the address.
  async function deployOnce(
    name: string,
    contractName: string,
    args: unknown[],
  ): Promise<string> {
    const prior = existing(data, name);
    if (prior) {
      console.log(`= ${name} (reused) ${prior}`);
      return prior;
    }
    const factory = await ethers.getContractFactory(contractName);
    const c = await factory.deploy(...(args as never[]));
    await c.waitForDeployment();
    const address = await c.getAddress();
    const tx = c.deploymentTransaction();
    record(data, name, address, {
      txHash: tx?.hash,
      blockNumber: tx?.blockNumber ?? undefined,
      args, // BigInts (incl. nested struct args) are serialized by saveDeployments
    });
    console.log(`+ ${name} deployed ${address}  (tx ${tx?.hash})`);
    return address;
  }

  // 1. Token (fixed supply to deployer).
  const token = await deployOnce("AgentPayToken", "AgentPayToken", [
    cfg.initialSupply,
    deployer.address,
  ]);

  // 2. Price feed source: real Chainlink aggregator, or a mock on local networks.
  let feed = cfg.external.ethUsdFeed;
  if (!feed) {
    feed = await deployOnce("MockV3Aggregator", "MockV3Aggregator", [
      8,
      cfg.mockInitialEthUsd,
    ]);
  } else {
    console.log(`= ETH/USD feed (external) ${feed}`);
  }

  // 3. Price adapter.
  const priceFeed = await deployOnce("PriceFeedAdapter", "PriceFeedAdapter", [
    feed,
    cfg.maxStaleness,
    cfg.aptPerEth,
  ]);

  // 4. Service registry (on BOTH chains: the catalog is multi-chain).
  const registry = await deployOnce("ServiceRegistry", "ServiceRegistry", []);

  // ---------------- REMOTE-CHAIN STACK ----------------
  // A settlement counterparty: no DAO, no staking, no agent wallets. Those live
  // on the home chain, which is where every policy check runs.
  if (cfg.role === "remote") {
    const remotePolicy = await deployOnce(
      "RemotePolicyParameters",
      "RemotePolicyParameters",
      [
        deployer.address,
        cfg.policy.maxPerTxUsd,
        cfg.policy.defaultDailyBudgetUsd,
        cfg.policy.slashBps,
        cfg.policy.disputeWindow,
        deployer.address, // treasury
        cfg.policy.providerMinStake,
      ],
    );

    const remoteEscrow = await deployOnce("SettlementEscrow", "SettlementEscrow", [
      token,
      remotePolicy,
      deployer.address,
    ]);

    if (!cfg.external.ccipRouter) {
      throw new Error(`${cfg.label} is a remote chain but has no CCIP router configured.`);
    }
    const remoteRouter = await deployOnce(
      "CrossChainSpendRouter",
      "CrossChainSpendRouter",
      [token, cfg.external.ccipRouter, remoteEscrow, deployer.address],
    );

    // No factory here, so an explicit allowlist vouches for the router as the
    // escrow's only authorized payer.
    const allow = await deployOnce("AllowlistAuthorizer", "AllowlistAuthorizer", [
      deployer.address,
    ]);
    const allowC = await ethers.getContractAt("AllowlistAuthorizer", allow);
    if (!(await allowC.isWallet(remoteRouter))) {
      await (await allowC.setAuthorized(remoteRouter, true)).wait();
      console.log("~ AllowlistAuthorizer: authorized the router as escrow payer");
    }
    await setAuthorizerOnce("SettlementEscrow", remoteEscrow, allow);

    console.log(`\nSaved deployments/${network.name}.json`);
    printSummary(data);
    console.log(
      "\nNext: deploy the home chain, then run scripts/deploy/wire-lane.ts on BOTH networks.",
    );
    return;
  }

  // ---------------- HOME-CHAIN STACK ----------------

  // 5. Timelock (deployer is temporary admin; proposer/executor granted below).
  const timelock = await deployOnce("TimelockController", "TimelockController", [
    cfg.governance.timelockMinDelaySeconds,
    [],
    [],
    deployer.address,
  ]);

  // 6. Governor + live parameter store (treasury defaults to the deployer).
  const governor = await deployOnce("PolicyGovernor", "PolicyGovernor", [
    token,
    timelock,
    cfg.governance.votingDelayBlocks,
    cfg.governance.votingPeriodBlocks,
    cfg.governance.proposalThresholdVotes,
    cfg.governance.quorumPercent,
    {
      maxPerTxUsd: cfg.policy.maxPerTxUsd,
      defaultDailyBudgetUsd: cfg.policy.defaultDailyBudgetUsd,
      slashBps: cfg.policy.slashBps,
      disputeWindow: cfg.policy.disputeWindow,
      treasury: deployer.address,
      providerMinStake: cfg.policy.providerMinStake,
    },
  ]);

  // 7. Staking (owner = deployer initially; ownership handed to the timelock below).
  const staking = await deployOnce("ProviderStaking", "ProviderStaking", [
    token,
    governor,
    deployer.address,
  ]);

  // 8. Escrow. Owned by the deployer just long enough to set its authorizer
  //    (a one-time initializer); it exposes no live admin lever afterwards.
  const escrow = await deployOnce("SettlementEscrow", "SettlementEscrow", [
    token,
    governor,
    deployer.address,
  ]);

  // 9. Cross-chain router (M6). Only deployed where a CCIP router exists; on a
  //    chain without one, wallets are created with cross-chain disabled.
  let router = ethers.ZeroAddress;
  if (cfg.external.ccipRouter) {
    router = await deployOnce("CrossChainSpendRouter", "CrossChainSpendRouter", [
      token,
      cfg.external.ccipRouter,
      escrow,
      deployer.address,
    ]);
  } else {
    console.log("= CrossChainSpendRouter (skipped: no CCIP router on this network)");
  }

  // 10. Factory. Escrow<->factory and router<->factory are mutually dependent;
  //     the one-time setAuthorizer on each breaks both cycles, so deployment is a
  //     straight line with no CREATE-address prediction.
  const factory = await deployOnce("AgentWalletFactory", "AgentWalletFactory", [
    token,
    governor,
    priceFeed,
    registry,
    staking,
    escrow,
    cfg.external.chainSelector,
    router,
  ]);

  // --- Wiring (idempotent) ---
  await setAuthorizerOnce("SettlementEscrow", escrow, factory);
  if (router !== ethers.ZeroAddress) {
    await setAuthorizerOnce("CrossChainSpendRouter", router, factory);
  }
  await wireTimelock(timelock, governor, deployer.address);
  await handStakingToTimelock(staking, timelock);

  console.log(`\nSaved deployments/${network.name}.json`);
  printSummary(data);
}

/// Set a one-time authorizer if it is not already set (keeps re-runs idempotent).
async function setAuthorizerOnce(
  label: string,
  target: string,
  authorizer: string,
) {
  // Both SettlementEscrow and CrossChainSpendRouter expose the same shape.
  const c = await ethers.getContractAt("SettlementEscrow", target);
  const current = await c.authorizer();
  if (current === ethers.ZeroAddress) {
    await (await c.setAuthorizer(authorizer)).wait();
    console.log(`~ ${label}.setAuthorizer(factory)`);
  } else if (current.toLowerCase() !== authorizer.toLowerCase()) {
    throw new Error(
      `${label} authorizer is ${current}, expected ${authorizer}. ` +
        `It is set once and immutable — redeploy ${label} to change it.`,
    );
  }
}

async function wireTimelock(
  timelockAddr: string,
  governorAddr: string,
  deployerAddr: string,
) {
  const timelock = await ethers.getContractAt("TimelockController", timelockAddr);
  const PROPOSER = await timelock.PROPOSER_ROLE();
  const CANCELLER = await timelock.CANCELLER_ROLE();
  const EXECUTOR = await timelock.EXECUTOR_ROLE();

  if (!(await timelock.hasRole(PROPOSER, governorAddr))) {
    await (await timelock.grantRole(PROPOSER, governorAddr)).wait();
    console.log("~ granted PROPOSER_ROLE to governor");
  }
  if (!(await timelock.hasRole(CANCELLER, governorAddr))) {
    await (await timelock.grantRole(CANCELLER, governorAddr)).wait();
    console.log("~ granted CANCELLER_ROLE to governor");
  }
  // Open execution: anyone may execute a queued, matured proposal.
  if (!(await timelock.hasRole(EXECUTOR, ethers.ZeroAddress))) {
    await (await timelock.grantRole(EXECUTOR, ethers.ZeroAddress)).wait();
    console.log("~ granted EXECUTOR_ROLE to anyone");
  }
  // NOTE: the deployer keeps TIMELOCK_ADMIN_ROLE so the testnet demo can recover
  // from a role misconfiguration. A production deployment would renounce it here
  // to make governance the sole authority (documented in SECURITY_NOTES.md).
  void deployerAddr;
}

async function handStakingToTimelock(stakingAddr: string, timelockAddr: string) {
  const staking = await ethers.getContractAt("ProviderStaking", stakingAddr);
  const owner = await staking.owner();
  if (owner.toLowerCase() !== timelockAddr.toLowerCase()) {
    await (await staking.transferOwnership(timelockAddr)).wait();
    console.log("~ transferred ProviderStaking ownership to the timelock (DAO-only slashing)");
  }
}

function printSummary(data: DeploymentFile) {
  console.log(`\n| Contract | Address |`);
  console.log(`|---|---|`);
  for (const [name, e] of Object.entries(data.contracts)) {
    console.log(`| ${name} | \`${e.address}\` |`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
