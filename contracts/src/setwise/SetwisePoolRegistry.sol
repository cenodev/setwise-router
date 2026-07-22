// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISetwisePool} from "./ISetwisePool.sol";
import {ISetwisePoolRegistry} from "./ISetwisePoolRegistry.sol";

/// @title SetwisePoolRegistry
/// @notice Governed, per-chain registry of permanent Setwise pool proxies.
/// @dev This implementation is UUPS-upgradeable. Deploy it behind an ERC-1967
///      proxy and initialize ownership with the governance Safe/timelock. Pool
///      implementations are deliberately rejected: upgrades must retain the
///      registered proxy address.
contract SetwisePoolRegistry is ISetwisePoolRegistry {
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d938fcb;

    address private immutable _self = address(this);

    struct PoolRecord {
        uint256 indexPlusOne;
        bool enabled;
    }

    address private _owner;
    address private _pendingOwner;
    address private _emergencyGuardian;
    bool private _initialized;
    mapping(address pool => PoolRecord record) private _poolRecords;
    address[] private _pools;

    // Reserved for storage-compatible upgrades.
    uint256[44] private __gap;

    modifier onlyOwner() {
        if (msg.sender != _owner) revert Unauthorized(msg.sender);
        _;
    }

    modifier onlyProxy() {
        if (address(this) == _self || _implementation() != _self) revert UUPSUnauthorizedCallContext();
        _;
    }

    modifier notDelegated() {
        if (address(this) != _self) revert UUPSUnauthorizedCallContext();
        _;
    }

    /// @dev Lock the implementation itself; proxy storage remains initializable.
    constructor() {
        _initialized = true;
    }

    function initialize(address initialOwner, address initialEmergencyGuardian) external {
        if (_initialized) revert AlreadyInitialized();
        if (initialOwner == address(0)) revert InvalidAddress(initialOwner);

        _initialized = true;
        _owner = initialOwner;
        _emergencyGuardian = initialEmergencyGuardian;

        emit OwnershipTransferred(address(0), initialOwner);
        emit EmergencyGuardianChanged(address(0), initialEmergencyGuardian);
    }

    function owner() external view returns (address) {
        return _owner;
    }

    function pendingOwner() external view returns (address) {
        return _pendingOwner;
    }

    function emergencyGuardian() external view returns (address) {
        return _emergencyGuardian;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress(newOwner);
        _pendingOwner = newOwner;
        emit OwnershipTransferStarted(_owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != _pendingOwner) revert Unauthorized(msg.sender);
        address previousOwner = _owner;
        _owner = msg.sender;
        _pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, msg.sender);
    }

    function setEmergencyGuardian(address newGuardian) external onlyOwner {
        address previousGuardian = _emergencyGuardian;
        _emergencyGuardian = newGuardian;
        emit EmergencyGuardianChanged(previousGuardian, newGuardian);
    }

    function addPool(address pool) external onlyOwner {
        if (pool == address(0)) revert InvalidAddress(pool);
        if (_poolRecords[pool].indexPlusOne != 0) revert PoolAlreadyRegistered(pool);
        _validatePoolProxy(pool);

        uint256 index = _pools.length;
        _pools.push(pool);
        _poolRecords[pool] = PoolRecord({indexPlusOne: index + 1, enabled: true});
        emit PoolAdded(pool, index, true);
    }

    function removePool(address pool) external onlyOwner {
        PoolRecord memory record = _poolRecords[pool];
        if (record.indexPlusOne == 0) revert PoolNotRegistered(pool);

        uint256 index = uint256(record.indexPlusOne) - 1;
        uint256 lastIndex = _pools.length - 1;
        address movedPool;
        if (index != lastIndex) {
            movedPool = _pools[lastIndex];
            _pools[index] = movedPool;
            _poolRecords[movedPool].indexPlusOne = index + 1;
        }
        _pools.pop();
        delete _poolRecords[pool];

        emit PoolRemoved(pool, index, movedPool, record.enabled);
    }

    function setPoolEnabled(address pool, bool enabled) external onlyOwner {
        _setPoolEnabled(pool, enabled);
    }

    /// @notice Disable a pool immediately. The guardian can never add, remove,
    ///         upgrade, or re-enable a pool.
    function emergencyDisablePool(address pool) external {
        if (msg.sender != _owner && msg.sender != _emergencyGuardian) revert Unauthorized(msg.sender);
        _setPoolEnabled(pool, false);
    }

    function isPoolRegistered(address pool) public view returns (bool) {
        return _poolRecords[pool].indexPlusOne != 0;
    }

    function isPoolEnabled(address pool) public view returns (bool) {
        PoolRecord memory record = _poolRecords[pool];
        return record.indexPlusOne != 0 && record.enabled;
    }

    /// @notice Router-facing fail-closed guard. Call this before any approval or transfer.
    function requireEnabledPool(address pool) external view {
        PoolRecord memory record = _poolRecords[pool];
        if (record.indexPlusOne == 0) revert PoolNotRegistered(pool);
        if (!record.enabled) revert PoolDisabled(pool);
    }

    function poolCount() external view returns (uint256) {
        return _pools.length;
    }

    function poolAt(uint256 index) external view returns (address) {
        return _pools[index];
    }

    function pools() external view returns (address[] memory) {
        return _pools;
    }

    function poolState(address pool) external view returns (bool registered, bool enabled, uint256 index) {
        PoolRecord memory record = _poolRecords[pool];
        registered = record.indexPlusOne != 0;
        enabled = registered && record.enabled;
        index = registered ? uint256(record.indexPlusOne) - 1 : 0;
    }

    /// @notice ERC-1822 compatibility identifier. Reverts through a proxy so a
    ///         pool implementation address can be distinguished from its proxy.
    function proxiableUUID() external view notDelegated returns (bytes32) {
        return IMPLEMENTATION_SLOT;
    }

    /// @notice Owner-authorized UUPS implementation upgrade.
    function upgradeToAndCall(address newImplementation, bytes calldata data) external onlyProxy onlyOwner {
        _validateImplementation(newImplementation);
        assembly ("memory-safe") {
            sstore(IMPLEMENTATION_SLOT, newImplementation)
        }
        emit Upgraded(newImplementation);

        if (data.length != 0) {
            (bool ok, bytes memory reason) = newImplementation.delegatecall(data);
            if (!ok) revert UpgradeCallFailed(reason);
        }
    }

    function _setPoolEnabled(address pool, bool enabled) private {
        PoolRecord storage record = _poolRecords[pool];
        if (record.indexPlusOne == 0) revert PoolNotRegistered(pool);
        if (record.enabled == enabled) revert PoolStatusUnchanged(pool, enabled);
        record.enabled = enabled;
        emit PoolStatusChanged(pool, enabled, msg.sender);
    }

    function _validatePoolProxy(address pool) private view {
        if (pool.code.length == 0) revert InvalidPoolProxy(pool);

        // A compliant UUPS implementation returns the ERC-1967 slot directly;
        // the permanent proxy delegates this call and the implementation's
        // notDelegated guard reverts. Never register the implementation.
        (bool uuidOk, bytes memory uuidData) = pool.staticcall(abi.encodeCall(this.proxiableUUID, ()));
        if (uuidOk && uuidData.length >= 32 && abi.decode(uuidData, (bytes32)) == IMPLEMENTATION_SLOT) {
            revert PoolIsImplementation(pool);
        }

        (bool signerOk, bytes memory signerData) = pool.staticcall(abi.encodeCall(ISetwisePool.QUOTE_SIGNER, ()));
        (bool wrappedOk, bytes memory wrappedData) =
            pool.staticcall(abi.encodeCall(ISetwisePool.WRAPPED_NATIVE_TOKEN, ()));
        if (
            !signerOk || signerData.length < 32 || abi.decode(signerData, (address)) == address(0) || !wrappedOk
                || wrappedData.length < 32 || abi.decode(wrappedData, (address)) == address(0)
        ) revert InvalidPoolProxy(pool);
    }

    function _validateImplementation(address implementation) private view {
        if (implementation.code.length == 0) revert InvalidImplementation(implementation);
        (bool ok, bytes memory data) = implementation.staticcall(abi.encodeCall(this.proxiableUUID, ()));
        if (!ok || data.length < 32 || abi.decode(data, (bytes32)) != IMPLEMENTATION_SLOT) {
            revert InvalidImplementation(implementation);
        }
    }

    function _implementation() private view returns (address implementation) {
        assembly ("memory-safe") {
            implementation := sload(IMPLEMENTATION_SLOT)
        }
    }
}
