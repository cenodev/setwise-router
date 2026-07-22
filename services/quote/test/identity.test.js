import assert from "node:assert/strict";
import test from "node:test";
import { SERVICE_NAME, VERSION } from "../src/index.js";

test("quote service exports stable identity", () => {
  assert.equal(SERVICE_NAME, "setwise-router-quote");
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
