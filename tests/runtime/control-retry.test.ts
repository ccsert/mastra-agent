import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { runtimeClient } from "../../apps/runtime/src/control-plane/client.ts";

test("fenced writes retry transient failures with identical identity while claim does not retry", async () => {
  const calls: Array<{ path: string; id: string; body: string }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    calls.push({ path: req.url ?? "", id: String(req.headers["x-request-id"]), body });
    const first = calls.filter((call) => call.path === req.url).length === 1;
    res.writeHead(first ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(first ? { code: "TEMPORARY_UNAVAILABLE" } : { ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const post = runtimeClient({
    controlPlaneUrl: `http://127.0.0.1:${address.port}`,
    runtimeId: "test",
    runtimeToken: "test",
    signal: AbortSignal.timeout(5000),
    logger: () => {},
  });
  try {
    assert.deepEqual(
      await post("/internal/runtime/runs/test/events", { seq: 0, leaseToken: "lease" }),
      { ok: true },
    );
    assert.deepEqual(calls[0], calls[1]);
    await assert.rejects(post("/internal/runtime/claim", {}), /CONTROL_PLANE_503/);
    assert.equal(calls.filter((call) => call.path.endsWith("/claim")).length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
