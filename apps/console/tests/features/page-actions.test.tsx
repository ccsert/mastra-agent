import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import {
  PageActionsProvider,
  usePageActions,
  usePageActionTargets,
} from "../../src/shared/PageActions.tsx";
import { mockInsecureContext } from "../helpers/insecure-context.ts";

afterEach(cleanup);
function Fields() {
  const [name, setName] = useState("原始草稿"),
    [result, setResult] = useState("");
  const registry = usePageActions();
  usePageActionTargets([
    {
      id: "agent.name",
      kind: "fill",
      label: "名称",
      value: name,
      execute: (value) => setName(value ?? ""),
    },
  ]);
  function run(target: string, stale = false, aborted = false) {
    assert.ok(registry);
    const signal = new AbortController();
    if (aborted) signal.abort();
    const view = registry.view();
    void registry
      .perform(
        {
          operation: "act",
          target,
          value: "助手填写的草稿",
          viewRevision: stale ? "stale" : view.revision,
        },
        signal.signal,
      )
      .then(setResult)
      .catch((error) => setResult(error.message));
  }
  return (
    <>
      <input aria-label="名称" value={name} onChange={(e) => setName(e.target.value)} />
      <button type="button" onClick={() => run("agent.name")}>
        填写
      </button>
      <button type="button" onClick={() => run("agent.name", true)}>
        旧页面
      </button>
      <button type="button" onClick={() => run("agent.save")}>
        保存
      </button>
      <button type="button" onClick={() => run("agent.name", false, true)}>
        已停止
      </button>
      <output>{result}</output>
    </>
  );
}
const mount = () =>
  render(
    <PageActionsProvider page="agents" locationKey="agents/new" onNavigate={() => {}}>
      <Fields />
    </PageActionsProvider>,
  );
test("HTTP LAN page actions mount and update the real form without crypto.randomUUID", async (t) => {
  mockInsecureContext(t);
  mount();
  fireEvent.click(screen.getByText("填写"));
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("textbox", { name: "名称" }) as HTMLInputElement).value,
      "助手填写的草稿",
    ),
  );
  await screen.findByText("页面操作已完成；草稿字段尚未保存");
});
test("stale revisions, unregistered save and stopped sessions cannot edit the page", async () => {
  mount();
  fireEvent.click(screen.getByText("旧页面"));
  await screen.findByText("页面已变化，动作未执行；请重新读取页面");
  fireEvent.click(screen.getByText("保存"));
  await screen.findByText("当前页面操作目标不可用");
  fireEvent.click(screen.getByText("已停止"));
  await screen.findByText(/aborted/i);
  assert.equal(
    (screen.getByRole("textbox", { name: "名称" }) as HTMLInputElement).value,
    "原始草稿",
  );
});
