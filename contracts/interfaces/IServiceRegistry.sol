// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IServiceRegistry
/// @notice Read/write surface of the service catalog. Consumers (e.g. AgentWallet)
///         depend on this interface, not the concrete registry, so the catalog is
///         swappable and unit-testable.
interface IServiceRegistry {
    struct Service {
        // Slot 0: address(20) + uint64(8) + bool(1) = 29 bytes, packed together.
        address provider; // who registered / gets paid; the staking subject
        uint64 homeChainSelector; // CCIP chain selector of the settlement chain
        bool active; // provider can toggle availability without deregistering
        // Subsequent slots:
        uint256 priceUsdCents; // service price in USD cents (integer)
        bytes32 termsHash; // keccak256 of the canonical off-chain terms document
        string metadataURI; // IPFS CID or URL for full terms / endpoint spec
    }

    function registerService(
        uint256 priceUsdCents,
        bytes32 termsHash,
        string calldata metadataURI,
        uint64 homeChainSelector
    ) external returns (uint256 serviceId);

    function updateService(
        uint256 serviceId,
        uint256 priceUsdCents,
        bytes32 termsHash,
        string calldata metadataURI
    ) external;

    function setActive(uint256 serviceId, bool active) external;

    function getService(uint256 serviceId) external view returns (Service memory);

    function providerOf(uint256 serviceId) external view returns (address);

    function exists(uint256 serviceId) external view returns (bool);

    function isActive(uint256 serviceId) external view returns (bool);

    function verifyTerms(uint256 serviceId, bytes calldata termsDocument)
        external
        view
        returns (bool);

    function totalServices() external view returns (uint256);
}
