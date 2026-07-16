import { ethers, network } from "hardhat";
import { execFileSync } from "child_process";
import * as path from "path";
import { existing, loadDeployments } from "../util/deployments";
import * as fs from "fs";

// The complete demo from the build brief, section 10, end to end:
//
//   1. Provider registers an inference service and stakes APT.
//   2. Agent wallet funded; owner sets the allowlist and a $5/day budget.
//   3. `agent quote` -> the model picks a service; `agent spend` -> payment lands,
//      provider-sim verifies it on-chain and serves the inference.
//   4. A second spend exceeds the daily budget -> on-chain ExceedsDailyBudget.
//   5. A governance proposal raises maxPerTxUsd -> the SAME spend that failed a
//      cap check now succeeds. No redeploy. This is the centerpiece.
//   6. Global pause via governance -> every spend halts. Unpause.
//   7. `agent audit` rebuilds the spend log from events.
//
//   npx hardhat run scripts/demo/full-demo.ts --network localhost
//
// Steps 3 and 7 shell out to the real agent CLI, so this script proves the CLI
// works rather than reimplementing it. Governance timing is fast-forwarded on
// local networks; on a live testnet the script waits out the real windows.

const USD = (d: number) => BigInt(Math.round(d * 1e8));
const APT = (n: string) => ethers.parseEther(n);

const CHEAP_PRICE_CENTS = 50n; // $0.50 inference service
const MIDSIZE_PRICE_CENTS = 500n; // $5.00 — trips the $5/day budget
const PREMIUM_PRICE_CENTS = 2000n; // $20.00 — trips the $10 global per-tx cap

const AGENT_DIR = path.join(__dirname, "..", "..", "agent");

function isLocal() {
  return network.name === "localhost" || network.name === "hardhat";
}

function banner(n: number, title: string) {
  console.log(`\n${"=".repeat(72)}\n  STEP ${n}. ${title}\n${"=".repeat(72)}`);
}

/** Run the real agent CLI, streaming its output into the demo transcript. */
function agent(args: string[]) {
  console.log(`\n$ agent ${args.join(" ")}\n`);
  execFileSync("npx", ["tsx", "src/cli.ts", ...args], {
    cwd: AGENT_DIR,
    stdio: "inherit",
    env: { ...process.env, AGENTPAY_NETWORK: network.name },
  });
}

async function mineBlocks(n: bigint) {
  for (let i = 0n; i < n; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}

async function advanceTime(seconds: number) {
  if (isLocal()) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  } else {
    console.log(`  (waiting ${seconds}s for the real timelock...)`);
    await new Promise((r) => setTimeout(r, seconds * 1000 + 5000));
  }
}

