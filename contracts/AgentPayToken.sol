// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title AgentPayToken (APT)
/// @notice The single ERC-20 of the AgentPay platform. Testnet only; valueless.
/// @dev Triple duty:
///      1. Governance voting weight via {ERC20Votes} (checkpointed balances +
///         delegation) — consumed by `PolicyGovernor`.
///      2. Provider staking collateral — consumed by `ProviderStaking`.
///      3. The unit AI agents spend for services — moved by `AgentWallet`.
///      Fixed supply is minted to the deployer at construction for demo
///      distribution. There is NO open mint; the only post-deploy minting is
///      {faucet}, which is explicitly a demo convenience (see its NatSpec) and
///      would be removed for any non-testnet deployment.
contract AgentPayToken is ERC20, ERC20Permit, ERC20Votes {
    /// @notice Per-call cap on the demo faucet, in wei (18 decimals).
    uint256 public constant FAUCET_AMOUNT = 1_000 ether;

    /// @param initialSupply Fixed supply (wei) minted to `initialHolder`.
    /// @param initialHolder Recipient of the initial supply (the deployer/treasury).
    constructor(uint256 initialSupply, address initialHolder)
        ERC20("AgentPay Token", "APT")
        ERC20Permit("AgentPay Token")
    {
        _mint(initialHolder, initialSupply);
    }

    /// @notice DEMO ONLY. Mints {FAUCET_AMOUNT} APT to the caller so testnet
    ///         demo participants (agents, providers) can self-fund without the
    ///         deployer distributing manually.
    /// @dev This function breaks the fixed-supply invariant and MUST be removed
    ///      before any deployment that is not a valueless testnet demo. It is
    ///      documented as a deliberate, disclosed testnet affordance.
    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    // --- Required multiple-inheritance overrides (ERC20Votes + Nonces) ---

    /// @inheritdoc ERC20
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Votes)
    {
        super._update(from, to, value);
    }

    /// @inheritdoc Nonces
    function nonces(address owner)
        public
        view
        override(ERC20Permit, Nonces)
        returns (uint256)
    {
        return super.nonces(owner);
    }
}
