import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  connectAgentFrame,
  createAgentApplication,
  serveAgentApplication,
} from "../../packages/agent-ui/src/index.ts";
import { AgentAppManifest } from "../../packages/contracts/src/index.ts";

const manifest = AgentAppManifest.parse({
  protocolVersion: "1.0",
  appId: "test.bridge",
  name: "Bridge",
  version: "1",
  actions: [
    {
      id: "view.open",
      title: "Open",
      description: "Open view",
      effect: "view",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
    },
  ],
});
test("frame bridge checks origin, source, channel, manifest and app-side user consent", async () => {
  const dom = new JSDOM("", { url: "https://host.example", pretendToBeVisual: true });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  let granted = false,
    calls = 0;
  const app = createAgentApplication({
    manifest,
    observe: () => ({
      page: { id: "home", title: "Home" },
      ready: true,
      summary: "",
      state: { calls },
      actions: [{ id: "view.open", available: true }],
    }),
    handlers: {
      "view.open": async () => {
        calls++;
        return { output: {}, message: "Opened" };
      },
    },
  });
  const received: { data: Record<string, unknown>; targetOrigin: string }[] = [];
  const host = {
    postMessage(data: Record<string, unknown>, targetOrigin: string) {
      received.push({ data, targetOrigin });
      queueMicrotask(() =>
        dom.window.dispatchEvent(
          new dom.window.MessageEvent("message", {
            source: frame as unknown as Window,
            origin: "https://app.example",
            data,
          }),
        ),
      );
    },
  };
  const frame = {
    postMessage(data: Record<string, unknown>, targetOrigin: string) {
      assert.equal(targetOrigin, "https://app.example");
      queueMicrotask(() =>
        dom.window.dispatchEvent(
          new dom.window.MessageEvent("message", {
            source: host as unknown as Window,
            origin: "https://host.example",
            data,
          }),
        ),
      );
    },
  };
  const server = serveAgentApplication({
    application: app,
    hostWindow: host as unknown as Window,
    hostOrigin: "https://host.example",
    authorize: () => granted,
  });
  const connect = (m = manifest) =>
    connectAgentFrame({
      frame: frame as unknown as Window,
      origin: "https://app.example",
      manifest: m,
      allowDraft: false,
      signal: new AbortController().signal,
    });
  try {
    await assert.rejects(connect(), /APP_USER_GRANT_REQUIRED/);
    granted = true;
    await assert.rejects(connect({ ...manifest, version: "2" }), /APP_MANIFEST_CHANGED/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const connection = await connect();
    const count = received.length;
    for (const variant of [
      { source: frame, origin: "https://host.example" },
      { source: host, origin: "https://evil.example" },
      { source: host, origin: "https://host.example" },
    ])
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          ...variant,
          source: variant.source as unknown as Window,
          data: {
            protocol: "platform-agent-app/1.0",
            channel: "spoofed",
            id: "spoofed",
            method: "invoke",
            args: {},
          },
        }),
      );
    assert.equal(received.length, count);
    assert.equal(calls, 0);
    const view = await connection.observe();
    const result = await connection.invoke({
      requestId: crypto.randomUUID(),
      action: "view.open",
      args: {},
      expectedRevision: view.revision,
    });
    assert.equal(result.status, "succeeded");
    assert.equal(calls, 1);
    granted = false;
    await assert.rejects(connection.observe(), /APP_DISCONNECTED/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(connection.observe(), /APP_DISCONNECTED/);
    assert.ok(received.every((r) => r.targetOrigin === "https://host.example"));
  } finally {
    server.dispose();
    dom.window.close();
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  }
});
