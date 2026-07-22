// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISetwisePoolRegistry} from "../src/setwise/ISetwisePoolRegistry.sol";
import {SetwisePoolRegistry} from "../src/setwise/SetwisePoolRegistry.sol";

interface VmRegistry {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function expectRevert(bytes calldata revertData) external;
    function prank(address caller) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory logs);
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

    function testUpgradeTo(address implementation) external {
        assembly ("memory-safe") {
            sstore(IMPLEMENTATION_SLOT, implementation)
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

contract MockSetwisePoolImplementation {
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d938fcb;
    address private immutable _self = address(this);

    function QUOTE_SIGNER() external pure returns (address) {
        return address(0x5151);
    }

    function WRAPPED_NATIVE_TOKEN() external pure returns (address) {
        return address(0xBEEF);
    }

    function proxiableUUID() external view returns (bytes32) {
        require(address(this) == _self, "not delegated");
        return IMPLEMENTATION_SLOT;
    }

    function version() external pure virtual returns (uint256) {
        return 1;
    }
}

contract MockSetwisePoolImplementationV2 is MockSetwisePoolImplementation {
    function version() external pure override returns (uint256) {
        return 2;
    }
}

contract InvalidPoolTarget {}

contract GuardedApprovalHarness {
    error ApprovalAttempted();

    function execute(ISetwisePoolRegistry registry, address pool) external view {
        registry.requireEnabledPool(pool);
        // This stands in for the adapter's first approval/transfer interaction.
        // Reaching it is observable through its distinct revert selector.
        revert ApprovalAttempted();
    }
}

contract SetwisePoolRegistryV2 is SetwisePoolRegistry {
    function version() external pure returns (uint256) {
        return 2;
    }
}

/// @notice Secret-free registry governance, UUPS, and fail-closed guard tests.
contract SetwisePoolRegistryTest {
    VmRegistry internal constant vm = VmRegistry(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant GUARDIAN = address(0x600D);
    address internal constant OUTSIDER = address(0xBAD);
    address internal constant SAFE = address(0x5AFE);

    SetwisePoolRegistry internal implementation;
    ISetwisePoolRegistry internal registry;
    TestERC1967Proxy internal registryProxy;
    MockSetwisePoolImplementation internal poolImplementation;
    TestERC1967Proxy internal poolProxy;

    function setUp() public {
        implementation = new SetwisePoolRegistry();
        registryProxy = new TestERC1967Proxy(
            address(implementation), abi.encodeCall(SetwisePoolRegistry.initialize, (address(this), GUARDIAN))
        );
        registry = ISetwisePoolRegistry(address(registryProxy));

        poolImplementation = new MockSetwisePoolImplementation();
        poolProxy = new TestERC1967Proxy(address(poolImplementation), "");
    }

    function testInitializesGovernanceOnceAndLocksImplementation() external {
        require(registry.owner() == address(this), "owner");
        require(registry.emergencyGuardian() == GUARDIAN, "guardian");

        vm.expectRevert(abi.encodeWithSelector(ISetwisePoolRegistry.AlreadyInitialized.selector));
        registry.initialize(address(this), GUARDIAN);

        vm.expectRevert(abi.encodeWithSelector(ISetwisePoolRegistry.AlreadyInitialized.selector));
        implementation.initialize(address(this), GUARDIAN);
    }

    function testOnlyOwnerCanChangeRegistryOrGovernance() external {
        bytes memory unauthorized = abi.encodeWithSelector(ISetwisePoolRegistry.Unauthorized.selector, OUTSIDER);

        vm.expectRevert(unauthorized);
        vm.prank(OUTSIDER);
        registry.addPool(address(poolProxy));

        registry.addPool(address(poolProxy));

        vm.expectRevert(unauthorized);
        vm.prank(OUTSIDER);
        registry.setPoolEnabled(address(poolProxy), false);

        vm.expectRevert(unauthorized);
        vm.prank(OUTSIDER);
        registry.removePool(address(poolProxy));

        vm.expectRevert(unauthorized);
        vm.prank(OUTSIDER);
        registry.setEmergencyGuardian(OUTSIDER);

        vm.expectRevert(unauthorized);
        vm.prank(OUTSIDER);
        registry.transferOwnership(OUTSIDER);
    }

    function testAddsEnumeratesDisablesAndRemovesPoolProxies() external {
        registry.addPool(address(poolProxy));
        require(registry.poolCount() == 1, "count after add");
        require(registry.poolAt(0) == address(poolProxy), "poolAt");
        require(registry.pools().length == 1, "pools length");
        require(registry.isPoolRegistered(address(poolProxy)), "registered");
        require(registry.isPoolEnabled(address(poolProxy)), "enabled");
        registry.requireEnabledPool(address(poolProxy));

        (bool registered, bool enabled, uint256 index) = registry.poolState(address(poolProxy));
        require(registered && enabled && index == 0, "pool state");

        registry.setPoolEnabled(address(poolProxy), false);
        require(!registry.isPoolEnabled(address(poolProxy)), "disabled");
        vm.expectRevert(abi.encodeWithSelector(ISetwisePoolRegistry.PoolDisabled.selector, address(poolProxy)));
        registry.requireEnabledPool(address(poolProxy));

        registry.removePool(address(poolProxy));
        require(registry.poolCount() == 0, "count after remove");
        require(!registry.isPoolRegistered(address(poolProxy)), "removed");
        vm.expectRevert(abi.encodeWithSelector(ISetwisePoolRegistry.PoolNotRegistered.selector, address(poolProxy)));
        registry.requireEnabledPool(address(poolProxy));
    }

    function testRemovalEventDescribesSwapAndPopExactly() external {
        TestERC1967Proxy secondPool = new TestERC1967Proxy(address(poolImplementation), "");
        registry.addPool(address(poolProxy));
        registry.addPool(address(secondPool));

        vm.recordLogs();
        registry.removePool(address(poolProxy));
        VmRegistry.Log[] memory logs = vm.getRecordedLogs();

        require(logs.length == 1, "one removal event");
        require(logs[0].emitter == address(registry), "registry emitter");
        require(logs[0].topics[0] == keccak256("PoolRemoved(address,uint256,address,bool)"), "PoolRemoved topic");
        require(address(uint160(uint256(logs[0].topics[1]))) == address(poolProxy), "removed pool topic");
        require(address(uint160(uint256(logs[0].topics[2]))) == address(secondPool), "moved pool topic");
        (uint256 removedIndex, bool wasEnabled) = abi.decode(logs[0].data, (uint256, bool));
        require(removedIndex == 0 && wasEnabled, "complete removal data");
        require(registry.poolAt(0) == address(secondPool), "enumeration reconstructed");
    }

    function testAddAndStatusEventsCarryCompleteState() external {
        vm.recordLogs();
        registry.addPool(address(poolProxy));
        VmRegistry.Log[] memory addLogs = vm.getRecordedLogs();

        require(addLogs.length == 1, "one add event");
        require(addLogs[0].topics[0] == keccak256("PoolAdded(address,uint256,bool)"), "PoolAdded topic");
        require(address(uint160(uint256(addLogs[0].topics[1]))) == address(poolProxy), "added pool topic");
        (uint256 index, bool enabled) = abi.decode(addLogs[0].data, (uint256, bool));
        require(index == 0 && enabled, "complete add data");

        vm.recordLogs();
        registry.setPoolEnabled(address(poolProxy), false);
        VmRegistry.Log[] memory statusLogs = vm.getRecordedLogs();

        require(statusLogs.length == 1, "one status event");
        require(
            statusLogs[0].topics[0] == keccak256("PoolStatusChanged(address,bool,address)"), "PoolStatusChanged topic"
        );
        require(address(uint160(uint256(statusLogs[0].topics[1]))) == address(poolProxy), "status pool topic");
        require(address(uint160(uint256(statusLogs[0].topics[2]))) == address(this), "status caller topic");
        require(!abi.decode(statusLogs[0].data, (bool)), "complete status data");
    }

    function testRejectsImplementationsAndNonPoolContracts() external {
        vm.expectRevert(
            abi.encodeWithSelector(ISetwisePoolRegistry.PoolIsImplementation.selector, address(poolImplementation))
        );
        registry.addPool(address(poolImplementation));

        InvalidPoolTarget invalid = new InvalidPoolTarget();
        vm.expectRevert(abi.encodeWithSelector(ISetwisePoolRegistry.InvalidPoolProxy.selector, address(invalid)));
        registry.addPool(address(invalid));
    }

    function testPermanentPoolProxyRemainsEnabledAcrossImplementationUpgrade() external {
        registry.addPool(address(poolProxy));
        require(MockSetwisePoolImplementation(address(poolProxy)).version() == 1, "pool v1");

        MockSetwisePoolImplementationV2 poolV2 = new MockSetwisePoolImplementationV2();
        poolProxy.testUpgradeTo(address(poolV2));

        require(MockSetwisePoolImplementation(address(poolProxy)).version() == 2, "pool v2");
        require(registry.isPoolEnabled(address(poolProxy)), "proxy remains enabled");
        require(!registry.isPoolRegistered(address(poolV2)), "implementation never registered");
    }

    function testEmergencyGuardianCanOnlyDisable() external {
        registry.addPool(address(poolProxy));

        vm.prank(GUARDIAN);
        registry.emergencyDisablePool(address(poolProxy));
        require(!registry.isPoolEnabled(address(poolProxy)), "guardian disabled");

        vm.expectRevert(abi.encodeWithSelector(ISetwisePoolRegistry.Unauthorized.selector, GUARDIAN));
        vm.prank(GUARDIAN);
        registry.setPoolEnabled(address(poolProxy), true);

        vm.expectRevert(abi.encodeWithSelector(ISetwisePoolRegistry.Unauthorized.selector, GUARDIAN));
        vm.prank(GUARDIAN);
        registry.removePool(address(poolProxy));

        registry.setPoolEnabled(address(poolProxy), true);
        require(registry.isPoolEnabled(address(poolProxy)), "owner re-enabled");
    }

    function testGuardRevertsBeforeApprovalOrTransferInteraction() external {
        GuardedApprovalHarness harness = new GuardedApprovalHarness();

        vm.expectRevert(abi.encodeWithSelector(ISetwisePoolRegistry.PoolNotRegistered.selector, address(poolProxy)));
        harness.execute(registry, address(poolProxy));

        registry.addPool(address(poolProxy));
        registry.emergencyDisablePool(address(poolProxy));
        vm.expectRevert(abi.encodeWithSelector(ISetwisePoolRegistry.PoolDisabled.selector, address(poolProxy)));
        harness.execute(registry, address(poolProxy));

        registry.setPoolEnabled(address(poolProxy), true);
        vm.expectRevert(abi.encodeWithSelector(GuardedApprovalHarness.ApprovalAttempted.selector));
        harness.execute(registry, address(poolProxy));
    }

    function testOwnershipTransfersToSafeOrTimelockInTwoSteps() external {
        registry.transferOwnership(SAFE);
        require(registry.owner() == address(this), "owner unchanged before acceptance");
        require(registry.pendingOwner() == SAFE, "pending owner");

        vm.expectRevert(abi.encodeWithSelector(ISetwisePoolRegistry.Unauthorized.selector, OUTSIDER));
        vm.prank(OUTSIDER);
        registry.acceptOwnership();

        vm.prank(SAFE);
        registry.acceptOwnership();
        require(registry.owner() == SAFE, "safe owns registry");
        require(registry.pendingOwner() == address(0), "pending owner cleared");

        vm.expectRevert(abi.encodeWithSelector(ISetwisePoolRegistry.Unauthorized.selector, address(this)));
        registry.addPool(address(poolProxy));

        vm.prank(SAFE);
        registry.addPool(address(poolProxy));
    }

    function testOwnerCanUpgradeRegistryAndPreserveState() external {
        registry.addPool(address(poolProxy));
        SetwisePoolRegistryV2 v2 = new SetwisePoolRegistryV2();

        registry.upgradeToAndCall(address(v2), "");

        require(SetwisePoolRegistryV2(address(registry)).version() == 2, "registry v2");
        require(registry.owner() == address(this), "owner preserved");
        require(registry.emergencyGuardian() == GUARDIAN, "guardian preserved");
        require(registry.isPoolEnabled(address(poolProxy)), "pool state preserved");
    }

    function testUnauthorizedOrInvalidRegistryUpgradesRevert() external {
        SetwisePoolRegistryV2 v2 = new SetwisePoolRegistryV2();

        vm.expectRevert(abi.encodeWithSelector(ISetwisePoolRegistry.Unauthorized.selector, OUTSIDER));
        vm.prank(OUTSIDER);
        registry.upgradeToAndCall(address(v2), "");

        InvalidPoolTarget invalid = new InvalidPoolTarget();
        vm.expectRevert(abi.encodeWithSelector(ISetwisePoolRegistry.InvalidImplementation.selector, address(invalid)));
        registry.upgradeToAndCall(address(invalid), "");

        vm.expectRevert(abi.encodeWithSelector(ISetwisePoolRegistry.UUPSUnauthorizedCallContext.selector));
        implementation.upgradeToAndCall(address(v2), "");
    }
}
