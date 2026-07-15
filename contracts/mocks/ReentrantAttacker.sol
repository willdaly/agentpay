// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ITokenReceiveHook} from "./ReentrantToken.sol";

interface IWithdrawable {
    function withdraw() external returns (uint256);
}

/// @notice Provider mock that attempts to re-enter SettlementEscrow.withdraw()
///         from a token-receive hook. The escrow's nonReentrant guard must make
///         the re-entrant call revert, so the whole withdraw reverts.
contract ReentrantAttacker is ITokenReceiveHook {
    IWithdrawable public immutable escrow;
    bool public reentered;

    constructor(IWithdrawable _escrow) {
        escrow = _escrow;
    }

    function attack() external {
        escrow.withdraw();
    }

    function onTokensReceived() external {
        // Re-enter exactly once; the guard should make this revert and bubble up.
        if (!reentered) {
            reentered = true;
            escrow.withdraw();
        }
    }
}
