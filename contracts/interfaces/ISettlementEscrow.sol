// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ISettlementEscrow
/// @notice Sink AgentWallet pays into. Pull-over-push: a spend credits the
///         provider's balance here; the provider later withdraw()s. A provider
///         that reverts on receipt can never block an agent's spend.
/// @dev Concrete implementation (`SettlementEscrow`) arrives in M3. The wallet
///      transfers APT to the escrow and then calls {credit} to record the claim,
///      so the escrow's token balance and its internal ledger stay in lockstep.
interface ISettlementEscrow {
    /// @notice Record that `amount` APT (already transferred to this escrow) is
    ///         owed to `provider` for `serviceId`.
    /// @dev MUST be called only after the tokens have been transferred in, and
    ///      only by an authorized payer (an AgentWallet from the known factory).
    function credit(address provider, uint256 serviceId, uint256 amount) external;
}
