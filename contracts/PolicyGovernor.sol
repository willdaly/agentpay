// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from
    "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorCountingSimple} from
    "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorVotes} from
    "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {GovernorVotesQuorumFraction} from
    "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {GovernorTimelockControl} from
    "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {TimelockController} from
    "@openzeppelin/contracts/governance/TimelockController.sol";

import {IPolicyParameters} from "./interfaces/IPolicyParameters.sol";

/// @title PolicyGovernor
/// @notice THE ARCHITECTURAL CENTERPIECE (lineage: the Module 7 midterm's
///         `MarketplaceGovernor`). A token-weighted DAO that is *also* the live
///         parameter store the rest of the platform reads.
/// @dev Two roles in one contract:
///
///      1. A standard OpenZeppelin Governor: APT holders (via ERC20Votes weight)
///         propose, vote, and — after the timelock delay — execute changes.
///
///      2. The `IPolicyParameters` store: the seven global risk parameters live
///         in this contract's storage. Consumers (`AgentWallet`, `ProviderStaking`,
///         `SettlementEscrow`) hold an `IPolicyParameters` reference and read
///         these values AT TRANSACTION TIME — never caching them. Each setter is
///         `onlyGovernance`, so it can be called only by the timelock executing a
///         passed proposal.
///
///      The consequence — and the property the governance lifecycle test asserts —
///      is that a passed proposal changes system-wide behavior with NO redeploy and
///      NO migration. The same `AgentWallet.spend()` that reverted on a cap check
///      succeeds once governance raises the cap, because the wallet re-reads
///      {maxPerTxUsd} live on the next call.
contract PolicyGovernor is
    IPolicyParameters,
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    // --- IPolicyParameters live store (mutated only by governance) ---

    uint256 public override maxPerTxUsd;
    uint256 public override defaultDailyBudgetUsd;
    uint256 public override slashBps;
    uint256 public override disputeWindow;
    address public override treasury;
    uint256 public override providerMinStake;
    bool public override globalPause;

    /// @notice Initial values for the parameter store, set once at construction.
    struct InitialParameters {
        uint256 maxPerTxUsd;
        uint256 defaultDailyBudgetUsd;
        uint256 slashBps;
        uint256 disputeWindow;
        address treasury;
        uint256 providerMinStake;
    }

    event MaxPerTxUsdSet(uint256 value);
    event DefaultDailyBudgetUsdSet(uint256 value);
    event SlashBpsSet(uint256 value);
    event DisputeWindowSet(uint256 value);
    event TreasurySet(address value);
    event ProviderMinStakeSet(uint256 value);
    event GlobalPauseSet(bool value);

    error InvalidSlashBps(uint256 value);
    error ZeroTreasury();

    /// @param token The ERC20Votes governance token (APT).
    /// @param timelock The timelock that queues and executes passed proposals.
    /// @param votingDelayBlocks Blocks between proposal creation and voting start.
    /// @param votingPeriodBlocks Blocks the vote stays open.
    /// @param proposalThresholdVotes Min votes to create a proposal.
    /// @param quorumPercent Quorum as a percentage of total voting supply.
    /// @param init Initial parameter-store values.
    constructor(
        IVotes token,
        TimelockController timelock,
        uint48 votingDelayBlocks,
        uint32 votingPeriodBlocks,
        uint256 proposalThresholdVotes,
        uint256 quorumPercent,
        InitialParameters memory init
    )
        Governor("PolicyGovernor")
        GovernorSettings(votingDelayBlocks, votingPeriodBlocks, proposalThresholdVotes)
        GovernorVotes(token)
        GovernorVotesQuorumFraction(quorumPercent)
        GovernorTimelockControl(timelock)
    {
        if (init.slashBps > 10_000) revert InvalidSlashBps(init.slashBps);
        if (init.treasury == address(0)) revert ZeroTreasury();

        maxPerTxUsd = init.maxPerTxUsd;
        defaultDailyBudgetUsd = init.defaultDailyBudgetUsd;
        slashBps = init.slashBps;
        disputeWindow = init.disputeWindow;
        treasury = init.treasury;
        providerMinStake = init.providerMinStake;
        // globalPause defaults to false.
    }

    // --- Parameter setters (governance-only: callable only via a passed proposal) ---

    function setMaxPerTxUsd(uint256 value) external onlyGovernance {
        maxPerTxUsd = value;
        emit MaxPerTxUsdSet(value);
    }

    function setDefaultDailyBudgetUsd(uint256 value) external onlyGovernance {
        defaultDailyBudgetUsd = value;
        emit DefaultDailyBudgetUsdSet(value);
    }

    function setSlashBps(uint256 value) external onlyGovernance {
        if (value > 10_000) revert InvalidSlashBps(value);
        slashBps = value;
        emit SlashBpsSet(value);
    }

    function setDisputeWindow(uint256 value) external onlyGovernance {
        disputeWindow = value;
        emit DisputeWindowSet(value);
    }

    function setTreasury(address value) external onlyGovernance {
        if (value == address(0)) revert ZeroTreasury();
        treasury = value;
        emit TreasurySet(value);
    }

    function setProviderMinStake(uint256 value) external onlyGovernance {
        providerMinStake = value;
        emit ProviderMinStakeSet(value);
    }

    function setGlobalPause(bool value) external onlyGovernance {
        globalPause = value;
        emit GlobalPauseSet(value);
    }

    // --- Required overrides across the Governor stack ---

    function votingDelay()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingDelay();
    }

    function votingPeriod()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingPeriod();
    }

    function quorum(uint256 timepoint)
        public
        view
        override(Governor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        return super.quorum(timepoint);
    }

    function state(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    {
        return super.state(proposalId);
    }

    function proposalNeedsQueuing(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.proposalNeedsQueuing(proposalId);
    }

    function proposalThreshold()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.proposalThreshold();
    }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(
            proposalId, targets, values, calldatas, descriptionHash
        );
    }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(
            proposalId, targets, values, calldatas, descriptionHash
        );
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor()
        internal
        view
        override(Governor, GovernorTimelockControl)
        returns (address)
    {
        return super._executor();
    }
}
