import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hashPassword,
  signRequest,
  Vault,
  verifyPassword,
} from "../apps/control-plane/src/crypto.ts";

test("credentials are authenticated encrypted and wrong keys or tampering fail", () => {
  const vault = new Vault("ab".repeat(32));
  const encrypted = vault.encrypt("development-secret");
  assert.ok(!encrypted.includes("development-secret"));
  assert.equal(vault.decrypt(encrypted), "development-secret");
  assert.throws(() => new Vault("cd".repeat(32)).decrypt(encrypted));
  assert.throws(() => vault.decrypt(`${encrypted.slice(0, -4)}aaaa`));
});
test("password hash uses salt and rejects wrong password", async () => {
  const a = await hashPassword("test-password-123"),
    b = await hashPassword("test-password-123");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("test-password-123", a), true);
  assert.equal(await verifyPassword("wrong-password", a), false);
});
test("request signatures bind method, target, timestamp, nonce and exact body", () => {
  const args = [
    "POST",
    "/api/v1/run",
    "2026-09-07T00:00:00Z",
    "nonce",
    '{"input":"a"}',
    "secret",
  ] as const;
  const digest = signRequest(...args);
  for (let i = 0; i < 5; i++) {
    const changed: [string, string, string, string, string, string] = [...args];
    changed[i] += "x";
    assert.notEqual(signRequest(...changed), digest);
  }
});
