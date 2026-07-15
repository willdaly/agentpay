// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IWalletAuthorizer} from "../interfaces/IWalletAuthorizer.sol";

/// @notice Test double for wallet provenance. Lets escrow tests authorize an
///         arbitrary address (an EOA standing in for an AgentWallet) as a payer.
contract MockWalletAuthorizer is IWalletAuthorizer {
    mapping(address => bool) public authorized;

    function setWallet(address account, bool ok) external {
        authorized[account] = ok;
    }

    function isWallet(address account) external view returns (bool) {
        return authorized[account];
    }
}
