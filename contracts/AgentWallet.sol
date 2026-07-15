// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPolicyParameters} from "./interfaces/IPolicyParameters.sol";
import {IPriceFeedAdapter} from "./interfaces/IPriceFeedAdapter.sol";
import {IServiceRegistry} from "./interfaces/IServiceRegistry.sol";
import {IProviderStaking} from "./interfaces/IProviderStaking.sol";
import {ISettlementEscrow} from "./interfaces/ISettlementEscrow.sol";

/// @title AgentWallet — the product
/// @notice A per-agent smart account that holds APT and enforces on-chain spend
///         policy at `spend()` time. This is the control plane: even a fully
///         compromised agent runtime holding the operator key cannot spend
///         outside the limits an admin (and global governance) set for it.
/// @dev ROLE SPLIT (why it matters). Two distinct actors:
///      - `owner` (admin / enterprise): sets the allowlist, local caps, local
///        pause, funds and defunds the wallet, and appoints the agent operator.
///      - `agent` (operator key the off-chain CLI runs with): may only call
///        {spend}, and only within the limits. It cannot raise its own limits.
///      A compromised operator key is therefore bounded by admin-set local policy
///      AND by global governance policy read live from {IPolicyParameters}.
///
///      Every spend runs checks in strict checks-effects-interactions order and
///      is `nonReentrant`. Rejections revert with typed custom errors because the
///      live demo shows each one firing. Settlement is pull-over-push: funds are
///      credited to {ISettlementEscrow}, never pushed to the provider, so a
///      provider that reverts on receipt cannot grief the agent.
contract AgentWallet is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Immutable wiring (shared across all wallets from one factory) ---

    IERC20 public immutable token; // APT
    IPolicyParameters public immutable policy; // live governance parameters
    IPriceFeedAdapter public immutable priceFeed; // USD <-> APT at live oracle price
    IServiceRegistry public immutable registry; // service catalog
    IProviderStaking public immutable staking; // provider collateral gate
    ISettlementEscrow public immutable escrow; // pull-payment sink
    uint64 public immutable localChainSelector; // CCIP selector of this chain

    // --- Local, admin-managed policy ---

    /// @notice Operator permitted to call {spend}. Set by the owner.
    address public agent;

    /// @notice Owner-controlled local kill switch, layered over the global pause.
    bool public localPaused;

    /// @notice Local per-tx USD cap (8-decimal). 0 = unset: only the global cap
    ///         applies. When set, the effective cap is min(local, global).
    uint256 public localMaxPerTxUsd;

    /// @notice Local rolling daily budget in USD (8-decimal). 0 = unset: the
    ///         governance `defaultDailyBudgetUsd` applies.
    uint256 public localDailyBudgetUsd;

    /// @notice serviceId => allowed. Only allowlisted services can be paid.
    mapping(uint256 => bool) public allowedService;

    // --- Daily budget accounting (USD, 8-decimal, day-bucketed) ---

    /// @notice Day bucket (block.timestamp / 1 days) the counter currently tracks.
    uint256 public currentDay;

    /// @notice USD spent within `currentDay`. Reset lazily on the first spend of a
    ///         new day. Read {spentTodayUsd} for a rollover-aware view.
    uint256 public spentThisDayUsd;

    // --- Events ---

    /// @notice Rich audit record: the whole spend history is reconstructable from
    ///         these logs alone (the "monitoring/logging" evidence).
    event SpendExecuted(
        address indexed agentWallet,
        uint256 indexed serviceId,
        address indexed provider,
        uint256 tokenAmount, // APT (wei) moved to escrow
        uint256 usdValue, // USD (8-decimal) value at the feed price used
        uint64 chainSelector, // settlement chain of the service
        bytes32 policySnapshot // hash of governance + effective local policy at spend time
    );
    event AgentUpdated(address indexed previousAgent, address indexed newAgent);
    event LocalPauseSet(bool paused);
    event LocalMaxPerTxUsdSet(uint256 usd);
    event LocalDailyBudgetUsdSet(uint256 usd);
    event ServiceAllowanceSet(uint256 indexed serviceId, bool allowed);
    event Funded(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    // --- Errors (typed reasons; demonstrated live) ---

    error Paused();
    error NotAuthorizedAgent(address caller);
    error CounterpartyNotAllowed(uint256 serviceId);
    error ServiceNotActive(uint256 serviceId);
    error ProviderUnderstaked(address provider, uint256 staked, uint256 required);
    error ExceedsPerTxCap(uint256 usdValue, uint256 capUsd);
    error ExceedsDailyBudget(uint256 usdValue, uint256 spentUsd, uint256 budgetUsd);
    error InsufficientBalance(uint256 needed, uint256 available);
    error RemoteServiceUnsupported(uint64 homeChainSelector, uint64 localChainSelector);
    error ZeroAddress();

    /// @param _owner Admin of this wallet.
    /// @param _agent Operator permitted to call {spend} (may equal the owner).
    /// @param _token APT token.
    /// @param _policy Live governance parameters.
    /// @param _priceFeed USD <-> APT price adapter for this chain.
    /// @param _registry Service catalog.
    /// @param _staking Provider staking gate.
    /// @param _escrow Pull-payment settlement sink.
    /// @param _localChainSelector CCIP chain selector of the chain this wallet lives on.
    constructor(
        address _owner,
        address _agent,
        IERC20 _token,
        IPolicyParameters _policy,
        IPriceFeedAdapter _priceFeed,
        IServiceRegistry _registry,
        IProviderStaking _staking,
        ISettlementEscrow _escrow,
        uint64 _localChainSelector
    ) Ownable(_owner) {
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
        agent = _agent; // may be zero; owner can set it later
    }

    // --- Core: policy-enforced spend ---

    /// @notice Pay for `serviceId` at its registered USD price, converted to APT at
    ///         the live oracle price, subject to every policy check below.
    /// @dev Checks (in order) -> effects -> interactions. `nonReentrant`.
    /// @return tokenAmount APT (wei) credited to the provider in the escrow.
    function spend(uint256 serviceId)
        external
        nonReentrant
        returns (uint256 tokenAmount)
    {
        // --- CHECKS ---
        if (msg.sender != agent && msg.sender != owner()) {
            revert NotAuthorizedAgent(msg.sender);
        }
        if (localPaused || policy.globalPause()) revert Paused();
        if (!allowedService[serviceId]) revert CounterpartyNotAllowed(serviceId);
        if (!registry.isActive(serviceId)) revert ServiceNotActive(serviceId);

        IServiceRegistry.Service memory svc = registry.getService(serviceId);

        if (svc.homeChainSelector != localChainSelector) {
            revert RemoteServiceUnsupported(svc.homeChainSelector, localChainSelector);
        }

        uint256 required = policy.providerMinStake();
        uint256 staked = staking.stakedOf(svc.provider);
        if (staked < required) {
            revert ProviderUnderstaked(svc.provider, staked, required);
        }

        // USD value of this spend (8-decimal). $1 == 100 cents == 1e8.
        uint256 usdValue = svc.priceUsdCents * 1e6;

        uint256 capUsd = _effectiveMaxPerTxUsd();
        if (usdValue > capUsd) revert ExceedsPerTxCap(usdValue, capUsd);

        uint256 budgetUsd = _effectiveDailyBudgetUsd();
        uint256 today = block.timestamp / 1 days;
        uint256 spentUsd = (today == currentDay) ? spentThisDayUsd : 0;
        if (spentUsd + usdValue > budgetUsd) {
            revert ExceedsDailyBudget(usdValue, spentUsd, budgetUsd);
        }

        // Live oracle read; reverts (StalePrice / bad answer) if the feed is unhealthy.
        tokenAmount = priceFeed.usdToToken(usdValue);

        uint256 balance = token.balanceOf(address(this));
        if (balance < tokenAmount) revert InsufficientBalance(tokenAmount, balance);

        // --- EFFECTS ---
        currentDay = today;
        spentThisDayUsd = spentUsd + usdValue;

        bytes32 snapshot = _policySnapshot(capUsd, budgetUsd, required, usdValue);

        // --- INTERACTIONS ---
        token.safeTransfer(address(escrow), tokenAmount);
        escrow.credit(svc.provider, serviceId, tokenAmount);

        emit SpendExecuted(
            address(this),
            serviceId,
            svc.provider,
            tokenAmount,
            usdValue,
            svc.homeChainSelector,
            snapshot
        );
    }

    // --- Admin (owner-only) configuration ---

    /// @notice Appoint (or clear) the operator permitted to call {spend}.
    function setAgent(address newAgent) external onlyOwner {
        emit AgentUpdated(agent, newAgent);
        agent = newAgent;
    }

    /// @notice Owner kill switch, independent of the global pause.
    function setLocalPaused(bool paused) external onlyOwner {
        localPaused = paused;
        emit LocalPauseSet(paused);
    }

    /// @notice Set the local per-tx USD cap (8-decimal). 0 clears it (global only).
    function setLocalMaxPerTxUsd(uint256 usd) external onlyOwner {
        localMaxPerTxUsd = usd;
        emit LocalMaxPerTxUsdSet(usd);
    }

    /// @notice Set the local daily budget in USD (8-decimal). 0 clears it (uses
    ///         the governance default).
    function setLocalDailyBudgetUsd(uint256 usd) external onlyOwner {
        localDailyBudgetUsd = usd;
        emit LocalDailyBudgetUsdSet(usd);
    }

    /// @notice Add or remove a service from this wallet's counterparty allowlist.
    function setServiceAllowed(uint256 serviceId, bool allowed) external onlyOwner {
        allowedService[serviceId] = allowed;
        emit ServiceAllowanceSet(serviceId, allowed);
    }

    // --- Funding / recovery ---

    /// @notice Pull `amount` APT from the caller into this wallet. Convenience for
    ///         funding; a plain ERC-20 transfer to this address works too.
    function fund(uint256 amount) external {
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    /// @notice Owner recovers APT from the wallet.
    function withdraw(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    // --- Views ---

    /// @notice Effective per-tx USD cap: min(local, global) if local set, else global.
    function effectiveMaxPerTxUsd() external view returns (uint256) {
        return _effectiveMaxPerTxUsd();
    }

    /// @notice Effective daily budget USD: local if set, else governance default.
    function effectiveDailyBudgetUsd() external view returns (uint256) {
        return _effectiveDailyBudgetUsd();
    }

    /// @notice USD spent today, accounting for day rollover (returns 0 on a new day).
    function spentTodayUsd() external view returns (uint256) {
        return (block.timestamp / 1 days == currentDay) ? spentThisDayUsd : 0;
    }

    /// @notice Remaining USD spendable today under the effective budget.
    function remainingDailyBudgetUsd() external view returns (uint256) {
        uint256 budget = _effectiveDailyBudgetUsd();
        uint256 spent = (block.timestamp / 1 days == currentDay) ? spentThisDayUsd : 0;
        return spent >= budget ? 0 : budget - spent;
    }

    // --- Internal ---

    function _effectiveMaxPerTxUsd() private view returns (uint256) {
        uint256 globalCap = policy.maxPerTxUsd();
        uint256 local = localMaxPerTxUsd;
        if (local == 0) return globalCap;
        return local < globalCap ? local : globalCap;
    }

    function _effectiveDailyBudgetUsd() private view returns (uint256) {
        uint256 local = localDailyBudgetUsd;
        return local == 0 ? policy.defaultDailyBudgetUsd() : local;
    }

    /// @dev Hash of the governance + effective-local policy in force for a spend,
    ///      plus the USD value priced. Lets an auditor prove which rules applied to
    ///      each `SpendExecuted` purely from logs, without trusting later state.
    function _policySnapshot(
        uint256 capUsd,
        uint256 budgetUsd,
        uint256 minStake,
        uint256 usdValue
    ) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                policy.maxPerTxUsd(),
                policy.defaultDailyBudgetUsd(),
                policy.globalPause(),
                minStake,
                capUsd,
                budgetUsd,
                usdValue
            )
        );
    }
}
