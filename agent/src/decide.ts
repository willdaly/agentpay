import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { CatalogEntry, catalogForPrompt } from "./catalog";
import { anthropicApiKey } from "./config";

// THE LLM PROPOSES, THE CONTRACT DISPOSES.
//
// This module turns a natural-language need plus the live on-chain catalog into
// a spend decision. It is deliberately paranoid about the model's output, in
// three layers:
//
//   1. WIRE FORMAT — structured outputs (`messages.parse` + a zod schema) make
//      the response schema-valid by construction. A text-extraction fallback
//      (fence-stripping + JSON.parse) covers the case where the response has no
//      parsed output at all.
//   2. SEMANTICS — structured outputs cannot stop the model choosing a service
//      that does not exist, is inactive, or naming an absurd price. Those checks
//      are here, against the real catalog.
//   3. ON-CHAIN POLICY — the real gate. Everything above is convenience; the
//      only enforcement that counts happens in AgentWallet.spend().
//
// Note layer 2 does NOT silently repair an over-budget decision. Clamping it
// away would hide exactly the failure the platform exists to catch. An
// over-budget decision is flagged and allowed through to the chain, where the
// typed revert proves the control plane works.

const MODEL = "claude-opus-4-8";

/** Absolute sanity bound on a proposed price, independent of any policy. */
const MAX_SANE_PRICE_USD = 1_000;

const DecisionSchema = z.object({
  serviceId: z
    .number()
    .int()
    .describe("The serviceId of the chosen service, from the catalog."),
  maxPriceUsd: z
    .number()
    .describe(
      "The most you are willing to pay in USD for this service, as a decimal (e.g. 0.05).",
    ),
  rationale: z
    .string()
    .describe("One or two sentences on why this service was chosen."),
});

export type Decision = z.infer<typeof DecisionSchema>;

export interface DecisionResult {
  decision: Decision;
  /** How the decision was produced. */
  source: "llm" | "llm-text-fallback" | "heuristic";
  /** Non-fatal problems found while validating — surfaced, never hidden. */
  warnings: string[];
}

const SYSTEM = `You choose which on-chain service an autonomous agent should pay for.

You are given a natural-language need and a catalog of services read live from
the blockchain. Choose exactly one service and state the maximum you would pay.

How to choose:
- The service must plausibly satisfy the need. Read each description carefully.
- Prefer cheaper services when two plausibly satisfy the need equally well.
- providerScore is a 0-100 commit-reveal quality score; 0 means the provider has
  never been rated, which is NOT the same as a bad score - treat it as unknown.
- providerStakedApt is collateral the provider loses if slashed. More stake means
  more accountability.
- If the need names a budget, respect it: maxPriceUsd must not exceed it.
- Only ever pick a serviceId that appears in the catalog.

Your decision is a proposal. On-chain policy independently enforces spending
limits and will reject anything over budget, so state your honest choice rather
than trying to guess what will be allowed.`;

function buildPrompt(need: string, catalog: CatalogEntry[]): string {
  return [
    `Need: ${need}`,
    "",
    "Catalog (read live from the on-chain ServiceRegistry):",
    JSON.stringify(catalogForPrompt(catalog), null, 2),
  ].join("\n");
}

/**
 * Last-resort parser for a model response with no structured output: strip any
 * markdown fences and pull out the first JSON object.
 */
export function extractJson(text: string): unknown {
  let t = text.trim();
  // ```json ... ``` or ``` ... ```
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();

  // Fall back to the outermost {...} span.
  if (!t.startsWith("{")) {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("no JSON object found in the model response");
    }
    t = t.slice(start, end + 1);
  }
  return JSON.parse(t);
}

/**
 * Layer 2: validate the proposal against reality and clamp what is safe to
 * clamp. Returns warnings rather than throwing, except where the decision is
 * unusable (a service that does not exist).
 */
export function validateDecision(
  raw: Decision,
  catalog: CatalogEntry[],
): { decision: Decision; warnings: string[] } {
  const warnings: string[] = [];

  const chosen = catalog.find((e) => e.serviceId === raw.serviceId);
  if (!chosen) {
    // Unusable: nothing on-chain to spend against. Fail here rather than send a
    // transaction we know reverts for an uninteresting reason.
    throw new Error(
      `the model chose serviceId ${raw.serviceId}, which is not an active service ` +
        `(available: ${catalog.map((e) => e.serviceId).join(", ") || "none"})`,
    );
  }

  let maxPriceUsd = raw.maxPriceUsd;
  if (!Number.isFinite(maxPriceUsd) || maxPriceUsd < 0) {
    warnings.push(`maxPriceUsd was ${raw.maxPriceUsd}; clamped to 0`);
    maxPriceUsd = 0;
  }
  if (maxPriceUsd > MAX_SANE_PRICE_USD) {
    warnings.push(
      `maxPriceUsd was ${raw.maxPriceUsd}; clamped to ${MAX_SANE_PRICE_USD}`,
    );
    maxPriceUsd = MAX_SANE_PRICE_USD;
  }

  const actualPrice = chosen.priceUsdCents / 100;
  if (actualPrice > maxPriceUsd) {
    warnings.push(
      `service #${chosen.serviceId} costs $${actualPrice.toFixed(2)}, above the ` +
        `model's own stated max of $${maxPriceUsd.toFixed(2)}`,
    );
  }

  const rationale =
    typeof raw.rationale === "string" && raw.rationale.trim().length > 0
      ? raw.rationale.trim()
      : "(no rationale given)";

  return {
    decision: { serviceId: chosen.serviceId, maxPriceUsd, rationale },
    warnings,
  };
}

/** Deterministic fallback when no API key is configured: cheapest active service. */
function heuristicDecision(catalog: CatalogEntry[]): DecisionResult {
  if (catalog.length === 0) throw new Error("the catalog is empty");
  const cheapest = [...catalog].sort(
    (a, b) => a.priceUsdCents - b.priceUsdCents,
  )[0];
  return {
    decision: {
      serviceId: cheapest.serviceId,
      maxPriceUsd: cheapest.priceUsdCents / 100,
      rationale:
        "Heuristic fallback (no ANTHROPIC_API_KEY set): chose the cheapest active service.",
    },
    source: "heuristic",
    warnings: ["no ANTHROPIC_API_KEY — used the deterministic fallback, not an LLM"],
  };
}

export interface DecideOptions {
  /** Skip the LLM entirely and use the deterministic fallback. */
  noLlm?: boolean;
}

/** Ask the model to choose a service, then validate the proposal defensively. */
export async function decide(
  need: string,
  catalog: CatalogEntry[],
  opts: DecideOptions = {},
): Promise<DecisionResult> {
  const apiKey = anthropicApiKey();
  if (opts.noLlm || !apiKey) return heuristicDecision(catalog);

  const client = new Anthropic({ apiKey });

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "low", // a scoped selection task; keep the CLI responsive
      format: zodOutputFormat(DecisionSchema),
    },
    system: SYSTEM,
    messages: [{ role: "user", content: buildPrompt(need, catalog) }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("the model declined to make a spend decision for this request");
  }

  let raw: Decision;
  let source: DecisionResult["source"] = "llm";

  if (response.parsed_output) {
    raw = response.parsed_output;
  } else {
    // No structured output — fall back to fence-stripping the text.
    source = "llm-text-fallback";
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!text.trim()) {
      throw new Error(
        `the model returned no usable decision (stop_reason: ${response.stop_reason})`,
      );
    }
    raw = DecisionSchema.parse(extractJson(text));
  }

  const { decision, warnings } = validateDecision(raw, catalog);
  return { decision, source, warnings };
}
