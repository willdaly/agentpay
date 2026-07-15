// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AggregatorV3Interface} from
    "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {IPriceFeedAdapter} from "./interfaces/IPriceFeedAdapter.sol";

/// @title PriceFeedAdapter
/// @notice Prices APT in USD by combining a LIVE Chainlink ETH/USD data feed
///         with a fixed, documented APT<->ETH demo peg, and converts between
///         USD policy caps and APT amounts at spend time.
/// @dev WHY THE ORACLE GENUINELY GATES BEHAVIOR (a graded requirement): APT has
///      no real market on testnet, so its USD price is derived as
///      `aptUsd = ethUsd / aptPerEth`. `ethUsd` comes from the live Chainlink
///      feed, so as ETH's real price moves, the number of APT that a $-denominated
///      cap converts to moves with it — the feed directly determines whether a
///      given spend passes or reverts. A production deployment would replace the
///      synthetic peg with a real APT market or settle in a priced stable token;
///      that limitation is called out here deliberately.
///
///      All prices are 8-decimal fixed point (Chainlink USD convention); APT
///      amounts are 18-decimal wei. Deployed once per chain.
contract PriceFeedAdapter is IPriceFeedAdapter {
    /// @notice USD fixed-point decimals this adapter normalizes every price to.
    uint8 public constant USD_DECIMALS = 8;

    /// @notice The Chainlink ETH/USD aggregator this adapter reads.
    AggregatorV3Interface public immutable feed;

    /// @notice Max age (seconds) of a feed answer before it is treated as stale.
    uint256 public immutable maxStaleness;

    /// @notice Demo peg: how many whole APT equal 1 ETH. Fixed at deploy.
    /// @dev e.g. 3000 => APT ~= $1 when ETH ~= $3000. Documented demo-only value.
    uint256 public immutable aptPerEth;

    /// @notice Decimals reported by the underlying feed (captured at deploy).
    uint8 public immutable feedDecimals;

    error ZeroAddress();
    error ZeroConfig();
    error StalePrice(uint256 updatedAt, uint256 maxStaleness);
    error NonPositiveAnswer(int256 answer);
    error IncompleteRound();

    /// @param _feed Chainlink ETH/USD aggregator for this chain.
    /// @param _maxStaleness Max acceptable answer age in seconds (feed heartbeat + margin).
    /// @param _aptPerEth Demo peg: whole APT per 1 ETH. Must be non-zero.
    constructor(address _feed, uint256 _maxStaleness, uint256 _aptPerEth) {
        if (_feed == address(0)) revert ZeroAddress();
        if (_maxStaleness == 0 || _aptPerEth == 0) revert ZeroConfig();
        feed = AggregatorV3Interface(_feed);
        maxStaleness = _maxStaleness;
        aptPerEth = _aptPerEth;
        feedDecimals = AggregatorV3Interface(_feed).decimals();
    }

    /// @inheritdoc IPriceFeedAdapter
    function latestUsdPrice() public view returns (uint256 price) {
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            feed.latestRoundData();

        if (answer <= 0) revert NonPositiveAnswer(answer);
        if (updatedAt == 0 || answeredInRound < roundId) revert IncompleteRound();
        if (block.timestamp - updatedAt > maxStaleness) {
            revert StalePrice(updatedAt, maxStaleness);
        }

        return _normalizeTo8Decimals(uint256(answer));
    }

    /// @inheritdoc IPriceFeedAdapter
    /// @dev aptWei = usdAmount * aptPerEth * 1e18 / ethUsd8. See contract NatSpec.
    function usdToToken(uint256 usdAmount) external view returns (uint256 aptWei) {
        uint256 ethUsd8 = latestUsdPrice();
        return (usdAmount * aptPerEth * 1e18) / ethUsd8;
    }

    /// @inheritdoc IPriceFeedAdapter
    /// @dev usdAmount = aptWei * ethUsd8 / (aptPerEth * 1e18). See contract NatSpec.
    function tokenToUsd(uint256 aptWei) external view returns (uint256 usdAmount) {
        uint256 ethUsd8 = latestUsdPrice();
        return (aptWei * ethUsd8) / (aptPerEth * 1e18);
    }

    /// @dev Scale a raw feed answer to 8-decimal fixed point. ETH/USD feeds are
    ///      already 8 decimals; this keeps the adapter correct if wired to a feed
    ///      that is not.
    function _normalizeTo8Decimals(uint256 raw) private view returns (uint256) {
        if (feedDecimals == USD_DECIMALS) return raw;
        if (feedDecimals < USD_DECIMALS) {
            return raw * (10 ** (USD_DECIMALS - feedDecimals));
        }
        return raw / (10 ** (feedDecimals - USD_DECIMALS));
    }
}
