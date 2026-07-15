// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentWallet} from "./AgentWallet.sol";
import {IPolicyParameters} from "./interfaces/IPolicyParameters.sol";
import {IPriceFeedAdapter} from "./interfaces/IPriceFeedAdapter.sol";
import {IServiceRegistry} from "./interfaces/IServiceRegistry.sol";
import {IProviderStaking} from "./interfaces/IProviderStaking.sol";
import {ISettlementEscrow} from "./interfaces/ISettlementEscrow.sol";

/// @title AgentWalletFactory
/// @notice Deploys {AgentWallet} instances that share one set of platform
///         dependencies (token, policy, price feed, registry, staking, escrow).
/// @dev Also the authority on wallet provenance: {isWallet} lets the settlement
///      escrow authorize only payers that this factory produced.
contract AgentWalletFactory {
    IERC20 public immutable token;
    IPolicyParameters public immutable policy;
    IPriceFeedAdapter public immutable priceFeed;
    IServiceRegistry public immutable registry;
    IProviderStaking public immutable staking;
    ISettlementEscrow public immutable escrow;
    uint64 public immutable localChainSelector;

    /// @notice Every wallet ever created by this factory, in creation order.
    address[] public allWallets;

    /// @notice wallet address => created by this factory.
    mapping(address => bool) public isWallet;

    /// @notice owner => their wallets.
    mapping(address => address[]) private _walletsOfOwner;

    event WalletCreated(
        address indexed wallet, address indexed owner, address indexed agent
    );

    error ZeroAddress();

    constructor(
        IERC20 _token,
        IPolicyParameters _policy,
        IPriceFeedAdapter _priceFeed,
        IServiceRegistry _registry,
        IProviderStaking _staking,
        ISettlementEscrow _escrow,
        uint64 _localChainSelector
    ) {
        if (
            address(_token) == address(0) || address(_policy) == address(0)
                || address(_priceFeed) == address(0) || address(_registry) == address(0)
                || address(_staking) == address(0) || address(_escrow) == address(0)
        ) revert ZeroAddress();

        token = _token;
        policy = _policy;
        priceFeed = _priceFeed;
        registry = _registry;
        staking = _staking;
        escrow = _escrow;
        localChainSelector = _localChainSelector;
    }

    /// @notice Deploy a new agent wallet.
    /// @param owner Admin of the new wallet (sets policy, funds, appoints agent).
    /// @param agent Operator permitted to call spend (may equal owner, or be zero
    ///        and set later by the owner).
    /// @return wallet The address of the newly deployed {AgentWallet}.
    function createWallet(address owner, address agent) external returns (address wallet) {
        if (owner == address(0)) revert ZeroAddress();

        AgentWallet w = new AgentWallet(
            owner,
            agent,
            token,
            policy,
            priceFeed,
            registry,
            staking,
            escrow,
            localChainSelector
        );
        wallet = address(w);

        allWallets.push(wallet);
        isWallet[wallet] = true;
        _walletsOfOwner[owner].push(wallet);

        emit WalletCreated(wallet, owner, agent);
    }

    /// @notice Number of wallets created by this factory.
    function walletCount() external view returns (uint256) {
        return allWallets.length;
    }

    /// @notice Wallets owned by `owner`.
    function walletsOf(address owner) external view returns (address[] memory) {
        return _walletsOfOwner[owner];
    }
}
