/* eslint-disable no-console */
// Reports deployed bytecode size for every product contract and fails if any
// exceeds the EVM's 24,576-byte limit (EIP-170).
//
// The build brief calls for "modular, single-responsibility contracts, each well
// under the 24 KB EVM limit (a discipline carried over from the midterm)". This
// turns that from an intention into an enforced gate.
const fs = require("fs");
const path = require("path");

const EIP170_LIMIT = 24576;
const WARN_AT = 0.75; // flag anything using >75% of the budget

const ARTIFACTS = path.join(__dirname, "..", "artifacts", "contracts");

if (!fs.existsSync(ARTIFACTS)) {
  console.error("No artifacts found. Run `npm run compile` first.");
  process.exit(1);
}

/** Walk artifacts/contracts, skipping mocks (test scaffolding) and interfaces. */
function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "mocks" || entry.name === "interfaces") continue;
      collect(p, out);
    } else if (entry.name.endsWith(".json") && !entry.name.endsWith(".dbg.json")) {
      const a = JSON.parse(fs.readFileSync(p, "utf8"));
      // Interfaces/abstract contracts have empty deployedBytecode.
      if (!a.deployedBytecode || a.deployedBytecode === "0x") continue;
      out.push({
        name: a.contractName,
        bytes: (a.deployedBytecode.length - 2) / 2,
      });
    }
  }
  return out;
}

const contracts = collect(ARTIFACTS).sort((a, b) => b.bytes - a.bytes);

console.log(`\nDeployed bytecode size (EIP-170 limit: ${EIP170_LIMIT} bytes)\n`);
console.log(`  ${"CONTRACT".padEnd(28)}${"BYTES".padStart(8)}${"% LIMIT".padStart(10)}   STATUS`);
console.log(`  ${"-".repeat(60)}`);

let failed = false;
for (const c of contracts) {
  const pct = c.bytes / EIP170_LIMIT;
  const over = c.bytes > EIP170_LIMIT;
  const status = over ? "OVER LIMIT" : pct > WARN_AT ? "large" : "ok";
  if (over) failed = true;
  console.log(
    `  ${c.name.padEnd(28)}${String(c.bytes).padStart(8)}${(pct * 100).toFixed(1).padStart(9)}%   ${status}`,
  );
}

const largest = contracts[0];
console.log(
  `\n  ${contracts.length} product contracts. Largest: ${largest.name} at ` +
    `${((largest.bytes / EIP170_LIMIT) * 100).toFixed(1)}% of the limit.`,
);

if (failed) {
  console.error(`\nAt least one contract exceeds the ${EIP170_LIMIT}-byte EVM limit.`);
  process.exit(1);
}
console.log("");
