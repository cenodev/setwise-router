// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "../src/proxy/ERC1967Proxy.sol";
import {IRouterControl} from "../src/setwise/IRouterControl.sol";
import {ISetwisePoolRegistry} from "../src/setwise/ISetwisePoolRegistry.sol";
import {RouterControl} from "../src/setwise/RouterControl.sol";
import {SetwiseExecutionAdapter} from "../src/setwise/SetwiseExecutionAdapter.sol";
import {SetwisePoolRegistry} from "../src/setwise/SetwisePoolRegistry.sol";

interface VmBscTestnetDeploy {
    function createDir(string calldata path, bool recursive) external;
    function envAddress(string calldata name) external returns (address value);
    function projectRoot() external view returns (string memory path);
    function serializeAddress(string calldata objectKey, string calldata valueKey, address value)
        external
        returns (string memory json);
    function serializeBool(string calldata objectKey, string calldata valueKey, bool value)
        external
        returns (string memory json);
    function serializeUint(string calldata objectKey, string calldata valueKey, uint256 value)
        external
        returns (string memory json);
    function startBroadcast() external;
    function stopBroadcast() external;
    function writeJson(string calldata json, string calldata path) external;
}

library BscTestnetDeploymentLib {
    uint256 internal constant CHAIN_ID = 97;

    error InvalidDeploymentAddress(string role);
    error MissingDeploymentCode(string role, address target);
    error WrongDeploymentChain(uint256 expected, uint256 actual);

    struct Config {
        address deployer;
        address governance;
        address emergencyGuardian;
        address setPool;
        address wrappedNative;
    }

    struct Result {
        address poolRegistryImplementation;
        address poolRegistryProxy;
        address routerControlImplementation;
        address routerControlProxy;
        address setwiseRouter;
        bool registryOwnershipPending;
    }

    function deploy(Config memory config) internal returns (Result memory result) {
        if (block.chainid != CHAIN_ID) revert WrongDeploymentChain(CHAIN_ID, block.chainid);
        _requireAddress(config.deployer, "deployer");
        _requireAddress(config.governance, "governance");
        _requireAddress(config.emergencyGuardian, "emergencyGuardian");
        _requireCode(config.setPool, "setPool");
        _requireCode(config.wrappedNative, "wrappedNative");

        SetwisePoolRegistry registryImplementation = new SetwisePoolRegistry();
        ERC1967Proxy registryProxy = new ERC1967Proxy(
            address(registryImplementation),
            abi.encodeCall(SetwisePoolRegistry.initialize, (config.deployer, config.emergencyGuardian))
        );
        ISetwisePoolRegistry registry = ISetwisePoolRegistry(address(registryProxy));
        registry.addPool(config.setPool);

        bool ownershipPending = config.governance != config.deployer;
        if (ownershipPending) registry.transferOwnership(config.governance);

        RouterControl controlImplementation = new RouterControl();
        ERC1967Proxy controlProxy = new ERC1967Proxy(
            address(controlImplementation),
            abi.encodeCall(RouterControl.initialize, (config.governance, config.emergencyGuardian))
        );

        SetwiseExecutionAdapter router = new SetwiseExecutionAdapter(
            CHAIN_ID, config.wrappedNative, config.governance, address(registry), address(controlProxy)
        );

        result = Result({
            poolRegistryImplementation: address(registryImplementation),
            poolRegistryProxy: address(registryProxy),
            routerControlImplementation: address(controlImplementation),
            routerControlProxy: address(controlProxy),
            setwiseRouter: address(router),
            registryOwnershipPending: ownershipPending
        });
    }

    function _requireAddress(address value, string memory role) private pure {
        if (value == address(0)) revert InvalidDeploymentAddress(role);
    }

    function _requireCode(address target, string memory role) private view {
        if (target.code.length == 0) revert MissingDeploymentCode(role, target);
    }
}

/// @title DeployBscTestnet
/// @notice Deploys the chain-97 Set registry, router controls, and direct Set
///         execution adapter. Pricing remains in the external RFQ service, so
///         this script deliberately does not invent an on-chain Set quoter.
/// @dev Sign with a Foundry keystore (`--account`); no private-key environment
///      variable is read. The deployer temporarily owns the registry so the
///      existing Set proxy can be registered atomically. When governance is a
///      different address it must complete `acceptOwnership()` before release.
contract DeployBscTestnet {
    using BscTestnetDeploymentLib for BscTestnetDeploymentLib.Config;

    uint256 public constant CHAIN_ID = 97;
    address public constant SET_POOL = 0xA54D041eD831BBE2D6F97107Ab3aD9f9682C392a;
    address public constant WRAPPED_NATIVE = 0x119FF2a8b74dfCE4c378CE4bd2c10201bf47e395;

    VmBscTestnetDeploy private constant vm =
        VmBscTestnetDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    event BscTestnetDeploymentPrepared(
        address indexed poolRegistry,
        address indexed routerControl,
        address indexed setwiseRouter,
        address governance,
        address emergencyGuardian,
        bool registryOwnershipPending
    );

    function run() external returns (BscTestnetDeploymentLib.Result memory result) {
        BscTestnetDeploymentLib.Config memory config = BscTestnetDeploymentLib.Config({
            deployer: vm.envAddress("DEPLOYER_ADDRESS"),
            governance: vm.envAddress("GOVERNANCE_ADDRESS"),
            emergencyGuardian: vm.envAddress("EMERGENCY_GUARDIAN_ADDRESS"),
            setPool: SET_POOL,
            wrappedNative: WRAPPED_NATIVE
        });

        vm.startBroadcast();
        result = config.deploy();
        vm.stopBroadcast();

        _writeDeploymentAddresses(config, result);
        emit BscTestnetDeploymentPrepared(
            result.poolRegistryProxy,
            result.routerControlProxy,
            result.setwiseRouter,
            config.governance,
            config.emergencyGuardian,
            result.registryOwnershipPending
        );
    }

    function _writeDeploymentAddresses(
        BscTestnetDeploymentLib.Config memory config,
        BscTestnetDeploymentLib.Result memory result
    ) private {
        string memory objectKey = "bscTestnetDeployment";
        vm.serializeUint(objectKey, "chainId", CHAIN_ID);
        vm.serializeAddress(objectKey, "deployer", config.deployer);
        vm.serializeAddress(objectKey, "governance", config.governance);
        vm.serializeAddress(objectKey, "emergencyGuardian", config.emergencyGuardian);
        vm.serializeAddress(objectKey, "setPool", config.setPool);
        vm.serializeAddress(objectKey, "wrappedNative", config.wrappedNative);
        vm.serializeAddress(objectKey, "poolRegistryImplementation", result.poolRegistryImplementation);
        vm.serializeAddress(objectKey, "poolRegistryProxy", result.poolRegistryProxy);
        vm.serializeAddress(objectKey, "routerControlImplementation", result.routerControlImplementation);
        vm.serializeAddress(objectKey, "routerControlProxy", result.routerControlProxy);
        vm.serializeAddress(objectKey, "setwiseRouter", result.setwiseRouter);
        string memory json = vm.serializeBool(objectKey, "registryOwnershipPending", result.registryOwnershipPending);

        string memory outputDir = string.concat(vm.projectRoot(), "/broadcast");
        vm.createDir(outputDir, true);
        vm.writeJson(json, string.concat(outputDir, "/bsc-testnet-97.addresses.json"));
    }
}
