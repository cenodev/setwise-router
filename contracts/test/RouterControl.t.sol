// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IRouterControl} from "../src/setwise/IRouterControl.sol";
import {RouterControl} from "../src/setwise/RouterControl.sol";

interface VmControl {
    function expectRevert(bytes calldata revertData) external;
    function prank(address caller) external;
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

contract RouterControlTest {
    VmControl internal constant vm = VmControl(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant OWNER = address(0x5AFE);
    address internal constant GUARDIAN = address(0x600D);
    address internal constant OUTSIDER = address(0xBAD);

    uint256 internal constant CHAIN_ETH = 1;
    uint256 internal constant CHAIN_BSC = 56;
    bytes32 internal constant SOURCE_SETWISE = keccak256("setwise");
    bytes32 internal constant SOURCE_UNISWAP = keccak256("uniswapV3");

    RouterControl internal implementation;
    RouterControl internal control;

    function setUp() public {
        implementation = new RouterControl();
        TestERC1967Proxy proxy = new TestERC1967Proxy(
            address(implementation),
            abi.encodeCall(RouterControl.initialize, (OWNER, GUARDIAN))
        );
        control = RouterControl(address(proxy));
    }

    function testInitializesOnce() external {
        require(control.owner() == OWNER, "owner");
        require(control.emergencyGuardian() == GUARDIAN, "guardian");
        require(!control.isPaused(), "not paused");

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.AlreadyInitialized.selector));
        control.initialize(OWNER, GUARDIAN);

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.AlreadyInitialized.selector));
        implementation.initialize(OWNER, GUARDIAN);
    }

    function testOnlyOwnerCanPauseAndResume() external {
        vm.expectRevert(abi.encodeWithSelector(IRouterControl.Unauthorized.selector, OUTSIDER));
        vm.prank(OUTSIDER);
        control.pause();

        vm.prank(OWNER);
        control.pause();
        require(control.isPaused(), "paused");

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.RouterAlreadyPaused.selector));
        vm.prank(OWNER);
        control.pause();

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.Unauthorized.selector, GUARDIAN));
        vm.prank(GUARDIAN);
        control.resume();

        vm.prank(OWNER);
        control.resume();
        require(!control.isPaused(), "resumed");

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.RouterAlreadyRunning.selector));
        vm.prank(OWNER);
        control.resume();
    }

    function testGuardianCanPauseButNotResume() external {
        vm.prank(GUARDIAN);
        control.pause();
        require(control.isPaused(), "guardian paused");

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.Unauthorized.selector, GUARDIAN));
        vm.prank(GUARDIAN);
        control.resume();

        vm.prank(OWNER);
        control.resume();
    }

    function testChainDisableAndEnable() external {
        require(control.isChainEnabled(CHAIN_ETH), "enabled by default");

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.Unauthorized.selector, OUTSIDER));
        vm.prank(OUTSIDER);
        control.disableChain(CHAIN_ETH);

        vm.prank(OWNER);
        control.disableChain(CHAIN_ETH);
        require(!control.isChainEnabled(CHAIN_ETH), "disabled");
        require(control.isChainEnabled(CHAIN_BSC), "other chain unaffected");

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.ChainAlreadyDisabled.selector, CHAIN_ETH));
        vm.prank(OWNER);
        control.disableChain(CHAIN_ETH);

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.Unauthorized.selector, GUARDIAN));
        vm.prank(GUARDIAN);
        control.enableChain(CHAIN_ETH);

        vm.prank(OWNER);
        control.enableChain(CHAIN_ETH);
        require(control.isChainEnabled(CHAIN_ETH), "re-enabled");

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.ChainAlreadyEnabled.selector, CHAIN_ETH));
        vm.prank(OWNER);
        control.enableChain(CHAIN_ETH);
    }

    function testGuardianCanEmergencyDisableChain() external {
        vm.prank(GUARDIAN);
        control.emergencyDisableChain(CHAIN_BSC);
        require(!control.isChainEnabled(CHAIN_BSC), "guardian disabled chain");

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.Unauthorized.selector, GUARDIAN));
        vm.prank(GUARDIAN);
        control.enableChain(CHAIN_BSC);

        vm.prank(OWNER);
        control.enableChain(CHAIN_BSC);
    }

    function testSourceDisableAndEnable() external {
        require(control.isSourceEnabled(CHAIN_ETH, SOURCE_SETWISE), "enabled by default");

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.Unauthorized.selector, OUTSIDER));
        vm.prank(OUTSIDER);
        control.disableSource(CHAIN_ETH, SOURCE_SETWISE);

        vm.prank(OWNER);
        control.disableSource(CHAIN_ETH, SOURCE_SETWISE);
        require(!control.isSourceEnabled(CHAIN_ETH, SOURCE_SETWISE), "disabled");
        require(control.isSourceEnabled(CHAIN_ETH, SOURCE_UNISWAP), "other source unaffected");
        require(control.isSourceEnabled(CHAIN_BSC, SOURCE_SETWISE), "same source other chain unaffected");

        vm.expectRevert(
            abi.encodeWithSelector(IRouterControl.SourceAlreadyDisabled.selector, CHAIN_ETH, SOURCE_SETWISE)
        );
        vm.prank(OWNER);
        control.disableSource(CHAIN_ETH, SOURCE_SETWISE);

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.Unauthorized.selector, GUARDIAN));
        vm.prank(GUARDIAN);
        control.enableSource(CHAIN_ETH, SOURCE_SETWISE);

        vm.prank(OWNER);
        control.enableSource(CHAIN_ETH, SOURCE_SETWISE);
        require(control.isSourceEnabled(CHAIN_ETH, SOURCE_SETWISE), "re-enabled");

        vm.expectRevert(
            abi.encodeWithSelector(IRouterControl.SourceAlreadyEnabled.selector, CHAIN_ETH, SOURCE_SETWISE)
        );
        vm.prank(OWNER);
        control.enableSource(CHAIN_ETH, SOURCE_SETWISE);
    }

    function testGuardianCanEmergencyDisableSource() external {
        vm.prank(GUARDIAN);
        control.emergencyDisableSource(CHAIN_ETH, SOURCE_SETWISE);
        require(!control.isSourceEnabled(CHAIN_ETH, SOURCE_SETWISE), "guardian disabled source");

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.Unauthorized.selector, GUARDIAN));
        vm.prank(GUARDIAN);
        control.enableSource(CHAIN_ETH, SOURCE_SETWISE);

        vm.prank(OWNER);
        control.enableSource(CHAIN_ETH, SOURCE_SETWISE);
    }

    function testRequireRouteEligibleFailsClosed() external {
        control.requireRouteEligible(CHAIN_ETH, SOURCE_SETWISE);

        vm.prank(OWNER);
        control.pause();
        vm.expectRevert(abi.encodeWithSelector(IRouterControl.RouterAlreadyPaused.selector));
        control.requireRouteEligible(CHAIN_ETH, SOURCE_SETWISE);

        vm.prank(OWNER);
        control.resume();
        control.requireRouteEligible(CHAIN_ETH, SOURCE_SETWISE);

        vm.prank(OWNER);
        control.disableChain(CHAIN_ETH);
        vm.expectRevert(abi.encodeWithSelector(IRouterControl.ChainAlreadyDisabled.selector, CHAIN_ETH));
        control.requireRouteEligible(CHAIN_ETH, SOURCE_SETWISE);

        vm.prank(OWNER);
        control.enableChain(CHAIN_ETH);
        control.requireRouteEligible(CHAIN_ETH, SOURCE_SETWISE);

        vm.prank(OWNER);
        control.disableSource(CHAIN_ETH, SOURCE_SETWISE);
        vm.expectRevert(
            abi.encodeWithSelector(IRouterControl.SourceAlreadyDisabled.selector, CHAIN_ETH, SOURCE_SETWISE)
        );
        control.requireRouteEligible(CHAIN_ETH, SOURCE_SETWISE);

        vm.prank(OWNER);
        control.enableSource(CHAIN_ETH, SOURCE_SETWISE);
        control.requireRouteEligible(CHAIN_ETH, SOURCE_SETWISE);
    }

    function testSingleVenueDisableDoesNotHaltHealthyRoutes() external {
        vm.prank(OWNER);
        control.disableSource(CHAIN_ETH, SOURCE_SETWISE);

        vm.expectRevert(
            abi.encodeWithSelector(IRouterControl.SourceAlreadyDisabled.selector, CHAIN_ETH, SOURCE_SETWISE)
        );
        control.requireRouteEligible(CHAIN_ETH, SOURCE_SETWISE);

        control.requireRouteEligible(CHAIN_ETH, SOURCE_UNISWAP);
        control.requireRouteEligible(CHAIN_BSC, SOURCE_SETWISE);
    }

    function testOwnershipTransfersInTwoSteps() external {
        address newOwner = address(0xABC0);

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.Unauthorized.selector, OUTSIDER));
        vm.prank(OUTSIDER);
        control.transferOwnership(newOwner);

        vm.prank(OWNER);
        control.transferOwnership(newOwner);
        require(control.owner() == OWNER, "owner unchanged before acceptance");
        require(control.pendingOwner() == newOwner, "pending owner");

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.Unauthorized.selector, OUTSIDER));
        vm.prank(OUTSIDER);
        control.acceptOwnership();

        vm.prank(newOwner);
        control.acceptOwnership();
        require(control.owner() == newOwner, "new owner");
        require(control.pendingOwner() == address(0), "pending cleared");

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.Unauthorized.selector, OWNER));
        vm.prank(OWNER);
        control.pause();
    }

    function testEventsCarryCompleteState() external {
        vm.recordLogs();
        vm.prank(OWNER);
        control.disableSource(CHAIN_ETH, SOURCE_SETWISE);
        VmControl.Log[] memory logs = vm.getRecordedLogs();

        require(logs.length == 1, "one event");
        require(logs[0].emitter == address(control), "emitter");
        require(
            logs[0].topics[0] == keccak256("SourceDisabled(uint256,bytes32,address)"), "SourceDisabled topic"
        );
        require(uint256(logs[0].topics[1]) == CHAIN_ETH, "chainId topic");
        require(logs[0].topics[2] == SOURCE_SETWISE, "sourceId topic");
        require(address(uint160(uint256(logs[0].topics[3]))) == OWNER, "caller topic");

        vm.recordLogs();
        vm.prank(OWNER);
        control.pause();
        VmControl.Log[] memory pauseLogs = vm.getRecordedLogs();
        require(pauseLogs.length == 1, "one pause event");
        require(pauseLogs[0].topics[0] == keccak256("RouterPaused(address)"), "RouterPaused topic");
    }

    function testSetEmergencyGuardian() external {
        vm.expectRevert(abi.encodeWithSelector(IRouterControl.Unauthorized.selector, OUTSIDER));
        vm.prank(OUTSIDER);
        control.setEmergencyGuardian(OUTSIDER);

        vm.prank(OWNER);
        control.setEmergencyGuardian(address(0));
        require(control.emergencyGuardian() == address(0), "guardian removed");

        vm.prank(OWNER);
        control.setEmergencyGuardian(GUARDIAN);
        require(control.emergencyGuardian() == GUARDIAN, "guardian restored");
    }
}
