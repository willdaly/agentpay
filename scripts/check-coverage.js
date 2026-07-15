/* eslint-disable no-console */
// Enforces the course's 90% coverage gate on PRODUCT contracts only.
// Reads the istanbul json-summary emitted by `hardhat coverage` and aggregates
// coverage across contracts/ excluding mocks (test scaffolding). Fails the
// process if total lines or branches fall below the threshold.
const fs = require("fs");
const path = require("path");

const THRESHOLD = 90;
const summaryPath = path.join(__dirname, "..", "coverage", "coverage-summary.json");

if (!fs.existsSync(summaryPath)) {
  console.error(
    `coverage summary not found at ${summaryPath}. Run \`npm run coverage\` first.`,
  );
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

// Product code = anything under contracts/, excluding the mocks/ subfolder.
// Summary keys are forward-slash relative paths (e.g. contracts/AgentWallet.sol).
const isProduct = (file) => {
  const f = file.replace(/\\/g, "/");
  return f.includes("contracts/") && !f.includes("/mocks/") && f.endsWith(".sol");
};

const metrics = ["lines", "branches", "statements", "functions"];
const agg = Object.fromEntries(metrics.map((m) => [m, { covered: 0, total: 0 }]));
const files = [];

for (const [file, data] of Object.entries(summary)) {
  if (file === "total" || !isProduct(file)) continue;
  files.push(path.relative(path.join(__dirname, ".."), file));
  for (const m of metrics) {
    agg[m].covered += data[m].covered;
    agg[m].total += data[m].total;
  }
}

if (files.length === 0) {
  console.error("No product contracts found in coverage summary.");
  process.exit(1);
}

const pct = (m) => (agg[m].total === 0 ? 100 : (agg[m].covered / agg[m].total) * 100);

console.log(`\nCoverage gate (>= ${THRESHOLD}% lines & branches on ${files.length} product contracts):`);
let failed = false;
for (const m of metrics) {
  const value = pct(m);
  const gated = m === "lines" || m === "branches";
  const ok = !gated || value >= THRESHOLD;
  console.log(
    `  ${m.padEnd(11)} ${value.toFixed(2).padStart(6)}%  (${agg[m].covered}/${agg[m].total})  ${
      gated ? (ok ? "PASS" : "FAIL") : "(info)"
    }`,
  );
  if (gated && !ok) failed = true;
}

if (failed) {
  console.error(`\nCoverage below ${THRESHOLD}% gate. Failing build.`);
  process.exit(1);
}
console.log("\nCoverage gate passed.\n");
