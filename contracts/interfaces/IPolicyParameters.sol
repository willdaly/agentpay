// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IPolicyParameters
/// @notice Live, on-chain global risk parameters for the AgentPay control plane.
/// @dev THE ARCHITECTURAL CENTERPIECE. Consumer contracts (e.g. {AgentWallet},
///      {ProviderStaking}) hold a reference to a single `IPolicyParameters`
///      implementation and read these values *at transaction time* — never
///      caching them. The implementation is `PolicyGovernor`, a token-weighted
///      DAO whose passed proposals mutate these values in place. The effect: a
///      governance vote changes system-wide behavior with NO redeploy and NO
///      migration. This governance boundary is inherited from the Module 7
///      midterm's `MarketplaceGovernor` pattern and is the property the
///      governance lifecycle test asserts.
interface IPolicyParameters {
    /// @notice Maximum USD value (8-decimal fixed point, matching Chainlink
    ///         USD feeds) permitted for any single agent spend, globally.
    function maxPerTxUsd() external view returns (uint256);

    /// @notice Default rolling daily budget in USD (8-decimal fixed point)
    ///         applied to an agent wallet that has not set a stricter local one.
    function defaultDailyBudgetUsd() external view returns (uint256);

    /// @notice Slashing penalty in basis points (1e4 = 100%) applied to a
    ///         provider's stake on a successful governance slash.
    function slashBps() external view returns (uint256);

    /// @notice Seconds a staked amount remains locked after an unstake request,
    ///         and the settlement dispute window length. One value, two uses.
    function disputeWindow() external view returns (uint256);

    /// @notice Destination for slashed collateral and protocol fees.
    function treasury() external view returns (address);

    /// @notice Minimum APT (in wei, 18 decimals) a provider must have staked
    ///         for its services to be spendable against.
    function providerMinStake() external view returns (uint256);

    /// @notice Emergency system-wide stop. When true, all agent spends revert.
    function globalPause() external view returns (bool);
}
