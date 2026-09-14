import assert from "node:assert/strict";
import { test } from "node:test";
import { Tool, ToolInput, ToolProbeInput, ToolUpdate } from "../../packages/contracts/src/index.ts";

const stored = {
  name: "order_lookup",
  description: "读取订单",
  kind: "http_get",
  url: "http://tool.test/orders",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  outputSchema: { type: "object" },
  id: "2c57cb45-032a-45f2-9487-dcffdf085c7d",
  projectId: "9e2e826c-99ec-48a7-b9cd-2c3430054323",
  hasCredential: true,
  createdAt: "2026-09-11",
  version: 1 as const,
};

/**
 * A tool row written before this change carries no probe fields at all, so the
 * read path must keep parsing it. `Tool` is derived from `ToolInput`, so this
 * asserts the stored shape indirectly, but the read path is checked directly.
 */
test("a tool row stored before probing existed still parses", () => {
  const parsed = Tool.parse(stored);
  assert.equal(parsed.kind, "http_get");
  assert.equal(parsed.version, 1);
});

test("an imported MCP tool keeps its pinned descriptor", () => {
  const parsed = Tool.parse({
    ...stored,
    kind: "mcp",
    mcp: {
      serverId: "9e2e826c-99ec-48a7-b9cd-2c3430054323",
      contractDigest: "sha256-fixture",
      descriptor: { name: "remote_sum", inputSchema: { type: "object" } },
    },
  });
  assert.equal(parsed.mcp?.descriptor.name, "remote_sum");
});

test("updating without a token keeps the credential field optional", () => {
  const parsed = ToolUpdate.parse({
    name: "order_lookup",
    description: "读取订单",
    kind: "http_get",
    url: "http://tool.test/orders",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  });
  assert.equal(parsed.bearerToken, undefined);
});

test("an authored tool rejects the MCP kind it cannot create by hand", () => {
  assert.equal(
    ToolInput.safeParse({
      name: "mcp_by_hand",
      description: "不应被接受",
      kind: "mcp",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    }).success,
    false,
  );
});

test("a probe request defaults its sample arguments to an empty object", () => {
  const parsed = ToolProbeInput.parse({
    kind: "http_get",
    url: "http://tool.test/orders",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  });
  assert.deepEqual(parsed.input, {});
  assert.equal(parsed.bearerToken, undefined);
});

test("a probe request rejects unknown keys instead of silently dropping them", () => {
  assert.equal(
    ToolProbeInput.safeParse({
      kind: "sum",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      method: "POST",
    }).success,
    false,
  );
});
