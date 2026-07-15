// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPolicyParameters} from "./interfaces/IPolicyParameters.sol";
import {IProviderStaking} from "./interfaces/IProviderStaking.sol";

/// @title ProviderStaking
/// @notice Per-provider APT collateral backing service quality. A provider must
///         stake to be spendable against (AgentWallet gates on {stakedOf} >=
///         `providerMinStake`). Unstaking has a cooldown equal to the live
///         `disputeWindow`, and governance can slash misbehaving providers.
/// @dev Design (kept deliberately minimal per the build brief):
///      - `active` collateral counts toward {stakedOf} and is slashable.
///      - {requestUnstake} moves collateral into a cooldown bucket that no longer
///        counts toward {stakedOf} (the provider signalled exit) BUT remains
///        slashable until actually withdrawn — which is the whole point of tying
///        the cooldown to the dispute window: a provider cannot stake, misbehave,
///        and yank collateral before governance can act.
///      - {slash} is authority-gated. The authority is this contract's owner,
///        which is the deployer in M3 and is transferred to `PolicyGovernor`
///        (its timelock) in M4 so that only a passed proposal can slash.
///      - All economic parameters (`disputeWindow`, `slashBps`, `treasury`) are
///        read LIVE from {IPolicyParameters}: a governance change takes effect
///        with no redeploy.
contract ProviderStaking is IProviderStaking, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Unstake {
        uint256 amount; // collateral in cooldown (slashable, not counted active)
        uint256 unlockAt; // timestamp the cooldown ends
    }

    IERC20 public immutable token; // APT
    IPolicyParameters public immutable policy; // live economic parameters

    /// @notice Active staked collateral per provider (counts toward {stakedOf}).
    mapping(address => uint256) private _active;

    /// @notice Pending cooldown withdrawal per provider.
    mapping(address => Unstake) private _cooldown;

    event Staked(address indexed provider, uint256 amount, uint256 newActive);
    event UnstakeRequested(
        address indexed provider, uint256 amount, uint256 unlockAt
    );
    event UnstakeCancelled(address indexed provider, uint256 amount, uint256 newActive);
    event Withdrawn(address indexed provider, uint256 amount);
    event Slashed(
        address indexed provider,
        uint256 amount,
        uint256 fromActive,
        uint256 fromCooldown,
        address indexed treasury
    );

    error ZeroAmount();
    error InsufficientActiveStake(uint256 requested, uint256 active);
    error NothingInCooldown();
    error CooldownNotElapsed(uint256 unlockAt);
    error NothingToSlash();

    constructor(IERC20 _token, IPolicyParameters _policy, address _owner)
        Ownable(_owner)
    {
        token = _token;
        policy = _policy;
    }

    // --- Provider actions ---

    /// @notice Stake `amount` APT as active collateral. Requires prior approval.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 newActive = _active[msg.sender] + amount;
        _active[msg.sender] = newActive;
        emit Staked(msg.sender, amount, newActive);
    }

    /// @notice Begin withdrawing `amount` from active collateral. It stops counting
    ///         toward {stakedOf} immediately, stays slashable, and becomes
    ///         withdrawable after the current `disputeWindow`.
    /// @dev A second request adds to the cooldown and resets the clock.
    function requestUnstake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 active = _active[msg.sender];
        if (amount > active) revert InsufficientActiveStake(amount, active);

        _active[msg.sender] = active - amount;
        Unstake storage u = _cooldown[msg.sender];
        u.amount += amount;
        u.unlockAt = block.timestamp + policy.disputeWindow();

        emit UnstakeRequested(msg.sender, amount, u.unlockAt);
    }

    /// @notice Cancel a pending cooldown and return the collateral to active.
    function cancelUnstake() external {
        Unstake storage u = _cooldown[msg.sender];
        uint256 amount = u.amount;
        if (amount == 0) revert NothingInCooldown();

        u.amount = 0;
        u.unlockAt = 0;
        uint256 newActive = _active[msg.sender] + amount;
        _active[msg.sender] = newActive;

        emit UnstakeCancelled(msg.sender, amount, newActive);
    }

    /// @notice Withdraw cooled-down collateral to the provider after the window.
    function withdraw() external nonReentrant {
        Unstake storage u = _cooldown[msg.sender];
        uint256 amount = u.amount;
        if (amount == 0) revert NothingInCooldown();
        if (block.timestamp < u.unlockAt) revert CooldownNotElapsed(u.unlockAt);

        u.amount = 0;
        u.unlockAt = 0;
        token.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    // --- Governance action ---

    /// @notice Slash a provider by the live `slashBps` of their TOTAL collateral
    ///         (active + cooldown). Slashed funds go to the live `treasury`.
    /// @dev Only the owner (the governance authority) may call. Deducts from
    ///      active collateral first, then from the cooldown bucket.
    function slash(address provider) external onlyOwner nonReentrant returns (uint256 amount) {
        uint256 active = _active[provider];
        Unstake storage u = _cooldown[provider];
        uint256 cooling = u.amount;
        uint256 total = active + cooling;
        if (total == 0) revert NothingToSlash();

        amount = (total * policy.slashBps()) / 10_000;
        if (amount == 0) revert NothingToSlash();

        uint256 fromActive = amount <= active ? amount : active;
        uint256 fromCooldown = amount - fromActive;

        _active[provider] = active - fromActive;
        if (fromCooldown > 0) {
            u.amount = cooling - fromCooldown;
        }

        address treasury = policy.treasury();
        token.safeTransfer(treasury, amount);

        emit Slashed(provider, amount, fromActive, fromCooldown, treasury);
    }

    // --- Views ---

    /// @inheritdoc IProviderStaking
    function stakedOf(address provider) external view returns (uint256) {
        return _active[provider];
    }

    /// @notice Collateral currently in cooldown for `provider`.
    function cooldownOf(address provider) external view returns (uint256 amount, uint256 unlockAt) {
        Unstake storage u = _cooldown[provider];
        return (u.amount, u.unlockAt);
    }

    /// @notice Total slashable collateral (active + cooldown) for `provider`.
    function totalCollateralOf(address provider) external view returns (uint256) {
        return _active[provider] + _cooldown[provider].amount;
    }
}
