// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IProviderStaking
/// @notice Read surface AgentWallet uses to gate spends on provider collateral.
/// @dev Concrete implementation (`ProviderStaking`) arrives in M3. AgentWallet
///      depends only on this interface so the understaked-provider check can be
///      unit-tested with a mock now and wired to the real staking contract later.
interface IProviderStaking {
    /// @notice Active staked APT (wei) attributed to `provider`. Excludes amounts
    ///         in cooldown / pending withdrawal.
    function stakedOf(address provider) external view returns (uint256);
}
