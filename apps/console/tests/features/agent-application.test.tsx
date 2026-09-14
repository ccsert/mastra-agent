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

// Exercise actual React state/paint boundaries: a transport retry must keep both
// the receipt and the exact verified prefix when a user edits another field.
for (const { interfere, awaitReceipt } of [
  { interfere: false, awaitReceipt: false },
  { interfere: true, awaitReceipt: false },
  { interfere: false, awaitReceipt: true },
]) {
  test(`page activity preserves verified changes and idempotent receipts (conflict=${interfere}, awaitingReceipt=${awaitReceipt})`, async () => {
    let observed: unknown;
    const phases: string[] = [];
    function Scenario() {
      const registry = usePageActions();
      const [name, setName] = useState("原名称");
      const [description, setDescription] = useState("原描述");
      const [done, setDone] = useState(false);
      usePageActionTargets([
        {
          id: "agent.name",
          kind: "fill",
          label: "名称",
          value: name,
          execute: (value) => {
            setName(value ?? "");
            if (interfere) setDescription("人工内容");
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
          <input aria-label="场景名称" value={name} readOnly />
          <input aria-label="场景描述" value={description} readOnly />
          <button
            type="button"
            onClick={async () => {
              assert.ok(registry);
              const unsubscribe = registry.activity.subscribe(() => {
                const step = registry.activity.getSnapshot()?.steps.at(-1);
                if (step) phases.push(step.status);
              });
              const app = createPlatformApplication(registry, () => {}, awaitReceipt);
              app.enable(true);
              const input = {
                requestId: randomUUID(),
                action: "agent.draft.patch",
                expectedRevision: app.observe().revision,
                args: { name: "助手名称", description: "助手描述" },
              };
              const promise = app.invoke(input);
              const busy = await app.invoke({ ...input, requestId: randomUUID() });
              assert.equal(busy.code, "PAGE_BUSY");
              assert.equal(registry.activity.getSnapshot()?.id, input.requestId);
              const result = await promise;
              const snapshot = registry.activity.getSnapshot();
              assert.deepEqual(await app.invoke(input), result);
              assert.equal(registry.activity.getSnapshot(), snapshot);
              await assert.rejects(
                app.invoke({ ...input, args: { name: "篡改" } }),
                /IDEMPOTENCY_CONFLICT/,
              );
              observed = { result, snapshot };
              unsubscribe();
              setDone(true);
            }}
          >
            验证动作
          </button>
          {done && <output>核验结束</output>}
        </>
      );
    }
    render(
      <PageActionsProvider page="agents" locationKey="agents/new" onNavigate={() => {}}>
        <Scenario />
      </PageActionsProvider>,
    );
    fireEvent.click(screen.getByText("验证动作"));
    await screen.findByText("核验结束");
    assert.ok(
      observed && typeof observed === "object" && "result" in observed && "snapshot" in observed,
    );
    const { result, snapshot } = observed as {
      result: {
        status: string;
        output: { changes: { target: string; before: string; after: string }[] };
      };
      snapshot: { status: string; steps: { status: string }[] };
    };
    assert.equal(result.status, interfere ? "unknown" : "succeeded");
    assert.equal(result.output.changes.length, interfere ? 1 : 2);
    assert.deepEqual(result.output.changes[0], {
      target: "agent.name",
      label: "名称",
      before: "原名称",
      after: "助手名称",
      truncated: false,
    });
    assert.equal(snapshot.status, awaitReceipt ? "running" : result.status);
    assert.ok(snapshot.steps.every((step) => !["applying", "verifying"].includes(step.status)));
    assert.ok(
      phases.includes("applying") && phases.includes("verifying") && phases.includes("applied"),
    );
    assert.equal(
      (screen.getByRole("textbox", { name: "场景描述" }) as HTMLInputElement).value,
      interfere ? "人工内容" : "助手描述",
    );
  });
}

test("a human edit after the target indicator paints prevents the pending field write", async () => {
  function Scenario() {
    const registry = usePageActions();
    const [name, setName] = useState("原名称"),
      [done, setDone] = useState(false);
    usePageActionTargets([
      {
        id: "agent.name",
        kind: "fill",
        label: "名称",
        value: name,
        execute: (value) => setName(value ?? ""),
      },
    ]);
    return (
      <>
        <input aria-label="保留人工内容" value={name} readOnly />
        <button
          type="button"
          onClick={async () => {
            assert.ok(registry);
            const unsubscribe = registry.activity.subscribe(() => {
              if (registry.activity.getSnapshot()?.steps.at(-1)?.status === "applying")
                setName("人工内容");
            });
            const app = createPlatformApplication(registry, () => {});
            app.enable(true);
            const result = await app.invoke({
              requestId: randomUUID(),
              action: "agent.draft.patch",
              expectedRevision: app.observe().revision,
              args: { name: "助手内容" },
            });
            assert.equal(result.status, "unknown");
            assert.equal(registry.activity.getSnapshot()?.steps[0].status, "not-applied");
            assert.equal(result.output.changes, undefined);
            unsubscribe();
            setDone(true);
          }}
        >
          触发人工冲突
        </button>
        {done && <output>人工修改已保留</output>}
      </>
    );
  }
  render(
    <PageActionsProvider page="agents" locationKey="agents/new" onNavigate={() => {}}>
      <Scenario />
    </PageActionsProvider>,
  );
  fireEvent.click(screen.getByText("触发人工冲突"));
  await screen.findByText("人工修改已保留");
  assert.equal(
    (screen.getByRole("textbox", { name: "保留人工内容" }) as HTMLInputElement).value,
    "人工内容",
  );
});
