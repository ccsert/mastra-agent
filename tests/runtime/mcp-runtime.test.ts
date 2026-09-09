import assert from "node:assert/strict";
import { test } from "node:test";
import { callMcpTool, discoverMcp } from "../../apps/runtime/src/mcp/mcp.ts";
import { compileMcpSchema } from "../../packages/contracts/src/index.ts";
import { mcpFixture } from "../fixtures/mcp-fixture.ts";

test("MCP schema profile blocks nested regex/ref while accepting ordinary field names", () => {
  const draft = { $schema: "http://json-schema.org/draft-07/schema#", type: "object" };
  assert.throws(
    () =>
      compileMcpSchema({
        ...draft,
        dependencies: { trigger: { properties: { value: { type: "string", pattern: "a+" } } } },
      }),
    /MCP_SCHEMA_UNSUPPORTED/,
  );
  assert.throws(
    () =>
      compileMcpSchema({
        ...draft,
        properties: {
          values: {
            type: "array",
            items: [{}],
            additionalItems: { type: "string", pattern: "a+" },
          },
        },
      }),
    /MCP_SCHEMA_UNSUPPORTED/,
  );
  assert.throws(
    () =>
      compileMcpSchema({
        ...draft,
        dependencies: { trigger: { $ref: "#/definitions/recursive" } },
      }),
    /MCP_SCHEMA_UNSUPPORTED/,
  );
  assert.equal(
    compileMcpSchema({ type: "object", properties: { format: { type: "string" } } })({
      format: "text",
    }),
    true,
  );
});

test("MCP Streamable HTTP also consumes SSE responses", async () => {
  const fixture = await mcpFixture(0, false);
  try {
    const binding = { url: fixture.url, bearerToken: "mcp-fixture-key" },
      signal = AbortSignal.timeout(5000);
    const tools = await discoverMcp(binding, signal);
    const result = await callMcpTool(binding, tools[0], { orderId: "ORD-1001" }, signal);
    assert.equal(result.data?.amount, 12800);
  } finally {
    await fixture.close();
  }
});

test("MCP paginated discovery is read-only; calls enforce the pinned contract and result schema", {
  timeout: 20000,
}, async () => {
  const fixture = await mcpFixture();
  const signal = AbortSignal.timeout(15000);
  const binding = { url: fixture.url, bearerToken: "mcp-fixture-key" };
  try {
    const descriptors = await discoverMcp(binding, signal);
    assert.deepEqual(
      descriptors.map((d) => d.name),
      ["orders_lookup", "orders_update"],
    );
    assert.equal(fixture.calls.length, 0);
    const result = await callMcpTool(binding, descriptors[0], { orderId: "ORD-1001" }, signal);
    assert.equal(result.data?.status, "待发货");
    assert.equal(fixture.calls.length, 1);
    await assert.rejects(
      () => callMcpTool(binding, descriptors[0], {}, signal),
      /MCP_INPUT_INVALID/,
    );
    fixture.state.changed = true;
    await assert.rejects(
      () => callMcpTool(binding, descriptors[0], { orderId: "ORD-1001" }, signal),
      /MCP_CONTRACT_CHANGED/,
    );
    assert.equal(fixture.calls.length, 1);
    fixture.state.changed = false;
    fixture.state.invalidOutput = true;
    await assert.rejects(
      () => callMcpTool(binding, descriptors[0], { orderId: "ORD-1001" }, signal),
      /MCP_RESULT_INVALID/,
    );
    await assert.rejects(
      () => discoverMcp({ ...binding, bearerToken: "wrong" }, signal),
      /MCP_CONNECTION_FAILED/,
    );
    fixture.state.repeatCursor = true;
    await assert.rejects(() => discoverMcp(binding, signal), /MCP_DISCOVERY_INVALID/);
  } finally {
    await fixture.close();
  }
});
