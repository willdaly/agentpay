// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ISettlementEscrow} from "../interfaces/ISettlementEscrow.sol";

/// @notice Test double for the pull-payment sink. Records credits so tests can
///         assert the provider was credited the right amount for the right
///         service. Real implementation is `SettlementEscrow` (M3).
contract MockSettlementEscrow is ISettlementEscrow {
    mapping(address => uint256) public creditedTo;
    uint256 public lastServiceId;
    address public lastProvider;
    uint256 public lastAmount;
    uint256 public creditCallCount;

    function credit(address provider, uint256 serviceId, uint256 amount) external {
        creditedTo[provider] += amount;
        lastProvider = provider;
        lastServiceId = serviceId;
        lastAmount = amount;
        creditCallCount++;
    }
}
