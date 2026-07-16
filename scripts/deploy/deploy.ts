import { ethers, network } from "hardhat";
import { getConfig } from "../../config/networks";
import {
  loadDeployments,
  existing,
  record,
  DeploymentFile,
} from "../util/deployments";

// Idempotent, network-aware deployment of the full AgentPay stack. Re-running
// reuses everything already recorded in deployments/<network>.json and deploys
// only what is missing, so a crash mid-run is resumable.
//
//   npx hardhat run scripts/deploy/deploy.ts --network sepolia
//   npx hardhat run scripts/deploy/deploy.ts --network localhost

async function main() {
  const cfg = getConfig(network.name);
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const data = loadDeployments(network.name, chainId);

  console.log(`\n== Deploying AgentPay to ${cfg.label} (chainId ${chainId}) ==`);
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

  // 4. Service registry.
  const registry = await deployOnce("ServiceRegistry", "ServiceRegistry", []);

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

  // 8+9. Escrow and factory are mutually dependent (escrow needs the factory as
  // its wallet-authorizer; the factory needs the escrow). Deploy them as a pair,
  // predicting the factory's CREATE address so the escrow can reference it.
  let escrow = existing(data, "SettlementEscrow");
  let factory = existing(data, "AgentWalletFactory");
  if (!escrow || !factory) {
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const predictedFactory = ethers.getCreateAddress({
      from: deployer.address,
      nonce: nonce + 1, // escrow at `nonce`, factory at `nonce + 1`
    });
    escrow = await deployOnce("SettlementEscrow", "SettlementEscrow", [
      token,
      governor,
      predictedFactory,
      timelock, // owner = timelock (reserved admin role)
    ]);
    factory = await deployOnce("AgentWalletFactory", "AgentWalletFactory", [
      token,
      governor,
      priceFeed,
      registry,
      staking,
      escrow,
      cfg.external.chainSelector,
    ]);
    if (factory.toLowerCase() !== predictedFactory.toLowerCase()) {
      throw new Error(
        `Factory address mismatch: predicted ${predictedFactory}, got ${factory}. ` +
          `Clear deployments/${network.name}.json and redeploy escrow+factory together.`,
      );
    }
  } else {
    console.log(`= SettlementEscrow (reused) ${escrow}`);
    console.log(`= AgentWalletFactory (reused) ${factory}`);
  }

  // --- Wiring (idempotent) ---
  await wireTimelock(timelock, governor, deployer.address);
  await handStakingToTimelock(staking, timelock);

  console.log(`\nSaved deployments/${network.name}.json`);
  printSummary(data);
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
