import * as http from "http";
import { ethers } from "ethers";
import Anthropic from "@anthropic-ai/sdk";
import { abiOf, addressOf, anthropicApiKey, homeNetwork } from "../src/config";
import { providerFor, readContract, usdFromCents } from "../src/chain";

// A minimal stand-in for a real service provider. Its entire job is to answer
// one question honestly: "was I actually paid for this, on-chain, and not
// already served?" It answers by reading the chain itself — it trusts the
// caller for nothing.
//
//   POST /infer  { serviceId, txHash, prompt }
//
// Verification, in order:
//   1. The transaction mined successfully.
//   2. It carries a SettlementEscrow credit event (PaymentSettled for immediate
//      settlement, or PaymentPending when a dispute window is configured) —
//      i.e. the escrow really recorded money owed to this provider.
//   3. The credit names THIS service's registered provider and THIS serviceId.
//   4. The amount covers the service's registered price.
//   5. The transaction has not already been redeemed (replay protection — one
//      payment buys one delivery).
//
// Only then does it serve the inference. This is what closes the loop: a real
// decision, a real payment, a real service.

const PORT = Number(process.env.PROVIDER_SIM_PORT ?? 8787);
const NETWORK = homeNetwork();

/** txHash (lowercased) => already served. One payment, one delivery. */
const redeemed = new Set<string>();

interface VerifyResult {
  ok: boolean;
  reason?: string;
  usdValue?: bigint;
  provider?: string;
}

async function verifyPayment(
  serviceId: number,
  txHash: string,
): Promise<VerifyResult> {
  const provider = providerFor(NETWORK);

  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return { ok: false, reason: "transaction not found" };
  if (receipt.status !== 1) return { ok: false, reason: "transaction reverted" };

  // Who is the registered provider for this service? The chain decides, not the caller.
  const registry = readContract(NETWORK, "ServiceRegistry");
  const svc = await registry.getService(BigInt(serviceId));
  const expectedProvider: string = svc.provider;
  const priceUsd = usdFromCents(svc.priceUsdCents);

  const escrowAddr = addressOf(NETWORK, "SettlementEscrow").toLowerCase();
  const escrowIface = new ethers.Interface(abiOf("SettlementEscrow"));
  const walletIface = new ethers.Interface(abiOf("AgentWallet"));

  // 2 + 3: the escrow's own record of the credit.
  let credited = false;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrowAddr) continue;
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = escrowIface.parseLog(log);
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (parsed.name === "PaymentSettled" || parsed.name === "PaymentPending") {
      if (
        String(parsed.args.provider).toLowerCase() ===
          expectedProvider.toLowerCase() &&
        BigInt(parsed.args.serviceId) === BigInt(serviceId)
      ) {
        credited = true;
        break;
      }
    }
  }
  if (!credited) {
    return {
      ok: false,
      reason: `no SettlementEscrow credit to ${expectedProvider} for service #${serviceId} in this transaction`,
    };
  }

  // 4: the spend's USD value must cover the registered price.
  let usdValue: bigint | undefined;
  for (const log of receipt.logs) {
    try {
      const parsed = walletIface.parseLog(log);
      if (parsed?.name === "SpendExecuted" && BigInt(parsed.args.serviceId) === BigInt(serviceId)) {
        usdValue = parsed.args.usdValue as bigint;
        break;
      }
    } catch {
      continue;
    }
  }
  if (usdValue === undefined) {
    return { ok: false, reason: "no SpendExecuted event for this service" };
  }
  if (usdValue < priceUsd) {
    return {
      ok: false,
      reason: `underpaid: ${usdValue} < ${priceUsd} (8-decimal USD)`,
    };
  }

  return { ok: true, usdValue, provider: expectedProvider };
}

async function serveInference(prompt: string): Promise<string> {
  const key = anthropicApiKey();
  if (!key) {
    // Deterministic stand-in so the demo runs with no API key.
    return `[provider-sim, no ANTHROPIC_API_KEY] Received and paid for. Echoing the request back: "${prompt}"`;
  }
  const client = new Anthropic({ apiKey: key });
  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    output_config: { effort: "low" },
    system:
      "You are a paid inference service. Answer the user's request directly and concisely. No preamble.",
    messages: [{ role: "user", content: prompt }],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function send(res: http.ServerResponse, code: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true, network: NETWORK, redeemed: redeemed.size });
  }
  if (req.method !== "POST" || req.url !== "/infer") {
    return send(res, 404, { error: "POST /infer" });
  }

  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > 1_000_000) req.destroy(); // don't buffer unbounded input
  });
  req.on("end", async () => {
    try {
      const { serviceId, txHash, prompt } = JSON.parse(raw || "{}");
      if (typeof serviceId !== "number" || typeof txHash !== "string") {
        return send(res, 400, { error: "expected { serviceId: number, txHash: string, prompt?: string }" });
      }

      const key = txHash.toLowerCase();
      if (redeemed.has(key)) {
        console.log(`  REJECT  ${txHash} — already redeemed`);
        return send(res, 409, { error: "this payment has already been redeemed" });
      }

      const verdict = await verifyPayment(serviceId, txHash);
      if (!verdict.ok) {
        console.log(`  REJECT  ${txHash} — ${verdict.reason}`);
        return send(res, 402, { error: `payment not verified: ${verdict.reason}` });
      }

      // Mark redeemed BEFORE serving: an expensive call that fails should not
      // hand the caller a free retry of a spent payment.
      redeemed.add(key);
      console.log(
        `  SERVE   ${txHash} — verified payment to ${verdict.provider} for service #${serviceId}`,
      );

      const output = await serveInference(
        typeof prompt === "string" && prompt.trim()
          ? prompt
          : "Say hello and confirm the payment was verified.",
      );
      return send(res, 200, { output, verifiedProvider: verdict.provider });
    } catch (e) {
      console.error(e);
      return send(res, 500, { error: (e as Error).message });
    }
  });
});

server.listen(PORT, () => {
  console.log(`\nprovider-sim listening on http://127.0.0.1:${PORT}`);
  console.log(`  network:   ${NETWORK}`);
  console.log(`  inference: ${anthropicApiKey() ? "real (Anthropic API)" : "deterministic stand-in (no API key)"}`);
  console.log(`  POST /infer { serviceId, txHash, prompt }\n`);
  console.log(`Set PROVIDER_SIM_URL=http://127.0.0.1:${PORT} so the agent collects the service.\n`);
});
