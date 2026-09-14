import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { createPlatformApplication } from "../../src/features/assistant/platform-application.ts";
import {
  PageActionsProvider,
  usePageActions,
  usePageActionTargets,
} from "../../src/shared/PageActions.tsx";
import { mockInsecureContext } from "../helpers/insecure-context.ts";

afterEach(cleanup);
function Form({ interfere = false }: { interfere?: boolean }) {
  const [name, setName] = useState("原名称"),
    [description, setDescription] = useState("原描述"),
    [outcome, setOutcome] = useState("");
  const registry = usePageActions();
  usePageActionTargets([
    {
      id: "agent.name",
      kind: "fill",
      label: "名称",
      value: name,
      execute: (value) => {
        setName(value ?? "");
        if (interfere) setDescription("用户手动修改");
      },
    },
    {
      id: "agent.description",
      kind: "fill",
      label: "描述",
      value: description,
      execute: (value) => setDescription(value ?? ""),
    },
  ]);
  return (
    <>
      <input aria-label="名称" value={name} readOnly />
      <input aria-label="描述" value={description} readOnly />
      <output>{outcome}</output>
      <button
        type="button"
        onClick={async () => {
          assert.ok(registry);
          const app = createPlatformApplication(registry, () => {});
          app.enable(true);
          const result = await app.invoke({
            requestId: randomUUID(),
            action: "agent.draft.patch",
            expectedRevision: app.observe().revision,
            args: { name: "助手名称", description: "助手描述" },
          });
          setOutcome(result.status);
        }}
      >
        填写草稿
      </button>
    </>
  );
}
function mount(interfere = false) {
  render(
    <PageActionsProvider page="agents" locationKey="agents/new" onNavigate={() => {}}>
      <Form interfere={interfere} />
    </PageActionsProvider>,
  );
}
test("HTTP LAN application SDK updates real React draft fields without crypto.randomUUID", async (t) => {
  mockInsecureContext(t);
  mount();
  fireEvent.click(screen.getByText("填写草稿"));
  await screen.findByText("succeeded");
  assert.equal(
    (screen.getByRole("textbox", { name: "名称" }) as HTMLInputElement).value,
    "助手名称",
  );
  assert.equal(
    (screen.getByRole("textbox", { name: "描述" }) as HTMLInputElement).value,
    "助手描述",
  );
});
test("human changes during a multi-field application action are preserved and stop remaining edits", async () => {
  mount(true);
  fireEvent.click(screen.getByText("填写草稿"));
  await screen.findByText("unknown");
  assert.equal(
    (screen.getByRole("textbox", { name: "描述" }) as HTMLInputElement).value,
    "用户手动修改",
  );
});
