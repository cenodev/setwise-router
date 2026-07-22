// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ISetwiseTimelock
/// @notice Minimal governance timelock for routine Setwise Router operations.
/// @dev Operations are scheduled by the proposer, become executable after a
///      delay, and expire if not executed within the grace period. The guardian
///      can cancel pending operations but cannot schedule or execute them.
interface ISetwiseTimelock {
    error AlreadyInitialized();
    error InvalidAddress(address value);
    error InvalidDelay(uint256 delay, uint256 minDelay, uint256 maxDelay);
    error OperationAlreadyScheduled(bytes32 id);
    error OperationNotReady(bytes32 id, uint256 readyAt, uint256 timestamp);
    error OperationExpired(bytes32 id, uint256 deadline, uint256 timestamp);
    error OperationNotScheduled(bytes32 id);
    error OperationAlreadyExecuted(bytes32 id);
    error OperationAlreadyCancelled(bytes32 id);
    error ExecutionFailed(bytes32 id, bytes reason);
    error Unauthorized(address caller);

    event Initialized(address indexed proposer, address indexed guardian, uint256 delay);
    event OperationScheduled(bytes32 indexed id, address indexed target, uint256 value, bytes data, uint256 readyAt, uint256 deadline);
    event OperationExecuted(bytes32 indexed id, address indexed target, uint256 value, bytes data);
    event OperationCancelled(bytes32 indexed id, address indexed caller);
    event DelayChanged(uint256 previousDelay, uint256 newDelay);
    event ProposerChanged(address indexed previousProposer, address indexed newProposer);
    event GuardianChanged(address indexed previousGuardian, address indexed newGuardian);

    function initialize(address initialProposer, address initialGuardian, uint256 initialDelay) external;

    function proposer() external view returns (address);
    function guardian() external view returns (address);
    function delay() external view returns (uint256);
    function gracePeriod() external view returns (uint256);

    function schedule(address target, uint256 value, bytes calldata data, uint256 eta) external returns (bytes32 id);
    function execute(bytes32 id) external payable returns (bytes memory result);
    function cancel(bytes32 id) external;

    function isOperationPending(bytes32 id) external view returns (bool);
    function isOperationReady(bytes32 id) external view returns (bool);
    function isOperationDone(bytes32 id) external view returns (bool);
    function getTimestamp(bytes32 id) external view returns (uint256);

    function setDelay(uint256 newDelay) external;
    function setProposer(address newProposer) external;
    function setGuardian(address newGuardian) external;
}
