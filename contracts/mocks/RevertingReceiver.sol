// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice A hostile provider that reverts on any plain call or ETH transfer.
///         Used to prove that a spend still succeeds when the provider is
///         uncooperative — because pull-over-push settlement never calls the
///         provider during a spend (it only credits the escrow ledger).
contract RevertingReceiver {
    error Nope();

    fallback() external payable {
        revert Nope();
    }

    receive() external payable {
        revert Nope();
    }
}
