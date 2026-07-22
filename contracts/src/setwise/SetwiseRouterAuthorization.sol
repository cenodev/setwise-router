// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISetwisePool} from "./ISetwisePool.sol";
import {SetwiseSwap} from "./SetwiseSwap.sol";

/// @notice ERC-1271 contract-signature surface used by Safe and other smart
///         contract signers.
interface IERC1271SetwiseSigner {
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4 magicValue);
}

/// @notice Signature verification for current EOAs and ERC-1271 contracts.
/// @dev EOA signatures accept canonical 65-byte and EIP-2098 compact 64-byte
///      encodings. Contract signatures are passed through without interpreting
///      their signer-specific encoding, which supports Safe-style signatures.
library SetwiseSignatureChecker {
    bytes4 internal constant ERC1271_MAGIC_VALUE = IERC1271SetwiseSigner.isValidSignature.selector;
    uint256 private constant _SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    function isValidSignatureNow(address signer, bytes32 digest, bytes calldata signature)
        internal
        view
        returns (bool)
    {
        if (signer.code.length == 0) return _recover(digest, signature) == signer;

        (bool ok, bytes memory result) =
            signer.staticcall(abi.encodeCall(IERC1271SetwiseSigner.isValidSignature, (digest, signature)));
        if (!ok || result.length < 32) return false;

        bytes4 magicValue;
        assembly ("memory-safe") {
            magicValue := mload(add(result, 0x20))
        }
        return magicValue == ERC1271_MAGIC_VALUE;
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address recovered) {
        bytes32 r;
        bytes32 s;
        uint8 v;

        if (signature.length == 65) {
            assembly ("memory-safe") {
                r := calldataload(signature.offset)
                s := calldataload(add(signature.offset, 0x20))
                v := byte(0, calldataload(add(signature.offset, 0x40)))
            }
        } else if (signature.length == 64) {
            bytes32 vs;
            assembly ("memory-safe") {
                r := calldataload(signature.offset)
                vs := calldataload(add(signature.offset, 0x20))
            }
            s = bytes32(uint256(vs) & 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);
            v = uint8((uint256(vs) >> 255) + 27);
        } else {
            return address(0);
        }

        if (uint256(s) > _SECP256K1_HALF_ORDER || (v != 27 && v != 28)) return address(0);
        return ecrecover(digest, v, r, s);
    }
}

/// @notice EIP-712 hashing shared by the Setwise Router and RFQ API.
library SetwiseAuthorizationLib {
    /// @dev Static-only transport struct used to avoid compiler stack pressure.
    ///      Its ABI encoding is exactly the flat EIP-712 type encoding below.
    struct AuthorizationHashInput {
        bytes32 typehash;
        uint256 chainId;
        address router;
        address pool;
        address funder;
        address recipient;
        address assetIn;
        address assetOut;
        bool nativeIn;
        bool nativeOut;
        uint256 amountIn;
        uint256 amountOut;
        bytes32 quoteId;
        uint256 deadline;
    }

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant NAME_HASH = keccak256("SetwiseRouter");
    bytes32 internal constant VERSION_HASH = keccak256("1");
    bytes32 internal constant AUTHORIZATION_TYPEHASH = keccak256(
        "SetwiseAuthorization(uint256 chainId,address router,address pool,address funder,address recipient,"
        "address assetIn,address assetOut,bool nativeIn,bool nativeOut,uint256 amountIn,uint256 amountOut,"
        "bytes32 quoteId,uint256 deadline)"
    );

    function domainSeparator(uint256 chainId, address router) internal pure returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, chainId, router));
    }

    function structHash(SetwiseSwap calldata swap, address funder, uint256 chainId, address router)
        internal
        pure
        returns (bytes32)
    {
        AuthorizationHashInput memory input;
        input.typehash = AUTHORIZATION_TYPEHASH;
        input.chainId = chainId;
        input.router = router;
        input.pool = swap.pool;
        input.funder = funder;
        input.recipient = swap.recipient;
        input.assetIn = swap.assetIn;
        input.assetOut = swap.assetOut;
        input.nativeIn = swap.nativeIn;
        input.nativeOut = swap.nativeOut;
        input.amountIn = swap.amountIn;
        input.amountOut = swap.amountOut;
        input.quoteId = swap.quoteId;
        input.deadline = swap.deadline;
        return keccak256(abi.encode(input));
    }

    function digest(SetwiseSwap calldata swap, address funder, uint256 chainId, address router)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(chainId, router), structHash(swap, funder, chainId, router))
        );
    }
}

/// @title SetwiseRouterAuthorization
/// @notice Router-level authorization that binds the funding wallet and all
///         security-sensitive Set swap calldata before an adapter moves funds.
/// @dev The pool still verifies its existing `SwapQuote` independently with the
///      router as `payer`. Both signatures use the pool's current
///      `QUOTE_SIGNER`; the successful pool call consumes the shared quote ID.
abstract contract SetwiseRouterAuthorization {
    error InvalidSetwiseAuthorization();
    error InvalidSetwiseQuoteSigner(address signer);
    error SetwiseAuthorizationExpired(uint256 deadline);
    error SetwiseAuthorizationWrongCaller(address caller, address funder);

    /// @notice Verify before entering the adapter body so approvals, token
    ///         pulls, native-value forwarding, and pool calls cannot precede it.
    modifier onlyValidSetwiseAuthorization(
        SetwiseSwap calldata swap,
        address funder,
        bytes calldata authorizationSignature
    ) {
        _verifySetwiseAuthorization(swap, funder, authorizationSignature);
        _;
    }

    /// @notice EIP-712 domain separator for this router on the current chain.
    function setwiseAuthorizationDomainSeparator() public view returns (bytes32) {
        return SetwiseAuthorizationLib.domainSeparator(block.chainid, address(this));
    }

    /// @notice Digest the RFQ signer authorizes for this exact call context.
    function setwiseAuthorizationDigest(SetwiseSwap calldata swap, address funder) public view returns (bytes32) {
        return SetwiseAuthorizationLib.digest(swap, funder, block.chainid, address(this));
    }

    function _verifySetwiseAuthorization(
        SetwiseSwap calldata swap,
        address funder,
        bytes calldata authorizationSignature
    ) internal view {
        if (msg.sender != funder) revert SetwiseAuthorizationWrongCaller(msg.sender, funder);
        if (block.timestamp > swap.deadline) revert SetwiseAuthorizationExpired(swap.deadline);

        address signer = ISetwisePool(swap.pool).QUOTE_SIGNER();
        if (signer == address(0)) revert InvalidSetwiseQuoteSigner(signer);
        if (!SetwiseSignatureChecker.isValidSignatureNow(
                signer, setwiseAuthorizationDigest(swap, funder), authorizationSignature
            )) revert InvalidSetwiseAuthorization();
    }
}
