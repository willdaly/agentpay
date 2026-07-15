// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPolicyParameters} from "../interfaces/IPolicyParameters.sol";

/// @notice Test double for the live governance parameter store. Every parameter
///         is independently settable so tests can drive each policy path. The
///         real implementation is `PolicyGovernor` (M4).
contract MockPolicyParameters is IPolicyParameters {
    uint256 public maxPerTxUsd;
    uint256 public defaultDailyBudgetUsd;
    uint256 public slashBps;
    uint256 public disputeWindow;
    address public treasury;
    uint256 public providerMinStake;
    bool public globalPause;

    constructor(
        uint256 _maxPerTxUsd,
        uint256 _defaultDailyBudgetUsd,
        uint256 _providerMinStake
    ) {
        maxPerTxUsd = _maxPerTxUsd;
        defaultDailyBudgetUsd = _defaultDailyBudgetUsd;
        providerMinStake = _providerMinStake;
        slashBps = 1000; // 10%
        disputeWindow = 1 days;
        treasury = msg.sender;
    }

    function setMaxPerTxUsd(uint256 v) external {
        maxPerTxUsd = v;
    }

    function setDefaultDailyBudgetUsd(uint256 v) external {
        defaultDailyBudgetUsd = v;
    }

    function setProviderMinStake(uint256 v) external {
        providerMinStake = v;
    }

    function setGlobalPause(bool v) external {
        globalPause = v;
    }

    function setTreasury(address v) external {
        treasury = v;
    }

    function setSlashBps(uint256 v) external {
        slashBps = v;
    }

    function setDisputeWindow(uint256 v) external {
        disputeWindow = v;
    }
}
