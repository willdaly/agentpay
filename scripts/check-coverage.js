/* eslint-disable no-console */
// Enforces the course's 90% coverage gate on product contracts.
// Reads the istanbul json-summary emitted by `hardhat coverage` and fails the
// process if total lines or branches fall below the threshold. Mocks are already
// excluded via .solcover.js skipFiles, so the "total" here is product code only.
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
const total = summary.total;

const metrics = ["lines", "branches", "statements", "functions"];
let failed = false;

console.log(`\nCoverage gate (>= ${THRESHOLD}% lines & branches on product contracts):`);
for (const m of metrics) {
  const pct = total[m].pct;
  const gated = m === "lines" || m === "branches";
  const ok = !gated || pct >= THRESHOLD;
  console.log(
    `  ${m.padEnd(11)} ${String(pct).padStart(6)}%  ${gated ? (ok ? "PASS" : "FAIL") : "(info)"}`,
  );
  if (gated && !ok) failed = true;
}

if (failed) {
  console.error(`\nCoverage below ${THRESHOLD}% gate. Failing build.`);
  process.exit(1);
}
console.log("\nCoverage gate passed.\n");