/** Drive a proposal through the full DAO lifecycle: propose -> vote -> queue -> execute. */
async function passProposal(
  governor: any,
  timelock: any,
  proposer: any,
  target: string,
  calldata: string,
  description: string,
) {
  const descHash = ethers.id(description);
  console.log(`  proposing: ${description}`);
  await (
    await governor.connect(proposer).propose([target], [0], [calldata], description)
  ).wait();
  const proposalId = await governor.hashProposal([target], [0], [calldata], descHash);

  const votingDelay: bigint = await governor.votingDelay();
  if (isLocal()) await mineBlocks(votingDelay + 1n);

  console.log(`  voting FOR (weight = delegated APT)`);
  await (await governor.connect(proposer).castVote(proposalId, 1)).wait();

  const votingPeriod: bigint = await governor.votingPeriod();
  if (isLocal()) await mineBlocks(votingPeriod + 1n);

  console.log(`  queueing into the timelock`);
  await (await governor.queue([target], [0], [calldata], descHash)).wait();

  const minDelay: bigint = await timelock.getMinDelay();
  await advanceTime(Number(minDelay) + 1);

  console.log(`  executing`);
  await (await governor.execute([target], [0], [calldata], descHash)).wait();
  console.log(`  proposal executed.`);
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const data = loadDeployments(network.name, chainId);
  const need = (name: string) => {
    const a = existing(data, name);
    if (!a) throw new Error(`${name} not deployed. Run scripts/deploy/deploy.ts first.`);
    return a;
  };

  const signers = await ethers.getSigners();
  const deployer = signers[0];
  // On a testnet there is only one key; locally, use distinct actors so the
  // owner/agent/provider role split is visible.
  const provider = signers[1] ?? deployer;
  const owner = signers[2] ?? deployer;
  const agentOperator = signers[3] ?? deployer;

  const token = await ethers.getContractAt("AgentPayToken", need("AgentPayToken"));
  const registry = await ethers.getContractAt("ServiceRegistry", need("ServiceRegistry"));
  const staking = await ethers.getContractAt("ProviderStaking", need("ProviderStaking"));
  const factory = await ethers.getContractAt("AgentWalletFactory", need("AgentWalletFactory"));
  const governor = await ethers.getContractAt("PolicyGovernor", need("PolicyGovernor"));
  const timelock = await ethers.getContractAt("TimelockController", need("TimelockController"));

  console.log(`\n${"#".repeat(72)}`);
  console.log(`  AgentPay — full demo on ${network.name} (chainId ${chainId})`);
  console.log(`${"#".repeat(72)}`);
  console.log(`  deployer/DAO voter : ${deployer.address}`);
  console.log(`  provider           : ${provider.address}`);
  console.log(`  wallet owner       : ${owner.address}`);
  console.log(`  agent operator     : ${agentOperator.address}`);

  // ---------------------------------------------------------------- STEP 1
  banner(1, "Provider registers an inference service and stakes APT");

  const selector = await factory.localChainSelector();
  const terms = (n: string) => ethers.keccak256(ethers.toUtf8Bytes(n));

  const mk = async (cents: bigint, uri: string) => {
    await (
      await registry.connect(provider).registerService(cents, terms(uri), uri, selector)
    ).wait();
    return await registry.totalServices();
  };

  const cheapId = await mk(CHEAP_PRICE_CENTS, "inference: text summarization, fast, $0.50");
  const midId = await mk(MIDSIZE_PRICE_CENTS, "inference: long-document analysis, $5.00");
  const premiumId = await mk(PREMIUM_PRICE_CENTS, "inference: premium frontier reasoning, $20.00");
  console.log(`  registered services #${cheapId} ($0.50), #${midId} ($5.00), #${premiumId} ($20.00)`);

  const minStake: bigint = await governor.providerMinStake();
  const staked: bigint = await staking.stakedOf(provider.address);
  if (staked < minStake) {
    const need_ = minStake - staked;
    if (provider.address !== deployer.address) {
      await (await token.transfer(provider.address, need_)).wait();
    }
    await (await token.connect(provider).approve(await staking.getAddress(), need_)).wait();
    await (await staking.connect(provider).stake(need_)).wait();
  }
  console.log(`  provider staked ${ethers.formatEther(await staking.stakedOf(provider.address))} APT`);

  // ---------------------------------------------------------------- STEP 2
  banner(2, "Agent wallet funded; owner sets the allowlist and a $5/day budget");

  const tx = await factory.createWallet(owner.address, agentOperator.address);
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

  await (await token.transfer(walletAddr, APT("200"))).wait();
  await (await wallet.connect(owner).setServiceAllowed(cheapId, true)).wait();
  await (await wallet.connect(owner).setServiceAllowed(midId, true)).wait();
  await (await wallet.connect(owner).setServiceAllowed(premiumId, true)).wait();
  await (await wallet.connect(owner).setLocalDailyBudgetUsd(USD(5))).wait();

  console.log(`  wallet   ${walletAddr}`);
  console.log(`  funded   200 APT`);
  console.log(`  owner    allowlisted #${cheapId}, #${midId}, #${premiumId}; set a $5/day budget`);
  console.log(`  NOTE: the owner set these. The agent operator key cannot change them.`);

  // Hand the wallet to the agent CLI.
  const ctxPath = path.join(__dirname, "..", "..", "deployments", `${network.name}.agent.json`);
  fs.writeFileSync(
    ctxPath,
    JSON.stringify(
      {
        wallet: walletAddr,
        agentOperator: agentOperator.address,
        providerEndpoint: process.env.PROVIDER_SIM_URL,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`  wrote agent context -> ${path.relative(process.cwd(), ctxPath)}`);

  // ---------------------------------------------------------------- STEP 3
  banner(3, "agent quote -> the model picks a service; agent spend -> payment lands");
  agent(["quote", "summarize this support ticket for under $1"]);
  agent(["spend", String(cheapId)]);

  console.log(`\n  spent today: $${(Number(await wallet.spentTodayUsd()) / 1e8).toFixed(2)} of $5.00`);

  // ---------------------------------------------------------------- STEP 4
  banner(4, "A second spend exceeds the daily budget -> on-chain ExceedsDailyBudget");
  console.log(`  $0.50 already spent; service #${midId} costs $5.00; budget is $5.00/day.`);
  agent(["spend", String(midId)]);

  // ---------------------------------------------------------------- STEP 5
  banner(5, "Governance raises maxPerTxUsd -> the SAME spend now succeeds. No redeploy.");

  // Take the daily budget out of the picture so the GLOBAL per-tx cap is the
  // only thing standing between the agent and service #premiumId.
  await (await wallet.connect(owner).setLocalDailyBudgetUsd(USD(100))).wait();
  console.log(`  owner raised this wallet's daily budget to $100 (its own choice).`);
  console.log(`  The binding constraint is now the DAO's global maxPerTxUsd = $${(Number(await governor.maxPerTxUsd()) / 1e8).toFixed(2)}.`);
  console.log(`\n  --- BEFORE the proposal ---`);
  agent(["spend", String(premiumId)]);

  console.log(`\n  --- Passing a proposal to raise maxPerTxUsd to $25 ---`);
  await (await token.connect(deployer).delegate(deployer.address)).wait();
  if (isLocal()) await mineBlocks(1n);

  await passProposal(
    governor,
    timelock,
    deployer,
    await governor.getAddress(),
    governor.interface.encodeFunctionData("setMaxPerTxUsd", [USD(25)]),
    `Raise maxPerTxUsd to $25 (demo ${Date.now()})`,
  );
  console.log(`  maxPerTxUsd is now $${(Number(await governor.maxPerTxUsd()) / 1e8).toFixed(2)}`);

  console.log(`\n  --- AFTER the proposal: the exact same command, no redeploy ---`);
  agent(["spend", String(premiumId)]);

  // ---------------------------------------------------------------- STEP 6
  banner(6, "Global pause via governance -> every agent spend halts. Then unpause.");

  await passProposal(
    governor,
    timelock,
    deployer,
    await governor.getAddress(),
    governor.interface.encodeFunctionData("setGlobalPause", [true]),
    `Emergency: pause all agent spending (demo ${Date.now()})`,
  );
  console.log(`  globalPause = ${await governor.globalPause()}`);
  agent(["spend", String(cheapId)]);

  console.log(`\n  --- Unpausing ---`);
  await passProposal(
    governor,
    timelock,
    deployer,
    await governor.getAddress(),
    governor.interface.encodeFunctionData("setGlobalPause", [false]),
    `Resume agent spending (demo ${Date.now()})`,
  );
  console.log(`  globalPause = ${await governor.globalPause()}`);

  // ---------------------------------------------------------------- STEP 7
  banner(7, "agent audit — the whole spend history, rebuilt from events");
  agent(["audit"]);

  console.log(`\n${"#".repeat(72)}`);
  console.log(`  Demo complete. Every rejection above was on-chain policy working.`);
  console.log(`${"#".repeat(72)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
