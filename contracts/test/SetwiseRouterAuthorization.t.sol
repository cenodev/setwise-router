// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    IERC1271SetwiseSigner,
    SetwiseAuthorizationLib,
    SetwiseRouterAuthorization,
    SetwiseSignatureChecker
} from "../src/setwise/SetwiseRouterAuthorization.sol";
import {SetwiseSwap} from "../src/setwise/SetwiseSwap.sol";

interface VmAuthorization {
    function addr(uint256 privateKey) external returns (address);
    function chainId(uint256 newChainId) external;
    function expectRevert(bytes calldata revertData) external;
    function prank(address caller) external;
    function readFile(string calldata path) external view returns (string memory data);
    function parseJsonAddress(string calldata json, string calldata key) external pure returns (address value);
    function parseJsonBool(string calldata json, string calldata key) external pure returns (bool value);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory value);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32 value);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256 value);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 newTimestamp) external;
}

contract MockAuthorizationPool {
    address public QUOTE_SIGNER;

    constructor(address initialSigner) {
        QUOTE_SIGNER = initialSigner;
    }

    function setQuoteSigner(address newSigner) external {
        QUOTE_SIGNER = newSigner;
    }
}

contract MockAuthorizationToken {
    mapping(address account => uint256 amount) public balanceOf;

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockSafeStyleSigner is IERC1271SetwiseSigner {
    bytes32 private _approvedDigest;
    bytes32 private _approvedSignatureHash;
    bool private _shouldRevert;

    function approve(bytes32 digest, bytes calldata signature) external {
        _approvedDigest = digest;
        _approvedSignatureHash = keccak256(signature);
    }

    function setShouldRevert(bool value) external {
        _shouldRevert = value;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (_shouldRevert) revert("signer unavailable");
        if (digest == _approvedDigest && keccak256(signature) == _approvedSignatureHash) {
            return IERC1271SetwiseSigner.isValidSignature.selector;
        }
        return 0xffffffff;
    }
}

contract AuthorizationExecutionHarness is SetwiseRouterAuthorization {
    uint256 public pulls;

    function execute(SetwiseSwap calldata swap, address funder, bytes calldata authorizationSignature)
        external
        onlyValidSetwiseAuthorization(swap, funder, authorizationSignature)
    {
        MockAuthorizationToken(swap.assetIn).transferFrom(funder, address(this), swap.amountIn);
        pulls += 1;
    }

    function explicitDomainSeparator(uint256 chainId, address router) external pure returns (bytes32) {
        return SetwiseAuthorizationLib.domainSeparator(chainId, router);
    }

    function explicitStructHash(SetwiseSwap calldata swap, address funder, uint256 chainId, address router)
        external
        pure
        returns (bytes32)
    {
        return SetwiseAuthorizationLib.structHash(swap, funder, chainId, router);
    }

    function explicitDigest(SetwiseSwap calldata swap, address funder, uint256 chainId, address router)
        external
        pure
        returns (bytes32)
    {
        return SetwiseAuthorizationLib.digest(swap, funder, chainId, router);
    }

    function authorizationTypehash() external pure returns (bytes32) {
        return SetwiseAuthorizationLib.AUTHORIZATION_TYPEHASH;
    }

    function isValidSignature(address expectedSigner, bytes32 digest, bytes calldata signature)
        external
        view
        returns (bool)
    {
        return SetwiseSignatureChecker.isValidSignatureNow(expectedSigner, digest, signature);
    }
}

/// @notice EOA/ERC-1271 and every-field negative tests for the router-specific
///         authorization. The execution harness deliberately pulls funds only
///         inside the protected function body.
contract SetwiseRouterAuthorizationTest {
    VmAuthorization internal constant vm = VmAuthorization(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant ROTATED_SIGNER_KEY = 0xB0B;
    uint256 internal constant SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    address internal constant FUNDER = address(0xF00D);
    address internal constant OTHER_FUNDER = address(0xF00E);
    address internal constant RECIPIENT = address(0xBEEF);
    address internal constant OUTPUT_ASSET = address(0xCAFE);
    uint256 internal constant CHAIN_ID = 56;
    uint256 internal constant AMOUNT_IN = 1_000_000;

    address internal signer;
    MockAuthorizationPool internal pool;
    MockAuthorizationToken internal token;
    AuthorizationExecutionHarness internal harness;

    function setUp() public {
        vm.chainId(CHAIN_ID);
        vm.warp(1_700_000_000);
        signer = vm.addr(SIGNER_KEY);
        pool = new MockAuthorizationPool(signer);
        token = new MockAuthorizationToken();
        harness = new AuthorizationExecutionHarness();
        token.mint(FUNDER, AMOUNT_IN * 10);
        token.mint(OTHER_FUNDER, AMOUNT_IN * 10);
    }

    function _swap() internal view returns (SetwiseSwap memory) {
        return SetwiseSwap({
            pool: address(pool),
            assetIn: address(token),
            assetOut: OUTPUT_ASSET,
            nativeIn: false,
            nativeOut: false,
            amountIn: AMOUNT_IN,
            amountOut: 500_000_000_000_000_000,
            quoteId: keccak256("setwise-router-authorization-test"),
            deadline: block.timestamp + 1 days,
            recipient: RECIPIENT,
            signature: hex"1234",
            auxiliaryData: hex"726671"
        });
    }

    function _sign(SetwiseSwap memory swap, address funder, uint256 privateKey) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, harness.setwiseAuthorizationDigest(swap, funder));
        return abi.encodePacked(r, s, v);
    }

    function _expectInvalid(SetwiseSwap memory modified, bytes memory originalSignature) internal {
        vm.expectRevert(abi.encodeWithSelector(SetwiseRouterAuthorization.InvalidSetwiseAuthorization.selector));
        vm.prank(FUNDER);
        harness.execute(modified, FUNDER, originalSignature);
        require(harness.pulls() == 0, "interaction preceded verification");
        require(token.balanceOf(FUNDER) == AMOUNT_IN * 10, "funds moved before verification");
    }

    function testValidEoaAuthorizationPullsOnlyAfterVerification() external {
        SetwiseSwap memory swap = _swap();
        bytes memory signature = _sign(swap, FUNDER, SIGNER_KEY);

        vm.prank(FUNDER);
        harness.execute(swap, FUNDER, signature);

        require(harness.pulls() == 1, "pull count");
        require(token.balanceOf(FUNDER) == AMOUNT_IN * 9, "funder debit");
        require(token.balanceOf(address(harness)) == AMOUNT_IN, "harness credit");
    }

    function testSharedRfqFixtureMatchesContractHashAndEoaSignature() external view {
        string memory json = vm.readFile("../baseline/setwise/router-authorization.json");
        address fixtureFunder = vm.parseJsonAddress(json, ".typedData.message.funder");
        uint256 fixtureChainId = vm.parseJsonUint(json, ".typedData.message.chainId");
        address fixtureRouter = vm.parseJsonAddress(json, ".typedData.message.router");
        SetwiseSwap memory fixtureSwap = SetwiseSwap({
            pool: vm.parseJsonAddress(json, ".typedData.message.pool"),
            assetIn: vm.parseJsonAddress(json, ".typedData.message.assetIn"),
            assetOut: vm.parseJsonAddress(json, ".typedData.message.assetOut"),
            nativeIn: vm.parseJsonBool(json, ".typedData.message.nativeIn"),
            nativeOut: vm.parseJsonBool(json, ".typedData.message.nativeOut"),
            amountIn: vm.parseJsonUint(json, ".typedData.message.amountIn"),
            amountOut: vm.parseJsonUint(json, ".typedData.message.amountOut"),
            quoteId: vm.parseJsonBytes32(json, ".typedData.message.quoteId"),
            deadline: vm.parseJsonUint(json, ".typedData.message.deadline"),
            recipient: vm.parseJsonAddress(json, ".typedData.message.recipient"),
            signature: "",
            auxiliaryData: ""
        });

        require(
            harness.authorizationTypehash() == vm.parseJsonBytes32(json, ".expected.authorizationTypehash"),
            "fixture typehash"
        );
        require(
            harness.explicitDomainSeparator(fixtureChainId, fixtureRouter)
                == vm.parseJsonBytes32(json, ".expected.domainSeparator"),
            "fixture domain"
        );
        require(
            harness.explicitStructHash(fixtureSwap, fixtureFunder, fixtureChainId, fixtureRouter)
                == vm.parseJsonBytes32(json, ".expected.structHash"),
            "fixture struct hash"
        );
        bytes32 fixtureDigest = harness.explicitDigest(fixtureSwap, fixtureFunder, fixtureChainId, fixtureRouter);
        require(fixtureDigest == vm.parseJsonBytes32(json, ".expected.digest"), "fixture digest");
        require(
            harness.isValidSignature(
                vm.parseJsonAddress(json, ".expected.signer"),
                fixtureDigest,
                vm.parseJsonBytes(json, ".expected.signature")
            ),
            "fixture EOA signature"
        );
    }

    function testAcceptsEip2098CompactEoaSignature() external {
        SetwiseSwap memory swap = _swap();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, harness.setwiseAuthorizationDigest(swap, FUNDER));
        bytes32 vs = bytes32(uint256(s) | ((uint256(v) - 27) << 255));

        vm.prank(FUNDER);
        harness.execute(swap, FUNDER, abi.encodePacked(r, vs));
        require(harness.pulls() == 1, "compact signature");
    }

    function testRejectsMalleableOrMalformedEoaSignature() external {
        SetwiseSwap memory swap = _swap();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, harness.setwiseAuthorizationDigest(swap, FUNDER));
        bytes32 highS = bytes32(SECP256K1_ORDER - uint256(s));
        _expectInvalid(swap, abi.encodePacked(r, highS, v == 27 ? uint8(28) : uint8(27)));
        _expectInvalid(swap, new bytes(63));
    }

    function testRejectsWrongCallerBeforeFundsMove() external {
        SetwiseSwap memory swap = _swap();
        bytes memory signature = _sign(swap, FUNDER, SIGNER_KEY);

        vm.expectRevert(
            abi.encodeWithSelector(
                SetwiseRouterAuthorization.SetwiseAuthorizationWrongCaller.selector, OTHER_FUNDER, FUNDER
            )
        );
        vm.prank(OTHER_FUNDER);
        harness.execute(swap, FUNDER, signature);

        require(harness.pulls() == 0, "pull occurred");
        require(token.balanceOf(FUNDER) == AMOUNT_IN * 10, "funds moved");
    }

    function testRejectsExpiredAuthorizationBeforeFundsMove() external {
        SetwiseSwap memory swap = _swap();
        bytes memory signature = _sign(swap, FUNDER, SIGNER_KEY);
        vm.warp(swap.deadline + 1);

        vm.expectRevert(
            abi.encodeWithSelector(SetwiseRouterAuthorization.SetwiseAuthorizationExpired.selector, swap.deadline)
        );
        vm.prank(FUNDER);
        harness.execute(swap, FUNDER, signature);
        require(token.balanceOf(FUNDER) == AMOUNT_IN * 10, "expired funds moved");
    }

    function testRejectsWrongChain() external {
        SetwiseSwap memory swap = _swap();
        bytes memory signature = _sign(swap, FUNDER, SIGNER_KEY);
        vm.chainId(CHAIN_ID + 1);
        _expectInvalid(swap, signature);
    }

    function testRejectsWrongRouter() external {
        SetwiseSwap memory swap = _swap();
        bytes memory signature = _sign(swap, FUNDER, SIGNER_KEY);
        AuthorizationExecutionHarness otherRouter = new AuthorizationExecutionHarness();

        vm.expectRevert(abi.encodeWithSelector(SetwiseRouterAuthorization.InvalidSetwiseAuthorization.selector));
        vm.prank(FUNDER);
        otherRouter.execute(swap, FUNDER, signature);
        require(token.balanceOf(FUNDER) == AMOUNT_IN * 10, "wrong-router funds moved");
    }

    function testRejectsWrongPool() external {
        SetwiseSwap memory swap = _swap();
        bytes memory signature = _sign(swap, FUNDER, SIGNER_KEY);
        swap.pool = address(new MockAuthorizationPool(signer));
        _expectInvalid(swap, signature);
    }

    function testRejectsWrongFunder() external {
        SetwiseSwap memory swap = _swap();
        bytes memory signature = _sign(swap, FUNDER, SIGNER_KEY);

        vm.expectRevert(abi.encodeWithSelector(SetwiseRouterAuthorization.InvalidSetwiseAuthorization.selector));
        vm.prank(OTHER_FUNDER);
        harness.execute(swap, OTHER_FUNDER, signature);
        require(token.balanceOf(OTHER_FUNDER) == AMOUNT_IN * 10, "wrong-funder funds moved");
    }

    function testRejectsModifiedRecipient() external {
        SetwiseSwap memory swap = _swap();
        bytes memory signature = _sign(swap, FUNDER, SIGNER_KEY);
        swap.recipient = address(0xBAD);
        _expectInvalid(swap, signature);
    }

    function testRejectsModifiedInputAsset() external {
        SetwiseSwap memory swap = _swap();
        bytes memory signature = _sign(swap, FUNDER, SIGNER_KEY);
        swap.assetIn = address(0xBAD);
        _expectInvalid(swap, signature);
    }

    function testRejectsModifiedOutputAsset() external {
        SetwiseSwap memory swap = _swap();
        bytes memory signature = _sign(swap, FUNDER, SIGNER_KEY);
        swap.assetOut = address(0xBAD);
        _expectInvalid(swap, signature);
    }

    function testRejectsModifiedNativeInFlag() external {
        SetwiseSwap memory swap = _swap();
        bytes memory signature = _sign(swap, FUNDER, SIGNER_KEY);
        swap.nativeIn = true;
        _expectInvalid(swap, signature);
    }

    function testRejectsModifiedNativeOutFlag() external {
        SetwiseSwap memory swap = _swap();
        bytes memory signature = _sign(swap, FUNDER, SIGNER_KEY);
        swap.nativeOut = true;
        _expectInvalid(swap, signature);
    }

    function testRejectsModifiedInputAmountBeforeFundsMove() external {
        SetwiseSwap memory swap = _swap();
        bytes memory signature = _sign(swap, FUNDER, SIGNER_KEY);
        swap.amountIn += 1;
        _expectInvalid(swap, signature);
    }

    function testRejectsModifiedOutputAmount() external {
        SetwiseSwap memory swap = _swap();
        bytes memory signature = _sign(swap, FUNDER, SIGNER_KEY);
        swap.amountOut += 1;
        _expectInvalid(swap, signature);
    }

    function testRejectsModifiedQuoteId() external {
        SetwiseSwap memory swap = _swap();
        bytes memory signature = _sign(swap, FUNDER, SIGNER_KEY);
        swap.quoteId = keccak256("copied calldata");
        _expectInvalid(swap, signature);
    }

    function testRejectsModifiedDeadline() external {
        SetwiseSwap memory swap = _swap();
        bytes memory signature = _sign(swap, FUNDER, SIGNER_KEY);
        swap.deadline += 1;
        _expectInvalid(swap, signature);
    }

    function testReadsCurrentPoolSignerAfterRotation() external {
        SetwiseSwap memory swap = _swap();
        bytes memory oldSignature = _sign(swap, FUNDER, SIGNER_KEY);
        pool.setQuoteSigner(vm.addr(ROTATED_SIGNER_KEY));
        _expectInvalid(swap, oldSignature);

        bytes memory rotatedSignature = _sign(swap, FUNDER, ROTATED_SIGNER_KEY);
        vm.prank(FUNDER);
        harness.execute(swap, FUNDER, rotatedSignature);
        require(harness.pulls() == 1, "rotated signer");
    }

    function testRejectsZeroPoolSigner() external {
        SetwiseSwap memory swap = _swap();
        pool.setQuoteSigner(address(0));

        vm.expectRevert(
            abi.encodeWithSelector(SetwiseRouterAuthorization.InvalidSetwiseQuoteSigner.selector, address(0))
        );
        vm.prank(FUNDER);
        harness.execute(swap, FUNDER, hex"");
    }

    function testSupportsSafeStyleErc1271Signatures() external {
        SetwiseSwap memory swap = _swap();
        MockSafeStyleSigner safe = new MockSafeStyleSigner();
        pool.setQuoteSigner(address(safe));

        bytes memory safeSignature = abi.encodePacked(
            bytes32(uint256(1)), bytes32(uint256(2)), uint8(27), bytes32(uint256(3)), bytes32(uint256(4)), uint8(28)
        );
        require(safeSignature.length == 130, "Safe-style signature length");
        safe.approve(harness.setwiseAuthorizationDigest(swap, FUNDER), safeSignature);

        vm.prank(FUNDER);
        harness.execute(swap, FUNDER, safeSignature);
        require(harness.pulls() == 1, "ERC-1271 authorization");
    }

    function testRejectsInvalidOrRevertingErc1271Signer() external {
        SetwiseSwap memory swap = _swap();
        MockSafeStyleSigner safe = new MockSafeStyleSigner();
        pool.setQuoteSigner(address(safe));

        vm.expectRevert(abi.encodeWithSelector(SetwiseRouterAuthorization.InvalidSetwiseAuthorization.selector));
        vm.prank(FUNDER);
        harness.execute(swap, FUNDER, hex"1234");

        safe.setShouldRevert(true);
        vm.expectRevert(abi.encodeWithSelector(SetwiseRouterAuthorization.InvalidSetwiseAuthorization.selector));
        vm.prank(FUNDER);
        harness.execute(swap, FUNDER, hex"1234");
    }
}
