// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Hook target invoked by {ReentrantToken} on receipt of a transfer.
interface ITokenReceiveHook {
    function onTokensReceived() external;
}

/// @notice A malicious, ERC-777-style ERC-20 that calls a hook on a designated
///         recipient during every transfer TO that recipient. Used to prove the
///         SettlementEscrow's `withdraw` is safe against a reentrant token
///         callback: the recipient's hook tries to re-enter `withdraw`, and the
///         nonReentrant guard (plus checks-effects-interactions) blocks it.
///
///         Plain ERC-20s (like the real APT) have no such callback; this mock
///         exists only to exercise the guard under the worst case.
contract ReentrantToken is ERC20 {
    address public hookTarget;
    bool private _inHook;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Arm the hook: transfers to `target` will call its receive hook.
    function setHookTarget(address target) external {
        hookTarget = target;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to == hookTarget && hookTarget != address(0) && !_inHook) {
            _inHook = true;
            ITokenReceiveHook(hookTarget).onTokensReceived();
            _inHook = false;
        }
    }
}
