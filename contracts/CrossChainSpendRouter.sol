// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IRouterClient} from
    "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {IAny2EVMMessageReceiver} from
    "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";

import {ISettlementEscrow} from "./interfaces/ISettlementEscrow.sol";
import {IWalletAuthorizer} from "./interfaces/IWalletAuthorizer.sol";

/// @title CrossChainSpendRouter
/// @notice Carries an agent's spend from the home chain (Sepolia) to a provider
///         on a remote chain (Base Sepolia) over Chainlink CCIP. One contract,
///         deployed on both chains, acting as SENDER on the source and RECEIVER
///         on the destination.
///
/// @dev FLOW
///      1. `AgentWallet.spend()` runs EVERY policy check on the home chain first
///         (pause, allowlist, provider stake, per-tx cap, daily budget, live
///         oracle price). Nothing is sent until the spend is fully authorized.
///      2. The wallet transfers APT to this router (LOCKING it here) and calls
///         {routeSpend}.
///      3. This router sends a DATA-ONLY CCIP message to its counterpart on the
///         destination chain.
///      4. The counterpart {ccipReceive}s it, checks the source-chain and sender
///         allowlists, and credits the provider in the REMOTE {SettlementEscrow}
///         from its own pre-funded APT liquidity. The provider then pulls funds.
///
/// @dev TRUST ASSUMPTIONS — STATED HONESTLY (this is a testnet capstone).
///      APT is NOT a CCIP-registered cross-chain token: making CCIP itself move
///      APT would require registering it in the Token Admin Registry and deploying
///      burn/mint token pools on both chains (the CCT standard). That is out of
///      scope here, so this router uses CCIP for MESSAGING ONLY and settles value
///      with a lock-and-credit scheme:
///        - Source chain: APT is LOCKED in this router forever (never burned).
///        - Destination chain: the provider is credited from a PRE-FUNDED APT
///          liquidity pool held by the remote router (a separate APT deployment).
///      Consequences an auditor should know:
///        - Total APT is NOT conserved cryptographically across chains; the two
///          APT deployments are independent tokens, not a canonical bridged asset.
///        - Remote settlement is only as good as the remote router's liquidity.
///          If it runs dry, {ccipReceive} reverts and CCIP will not deliver the
///          message; the source-side APT stays locked and the owner can recover it
///          via {rescueLockedTokens}.
///        - This is a TRUSTED bridge: the router owner is trusted not to drain
///          liquidity. A production system would register APT as a CCT so CCIP's
///          own token pools enforce conservation.
///      This is the fallback the build brief sanctions ("burn/lock-and-credit with
///      data-only messaging ... document the trust assumptions honestly").
///
/// @dev CCIP FEES are paid in NATIVE ETH (`feeToken = address(0)`), chosen over
///      LINK because it removes a funding-and-approval step. This router must hold
///      an ETH balance; top it up with {fundNative} (or a plain transfer).
contract CrossChainSpendRouter is IAny2EVMMessageReceiver, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Payload carried across the lane. Data-only: no CCIP token transfer.
    struct SpendMessage {
        address provider; // who to credit on the destination chain
        uint256 serviceId; // service paid for (destination-chain registry id)
        uint256 amount; // APT (wei) to credit
        address agentWallet; // originating wallet, for the remote audit trail
        uint256 usdValue; // USD (8-decimal) value at the home-chain feed price
    }

    // --- Immutable wiring ---

    /// @notice APT on THIS chain.
    IERC20 public immutable token;
    /// @notice The Chainlink CCIP router on THIS chain.
    IRouterClient public immutable ccipRouter;
    /// @notice The settlement escrow on THIS chain (used when receiving).
    ISettlementEscrow public immutable escrow;

    // --- Sender-side configuration ---

    /// @notice Vouches for genuine {AgentWallet} callers of {routeSpend}. Set once
    ///         by the owner at deploy time (breaks the factory<->router cycle).
    IWalletAuthorizer public authorizer;

    /// @notice destination chain selector => counterpart router address there.
    ///         A zero entry means the lane is not open.
    mapping(uint64 => address) public destinationRouter;

    /// @notice Gas limit requested for the callback on the destination chain.
    uint256 public destGasLimit = 300_000;

    // --- Receiver-side allowlists (standard CCIP hygiene) ---

    /// @notice source chain selector => accepted.
    mapping(uint64 => bool) public allowlistedSourceChains;
    /// @notice source chain selector => sender address accepted from that chain.
    mapping(uint64 => mapping(address => bool)) public allowlistedSenders;

    // --- Events ---

    event AuthorizerSet(address indexed authorizer);
    event DestinationRouterSet(uint64 indexed chainSelector, address indexed router);
    event DestGasLimitSet(uint256 gasLimit);
    event SourceChainAllowlisted(uint64 indexed chainSelector, bool allowed);
    event SenderAllowlisted(
        uint64 indexed chainSelector, address indexed sender, bool allowed
    );

    event CrossChainSpendSent(
        bytes32 indexed messageId,
        uint64 indexed destChainSelector,
        address indexed provider,
        uint256 serviceId,
        uint256 amount,
        uint256 fee
    );
    event CrossChainSpendReceived(
        bytes32 indexed messageId,
        uint64 indexed sourceChainSelector,
        address indexed provider,
        uint256 serviceId,
        uint256 amount,
        address agentWallet
    );
    event NativeFunded(address indexed from, uint256 amount);
    event NativeWithdrawn(address indexed to, uint256 amount);
    event LockedTokensRescued(address indexed to, uint256 amount);

    // --- Errors ---

    error ZeroAddress();
    error ZeroAmount();
    error NotAuthorizedWallet(address caller);
    error AuthorizerAlreadySet();
    error AuthorizerNotSet();
    error LaneNotOpen(uint64 destChainSelector);
    error OnlyCcipRouter(address caller);
    error SourceChainNotAllowlisted(uint64 sourceChainSelector);
    error SenderNotAllowlisted(uint64 sourceChainSelector, address sender);
    error InsufficientNativeForFee(uint256 needed, uint256 available);
    error InsufficientLiquidity(uint256 needed, uint256 available);

    /// @param _token APT on this chain.
    /// @param _ccipRouter Chainlink CCIP router on this chain.
    /// @param _escrow Settlement escrow on this chain (credited when receiving).
    /// @param _owner Admin (deploy-time wiring; hand to the timelock afterwards).
    constructor(
        IERC20 _token,
        IRouterClient _ccipRouter,
        ISettlementEscrow _escrow,
        address _owner
    ) Ownable(_owner) {
        if (
            address(_token) == address(0) || address(_ccipRouter) == address(0)
                || address(_escrow) == address(0)
        ) revert ZeroAddress();
        token = _token;
        ccipRouter = _ccipRouter;
        escrow = _escrow;
    }

    // =====================================================================
    //                            SENDER SIDE
    // =====================================================================

    /// @notice Send an already-authorized spend to a provider on a remote chain.
    /// @dev The caller (an {AgentWallet}) MUST have transferred `amount` APT to
    ///      this router immediately before calling — exactly the same convention
    ///      as {SettlementEscrow.credit}. Those tokens are locked here; the remote
    ///      router credits the provider from its own liquidity (see contract NatSpec).
    ///      All policy enforcement already happened on the home chain.
    /// @return messageId The CCIP message id (also the cross-chain audit handle).
    function routeSpend(
        uint64 destChainSelector,
        address provider,
        uint256 serviceId,
        uint256 amount,
        uint256 usdValue
    ) external nonReentrant returns (bytes32 messageId) {
        IWalletAuthorizer auth = authorizer;
        if (address(auth) == address(0)) revert AuthorizerNotSet();
        if (!auth.isWallet(msg.sender)) revert NotAuthorizedWallet(msg.sender);
        if (provider == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        address dest = destinationRouter[destChainSelector];
        if (dest == address(0)) revert LaneNotOpen(destChainSelector);

        Client.EVM2AnyMessage memory message = _buildMessage(
            dest,
            SpendMessage({
                provider: provider,
                serviceId: serviceId,
                amount: amount,
                agentWallet: msg.sender,
                usdValue: usdValue
            })
        );

        uint256 fee = ccipRouter.getFee(destChainSelector, message);
        uint256 balance = address(this).balance;
        if (fee > balance) revert InsufficientNativeForFee(fee, balance);

        messageId = ccipRouter.ccipSend{value: fee}(destChainSelector, message);

        emit CrossChainSpendSent(
            messageId, destChainSelector, provider, serviceId, amount, fee
        );
    }

    /// @notice Quote the native-ETH CCIP fee for a spend of this shape.
    /// @dev Lets the off-chain agent check the router is funded before spending.
    function quoteSpendFee(
        uint64 destChainSelector,
        address provider,
        uint256 serviceId,
        uint256 amount,
        uint256 usdValue
    ) external view returns (uint256 fee) {
        address dest = destinationRouter[destChainSelector];
        if (dest == address(0)) revert LaneNotOpen(destChainSelector);
        Client.EVM2AnyMessage memory message = _buildMessage(
            dest,
            SpendMessage({
                provider: provider,
                serviceId: serviceId,
                amount: amount,
                agentWallet: msg.sender,
                usdValue: usdValue
            })
        );
        return ccipRouter.getFee(destChainSelector, message);
    }

    function _buildMessage(address dest, SpendMessage memory payload)
        private
        view
        returns (Client.EVM2AnyMessage memory)
    {
        return Client.EVM2AnyMessage({
            receiver: abi.encode(dest),
            data: abi.encode(payload),
            tokenAmounts: new Client.EVMTokenAmount[](0), // data-only: see NatSpec
            feeToken: address(0), // native ETH
            extraArgs: Client._argsToBytes(
                Client.GenericExtraArgsV2({
                    gasLimit: destGasLimit,
                    allowOutOfOrderExecution: true
                })
            )
        });
    }

    // =====================================================================
    //                           RECEIVER SIDE
    // =====================================================================

    /// @notice CCIP entry point on the destination chain.
    /// @dev Only the local CCIP router may call. Enforces the source-chain and
    ///      sender allowlists before crediting anything.
    function ccipReceive(Client.Any2EVMMessage calldata message) external override {
        if (msg.sender != address(ccipRouter)) revert OnlyCcipRouter(msg.sender);

        uint64 src = message.sourceChainSelector;
        if (!allowlistedSourceChains[src]) revert SourceChainNotAllowlisted(src);

        address sender = abi.decode(message.sender, (address));
        if (!allowlistedSenders[src][sender]) revert SenderNotAllowlisted(src, sender);

        SpendMessage memory payload = abi.decode(message.data, (SpendMessage));

        uint256 liquidity = token.balanceOf(address(this));
        if (liquidity < payload.amount) {
            revert InsufficientLiquidity(payload.amount, liquidity);
        }

        // Credit the provider in the remote escrow from local liquidity, using the
        // escrow's transfer-then-credit convention.
        token.safeTransfer(address(escrow), payload.amount);
        escrow.credit(payload.provider, payload.serviceId, payload.amount);

        emit CrossChainSpendReceived(
            message.messageId,
            src,
            payload.provider,
            payload.serviceId,
            payload.amount,
            payload.agentWallet
        );
    }

    // =====================================================================
    //                          ADMIN / FUNDING
    // =====================================================================

    /// @notice Set the wallet authorizer. Callable once, by the owner, at deploy.
    function setAuthorizer(IWalletAuthorizer _authorizer) external onlyOwner {
        if (address(_authorizer) == address(0)) revert ZeroAddress();
        if (address(authorizer) != address(0)) revert AuthorizerAlreadySet();
        authorizer = _authorizer;
        emit AuthorizerSet(address(_authorizer));
    }

    /// @notice Open (or close, with address(0)) a lane to a counterpart router.
    function setDestinationRouter(uint64 chainSelector, address router)
        external
        onlyOwner
    {
        destinationRouter[chainSelector] = router;
        emit DestinationRouterSet(chainSelector, router);
    }

    /// @notice Gas limit requested for the destination-chain callback.
    function setDestGasLimit(uint256 gasLimit) external onlyOwner {
        destGasLimit = gasLimit;
        emit DestGasLimitSet(gasLimit);
    }

    /// @notice Allow or block an inbound source chain.
    function setAllowlistedSourceChain(uint64 chainSelector, bool allowed)
        external
        onlyOwner
    {
        allowlistedSourceChains[chainSelector] = allowed;
        emit SourceChainAllowlisted(chainSelector, allowed);
    }

    /// @notice Allow or block a specific sender on a given source chain.
    function setAllowlistedSender(uint64 chainSelector, address sender, bool allowed)
        external
        onlyOwner
    {
        allowlistedSenders[chainSelector][sender] = allowed;
        emit SenderAllowlisted(chainSelector, sender, allowed);
    }

    /// @notice Top up the native-ETH balance used to pay CCIP fees.
    function fundNative() external payable {
        emit NativeFunded(msg.sender, msg.value);
    }

    /// @notice Recover native ETH (unused fee budget).
    function withdrawNative(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit NativeWithdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert InsufficientNativeForFee(amount, address(this).balance);
    }

    /// @notice Recover APT held by this router.
    /// @dev On the SOURCE chain this is the locked pool backing already-sent
    ///      messages — the owner is trusted not to drain it (see trust assumptions).
    ///      On the DESTINATION chain it is the settlement liquidity pool.
    function rescueLockedTokens(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit LockedTokensRescued(to, amount);
    }

    /// @notice Accept plain ETH transfers as fee funding.
    receive() external payable {
        emit NativeFunded(msg.sender, msg.value);
    }
}
