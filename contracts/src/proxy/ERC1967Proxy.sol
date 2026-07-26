// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ERC1967Proxy
/// @notice Minimal ERC-1967 implementation proxy used for Set Router
///         governance contracts. When an implementation supports UUPS, upgrade
///         authorization remains entirely delegated; this proxy has no admin
///         surface of its own.
contract ERC1967Proxy {
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    error InvalidImplementation(address implementation);
    error InitializationFailed(bytes reason);

    constructor(address implementation, bytes memory initializationCall) payable {
        if (implementation.code.length == 0) revert InvalidImplementation(implementation);
        assembly ("memory-safe") {
            sstore(IMPLEMENTATION_SLOT, implementation)
        }

        if (initializationCall.length != 0) {
            (bool ok, bytes memory reason) = implementation.delegatecall(initializationCall);
            if (!ok) revert InitializationFailed(reason);
        }
    }

    fallback() external payable {
        _delegate();
    }

    receive() external payable {
        _delegate();
    }

    function _delegate() private {
        assembly ("memory-safe") {
            let implementation := sload(IMPLEMENTATION_SLOT)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}
