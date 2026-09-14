import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatFeedback } from "../../src/features/chat/ChatFeedback.tsx";

afterEach(cleanup);
test("feedback saves to the active run and retries the same text with the same request id", async (t) => {
  const bodies: { text: string; requestId: string }[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.match(input instanceof Request ? input.url : String(input), /\/runs\/run\/feedback$/);
    bodies.push(
      input instanceof Request ? await input.clone().json() : JSON.parse(String(init?.body)),
    );
    if (bodies.length === 1) throw new Error("temporary disconnect");
    return Response.json({ id: "feedback", text: bodies[0].text, readAt: null });
  });
  render(<ChatFeedback projectId="project" runId="run" />);
  fireEvent.click(screen.getByRole("button", { name: "补充要求" }));
  fireEvent.change(screen.getByRole("textbox", { name: "补充要求内容" }), {
    target: { value: "请优先检查手机布局" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存补充要求" }));
  await screen.findByRole("status");
  fireEvent.click(screen.getByRole("button", { name: "保存补充要求" }));
  await waitFor(() => assert.match(screen.getByRole("status").textContent ?? "", /要求已保存/));
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(
    (screen.getByRole("textbox", { name: "补充要求内容" }) as HTMLTextAreaElement).value,
    "",
  );
});
