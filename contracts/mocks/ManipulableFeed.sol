// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AggregatorV3Interface} from
    "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @notice Test-only aggregator that lets a test set `answeredInRound` and
///         `roundId` independently, which the canonical MockV3Aggregator cannot.
///         Used to exercise PriceFeedAdapter's stale-round guard
///         (`answeredInRound < roundId`).
contract ManipulableFeed is AggregatorV3Interface {
    uint8 public immutable feedDecimals;
    uint80 public roundId;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public answeredInRound;

    constructor(uint8 _decimals) {
        feedDecimals = _decimals;
    }

    function set(uint80 _roundId, int256 _answer, uint256 _updatedAt, uint80 _answeredInRound)
        external
    {
        roundId = _roundId;
        answer = _answer;
        updatedAt = _updatedAt;
        answeredInRound = _answeredInRound;
    }

    function decimals() external view returns (uint8) {
        return feedDecimals;
    }

    function description() external pure returns (string memory) {
        return "ManipulableFeed";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function getRoundData(uint80)
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}
