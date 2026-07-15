// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Re-export Chainlink's canonical mock feed so it is compiled into this project
// and gets a TypeChain factory for tests. Tests use updateRoundData(...) to
// simulate stale / non-positive answers and exercise PriceFeedAdapter guards.
// solhint-disable-next-line no-unused-import
import {MockV3Aggregator} from "@chainlink/contracts/src/v0.8/shared/mocks/MockV3Aggregator.sol";
