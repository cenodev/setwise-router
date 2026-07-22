// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IRouterControl
/// @notice Global, per-chain, and per-source disable controls for the Setwise
///         Router. The owner (governance Safe/timelock) manages routine state;
///         the emergency guardian can disable but never re-enable.
/// @dev User-facing surfaces describe sources as "Sets"; internal identifiers
///      retain `pool` and `poolId` terminology.
interface IRouterControl {
    error AlreadyInitialized();
    error InvalidAddress(address value);
    error SourceAlreadyDisabled(uint256 chainId, bytes32 sourceId);
    error SourceAlreadyEnabled(uint256 chainId, bytes32 sourceId);
    error ChainAlreadyDisabled(uint256 chainId);
    error ChainAlreadyEnabled(uint256 chainId);
    error RouterAlreadyPaused();
    error RouterAlreadyRunning();
    error Unauthorized(address caller);

    event Initialized(address indexed owner, address indexed emergencyGuardian);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event EmergencyGuardianChanged(address indexed previousGuardian, address indexed newGuardian);
    event RouterPaused(address indexed caller);
    event RouterResumed(address indexed caller);
    event ChainDisabled(uint256 indexed chainId, address indexed caller);
    event ChainEnabled(uint256 indexed chainId, address indexed caller);
    event SourceDisabled(uint256 indexed chainId, bytes32 indexed sourceId, address indexed caller);
    event SourceEnabled(uint256 indexed chainId, bytes32 indexed sourceId, address indexed caller);

    function initialize(address initialOwner, address initialEmergencyGuardian) external;

    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function emergencyGuardian() external view returns (address);

    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
    function setEmergencyGuardian(address newGuardian) external;

    function pause() external;
    function resume() external;
    function isPaused() external view returns (bool);

    function disableChain(uint256 chainId) external;
    function enableChain(uint256 chainId) external;
    function emergencyDisableChain(uint256 chainId) external;
    function isChainEnabled(uint256 chainId) external view returns (bool);

    function disableSource(uint256 chainId, bytes32 sourceId) external;
    function enableSource(uint256 chainId, bytes32 sourceId) external;
    function emergencyDisableSource(uint256 chainId, bytes32 sourceId) external;
    function isSourceEnabled(uint256 chainId, bytes32 sourceId) external view returns (bool);

    function requireRouteEligible(uint256 chainId, bytes32 sourceId) external view;
}
