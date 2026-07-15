// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IProviderStaking} from "../interfaces/IProviderStaking.sol";

/// @notice Test double for provider collateral. Tests set a provider's staked
///         balance directly to exercise the understaked-rejection path. Real
///         implementation is `ProviderStaking` (M3).
contract MockProviderStaking is IProviderStaking {
    mapping(address => uint256) public staked;

    function setStake(address provider, uint256 amount) external {
        staked[provider] = amount;
    }

    function stakedOf(address provider) external view returns (uint256) {
        return staked[provider];
    }
}
