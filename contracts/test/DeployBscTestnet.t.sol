// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BscTestnetDeploymentLib} from "../script/DeployBscTestnet.s.sol";
import {ERC1967Proxy} from "../src/proxy/ERC1967Proxy.sol";
import {IRouterControl} from "../src/setwise/IRouterControl.sol";
import {ISetwisePoolRegistry} from "../src/setwise/ISetwisePoolRegistry.sol";
import {RouterControl} from "../src/setwise/RouterControl.sol";
import {SetwiseExecutionAdapter} from "../src/setwise/SetwiseExecutionAdapter.sol";
import {SetwisePoolRegistry} from "../src/setwise/SetwisePoolRegistry.sol";

interface VmBscTestnetDeploymentTest {
    function chainId(uint256 newChainId) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
    function load(address target, bytes32 slot) external view returns (bytes32 value);
}

contract DeploymentMockWrappedNative {
    receive() external payable {}
}

contract DeploymentMockSetPool {
    address public immutable QUOTE_SIGNER;
    address public immutable WRAPPED_NATIVE_TOKEN;

    constructor(address signer, address wrappedNative) {
        QUOTE_SIGNER = signer;
        WRAPPED_NATIVE_TOKEN = wrappedNative;
    }
}

contract DeployBscTestnetTest {
    using BscTestnetDeploymentLib for BscTestnetDeploymentLib.Config;

    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    VmBscTestnetDeploymentTest internal constant vm =
        VmBscTestnetDeploymentTest(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant GOVERNANCE = address(0x5AFE);
    address internal constant GUARDIAN = address(0x600D);
    address internal constant SIGNER = address(0x51A9);

    DeploymentMockWrappedNative internal wrappedNative;
    DeploymentMockSetPool internal setPool;

    function setUp() public {
        vm.chainId(97);
        wrappedNative = new DeploymentMockWrappedNative();
        setPool = new DeploymentMockSetPool(SIGNER, address(wrappedNative));
    }

    function testDeploysAndWiresChain97Contracts() external {
        BscTestnetDeploymentLib.Result memory result = _config(GOVERNANCE).deploy();

        require(result.poolRegistryImplementation.code.length > 0, "registry implementation");
        require(result.poolRegistryProxy.code.length > 0, "registry proxy");
        require(result.routerControlImplementation.code.length > 0, "control implementation");
        require(result.routerControlProxy.code.length > 0, "control proxy");
        require(result.setwiseRouter.code.length > 0, "router");
        require(result.registryOwnershipPending, "ownership pending");

        ISetwisePoolRegistry registry = ISetwisePoolRegistry(result.poolRegistryProxy);
        require(registry.owner() == address(this), "bootstrap owner");
        require(registry.pendingOwner() == GOVERNANCE, "pending governance");
        require(registry.emergencyGuardian() == GUARDIAN, "registry guardian");
        require(registry.isPoolEnabled(address(setPool)), "Set registered");

        IRouterControl control = IRouterControl(result.routerControlProxy);
        require(control.owner() == GOVERNANCE, "control owner");
        require(control.emergencyGuardian() == GUARDIAN, "control guardian");
        require(control.isChainEnabled(97), "chain enabled");
        require(control.isSourceEnabled(97, keccak256("setwise")), "Set source enabled");

        SetwiseExecutionAdapter router = SetwiseExecutionAdapter(payable(result.setwiseRouter));
        require(router.configuredChainId() == 97, "router chain");
        require(router.wrappedNative() == address(wrappedNative), "wrapped native");
        require(router.governance() == GOVERNANCE, "router governance");
        require(address(router.poolRegistry()) == result.poolRegistryProxy, "router registry");
        require(address(router.routerControl()) == result.routerControlProxy, "router control");

        require(
            address(uint160(uint256(vm.load(result.poolRegistryProxy, IMPLEMENTATION_SLOT))))
                == result.poolRegistryImplementation,
            "registry implementation slot"
        );
        require(
            address(uint160(uint256(vm.load(result.routerControlProxy, IMPLEMENTATION_SLOT))))
                == result.routerControlImplementation,
            "control implementation slot"
        );

        SetwisePoolRegistry replacement = new SetwisePoolRegistry();
        registry.upgradeToAndCall(address(replacement), "");
        require(
            address(uint160(uint256(vm.load(result.poolRegistryProxy, IMPLEMENTATION_SLOT)))) == address(replacement),
            "registry upgrade"
        );
        require(registry.isPoolEnabled(address(setPool)), "upgrade preserves Set");
    }

    function testDeployerCanRemainTestnetGovernanceWithoutPendingTransfer() external {
        BscTestnetDeploymentLib.Result memory result = _config(address(this)).deploy();
        ISetwisePoolRegistry registry = ISetwisePoolRegistry(result.poolRegistryProxy);

        require(!result.registryOwnershipPending, "no pending transfer");
        require(registry.owner() == address(this), "governance owner");
        require(registry.pendingOwner() == address(0), "no pending owner");
    }

    function testDeploymentFailsClosedOnWrongChain() external {
        vm.chainId(56);
        vm.expectRevert(abi.encodeWithSelector(BscTestnetDeploymentLib.WrongDeploymentChain.selector, 97, 56));
        this.deploy(_config(GOVERNANCE));
    }

    function testDeploymentRejectsMissingExternalCode() external {
        BscTestnetDeploymentLib.Config memory config = _config(GOVERNANCE);
        config.setPool = address(0xBAD);

        vm.expectRevert(
            abi.encodeWithSelector(BscTestnetDeploymentLib.MissingDeploymentCode.selector, "setPool", address(0xBAD))
        );
        this.deploy(config);
    }

    function testProductionProxyRejectsInvalidImplementationAndInitialization() external {
        vm.expectRevert(abi.encodeWithSelector(ERC1967Proxy.InvalidImplementation.selector, address(0)));
        new ERC1967Proxy(address(0), "");

        RouterControl implementation = new RouterControl();
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC1967Proxy.InitializationFailed.selector,
                abi.encodeWithSelector(IRouterControl.InvalidAddress.selector, address(0))
            )
        );
        new ERC1967Proxy(address(implementation), abi.encodeCall(RouterControl.initialize, (address(0), GUARDIAN)));
    }

    function deploy(BscTestnetDeploymentLib.Config memory config)
        external
        returns (BscTestnetDeploymentLib.Result memory)
    {
        return config.deploy();
    }

    function _config(address governance) private view returns (BscTestnetDeploymentLib.Config memory) {
        return BscTestnetDeploymentLib.Config({
            deployer: address(this),
            governance: governance,
            emergencyGuardian: GUARDIAN,
            setPool: address(setPool),
            wrappedNative: address(wrappedNative)
        });
    }
}
