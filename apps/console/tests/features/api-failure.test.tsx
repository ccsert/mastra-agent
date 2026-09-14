import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { unwrap, unwrapPage } from "../../src/shared/api.ts";

/**
 * `unwrap` is the single place every console request turns a failure into text,
 * and the old version collapsed every non-`{message}` shape into
 * 「无法连接平台服务」 — which described a network outage for what was often a
 * route the running control plane did not have. These tests pin the cause named
 * for each shape, because a wrong cause sends the operator to the wrong place.
 */
const failed = (response: Response, error: unknown) =>
  Promise.resolve({ error, response } as { data?: unknown; error?: unknown; response?: Response });

test("a platform error body is reported with the server's own message", async () => {
  const response = Response.json(
    { code: "INVALID_INPUT", message: "名称不能为空" },
    { status: 400 },
  );
  await assert.rejects(unwrap(failed(response, { message: "名称不能为空" })), {
    message: "名称不能为空",
  });
});

test("a 5xx keeps the server's message instead of replacing it with a generic one", async () => {
  // The editor asserts this exact text, so a status-based rewrite must not win.
  const response = Response.json({ message: "Skill 目录读取失败" }, { status: 503 });
  await assert.rejects(unwrap(failed(response, { message: "Skill 目录读取失败" })), {
    message: "Skill 目录读取失败",
  });
});

test("a route the control plane does not serve says so, not that the network is down", async () => {
  // Hono answers an unknown route with plain text, which the client throws raw.
  const error = "404 Not Found";
  const response = new Response(error, { status: 404, headers: { "content-type": "text/plain" } });
  await assert.rejects(unwrap(failed(response, error)), (thrown: Error) => {
    assert.match(thrown.message, /没有这个接口（404）/);
    assert.doesNotMatch(thrown.message, /无法连接平台服务/);
    return true;
  });
});

test("no response at all is the only case described as a connection problem", async () => {
  // A transport failure leaves `response` undefined, which is what a stopped
  // service actually looks like.
  await assert.rejects(unwrap(Promise.resolve({ error: new TypeError("fetch failed") })), {
    message: /无法连接平台服务/,
  });
});

test("a 5xx without a parsed body still names the status", async () => {
  const response = new Response("upstream boom", { status: 502 });
  await assert.rejects(unwrap(failed(response, "upstream boom")), {
    message: /HTTP 502/,
  });
});

test("a successful result is returned as-is and pages read the cursor header", async () => {
  const response = Response.json([{ id: "a" }], { headers: { "X-Next-Cursor": "next-1" } });
  assert.deepEqual(await unwrap(Promise.resolve({ data: [1, 2], response })), [1, 2]);
  const page = await unwrapPage(Promise.resolve({ data: [{ id: "a" }], response }));
  assert.deepEqual(page.items, [{ id: "a" }]);
  assert.equal(page.nextCursor, "next-1");
});
