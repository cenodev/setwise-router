// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISetwiseTimelock} from "../src/setwise/ISetwiseTimelock.sol";
import {SetwiseTimelock} from "../src/setwise/SetwiseTimelock.sol";

interface VmTimelock {
    function expectRevert(bytes calldata revertData) external;
    function prank(address caller) external;
    function warp(uint256 timestamp) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory logs);

    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
}

contract TestERC1967Proxy {
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d938fcb;

    constructor(address implementation, bytes memory initializationCall) {
        assembly ("memory-safe") {
            sstore(IMPLEMENTATION_SLOT, implementation)
        }
        if (initializationCall.length != 0) {
            (bool ok, bytes memory reason) = implementation.delegatecall(initializationCall);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
        }
    }

    fallback() external payable {
        assembly ("memory-safe") {
            let implementation := sload(IMPLEMENTATION_SLOT)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    receive() external payable {}
}

contract TimelockTarget {
    uint256 public value;
    bool public called;

    function setValue(uint256 v) external {
        value = v;
        called = true;
    }

    function fail() external pure {
        revert("target failure");
    }

    receive() external payable {}
}

contract SetwiseTimelockTest {
    VmTimelock internal constant vm = VmTimelock(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant PROPOSER = address(0x5AFE);
    address internal constant GUARDIAN = address(0x600D);
    address internal constant OUTSIDER = address(0xBAD);

    SetwiseTimelock internal implementation;
    SetwiseTimelock internal timelock;
    TimelockTarget internal target;

    uint256 internal constant DELAY = 1 days;
    uint256 internal constant START = 1_700_000_000;

    function setUp() public {
        implementation = new SetwiseTimelock();
        TestERC1967Proxy proxy = new TestERC1967Proxy(
            address(implementation),
            abi.encodeCall(SetwiseTimelock.initialize, (PROPOSER, GUARDIAN, DELAY))
        );
        timelock = SetwiseTimelock(payable(address(proxy)));
        target = new TimelockTarget();
        vm.warp(START);
    }

    function testInitializesOnce() external {
        require(timelock.proposer() == PROPOSER, "proposer");
        require(timelock.guardian() == GUARDIAN, "guardian");
        require(timelock.delay() == DELAY, "delay");
        require(timelock.gracePeriod() == 14 days, "grace");

        vm.expectRevert(abi.encodeWithSelector(ISetwiseTimelock.AlreadyInitialized.selector));
        timelock.initialize(PROPOSER, GUARDIAN, DELAY);

        vm.expectRevert(abi.encodeWithSelector(ISetwiseTimelock.AlreadyInitialized.selector));
        implementation.initialize(PROPOSER, GUARDIAN, DELAY);
    }

    function testRejectsInvalidDelay() external {
        SetwiseTimelock impl = new SetwiseTimelock();

        vm.expectRevert(
            abi.encodeWithSelector(ISetwiseTimelock.InvalidDelay.selector, 59 minutes, 1 hours, 30 days)
        );
        new TestERC1967Proxy(
            address(impl),
            abi.encodeCall(SetwiseTimelock.initialize, (PROPOSER, GUARDIAN, 59 minutes))
        );

        vm.expectRevert(
            abi.encodeWithSelector(ISetwiseTimelock.InvalidDelay.selector, 31 days, 1 hours, 30 days)
        );
        new TestERC1967Proxy(
            address(impl),
            abi.encodeCall(SetwiseTimelock.initialize, (PROPOSER, GUARDIAN, 31 days))
        );
    }

    function testOnlyProposerCanSchedule() external {
        bytes memory data = abi.encodeCall(TimelockTarget.setValue, (42));

        vm.expectRevert(abi.encodeWithSelector(ISetwiseTimelock.Unauthorized.selector, OUTSIDER));
        vm.prank(OUTSIDER);
        timelock.schedule(address(target), 0, data, 0);

        vm.prank(PROPOSER);
        timelock.schedule(address(target), 0, data, 0);
    }

    function testScheduleAndExecuteAfterDelay() external {
        bytes memory data = abi.encodeCall(TimelockTarget.setValue, (42));

        vm.prank(PROPOSER);
        bytes32 id = timelock.schedule(address(target), 0, data, 0);

        require(timelock.isOperationPending(id), "pending");
        require(!timelock.isOperationReady(id), "not ready before delay");
        require(!timelock.isOperationDone(id), "not done");

        vm.expectRevert(
            abi.encodeWithSelector(ISetwiseTimelock.OperationNotReady.selector, id, START + DELAY, START)
        );
        vm.prank(PROPOSER);
        timelock.execute(id);

        vm.warp(START + DELAY);
        require(timelock.isOperationReady(id), "ready after delay");

        vm.prank(PROPOSER);
        timelock.execute(id);

        require(target.value() == 42, "target updated");
        require(target.called(), "target called");
        require(timelock.isOperationDone(id), "done");
        require(!timelock.isOperationPending(id), "no longer pending");
    }

    function testOperationExpiresAfterGracePeriod() external {
        bytes memory data = abi.encodeCall(TimelockTarget.setValue, (99));

        vm.prank(PROPOSER);
        bytes32 id = timelock.schedule(address(target), 0, data, 0);

        uint256 deadline = START + DELAY + 14 days;
        vm.warp(deadline + 1);

        vm.expectRevert(
            abi.encodeWithSelector(ISetwiseTimelock.OperationExpired.selector, id, deadline, deadline + 1)
        );
        vm.prank(PROPOSER);
        timelock.execute(id);
    }

    function testGuardianCanCancelButNotScheduleOrExecute() external {
        bytes memory data = abi.encodeCall(TimelockTarget.setValue, (7));

        vm.prank(PROPOSER);
        bytes32 id = timelock.schedule(address(target), 0, data, 0);

        vm.expectRevert(abi.encodeWithSelector(ISetwiseTimelock.Unauthorized.selector, GUARDIAN));
        vm.prank(GUARDIAN);
        timelock.schedule(address(target), 0, data, 0);

        vm.prank(GUARDIAN);
        timelock.cancel(id);

        require(!timelock.isOperationPending(id), "cancelled");

        vm.warp(START + DELAY);
        vm.expectRevert(abi.encodeWithSelector(ISetwiseTimelock.OperationAlreadyCancelled.selector, id));
        vm.prank(PROPOSER);
        timelock.execute(id);
    }

    function testCannotScheduleDuplicate() external {
        bytes memory data = abi.encodeCall(TimelockTarget.setValue, (1));

        vm.prank(PROPOSER);
        bytes32 id = timelock.schedule(address(target), 0, data, 0);

        vm.expectRevert(abi.encodeWithSelector(ISetwiseTimelock.OperationAlreadyScheduled.selector, id));
        vm.prank(PROPOSER);
        timelock.schedule(address(target), 0, data, 0);
    }

    function testCannotExecuteFailedCall() external {
        bytes memory data = abi.encodeCall(TimelockTarget.fail, ());

        vm.prank(PROPOSER);
        bytes32 id = timelock.schedule(address(target), 0, data, 0);

        vm.warp(START + DELAY);

        vm.prank(PROPOSER);
        (bool ok,) = address(timelock).call(
            abi.encodeWithSelector(ISetwiseTimelock.execute.selector, id)
        );
        require(!ok, "execution must revert");
        require(!target.called(), "target not called");
        require(timelock.isOperationPending(id), "still pending after failed execution");
    }

    function testCannotCancelExecutedOrUnset() external {
        bytes memory data = abi.encodeCall(TimelockTarget.setValue, (5));

        vm.expectRevert(abi.encodeWithSelector(ISetwiseTimelock.OperationNotScheduled.selector, bytes32(0)));
        vm.prank(PROPOSER);
        timelock.cancel(bytes32(0));

        vm.prank(PROPOSER);
        bytes32 id = timelock.schedule(address(target), 0, data, 0);

        vm.warp(START + DELAY);
        vm.prank(PROPOSER);
        timelock.execute(id);

        vm.expectRevert(abi.encodeWithSelector(ISetwiseTimelock.OperationAlreadyExecuted.selector, id));
        vm.prank(PROPOSER);
        timelock.cancel(id);
    }

    function testSelfGovernanceChangesRequireTimelockExecution() external {
        vm.expectRevert(abi.encodeWithSelector(ISetwiseTimelock.Unauthorized.selector, PROPOSER));
        vm.prank(PROPOSER);
        timelock.setDelay(2 days);

        vm.expectRevert(abi.encodeWithSelector(ISetwiseTimelock.Unauthorized.selector, OUTSIDER));
        vm.prank(OUTSIDER);
        timelock.setProposer(OUTSIDER);

        bytes memory delayData = abi.encodeCall(SetwiseTimelock.setDelay, (2 days));
        vm.prank(PROPOSER);
        bytes32 id = timelock.schedule(address(timelock), 0, delayData, 0);

        vm.warp(START + DELAY);
        vm.prank(PROPOSER);
        timelock.execute(id);

        require(timelock.delay() == 2 days, "delay updated via timelock");
    }

    function testScheduleEventCarriesCompleteState() external {
        bytes memory data = abi.encodeCall(TimelockTarget.setValue, (10));

        vm.recordLogs();
        vm.prank(PROPOSER);
        bytes32 id = timelock.schedule(address(target), 0, data, 0);
        VmTimelock.Log[] memory logs = vm.getRecordedLogs();

        require(logs.length == 1, "one event");
        require(logs[0].emitter == address(timelock), "emitter");
        require(logs[0].topics[0] == keccak256("OperationScheduled(bytes32,address,uint256,bytes,uint256,uint256)"), "topic");
        require(logs[0].topics[1] == id, "id topic");
        require(logs[0].topics[2] == bytes32(uint256(uint160(address(target)))), "target topic");
    }

    function testGetTimestampReturnsReadyAt() external {
        bytes memory data = abi.encodeCall(TimelockTarget.setValue, (3));

        vm.prank(PROPOSER);
        bytes32 id = timelock.schedule(address(target), 0, data, 0);

        require(timelock.getTimestamp(id) == START + DELAY, "readyAt");
    }
}
