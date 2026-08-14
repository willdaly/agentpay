import { run, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { loadDeployments } from "./deployments";

// Verify every script-deployed contract on the current network's block explorer,
// reading addresses + constructor args from deployments/<network>.json. Uses the
// stored `args` array directly (handles scalars, addresses, arrays, and the
// PolicyGovernor struct uniformly), and treats "already verified" as success.
//
//   npx hardhat run scripts/util/verify-all.ts --network sepolia
//   npx hardhat run scripts/util/verify-all.ts --network baseSepolia

// Mocks (local only) and the external feed are never verified here.
const SKIP = new Set(["MockV3Aggregator", "ManipulableFeed"]);

async function main() {
  // chainId is only used to seed a NEW deployments file; the file already exists
  // here, so 0 is fine for reading.
  const d = loadDeployments(network.name, 0);
  const entries = Object.entries(d.contracts).filter(([n]) => !SKIP.has(n));

  console.log(`\n== Verifying ${entries.length} contracts on ${network.name} ==\n`);

  const results: Record<string, string> = {};
  for (const [name, entry] of entries) {
    const args = (entry.args ?? []) as unknown[];
    process.stdout.write(`  ${name.padEnd(24)} ${entry.address} ... `);
    try {
      await run("verify:verify", {
        address: entry.address,
        constructorArguments: args,
      });
      results[name] = "verified";
      console.log("OK");
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (/already verified/i.test(msg)) {
        results[name] = "already verified";
        console.log("already verified");
      } else {
        results[name] = `FAILED: ${msg.split("\n")[0].slice(0, 120)}`;
        console.log(`FAILED — ${msg.split("\n")[0].slice(0, 120)}`);
      }
    }
  }

  const ok = Object.values(results).filter((r) => /verified/.test(r)).length;
  console.log(`\n${ok}/${entries.length} verified (or already verified) on ${network.name}.`);

  // Persist a small record for the docs/addresses.md tables.
  const out = path.join(__dirname, "..", "..", "deployments", `${network.name}.verify.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
