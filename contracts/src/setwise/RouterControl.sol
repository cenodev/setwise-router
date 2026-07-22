// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IRouterControl} from "./IRouterControl.sol";

/// @title RouterControl
/// @notice Hierarchical disable controls for the Setwise Router: global pause,
///         per-chain disable, and per-source (per-venue) disable. A route is
///         eligible only when the router is not paused, the chain is enabled,
///         and the source is enabled.
/// @dev The emergency guardian can disable at any level but can never re-enable
///      or resume. Governance (owner) retains full control. Deploy behind an
///      ERC-1967 proxy.
contract RouterControl is IRouterControl {
    address private _owner;
    address private _pendingOwner;
    address private _emergencyGuardian;
    bool private _initialized;
    bool private _paused;

    mapping(uint256 chainId => bool disabled) private _chainDisabled;
    mapping(uint256 chainId => mapping(bytes32 sourceId => bool disabled)) private _sourceDisabled;

    uint256[42] private __gap;

    modifier onlyOwner() {
        if (msg.sender != _owner) revert Unauthorized(msg.sender);
        _;
    }

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != _owner && msg.sender != _emergencyGuardian) revert Unauthorized(msg.sender);
        _;
    }

    constructor() {
        _initialized = true;
    }

    function initialize(address initialOwner, address initialEmergencyGuardian) external {
        if (_initialized) revert AlreadyInitialized();
        if (initialOwner == address(0)) revert InvalidAddress(initialOwner);

        _initialized = true;
        _owner = initialOwner;
        _emergencyGuardian = initialEmergencyGuardian;

        emit Initialized(initialOwner, initialEmergencyGuardian);
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

    function pause() external onlyOwnerOrGuardian {
        if (_paused) revert RouterAlreadyPaused();
        _paused = true;
        emit RouterPaused(msg.sender);
    }

    function resume() external onlyOwner {
        if (!_paused) revert RouterAlreadyRunning();
        _paused = false;
        emit RouterResumed(msg.sender);
    }

    function isPaused() external view returns (bool) {
        return _paused;
    }

    function disableChain(uint256 chainId) external onlyOwner {
        if (_chainDisabled[chainId]) revert ChainAlreadyDisabled(chainId);
        _chainDisabled[chainId] = true;
        emit ChainDisabled(chainId, msg.sender);
    }

    function enableChain(uint256 chainId) external onlyOwner {
        if (!_chainDisabled[chainId]) revert ChainAlreadyEnabled(chainId);
        _chainDisabled[chainId] = false;
        emit ChainEnabled(chainId, msg.sender);
    }

    function emergencyDisableChain(uint256 chainId) external onlyOwnerOrGuardian {
        if (_chainDisabled[chainId]) revert ChainAlreadyDisabled(chainId);
        _chainDisabled[chainId] = true;
        emit ChainDisabled(chainId, msg.sender);
    }

    function isChainEnabled(uint256 chainId) external view returns (bool) {
        return !_chainDisabled[chainId];
    }

    function disableSource(uint256 chainId, bytes32 sourceId) external onlyOwner {
        if (_sourceDisabled[chainId][sourceId]) revert SourceAlreadyDisabled(chainId, sourceId);
        _sourceDisabled[chainId][sourceId] = true;
        emit SourceDisabled(chainId, sourceId, msg.sender);
    }

    function enableSource(uint256 chainId, bytes32 sourceId) external onlyOwner {
        if (!_sourceDisabled[chainId][sourceId]) revert SourceAlreadyEnabled(chainId, sourceId);
        _sourceDisabled[chainId][sourceId] = false;
        emit SourceEnabled(chainId, sourceId, msg.sender);
    }

    function emergencyDisableSource(uint256 chainId, bytes32 sourceId) external onlyOwnerOrGuardian {
        if (_sourceDisabled[chainId][sourceId]) revert SourceAlreadyDisabled(chainId, sourceId);
        _sourceDisabled[chainId][sourceId] = true;
        emit SourceDisabled(chainId, sourceId, msg.sender);
    }

    function isSourceEnabled(uint256 chainId, bytes32 sourceId) external view returns (bool) {
        return !_sourceDisabled[chainId][sourceId];
    }

    /// @notice Fail-closed route eligibility guard. Call before any approval,
    ///         transfer, or value forwarding.
    function requireRouteEligible(uint256 chainId, bytes32 sourceId) external view {
        if (_paused) revert RouterAlreadyPaused();
        if (_chainDisabled[chainId]) revert ChainAlreadyDisabled(chainId);
        if (_sourceDisabled[chainId][sourceId]) revert SourceAlreadyDisabled(chainId, sourceId);
    }
}
