import { ethers } from "ethers";
import { chunkedQueryFilter, fmtUsd, providerFor, readContract } from "../chain";
import { homeNetwork, loadContext } from "../config";

// `agent audit` — reconstruct the wallet's entire spend history from
// SpendExecuted logs alone. This is the monitoring/logging evidence: no indexer,
// no database, no trust in this CLI. Anyone with an RPC endpoint can rebuild the
// same table, which is exactly what makes the audit trail credible.
//
// Each row also carries the policySnapshot hash — the hash of the governance and
// local policy that was in force for that specific spend — so an auditor can
// prove which rules applied at the time without trusting current state.

interface AuditOpts {
  wallet?: string;
  fromBlock?: string;
}

export async function audit(opts: AuditOpts) {
  const network = homeNetwork();
  const ctx = loadContext(network);
  const walletAddr = opts.wallet ?? ctx.wallet;

  const wallet = readContract(network, "AgentWallet", walletAddr);
  const provider = providerFor(network);

  // Start the scan at the wallet's creation block (recorded in the context), not
  // genesis — a from-0 scan trips public RPCs' eth_getLogs range caps, and the
  // wallet has no events before it existed anyway. --from-block overrides.
  const toBlock = await provider.getBlockNumber();
  const fromBlock = opts.fromBlock
    ? Number(opts.fromBlock)
    : (ctx.createdBlock ?? 0);
  const events = await chunkedQueryFilter(
    wallet,
    wallet.filters.SpendExecuted(),
    fromBlock,
    toBlock,
  );

  console.log(`\n== agent audit on ${network} ==`);
  console.log(`Wallet: ${walletAddr}`);
  console.log(`Source: SpendExecuted logs from block ${fromBlock} (no indexer)\n`);

  if (events.length === 0) {
    console.log("No spends recorded yet.");
    return;
  }

  const head =
    `  ${"block".padEnd(9)}${"service".padEnd(9)}${"USD".padEnd(9)}` +
    `${"APT".padEnd(12)}${"chain".padEnd(22)}provider`;
  console.log(head);
  console.log(`  ${"-".repeat(head.length)}`);

  let totalUsd = 0n;
  for (const e of events) {
    const a = (e as ethers.EventLog).args;
    totalUsd += a.usdValue as bigint;
    console.log(
      `  ${String(e.blockNumber).padEnd(9)}` +
        `#${String(a.serviceId).padEnd(8)}` +
        `${fmtUsd(a.usdValue).padEnd(9)}` +
        `${Number(ethers.formatEther(a.tokenAmount)).toFixed(4).padEnd(12)}` +
        `${String(a.chainSelector).padEnd(22)}` +
        `${a.provider}`,
    );
  }

  console.log(`\n  ${events.length} spend(s), ${fmtUsd(totalUsd)} total`);

  // Live policy context, so the operator can see what the next spend faces.
  try {
    const spentToday: bigint = await wallet.spentTodayUsd();
    const remaining: bigint = await wallet.remainingDailyBudgetUsd();
    const cap: bigint = await wallet.effectiveMaxPerTxUsd();
    console.log(
      `\n  Today: ${fmtUsd(spentToday)} spent, ${fmtUsd(remaining)} left. ` +
        `Per-tx cap ${fmtUsd(cap)}.`,
    );
  } catch {
    // A non-fatal extra; the log-derived table above is the deliverable.
  }

  console.log(
    `\n  Each spend's policySnapshot hash pins the exact governance + local policy\n` +
      `  in force at that block:`,
  );
  for (const e of events.slice(-3)) {
    const a = (e as ethers.EventLog).args;
    console.log(`    #${a.serviceId} @ block ${e.blockNumber}: ${a.policySnapshot}`);
  }
  console.log("");
  void provider;
}
