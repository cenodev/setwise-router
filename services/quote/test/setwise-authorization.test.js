import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildSetwiseAuthorizationTypedData,
  SETWISE_AUTHORIZATION_PRIMARY_TYPE,
  SETWISE_AUTHORIZATION_TYPES,
} from "../src/setwise-authorization.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = JSON.parse(readFileSync(join(root, "baseline/setwise/router-authorization.json"), "utf8"));

test("RFQ typed data matches the shared contract authorization fixture", () => {
  const typedData = buildSetwiseAuthorizationTypedData(fixture.typedData.message);

  assert.equal(typedData.primaryType, SETWISE_AUTHORIZATION_PRIMARY_TYPE);
  assert.deepEqual(typedData.types, SETWISE_AUTHORIZATION_TYPES);
  assert.deepEqual(typedData, fixture.typedData);
  assert.equal(typedData.domain.name, "SetwiseRouter");
  assert.equal(typedData.domain.version, "1");
  assert.equal(typedData.domain.chainId, typedData.message.chainId);
  assert.equal(typedData.domain.verifyingContract, typedData.message.router);
});

test("authorization fixture contains an EOA signature and every bound field", () => {
  assert.equal(fixture.schema, "setwise-router/router-authorization@1");
  assert.match(fixture.expected.authorizationTypehash, /^0x[0-9a-f]{64}$/);
  assert.match(fixture.expected.domainSeparator, /^0x[0-9a-f]{64}$/);
  assert.match(fixture.expected.structHash, /^0x[0-9a-f]{64}$/);
  assert.match(fixture.expected.digest, /^0x[0-9a-f]{64}$/);
  assert.match(fixture.expected.signer, /^0x[0-9a-fA-F]{40}$/);
  assert.match(fixture.expected.signature, /^0x[0-9a-f]{130}$/);
  assert.deepEqual(
    fixture.typedData.types.SetwiseAuthorization.map(({ name }) => name),
    [
      "chainId",
      "router",
      "pool",
      "funder",
      "recipient",
      "assetIn",
      "assetOut",
      "nativeIn",
      "nativeOut",
      "amountIn",
      "amountOut",
      "quoteId",
      "deadline",
    ],
  );
});
