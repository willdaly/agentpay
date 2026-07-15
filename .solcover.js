// solidity-coverage config. Mocks are test scaffolding, not product code, so
// they are excluded from the 90% coverage gate (see scripts/check-coverage.js).
// Interfaces carry no executable code but are left in — they report 100%.
// Mocks stay compiled and instrumented here (skipping the folder breaks tests
// that deploy those mocks under coverage). They are instead excluded from the
// 90% gate by scripts/check-coverage.js, which aggregates only product code.
module.exports = {
  istanbulReporter: ["text", "json-summary", "lcov"],
  configureYulOptimizer: true,
};
