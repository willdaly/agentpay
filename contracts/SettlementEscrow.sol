// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISettlementEscrow} from "./interfaces/ISettlementEscrow.sol";
import {IPolicyParameters} from "./interfaces/IPolicyParameters.sol";
import {IWalletAuthorizer} from "./interfaces/IWalletAuthorizer.sol";

/// @title SettlementEscrow
/// @notice Pull-over-push settlement sink for agent spends (lineage: the midterm
///         `ModelMarketplace` pull-payment flow). AgentWallet transfers APT here
///         and calls {credit}; providers later {withdraw}. A provider that would
///         revert on receipt can never block an agent's spend, because a spend
///         performs no call to the provider.
/// @dev Two settlement modes, selected by the LIVE `disputeWindow`:
///      - window == 0: the credit is immediately withdrawable (fast settlement).
///      - window  > 0: the credit becomes a time-locked {Payment} that anyone can
///        {release} once the window elapses. The delay gives governance a chance
///        to slash the provider's stake (in `ProviderStaking`) before funds are
///        withdrawable. Automated payment clawback / dispute arbitration is
///        deliberately out of scope; governance staking-slash is the recourse.
///
///      {withdraw} follows checks-effects-interactions and is `nonReentrant`.
///      Only wallets vouched for by the {IWalletAuthorizer} (the factory) may
///      {credit}, so the internal ledger cannot be inflated by arbitrary callers.
contract SettlementEscrow is ISettlementEscrow, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Payment {
        address provider;
        bool released;
        uint256 serviceId;
        address payer;
        uint256 amount;
        uint256 releaseAt;
    }

    IERC20 public immutable token; // APT
    IPolicyParameters public immutable policy; // live economic parameters
    IWalletAuthorizer public immutable authorizer; // vouches for genuine wallets

    /// @notice Balance each provider can pull right now.
    mapping(address => uint256) public withdrawable;

    /// @notice Time-locked payments awaiting release, by id (from 1).
    mapping(uint256 => Payment) private _payments;

    /// @notice Number of time-locked payments ever created; highest valid id.
    uint256 public paymentCount;

    /// @notice Total APT this escrow owes (withdrawable + not-yet-released).
    ///         Invariant: token.balanceOf(this) >= totalOwed.
    uint256 public totalOwed;

    event PaymentSettled(
        address indexed provider, uint256 indexed serviceId, uint256 amount
    );
    event PaymentPending(
        uint256 indexed paymentId,
        address indexed provider,
        address indexed payer,
        uint256 serviceId,
        uint256 amount,
        uint256 releaseAt
    );
    event PaymentReleased(
        uint256 indexed paymentId, address indexed provider, uint256 amount
    );
    event Withdrawn(address indexed provider, uint256 amount);

    error NotAuthorizedPayer(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error UnknownPayment(uint256 paymentId);
    error AlreadyReleased(uint256 paymentId);
    error ReleaseNotReady(uint256 paymentId, uint256 releaseAt);
    error NothingToWithdraw();

    constructor(
        IERC20 _token,
        IPolicyParameters _policy,
        IWalletAuthorizer _authorizer,
        address _owner
    ) Ownable(_owner) {
        if (
            address(_token) == address(0) || address(_policy) == address(0)
                || address(_authorizer) == address(0)
        ) revert ZeroAddress();
        token = _token;
        policy = _policy;
        authorizer = _authorizer;
    }

    /// @inheritdoc ISettlementEscrow
    /// @dev Tokens MUST already have been transferred to this escrow by the caller
    ///      (the AgentWallet) before this call; only vouched wallets may call.
    function credit(address provider, uint256 serviceId, uint256 amount) external {
        if (!authorizer.isWallet(msg.sender)) revert NotAuthorizedPayer(msg.sender);
        if (provider == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        totalOwed += amount;

        uint256 window = policy.disputeWindow();
        if (window == 0) {
            withdrawable[provider] += amount;
            emit PaymentSettled(provider, serviceId, amount);
            return;
        }

        uint256 releaseAt = block.timestamp + window;
        uint256 id = ++paymentCount;
        _payments[id] = Payment({
            provider: provider,
            released: false,
            serviceId: serviceId,
            payer: msg.sender,
            amount: amount,
            releaseAt: releaseAt
        });
        emit PaymentPending(id, provider, msg.sender, serviceId, amount, releaseAt);
    }

    /// @notice Release a time-locked payment once its window has elapsed.
    /// @dev Permissionless crank: anyone may trigger the release to the provider.
    function release(uint256 paymentId) external {
        Payment storage p = _payments[paymentId];
        if (p.amount == 0) revert UnknownPayment(paymentId);
        if (p.released) revert AlreadyReleased(paymentId);
        if (block.timestamp < p.releaseAt) revert ReleaseNotReady(paymentId, p.releaseAt);

        p.released = true;
        withdrawable[p.provider] += p.amount;

        emit PaymentReleased(paymentId, p.provider, p.amount);
    }

    /// @notice Pull all currently-withdrawable APT to the caller.
    function withdraw() external nonReentrant returns (uint256 amount) {
        amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        withdrawable[msg.sender] = 0;
        totalOwed -= amount;
        token.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    // --- Views ---

    /// @notice Full record of a time-locked payment.
    function getPayment(uint256 paymentId) external view returns (Payment memory) {
        if (_payments[paymentId].amount == 0) revert UnknownPayment(paymentId);
        return _payments[paymentId];
    }

    /// @notice True while the escrow holds at least what it owes (monitoring aid).
    function solvent() external view returns (bool) {
        return token.balanceOf(address(this)) >= totalOwed;
    }
}
