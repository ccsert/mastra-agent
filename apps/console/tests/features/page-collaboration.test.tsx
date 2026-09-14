import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PageCollaboration } from "../../src/features/assistant/PageCollaboration.tsx";
import { PageActionsProvider } from "../../src/shared/PageActions.tsx";

afterEach(cleanup);
test("page control shows BorderBeam before execution; stopping revokes access and suppresses a late success", async () => {
  let release: () => void = () => {},
    acks = 0,
    revoked = 0,
    revealed = 0;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async (request, init) => {
    const url = request instanceof Request ? request.url : String(request);
    const body = (
      request instanceof Request ? await request.json() : JSON.parse(String(init?.body))
    ) as {
      enabled: boolean;
      grant?: boolean;
      view: { revision: string };
    };
    if (url.endsWith("/ui")) {
      if (!body.enabled) {
        revoked++;
        return Response.json({ active: false, action: null });
      }
      return Response.json({
        active: true,
        action: body.grant
          ? {
              id: "action",
              status: "executing",
              result: null,
              input: { operation: "act", target: "agent.create", viewRevision: body.view.revision },
            }
          : null,
      });
    }
    if (url.endsWith("/ui/action")) {
      acks++;
      return Response.json({ id: "action", status: "succeeded", input: {}, result: {} });
    }
    throw new Error(`Unexpected ${url}`);
  };
  render(
    <PageActionsProvider
      page="agents"
      locationKey="agents"
      onNavigate={() => {}}
      targets={[{ id: "agent.create", label: "创建草稿", kind: "click", execute: () => pending }]}
    >
      <PageCollaboration
        projectId="project"
        conversationId="conversation"
        onReveal={() => {
          revealed++;
        }}
      />
    </PageActionsProvider>,
  );
  fireEvent.click(screen.getByRole("switch", { name: "页面协作" }));
  await screen.findByText("助手正在操作页面");
  assert.ok(document.querySelector(".assistant-ui-beam"));
  assert.equal(revealed, 1);
  assert.equal(acks, 0);
  fireEvent.click(screen.getByRole("button", { name: /停止页面协作/ }));
  await waitFor(() => assert.ok(revoked > 0));
  release();
  await waitFor(() => assert.equal(document.querySelector(".assistant-ui-beam"), null));
  assert.equal(
    screen.getByRole("switch", { name: "页面协作" }).getAttribute("aria-checked"),
    "false",
  );
  assert.equal(acks, 0);
});
