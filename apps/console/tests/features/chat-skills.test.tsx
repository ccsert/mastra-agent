import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { Chat } from "../../src/features/chat/Chat.tsx";
import { ChatToolContent } from "../../src/features/chat/ChatToolContent.tsx";
import { skillTriggerMatcher } from "../../src/features/chat/commands.ts";
import { SkillPicker } from "../../src/features/chat/SkillPicker.tsx";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";

afterEach(cleanup);
const skills = [
  { versionId: "pinned", name: "report", version: 3, description: "订单汇总与核对", enabled: true },
  { versionId: "second", name: "review", version: 2, description: "审核表格", enabled: true },
  { versionId: "revoked", name: "old-report", version: 1, description: "旧版报表", enabled: false },
];

test("the searchable Skill picker preserves the draft and records explicit intent before response headers arrive", async (t) => {
  let resolveHeaders: (response: Response) => void = () => {
    throw new Error("Headers resolver unavailable");
  };
  const headers = new Promise<Response>((resolve) => {
    resolveHeaders = resolve;
  });
  let body: { skillVersionIds: string[]; messages: { metadata?: unknown }[] } | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/capabilities")) return Response.json({ skills });
    if (url.endsWith("/chat")) {
      body = JSON.parse(String(init?.body));
      return headers;
    }
    throw new Error(`Unexpected ${url}`);
  });
  render(
    <ProjectData projectId="project">
      <Chat projectId="project" conversationId="skills" messages={[]} onFinish={() => {}} />
    </ProjectData>,
  );
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "消息" });
  fireEvent.change(input, { target: { value: "保留原本的订单问题" } });
  fireEvent.click(screen.getByRole("button", { name: "选择 Skills" }));
  const picker = await screen.findByRole("dialog", { name: "选择 Skills" });
  const search = within(picker).getByRole("textbox", { name: "搜索 Skills" });
  const revoked = await within(picker).findByRole<HTMLButtonElement>("button", {
    name: /old-report/,
  });
  assert.equal(revoked.disabled, true);
  fireEvent.change(search, { target: { value: "核对" } });
  assert.equal(within(picker).queryByRole("button", { name: /review/ }), null);
  fireEvent.click(within(picker).getByRole("button", { name: /report/ }));
  assert.equal(
    within(picker)
      .getByRole("button", { name: /report/ })
      .getAttribute("aria-pressed"),
    "true",
  );
  fireEvent.change(search, { target: { value: "" } });
  fireEvent.click(within(picker).getByRole("button", { name: /review/ }));
  fireEvent.click(within(picker).getByRole("button", { name: /review/ }));
  fireEvent.keyDown(search, { key: "Escape", isComposing: true });
  assert.ok(screen.getByRole("dialog", { name: "选择 Skills" }));
  fireEvent.keyDown(search, { key: "Escape" });
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "选择 Skills" }), null));
  assert.equal(document.activeElement, screen.getByRole("button", { name: "选择 Skills" }));
  assert.equal(input.value, "保留原本的订单问题");
  assert.equal(body, undefined);
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await waitFor(() => assert.deepEqual(body?.skillVersionIds, ["pinned"]));
  await screen.findByText("本次指定");
  assert.ok(
    document
      .querySelector('[data-slot="aui_user-message-root"] .message-context')
      ?.textContent?.includes("report · v3"),
  );
  assert.ok(
    screen.getByRole("region", { name: "本次指定的 Skills" }),
    "retain selection until accepted",
  );
  await act(async () =>
    resolveHeaders(
      new Response(
        'data: {"type":"start","messageId":"answer"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n',
        {
          headers: {
            "Content-Type": "text/event-stream",
            "x-vercel-ai-ui-message-stream": "v1",
            "x-platform-run-id": "run",
          },
        },
      ),
    ),
  );
  await waitFor(() =>
    assert.equal(screen.queryByRole("region", { name: "本次指定的 Skills" }), null),
  );
  assert.equal(screen.getAllByText("本次指定").length, 1);
});

test("inline slash selection removes only the trigger and retains surrounding text", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ skills }));
  render(
    <ProjectData projectId="project">
      <Chat projectId="project" conversationId="inline" messages={[]} onFinish={() => {}} />
    </ProjectData>,
  );
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "消息" });
  fireEvent.change(input, { target: { value: "请用 /rep" } });
  await screen.findByRole("option", { name: /\/report/ });
  fireEvent.keyDown(input, { key: "Enter" });
  assert.equal(input.value, "请用 ");
  assert.ok(screen.getByRole("region", { name: "本次指定的 Skills" }));
  const text = "前文 /rep 后文";
  assert.deepEqual(skillTriggerMatcher(text, "/", 7), { query: "rep", offset: 3, endOffset: 7 });
  for (const value of ["https://example.com/rep", "references/rep", "```md\n/rep"]) {
    assert.equal(skillTriggerMatcher(value, "/", value.length), null);
  }
});

