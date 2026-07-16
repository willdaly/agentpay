import { ethers, network } from "hardhat";
import { loadDeployments, existing } from "../util/deployments";

// End-to-end demo of a single policy-governed spend against a deployed stack.
// Uses the deployer as a solo actor (provider + wallet owner + agent), which is
// realistic for a single-key testnet run. Run AFTER scripts/deploy/deploy.ts:
//
//   npx hardhat run scripts/demo/spend.ts --network sepolia
//   npx hardhat run scripts/demo/spend.ts --network localhost

const USD = (d: number) => BigInt(Math.round(d * 1e8));

async function main() {
  const [me] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const data = loadDeployments(network.name, chainId);

  const need = (name: string) => {
    const a = existing(data, name);
    if (!a) throw new Error(`${name} not deployed. Run scripts/deploy/deploy.ts first.`);
    return a;
  };

  const token = await ethers.getContractAt("AgentPayToken", need("AgentPayToken"));
  const registry = await ethers.getContractAt("ServiceRegistry", need("ServiceRegistry"));
  const staking = await ethers.getContractAt("ProviderStaking", need("ProviderStaking"));
  const escrow = await ethers.getContractAt("SettlementEscrow", need("SettlementEscrow"));
  const factory = await ethers.getContractAt("AgentWalletFactory", need("AgentWalletFactory"));
  const governor = await ethers.getContractAt("PolicyGovernor", need("PolicyGovernor"));

  console.log(`\n== AgentPay demo spend on ${network.name} (chainId ${chainId}) ==`);
  console.log(`Actor: ${me.address}\n`);

  // 1. Provider registers a $0.50 inference service on this chain.
  const cfgSelector = await factory.localChainSelector();
  const termsHash = ethers.keccak256(ethers.toUtf8Bytes("AgentPay demo inference v1"));
  let tx = await registry.registerService(50, termsHash, "ipfs://demo-service", cfgSelector);
  await tx.wait();
  const serviceId = await registry.totalServices();
  console.log(`1. Registered service #${serviceId} ($0.50, provider ${me.address})`);

  // 2. Provider stakes up to the minimum required collateral.
  const minStake = await governor.providerMinStake();
  const staked = await staking.stakedOf(me.address);
  if (staked < minStake) {
    const need = minStake - staked;
    await (await token.approve(await staking.getAddress(), need)).wait();
    await (await staking.stake(need)).wait();
    console.log(`2. Staked ${ethers.formatEther(need)} APT (min ${ethers.formatEther(minStake)})`);
  } else {
    console.log(`2. Already staked ${ethers.formatEther(staked)} APT`);
  }

  // 3. Create an agent wallet (owner + agent = me) and fund it.
  tx = await factory.createWallet(me.address, me.address);
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
  await (await token.transfer(walletAddr, ethers.parseEther("100"))).wait();
  console.log(`3. Created wallet ${walletAddr}, funded 100 APT`);

  // 4. Owner sets the allowlist and a $5/day budget.
  await (await wallet.setServiceAllowed(serviceId, true)).wait();
  await (await wallet.setLocalDailyBudgetUsd(USD(5))).wait();
  console.log(`4. Allowlisted service #${serviceId}, set $5/day budget`);

  // 5. Agent spends.
  tx = await wallet.spend(serviceId);
  const spendRcpt = await tx.wait();
  const spendEvent = spendRcpt!.logs
    .map((l) => {
      try {
        return wallet.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "SpendExecuted")!;
  const amt = spendEvent.args.tokenAmount as bigint;
  console.log(`5. SPEND OK  tx ${tx.hash}`);
  console.log(
    `   ${ethers.formatEther(amt)} APT ($${(Number(spendEvent.args.usdValue) / 1e8).toFixed(2)}) ` +
      `-> provider ${spendEvent.args.provider}`,
  );

  // 6. Settlement: with disputeWindow == 0 the provider can withdraw immediately.
  const window = await governor.disputeWindow();
  if (window === 0n) {
    const claimable = await escrow.withdrawable(me.address);
    if (claimable > 0n) {
      await (await escrow.withdraw()).wait();
      console.log(`6. Provider withdrew ${ethers.formatEther(claimable)} APT from escrow`);
    }
  } else {
    console.log(`6. Payment is time-locked ${window}s (release then withdraw).`);
  }

  // 7. Audit: reconstruct the spend history from SpendExecuted logs.
  const events = await wallet.queryFilter(wallet.filters.SpendExecuted());
  console.log(`\n7. Audit — ${events.length} spend(s) reconstructed from logs:`);
  console.log(`   ${"service".padEnd(9)}${"USD".padEnd(10)}${"APT".padEnd(14)}provider`);
  for (const e of events) {
    const a = e.args;
    console.log(
      `   #${String(a.serviceId).padEnd(8)}$${(Number(a.usdValue) / 1e8).toFixed(2).padEnd(9)}` +
        `${ethers.formatEther(a.tokenAmount).padEnd(14)}${a.provider}`,
    );
  }
  console.log("\nDemo complete.\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
