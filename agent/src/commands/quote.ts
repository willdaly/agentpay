import { loadCatalog, renderCatalog } from "../catalog";
import { decide } from "../decide";
import { homeNetwork } from "../config";

// `agent quote <need>` — read the live multi-chain catalog, ask the LLM to pick
// a service, and print the validated decision. Spends nothing.

export async function quote(need: string, opts: { noLlm?: boolean }) {
  if (!need.trim()) {
    throw new Error(`usage: agent quote "<what you need>"`);
  }

  console.log(`\n== agent quote on ${homeNetwork()} ==`);
  console.log(`Need: ${need}\n`);

  const catalog = await loadCatalog();
  console.log("Live on-chain catalog:");
  console.log(renderCatalog(catalog));

  if (catalog.length === 0) {
    console.log("\nNothing to quote against.");
    return;
  }

  console.log("\nAsking the model to choose...");
  const { decision, source, warnings } = await decide(need, catalog, opts);

  const chosen = catalog.find((e) => e.serviceId === decision.serviceId)!;

  console.log(`\nDecision (${source}):`);
  console.log(`  service    #${decision.serviceId} — ${chosen.metadataURI}`);
  console.log(`  price      ${chosen.priceUsd} (settles on the ${chosen.isRemote ? "remote" : "home"} chain)`);
  console.log(`  max price  $${decision.maxPriceUsd.toFixed(2)} (the model's own limit)`);
  console.log(`  rationale  ${decision.rationale}`);

  for (const w of warnings) console.log(`  ! ${w}`);

  console.log(
    `\nThis is only a proposal. On-chain policy decides:\n` +
      `  agent spend ${decision.serviceId}\n`,
  );
}
