// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ICrossChainSpendRouter
/// @notice The surface {AgentWallet} needs to hand an already-authorized spend to
///         a provider on another chain.
/// @dev The wallet depends on this interface, not the concrete CCIP router, so the
///      remote-spend path is unit-testable without a CCIP simulator.
interface ICrossChainSpendRouter {
    /// @notice Forward a spend to `destChainSelector`. The caller MUST have
    ///         transferred `amount` APT to the router immediately beforehand.
    /// @param destChainSelector CCIP selector of the service's settlement chain.
    /// @param provider Provider to credit on the destination chain.
    /// @param serviceId Service being paid for.
    /// @param amount APT (wei) being settled.
    /// @param usdValue USD (8-decimal) value at the home-chain feed price.
    /// @return messageId Cross-chain message id (the audit handle).
    function routeSpend(
        uint64 destChainSelector,
        address provider,
        uint256 serviceId,
        uint256 amount,
        uint256 usdValue
    ) external returns (bytes32 messageId);
}
