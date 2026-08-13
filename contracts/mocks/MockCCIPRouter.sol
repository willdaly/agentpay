// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IRouterClient} from
    "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {IAny2EVMMessageReceiver} from
    "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Test-only stand-in for the Chainlink CCIP router. Captures outbound
///         messages from {ccipSend} and can replay them into a receiver via
///         {deliver}, impersonating the destination-chain router.
/// @dev Used instead of the Chainlink Local simulator, which the build brief
///      explicitly permits ("otherwise a MockRouter capturing messages and
///      replaying them to the receiver"). This keeps the CCIP tests deterministic
///      and dependency-light while exercising the real `Client` message structs
///      and the real `IRouterClient` / `IAny2EVMMessageReceiver` interfaces.
contract MockCCIPRouter is IRouterClient {
    struct SentMessage {
        uint64 destChainSelector;
        address receiver;
        bytes data;
        address feeToken;
        uint256 feePaid;
        bytes32 messageId;
    }

    SentMessage[] private _sent;

    uint256 public fee = 0.01 ether;
    bool public chainSupported = true;

    error FeeNotPaid(uint256 needed, uint256 paid);

    function setFee(uint256 newFee) external {
        fee = newFee;
    }

    function setChainSupported(bool supported) external {
        chainSupported = supported;
    }

    // --- IRouterClient ---

    function isChainSupported(uint64) external view override returns (bool) {
        return chainSupported;
    }

    function getFee(uint64, Client.EVM2AnyMessage memory)
        external
        view
        override
        returns (uint256)
    {
        return fee;
    }

    function ccipSend(uint64 destChainSelector, Client.EVM2AnyMessage calldata message)
        external
        payable
        override
        returns (bytes32)
    {
        if (msg.value < fee) revert FeeNotPaid(fee, msg.value);

        bytes32 messageId = keccak256(abi.encode(destChainSelector, _sent.length, message.data));
        _sent.push(
            SentMessage({
                destChainSelector: destChainSelector,
                receiver: abi.decode(message.receiver, (address)),
                data: message.data,
                feeToken: message.feeToken,
                feePaid: msg.value,
                messageId: messageId
            })
        );
        return messageId;
    }

    // --- Test helpers ---

    function sentCount() external view returns (uint256) {
        return _sent.length;
    }

    function sentAt(uint256 i) external view returns (SentMessage memory) {
        return _sent[i];
    }

    function lastSent() external view returns (SentMessage memory) {
        return _sent[_sent.length - 1];
    }

    /// @notice Replay a captured message into `receiver`, as the local CCIP router
    ///         would on the destination chain.
    function deliver(
        address receiver,
        bytes32 messageId,
        uint64 sourceChainSelector,
        address sender,
        bytes memory data
    ) public {
        Client.Any2EVMMessage memory message = Client.Any2EVMMessage({
            messageId: messageId,
            sourceChainSelector: sourceChainSelector,
            sender: abi.encode(sender),
            data: data,
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });

        // Replicate the REAL CCIP OffRamp's ERC165 gate: it invokes ccipReceive
        // ONLY if the receiver declares support for IAny2EVMMessageReceiver.
        // Without this check the mock would call ccipReceive on any address —
        // masking a receiver that forgot ERC165, which on live CCIP would have
        // its callback silently skipped (message still marked SUCCESS). A receiver
        // that fails this gate here delivers nothing, so tests asserting a credit
        // will fail — exactly as they should.
        if (!_supportsCcipReceiver(receiver)) {
            emit DeliverySkippedUnsupportedReceiver(receiver, messageId);
            return;
        }
        IAny2EVMMessageReceiver(receiver).ccipReceive(message);
    }

    event DeliverySkippedUnsupportedReceiver(address indexed receiver, bytes32 messageId);

    /// @dev try/catch mirrors the OffRamp: a reverting or false supportsInterface
    ///      both mean "not a CCIP receiver — skip the callback".
    function _supportsCcipReceiver(address receiver) private view returns (bool) {
        try IERC165(receiver).supportsInterface(type(IAny2EVMMessageReceiver).interfaceId)
            returns (bool ok)
        {
            return ok;
        } catch {
            return false;
        }
    }

    /// @notice Convenience: relay message `i` captured by THIS mock into `receiver`,
    ///         attributing it to `sourceChainSelector` / `sender`.
    function relaySent(
        uint256 i,
        address receiver,
        uint64 sourceChainSelector,
        address sender
    ) external {
        SentMessage memory m = _sent[i];
        deliver(receiver, m.messageId, sourceChainSelector, sender, m.data);
    }
}
