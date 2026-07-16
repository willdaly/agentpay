// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IWalletAuthorizer} from "./interfaces/IWalletAuthorizer.sol";

/// @title AllowlistAuthorizer
/// @notice An owner-managed {IWalletAuthorizer} for contexts where there is no
///         {AgentWalletFactory} to vouch for payers.
/// @dev Used on the REMOTE chain (e.g. Base Sepolia): agent wallets and their
///      factory live on the home chain, so the remote {SettlementEscrow} has no
///      factory to ask. Instead it consults this allowlist, which names the
///      {CrossChainSpendRouter} as the only authorized payer. On the home chain
///      the factory itself is the authorizer and this contract is not used.
contract AllowlistAuthorizer is IWalletAuthorizer, Ownable {
    /// @notice payer => authorized to credit the escrow.
    mapping(address => bool) public override isWallet;

    event AuthorizationSet(address indexed account, bool allowed);

    error ZeroAddress();

    constructor(address _owner) Ownable(_owner) {}

    /// @notice Authorize (or revoke) an address as a credit-capable payer.
    function setAuthorized(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        isWallet[account] = allowed;
        emit AuthorizationSet(account, allowed);
    }
}
