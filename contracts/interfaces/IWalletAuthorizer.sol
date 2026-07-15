// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IWalletAuthorizer
/// @notice Minimal provenance oracle: answers "did I create this wallet?". The
///         settlement escrow uses it to accept `credit` calls only from genuine
///         {AgentWallet}s, never from arbitrary addresses.
/// @dev {AgentWalletFactory} implements this via its `isWallet` mapping.
interface IWalletAuthorizer {
    function isWallet(address account) external view returns (bool);
}
