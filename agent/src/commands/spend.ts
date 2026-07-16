import { ethers } from "ethers";
import {
  contractAt,
  decodeRevert,
  fmtUsd,
  signerFor,
  spendErrorInterfaces,
} from "../chain";
import { homeNetwork, loadContext } from "../config";
import { loadCatalog } from "../catalog";

// `agent spend <serviceId>` — submit the spend through AgentWallet and report
// what the chain decided. Two outcomes, both worth seeing:
//
//   ALLOWED  -> SpendExecuted, decoded into a human-readable audit line, and (for
//               an inference service) the provider-sim is called to actually
//               deliver the service the agent just paid for.
//   REJECTED -> a TYPED custom error naming the exact policy that said no. This
//               is not an error path to hide; it is the product working.

interface SpendOpts {
  wallet?: string;
  /** Skip calling the provider endpoint after payment. */
  noDeliver?: boolean;
}

export async function spend(serviceIdRaw: string, opts: SpendOpts) {
  const serviceId = BigInt(serviceIdRaw);
  const network = homeNetwork();
  const ctx = loadContext(network);
  const walletAddr = opts.wallet ?? ctx.wallet;

  const signer = await signerFor(network, ctx.agentOperator);
  const wallet = contractAt(network, "AgentWallet", signer, walletAddr);

  console.log(`\n== agent spend on ${network} ==`);
  console.log(`Wallet:  ${walletAddr}`);
  console.log(`Agent:   ${await (signer as ethers.Signer).getAddress()}`);
  console.log(`Service: #${serviceId}`);

  // Pre-flight: previewSpend runs the identical policy gate as a view, so we can
  // report the verdict without spending gas on a doomed transaction.
  try {
    const ctxPreview = await wallet.previewSpend.staticCall(serviceId);
    console.log(
      `\nPre-flight: ALLOWED — ${ethers.formatEther(ctxPreview.tokenAmount)} APT ` +
        `(${fmtUsd(ctxPreview.usdValue)})${ctxPreview.isRemote ? ", settles cross-chain" : ""}`,
    );
  } catch (e) {
    reportRejection(e);
    return;
  }

  let receipt: ethers.TransactionReceipt;
  try {
    const tx = await wallet.spend(serviceId);
    console.log(`\nSubmitted ${tx.hash} — waiting...`);
    receipt = (await tx.wait())!;
  } catch (e) {
    // The policy can still reject between pre-flight and mining (e.g. governance
    // paused the platform, or another spend consumed the daily budget first).
    reportRejection(e);
    return;
  }

  const event = receipt.logs
    .map((l) => {
      try {
        return wallet.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "SpendExecuted");

  if (!event) {
    console.log(`\nSPEND MINED but no SpendExecuted event found (tx ${receipt.hash}).`);
    return;
  }

  const a = event.args;
  console.log(`\nSPEND ALLOWED  tx ${receipt.hash}`);
  console.log(`  paid       ${ethers.formatEther(a.tokenAmount)} APT (${fmtUsd(a.usdValue)})`);
  console.log(`  provider   ${a.provider}`);
  console.log(`  chain      ${a.chainSelector}`);
  console.log(`  policy     ${a.policySnapshot}`);

  if (opts.noDeliver) return;
  await deliver(serviceId, receipt.hash);
}

/** Decode a revert into the typed policy error that caused it. */
function reportRejection(e: unknown) {
  const decoded = decodeRevert(e, spendErrorInterfaces());
  if (decoded) {
    console.log(`\nSPEND REJECTED by on-chain policy: ${decoded.name}`);
    if (decoded.args.length) {
      console.log(`  ${decoded.args.join(", ")}`);
    }
    console.log(`\n  ${explain(decoded.name)}`);
    return;
  }
  console.log(`\nSPEND FAILED: ${(e as Error).message ?? String(e)}`);
}

/** Plain-English gloss for each typed policy error. */
function explain(name: string): string {
  const map: Record<string, string> = {
    ExceedsPerTxCap:
      "The service costs more than the per-transaction cap (the lower of this wallet's local cap and the DAO's global maxPerTxUsd).",
    ExceedsDailyBudget:
      "This spend would push the wallet past its rolling daily budget. The budget resets on the next day bucket.",
    CounterpartyNotAllowed:
      "The wallet's owner has not allowlisted this service. The agent cannot add it itself.",
    Paused:
      "Spending is halted — either the wallet's local pause or the DAO's global pause.",
    ProviderUnderstaked:
      "The provider's staked collateral is below the DAO's providerMinStake.",
    ServiceNotActive: "The provider has deactivated this service.",
    NotAuthorizedAgent:
      "This key is neither the wallet's agent operator nor its owner.",
    InsufficientBalance: "The wallet does not hold enough APT to cover the spend.",
    StalePrice:
      "The oracle's price is too old to trust, so the wallet refused to convert the USD cap. The feed gates spending.",
    RemoteServiceUnsupported:
      "This service settles on another chain and the wallet has no cross-chain router configured.",
  };
  return map[name] ?? "See docs/SECURITY_NOTES.md for this policy.";
}

/**
 * Close the loop: having paid on-chain, actually collect the service. The
 * provider-sim independently verifies the payment before serving.
 */
async function deliver(serviceId: bigint, txHash: string) {
  const ctx = loadContext(homeNetwork());
  const endpoint = ctx.providerEndpoint;
  if (!endpoint) {
    console.log(
      `\n(no PROVIDER_SIM_URL set — skipping delivery. Start it with: npm run provider-sim)`,
    );
    return;
  }

  const catalog = await loadCatalog();
  const svc = catalog.find((e) => e.serviceId === Number(serviceId));
  const prompt = process.env.AGENT_PROMPT ?? "Summarize what AgentPay does in one sentence.";

  console.log(`\nCollecting the service from ${endpoint} ...`);
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, "")}/infer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serviceId: Number(serviceId), txHash, prompt }),
    });
    const body = (await res.json()) as any;
    if (!res.ok) {
      console.log(`  provider refused (${res.status}): ${body.error ?? "unknown"}`);
      return;
    }
    console.log(`  provider verified payment on-chain and served:`);
    console.log(`\n  ${String(body.output).split("\n").join("\n  ")}\n`);
  } catch (e) {
    console.log(`  could not reach the provider: ${(e as Error).message}`);
    void svc;
  }
}
