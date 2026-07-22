// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ISetwisePoolRegistry
/// @notice Per-chain allowlist of permanent Setwise pool proxy addresses.
/// @dev Router execution code must call `requireEnabledPool` before approving
///      or transferring any asset to a pool.
interface ISetwisePoolRegistry {
    error AlreadyInitialized();
    error InvalidAddress(address value);
    error InvalidImplementation(address implementation);
    error InvalidPoolProxy(address pool);
    error PoolAlreadyRegistered(address pool);
    error PoolDisabled(address pool);
    error PoolIsImplementation(address pool);
    error PoolNotRegistered(address pool);
    error PoolStatusUnchanged(address pool, bool enabled);
    error Unauthorized(address caller);
    error UUPSUnauthorizedCallContext();
    error UpgradeCallFailed(bytes reason);

    /// @notice Emitted for the initial owner and every completed ownership transfer.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    /// @notice Emitted when the current owner nominates a Safe/timelock successor.
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    /// @notice Emitted whenever the disable-only emergency role changes.
    event EmergencyGuardianChanged(address indexed previousGuardian, address indexed newGuardian);
    /// @notice Emitted when a pool proxy is appended to the enumerable registry.
    event PoolAdded(address indexed pool, uint256 index, bool enabled);
    /// @notice Emitted whenever the enabled bit changes, including emergency disables.
    event PoolStatusChanged(address indexed pool, bool enabled, address indexed caller);
    /// @notice Emitted when a pool is removed. `movedPool` is the proxy moved into
    ///         `index` by swap-and-pop, or zero when no entry moved.
    event PoolRemoved(address indexed pool, uint256 index, address indexed movedPool, bool wasEnabled);
    /// @notice Standard ERC-1967 implementation-change event.
    event Upgraded(address indexed implementation);

    function initialize(address initialOwner, address initialEmergencyGuardian) external;

    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function emergencyGuardian() external view returns (address);

    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
    function setEmergencyGuardian(address newGuardian) external;

    function addPool(address pool) external;
    function removePool(address pool) external;
    function setPoolEnabled(address pool, bool enabled) external;
    function emergencyDisablePool(address pool) external;

    function isPoolRegistered(address pool) external view returns (bool);
    function isPoolEnabled(address pool) external view returns (bool);
    function requireEnabledPool(address pool) external view;
    function poolCount() external view returns (uint256);
    function poolAt(uint256 index) external view returns (address);
    function pools() external view returns (address[] memory);
    function poolState(address pool) external view returns (bool registered, bool enabled, uint256 index);

    function proxiableUUID() external view returns (bytes32);
    function upgradeToAndCall(address newImplementation, bytes calldata data) external;
}
