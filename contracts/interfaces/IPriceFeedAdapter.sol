// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IPriceFeedAdapter
/// @notice Converts USD-denominated policy caps into APT token amounts at spend
///         time, using a live Chainlink price feed with staleness/sanity guards.
/// @dev Deployed per chain. Consumers depend only on this interface so the
///      concrete feed source (real Chainlink aggregator vs. mock in tests) is
///      swappable without touching policy logic.
interface IPriceFeedAdapter {
    /// @notice Convert a USD value into the equivalent amount of APT (in wei).
    /// @param usdAmount USD value in 8-decimal fixed point (Chainlink USD convention).
    /// @return aptWei Equivalent APT amount in 18-decimal wei.
    function usdToToken(uint256 usdAmount) external view returns (uint256 aptWei);

    /// @notice Convert an APT amount (wei) into its USD value at the current price.
    /// @param aptWei APT amount in 18-decimal wei.
    /// @return usdAmount USD value in 8-decimal fixed point.
    function tokenToUsd(uint256 aptWei) external view returns (uint256 usdAmount);

    /// @notice The current, freshness-checked ETH/USD price in 8-decimal fixed point.
    /// @dev Reverts (StalePrice / bad answer) rather than returning a suspect value.
    function latestUsdPrice() external view returns (uint256 price);
}
