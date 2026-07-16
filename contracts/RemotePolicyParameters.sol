// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPolicyParameters} from "./interfaces/IPolicyParameters.sol";

/// @title RemotePolicyParameters
/// @notice A minimal, administered {IPolicyParameters} store for REMOTE chains.
/// @dev Governance (`PolicyGovernor`) lives on the home chain (Sepolia) — that is
///      a deliberate architecture decision, not an oversight. But the remote
///      {SettlementEscrow} still needs to read `disputeWindow` at credit time, so
///      the remote chain needs *some* IPolicyParameters implementation.
///
///      HONEST LIMITATION: these values are set by an owner (the deployer, then
///      ideally a remote admin/multisig), NOT by the DAO. They are a mirror of the
///      home-chain parameters maintained out-of-band, so the two chains can drift.
///      Only `disputeWindow` is actually consumed on the remote chain today; the
///      spend-gating parameters (caps, budgets, pause, min-stake) are enforced on
///      the HOME chain before any CCIP message is sent, so remote drift cannot
///      widen an agent's spending authority.
///
///      Future work: have governance push parameter updates to remote chains over
///      CCIP so the DAO is the single source of truth on every chain.
contract RemotePolicyParameters is IPolicyParameters, Ownable {
    uint256 public override maxPerTxUsd;
    uint256 public override defaultDailyBudgetUsd;
    uint256 public override slashBps;
    uint256 public override disputeWindow;
    address public override treasury;
    uint256 public override providerMinStake;
    bool public override globalPause;

    event ParametersUpdated(
        uint256 maxPerTxUsd,
        uint256 defaultDailyBudgetUsd,
        uint256 slashBps,
        uint256 disputeWindow,
        address treasury,
        uint256 providerMinStake
    );
    event GlobalPauseSet(bool value);

    error InvalidSlashBps(uint256 value);
    error ZeroTreasury();

    constructor(
        address _owner,
        uint256 _maxPerTxUsd,
        uint256 _defaultDailyBudgetUsd,
        uint256 _slashBps,
        uint256 _disputeWindow,
        address _treasury,
        uint256 _providerMinStake
    ) Ownable(_owner) {
        _set(
            _maxPerTxUsd,
            _defaultDailyBudgetUsd,
            _slashBps,
            _disputeWindow,
            _treasury,
            _providerMinStake
        );
    }

    /// @notice Mirror the home-chain parameters onto this chain.
    function setParameters(
        uint256 _maxPerTxUsd,
        uint256 _defaultDailyBudgetUsd,
        uint256 _slashBps,
        uint256 _disputeWindow,
        address _treasury,
        uint256 _providerMinStake
    ) external onlyOwner {
        _set(
            _maxPerTxUsd,
            _defaultDailyBudgetUsd,
            _slashBps,
            _disputeWindow,
            _treasury,
            _providerMinStake
        );
    }

    /// @notice Remote emergency stop (does not affect the home chain).
    function setGlobalPause(bool value) external onlyOwner {
        globalPause = value;
        emit GlobalPauseSet(value);
    }

    function _set(
        uint256 _maxPerTxUsd,
        uint256 _defaultDailyBudgetUsd,
        uint256 _slashBps,
        uint256 _disputeWindow,
        address _treasury,
        uint256 _providerMinStake
    ) private {
        if (_slashBps > 10_000) revert InvalidSlashBps(_slashBps);
        if (_treasury == address(0)) revert ZeroTreasury();

        maxPerTxUsd = _maxPerTxUsd;
        defaultDailyBudgetUsd = _defaultDailyBudgetUsd;
        slashBps = _slashBps;
        disputeWindow = _disputeWindow;
        treasury = _treasury;
        providerMinStake = _providerMinStake;

        emit ParametersUpdated(
            _maxPerTxUsd,
            _defaultDailyBudgetUsd,
            _slashBps,
            _disputeWindow,
            _treasury,
            _providerMinStake
        );
    }
}