test("unavailable selections block sending after draft restoration and can be removed", async (t) => {
  let enabled = true;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ skills: skills.map((s) => ({ ...s, enabled: enabled && s.enabled })) }),
  );
  const session = (id: string) => (
    <ProjectData projectId="project">
      <Chat key={id} projectId="project" conversationId={id} messages={[]} onFinish={() => {}} />
    </ProjectData>
  );
  const view = render(session("original"));
  const input = await screen.findByRole("textbox", { name: "消息" });
  fireEvent.change(input, { target: { value: "/report" } });
  await screen.findByRole("option", { name: /report/ });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.change(input, { target: { value: "继续汇总" } });
  view.rerender(session("other"));
  enabled = false;
  view.rerender(session("original"));
  await screen.findByText("所选 Skill 已停用或不再可用，请移除后发送。");
  await waitFor(() =>
    assert.equal(
      screen.getByRole<HTMLButtonElement>("button", { name: "发送消息" }).disabled,
      true,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "选择 Skills" }));
  fireEvent.click(
    await within(screen.getByRole("dialog", { name: "选择 Skills" })).findByRole("button", {
      name: /^file-zip report/,
    }),
  );
  await waitFor(() =>
    assert.equal(
      screen.getByRole<HTMLButtonElement>("button", { name: "发送消息" }).disabled,
      false,
    ),
  );
  assert.equal(
    screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" }).value,
    "继续汇总",
  );
});

test("the picker caps new selections at ten while permitting removal", async () => {
  const catalog = Array.from({ length: 11 }, (_, n) => ({
    ...skills[0],
    description: "订单汇总与核对",
    enabled: true,
    version: 3,
    versionId: `v${n}`,
    name: `skill-${n}`,
  }));
  function Picker() {
    const [selected, setSelected] = useState(catalog.slice(0, 10).map((s) => s.versionId));
    return (
      <SkillPicker
        skills={catalog}
        selected={selected}
        onSelect={setSelected}
        disabled={false}
        loading={false}
        error={false}
        onRetry={() => {}}
      />
    );
  }
  render(<Picker />);
  fireEvent.click(screen.getByRole("button", { name: "选择 Skills" }));
  const picker = within(await screen.findByRole("dialog", { name: "选择 Skills" }));
  assert.equal(picker.getByRole<HTMLButtonElement>("button", { name: /skill-10/ }).disabled, true);
  fireEvent.click(picker.getByRole("button", { name: /skill-0/ }));
  assert.equal(picker.getByRole<HTMLButtonElement>("button", { name: /skill-10/ }).disabled, false);
});

test("Skill files render Markdown with exact raw content and safe file references", async (t) => {
  const text =
    "# 汇总规则\n\n- 不得编造结果。\n\n[参考](references/rules.md) · [外部文档](https://example.com/docs)\n";
  let copied = "";
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  });
  render(
    <ChatToolContent
      toolName="skill_read"
      args={{ skillName: "report", path: "references/rules.markdown", startLine: 5, endLine: 10 }}
      result={text}
    />,
  );
  assert.ok(screen.getByRole("heading", { name: "汇总规则" }));
  assert.ok(screen.getByRole("region", { name: "report / references/rules.markdown · L5–10" }));
  assert.equal(screen.queryByRole("link", { name: "参考" }), null);
  assert.equal(
    screen.getByRole("link", { name: "外部文档" }).getAttribute("href"),
    "https://example.com/docs",
  );
  fireEvent.click(screen.getByRole("tab", { name: "原文" }));
  assert.equal(screen.getByRole("tabpanel").querySelector("pre")?.textContent, text);
  fireEvent.click(screen.getByRole("button", { name: "复制内容" }));
  await waitFor(() => assert.equal(copied, text));
});

test("script results separate structured data, output streams and the complete execution record", async () => {
  const result = {
    skill: "report",
    version: 3,
    entrypoint: "scripts/report.mjs",
    stdout: '{"total":10,"orders":[{"id":"A","amount":3},{"id":"B","amount":7}]}',
    stderr: "",
    exitCode: 0,
    digest: "actual-record-digest",
  };
  const view = render(<ChatToolContent toolName="run_skill_script" args={{}} result={result} />);
  assert.ok(screen.getByRole("region", { name: "结构化工具结果" }));
  assert.equal(screen.queryByRole("region", { name: "标准输出" }), null);
  fireEvent.click(screen.getByRole("tab", { name: "输出" }));
  assert.equal(
    screen.getByRole("region", { name: "标准输出" }).querySelector("pre")?.textContent,
    result.stdout,
  );
  fireEvent.click(screen.getByRole("tab", { name: "完整记录" }));
  assert.equal(
    screen.getByRole("tabpanel").querySelector("pre")?.textContent,
    JSON.stringify(result, null, 2),
  );
  view.unmount();
  render(
    <ChatToolContent
      toolName="run_skill_script"
      args={{}}
      result={{ ...result, exitCode: 1, stderr: "Invalid amount" }}
    />,
  );
  assert.equal(
    screen.getByRole("tab", { name: "输出 · 有 stderr" }).getAttribute("aria-selected"),
    "true",
  );
  assert.ok(screen.getByText("Invalid amount"));
});
