// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IServiceRegistry} from "./interfaces/IServiceRegistry.sol";

/// @title ServiceRegistry
/// @notice Permissionless catalog of services that AI agents can pay for. Each
///         service records its provider, USD price, an integrity hash of its
///         off-chain terms, a metadata pointer (IPFS CID / endpoint spec), and
///         the chain it settles on.
/// @dev Lineage: the Module 7 midterm's `AIModelNFT` metadata pattern, minus the
///      NFT. Registration is intentionally permissionless — the economic quality
///      gate is `ProviderStaking` (checked by `AgentWallet` at spend time), not
///      an access-control role here.
///
///      INTEGRITY-HASH PATTERN (carried from the midterm's model NFTs): a service
///      stores `termsHash = keccak256(termsDocument)`. A consumer fetches the
///      document from `metadataURI`, hashes it, and compares — proving the
///      off-chain artifact matches exactly what the provider committed on-chain.
///      Use {verifyTerms} for that check.
contract ServiceRegistry is IServiceRegistry {
    /// @notice serviceId (starts at 1) => service record. Id 0 is never used
    ///         so callers can treat 0 as "unset".
    mapping(uint256 => Service) private _services;

    /// @notice Number of services ever registered; also the highest valid id.
    uint256 public override totalServices;

    event ServiceRegistered(
        uint256 indexed serviceId,
        address indexed provider,
        uint256 priceUsdCents,
        uint64 indexed homeChainSelector,
        bytes32 termsHash,
        string metadataURI
    );
    event ServiceUpdated(
        uint256 indexed serviceId,
        uint256 priceUsdCents,
        bytes32 termsHash,
        string metadataURI
    );
    event ServiceActiveSet(uint256 indexed serviceId, bool active);

    error UnknownService(uint256 serviceId);
    error NotServiceProvider(uint256 serviceId, address caller);
    error EmptyMetadata();
    error ZeroChainSelector();

    /// @notice Register a new service. Permissionless; caller becomes provider.
    /// @param priceUsdCents Price in USD cents (may be 0 for free/demo services).
    /// @param termsHash keccak256 of the canonical off-chain terms document.
    /// @param metadataURI IPFS CID or URL for the full terms / endpoint spec.
    /// @param homeChainSelector CCIP chain selector of the chain that settles this service.
    /// @return serviceId The id assigned to the new service (>= 1).
    function registerService(
        uint256 priceUsdCents,
        bytes32 termsHash,
        string calldata metadataURI,
        uint64 homeChainSelector
    ) external override returns (uint256 serviceId) {
        if (bytes(metadataURI).length == 0) revert EmptyMetadata();
        if (homeChainSelector == 0) revert ZeroChainSelector();

        serviceId = ++totalServices;
        _services[serviceId] = Service({
            provider: msg.sender,
            priceUsdCents: priceUsdCents,
            termsHash: termsHash,
            metadataURI: metadataURI,
            homeChainSelector: homeChainSelector,
            active: true
        });

        emit ServiceRegistered(
            serviceId, msg.sender, priceUsdCents, homeChainSelector, termsHash, metadataURI
        );
    }

    /// @notice Update mutable fields of a service. Only its provider may call.
    /// @dev provider and homeChainSelector are immutable after registration; to
    ///      change them, register a new service.
    function updateService(
        uint256 serviceId,
        uint256 priceUsdCents,
        bytes32 termsHash,
        string calldata metadataURI
    ) external override {
        Service storage s = _requireProvider(serviceId);
        if (bytes(metadataURI).length == 0) revert EmptyMetadata();

        s.priceUsdCents = priceUsdCents;
        s.termsHash = termsHash;
        s.metadataURI = metadataURI;

        emit ServiceUpdated(serviceId, priceUsdCents, termsHash, metadataURI);
    }

    /// @notice Toggle a service's availability. Only its provider may call.
    function setActive(uint256 serviceId, bool active) external override {
        Service storage s = _requireProvider(serviceId);
        s.active = active;
        emit ServiceActiveSet(serviceId, active);
    }

    // --- Views ---

    /// @notice Full service record. Reverts if the id was never registered.
    function getService(uint256 serviceId) external view override returns (Service memory) {
        _requireExists(serviceId);
        return _services[serviceId];
    }

    /// @notice The provider address for a service (cheap accessor for consumers).
    function providerOf(uint256 serviceId) external view override returns (address) {
        _requireExists(serviceId);
        return _services[serviceId].provider;
    }

    /// @notice True if the id has been registered (regardless of active flag).
    function exists(uint256 serviceId) public view override returns (bool) {
        return serviceId != 0 && serviceId <= totalServices;
    }

    /// @notice True if the service exists and is currently active.
    function isActive(uint256 serviceId) external view override returns (bool) {
        return exists(serviceId) && _services[serviceId].active;
    }

    /// @notice Verify an off-chain terms document matches the registered hash.
    /// @param serviceId The service to check against.
    /// @param termsDocument The full off-chain document bytes.
    /// @return True iff keccak256(termsDocument) equals the stored termsHash.
    function verifyTerms(uint256 serviceId, bytes calldata termsDocument)
        external
        view
        override
        returns (bool)
    {
        _requireExists(serviceId);
        return keccak256(termsDocument) == _services[serviceId].termsHash;
    }

    // --- Internal helpers ---

    function _requireExists(uint256 serviceId) private view {
        if (!exists(serviceId)) revert UnknownService(serviceId);
    }

    function _requireProvider(uint256 serviceId) private view returns (Service storage s) {
        _requireExists(serviceId);
        s = _services[serviceId];
        if (s.provider != msg.sender) revert NotServiceProvider(serviceId, msg.sender);
    }
}
