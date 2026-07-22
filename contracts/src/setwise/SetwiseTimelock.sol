// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISetwiseTimelock} from "./ISetwiseTimelock.sol";

/// @title SetwiseTimelock
/// @notice Minimal governance timelock separating routine governance from
///         emergency controls. The proposer (a Safe or governance contract)
///         schedules operations that become executable after a delay. The
///         guardian can cancel pending operations but cannot schedule or
///         execute them.
/// @dev Deploy behind an ERC-1967 proxy. The delay bounds are 1 hour minimum
///      and 30 days maximum. The grace period is fixed at 14 days.
contract SetwiseTimelock is ISetwiseTimelock {
    uint256 public constant MIN_DELAY = 1 hours;
    uint256 public constant MAX_DELAY = 30 days;
    uint256 public constant GRACE_PERIOD = 14 days;

    uint8 private constant STATE_UNSET = 0;
    uint8 private constant STATE_PENDING = 1;
    uint8 private constant STATE_EXECUTED = 2;
    uint8 private constant STATE_CANCELLED = 3;

    struct Operation {
        uint8 state;
        uint256 readyAt;
        uint256 deadline;
        address target;
        uint256 value;
        bytes data;
    }

    address private _proposer;
    address private _guardian;
    uint256 private _delay;
    bool private _initialized;
    mapping(bytes32 id => Operation op) private _operations;

    uint256[44] private __gap;

    modifier onlyProposer() {
        if (msg.sender != _proposer) revert Unauthorized(msg.sender);
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert Unauthorized(msg.sender);
        _;
    }

    constructor() {
        _initialized = true;
    }

    function initialize(address initialProposer, address initialGuardian, uint256 initialDelay) external {
        if (_initialized) revert AlreadyInitialized();
        if (initialProposer == address(0)) revert InvalidAddress(initialProposer);
        if (initialDelay < MIN_DELAY || initialDelay > MAX_DELAY) {
            revert InvalidDelay(initialDelay, MIN_DELAY, MAX_DELAY);
        }

        _initialized = true;
        _proposer = initialProposer;
        _guardian = initialGuardian;
        _delay = initialDelay;

        emit Initialized(initialProposer, initialGuardian, initialDelay);
    }

    function proposer() external view returns (address) {
        return _proposer;
    }

    function guardian() external view returns (address) {
        return _guardian;
    }

    function delay() external view returns (uint256) {
        return _delay;
    }

    function gracePeriod() external pure returns (uint256) {
        return GRACE_PERIOD;
    }

    function schedule(address target, uint256 value, bytes calldata data, uint256 eta)
        external
        onlyProposer
        returns (bytes32 id)
    {
        if (target == address(0)) revert InvalidAddress(target);

        id = keccak256(abi.encode(target, value, data, eta));
        if (_operations[id].state != STATE_UNSET) revert OperationAlreadyScheduled(id);

        uint256 readyAt = block.timestamp + _delay;
        if (eta != 0 && eta < readyAt) {
            readyAt = eta;
        }
        uint256 deadline = readyAt + GRACE_PERIOD;

        _operations[id] = Operation({
            state: STATE_PENDING,
            readyAt: readyAt,
            deadline: deadline,
            target: target,
            value: value,
            data: data
        });

        emit OperationScheduled(id, target, value, data, readyAt, deadline);
    }

    function execute(bytes32 id) external payable onlyProposer returns (bytes memory result) {
        Operation storage op = _operations[id];
        if (op.state == STATE_UNSET) revert OperationNotScheduled(id);
        if (op.state == STATE_EXECUTED) revert OperationAlreadyExecuted(id);
        if (op.state == STATE_CANCELLED) revert OperationAlreadyCancelled(id);

        if (block.timestamp < op.readyAt) revert OperationNotReady(id, op.readyAt, block.timestamp);
        if (block.timestamp > op.deadline) revert OperationExpired(id, op.deadline, block.timestamp);

        op.state = STATE_EXECUTED;

        (bool ok, bytes memory reason) = op.target.call{value: op.value}(op.data);
        if (!ok) revert ExecutionFailed(id, reason);

        emit OperationExecuted(id, op.target, op.value, op.data);
        return reason;
    }

    function cancel(bytes32 id) external {
        if (msg.sender != _proposer && msg.sender != _guardian) revert Unauthorized(msg.sender);

        Operation storage op = _operations[id];
        if (op.state == STATE_UNSET) revert OperationNotScheduled(id);
        if (op.state == STATE_EXECUTED) revert OperationAlreadyExecuted(id);
        if (op.state == STATE_CANCELLED) revert OperationAlreadyCancelled(id);

        op.state = STATE_CANCELLED;
        emit OperationCancelled(id, msg.sender);
    }

    function isOperationPending(bytes32 id) external view returns (bool) {
        return _operations[id].state == STATE_PENDING;
    }

    function isOperationReady(bytes32 id) external view returns (bool) {
        Operation storage op = _operations[id];
        return op.state == STATE_PENDING && block.timestamp >= op.readyAt && block.timestamp <= op.deadline;
    }

    function isOperationDone(bytes32 id) external view returns (bool) {
        return _operations[id].state == STATE_EXECUTED;
    }

    function getTimestamp(bytes32 id) external view returns (uint256) {
        return _operations[id].readyAt;
    }

    function setDelay(uint256 newDelay) external onlySelf {
        if (newDelay < MIN_DELAY || newDelay > MAX_DELAY) {
            revert InvalidDelay(newDelay, MIN_DELAY, MAX_DELAY);
        }
        uint256 previousDelay = _delay;
        _delay = newDelay;
        emit DelayChanged(previousDelay, newDelay);
    }

    function setProposer(address newProposer) external onlySelf {
        if (newProposer == address(0)) revert InvalidAddress(newProposer);
        address previousProposer = _proposer;
        _proposer = newProposer;
        emit ProposerChanged(previousProposer, newProposer);
    }

    function setGuardian(address newGuardian) external onlySelf {
        address previousGuardian = _guardian;
        _guardian = newGuardian;
        emit GuardianChanged(previousGuardian, newGuardian);
    }

    receive() external payable {}
}
