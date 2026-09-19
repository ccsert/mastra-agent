import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTokenShort,
  parseTokenShort,
  recommendedMaxTokens,
} from "../../src/features/agents/token-short.ts";

test("token shorthand parses k, m and plain numbers", () => {
  assert.equal(parseTokenShort("128k"), 128000);
  assert.equal(parseTokenShort("128K"), 128000);
  assert.equal(parseTokenShort("1m"), 1000000);
  assert.equal(parseTokenShort("1.5m"), 1500000);
  assert.equal(parseTokenShort("0.5 m"), 500000);
  assert.equal(parseTokenShort("4096"), 4096);
  assert.equal(parseTokenShort(""), Number.NaN);
  assert.equal(parseTokenShort("abc"), Number.NaN);
  assert.equal(parseTokenShort("12x"), Number.NaN);
});

test("token formatting picks the shortest readable unit", () => {
  assert.equal(formatTokenShort(128000), "128k");
  assert.equal(formatTokenShort(32000), "32k");
  assert.equal(formatTokenShort(4096), "4096");
  assert.equal(formatTokenShort(8192), "8192");
  assert.equal(formatTokenShort(2000000), "2m");
  assert.equal(formatTokenShort(1280000), "1.28m");
  assert.equal(formatTokenShort(400000), "400k");
  assert.equal(formatTokenShort(0), "0");
});

test("format and parse round-trip", () => {
  for (const value of [32000, 128000, 400000, 1290000, 20000000]) {
    assert.equal(parseTokenShort(formatTokenShort(value)), value, String(value));
  }
});

test("the recommended run budget scales with the window but never below one call", () => {
  // The shipped default shape: 32k window, 4096 output, 100 calls.
  assert.equal(recommendedMaxTokens(32000, 4096, 100), 324096);
  // A 128k window with 160 calls budgets ten full windows.
  assert.equal(recommendedMaxTokens(128000, 10000, 160), 1290000);
  // Few calls: the budget scales with the actual call count, floor is one call.
  assert.equal(recommendedMaxTokens(32000, 4096, 2), 68096);
  // At least one full call even when the call count is one.
  assert.equal(recommendedMaxTokens(128000, 8192, 1), 136192);
});
