// solidity-coverage config. Mocks are test scaffolding, not product code, so
// they are excluded from the 90% coverage gate (see scripts/check-coverage.js).
// Interfaces carry no executable code but are left in — they report 100%.
module.exports = {
  skipFiles: ["mocks/MockV3Aggregator.sol", "mocks/ManipulableFeed.sol"],
  istanbulReporter: ["text", "json-summary", "lcov"],
  configureYulOptimizer: true,
};
