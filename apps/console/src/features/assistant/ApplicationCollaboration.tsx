import { AppstoreOutlined, ControlOutlined, LinkOutlined, StopOutlined } from "@ant-design/icons";
import {
  type AgentAppOutcome,
  AgentAppRegistration,
  AgentAppRegistrationView,
  type AgentAppView,
  type AgentFrameConnection,
  connectAgentFrame,
  platformAppManifest,
  platformAppRegistrationId,
} from "@platform/agent-ui";
import * as api from "@platform/sdk";
import { Alert, BorderBeam, Button, Checkbox, Drawer, Input, Select, Space, Tag } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { v4 as uuid } from "uuid";
import { useProjectAccess } from "../../shared/access";
import { unwrap } from "../../shared/api";
import { usePageActions } from "../../shared/PageActions";
import { createPlatformApplication } from "./platform-application";

type Connection = Pick<AgentFrameConnection, "stop" | "invoke"> & {
  observe(): AgentAppView | Promise<AgentAppView>;
};
export function ApplicationCollaboration({
  projectId,
  conversationId,
  onReveal,
  onWorkspace,
}: {
  projectId: string;
  conversationId: string;
  onReveal(): void;
  onWorkspace(visible: boolean): void;
}) {
  const registry = usePageActions(),
    access = useProjectAccess();
  const [apps, setApps] = useState<AgentAppRegistrationView[]>([
      {
        id: platformAppRegistrationId,
        url: "https://platform.invalid/",
        manifest: platformAppManifest,
      },
    ]),
    [selected, setSelected] = useState(platformAppRegistrationId);
  const [open, setOpen] = useState(false),
    [manage, setManage] = useState(false),
    [draft, setDraft] = useState(false);
  const [enabled, setEnabled] = useState(false),
    [connecting, setConnecting] = useState(false),
    [acting, setActing] = useState(false),
    [status, setStatus] = useState("");
  const [error, setError] = useState(""),
    [registration, setRegistration] = useState(""),
    [saving, setSaving] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null),
    controller = useRef<AbortController | undefined>(undefined);
  const reveal = useRef(onReveal);
  reveal.current = onReveal;
  const chosen = apps.find((a) => a.id === selected),
    external = selected !== platformAppRegistrationId;
  useEffect(() => {
    onWorkspace(open && external);
    return () => onWorkspace(false);
  }, [open, external, onWorkspace]);
  const reload = useCallback(
    async () =>
      setApps(
        (await unwrap(api.listAssistantApps({ path: { projectId } }))).map((a) =>
          AgentAppRegistrationView.parse(a),
        ),
      ),
    [projectId],
  );
  useEffect(() => {
    void reload().catch((e) => setError(e.message));
  }, [reload]);
  const stop = useCallback(() => {
    controller.current?.abort();
    setEnabled(false);
    setConnecting(false);
    setActing(false);
    setStatus("应用协作已停止");
  }, []);
  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState === "hidden") stop();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      controller.current?.abort();
    };
  }, [stop]);
  async function connect() {
    if (!chosen || !registry || (controller.current && !controller.current.signal.aborted)) return;
    const current = new AbortController();
    controller.current = current;
    const clientId = uuid(),
      path = { projectId, id: conversationId };
    let connection: Connection | undefined,
      view: AgentAppView | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    setConnecting(true);
    setError("");
    const fail = (e: unknown) => {
      if (!current.signal.aborted) {
        const code = e instanceof Error ? e.message : "应用连接失败";
        setError(
          (
            {
              APP_USER_GRANT_REQUIRED: "请先在应用页面内允许协作；填写草稿还需要应用侧的草稿授权。",
              APP_MANIFEST_CHANGED: "应用能力与登记版本不一致，请管理员核对后重新登记。",
              APP_REPLY_TIMEOUT:
                "应用未在时限内响应，连接已停止；请确认页面支持协作并核对当前状态。",
            } as Record<string, string>
          )[code] ?? code,
        );
        stop();
      }
    };
    current.signal.addEventListener(
      "abort",
      () => {
        connection?.stop();
        clearTimeout(timer);
        if (view)
          void api
            .syncAssistantApp({
              path,
              body: { registrationId: chosen.id, clientId, enabled: false, view },
            })
            .catch(() => {});
      },
      { once: true },
    );
    try {
      if (external) {
        if (!frame.current?.contentWindow) throw new Error("请先打开应用页面并允许协作");
        if (new URL(chosen.url).origin === window.location.origin)
          throw new Error("第三方应用应部署在独立 origin");
        connection = await connectAgentFrame({
          frame: frame.current.contentWindow,
          origin: new URL(chosen.url).origin,
          manifest: chosen.manifest,
          allowDraft: draft,
          signal: current.signal,
          onDisconnect: () => {
            if (!current.signal.aborted) {
              setError("应用页面已断开，请重新连接");
              stop();
            }
          },
        });
      } else {
        const internal = createPlatformApplication(registry, ({ running, title }) => {
          if (!current.signal.aborted) {
            setActing(running);
            setStatus(title);
            if (running) reveal.current();
          }
        });
        internal.enable(draft);
        connection = internal;
      }
      const app = connection;
      const execute = async (action: api.SyncAssistantAppResponses[200]["action"]) => {
        if (!action) return;
        try {
          current.signal.throwIfAborted();
          setActing(true);
          setStatus(
            chosen.manifest.actions.find((a) => a.id === action.input.action)?.title ??
              "正在操作应用",
          );
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          current.signal.throwIfAborted();
          const result: AgentAppOutcome = await app.invoke(action.input);
          current.signal.throwIfAborted();
          view = result.view;
          const receipt = await unwrap(
            api.completeAssistantApp({
              path: { ...path, actionId: action.id },
              body: { clientId, result },
              signal: current.signal,
            }),
          );
          if (receipt.status !== result.status)
            throw new Error(receipt.result?.message ?? "服务端未确认动作，请核对页面");
          setStatus(result.message);
          setActing(false);
        } catch (e) {
          fail(e);
        }
      };
      const tick = async (grant = false) => {
        try {
          current.signal.throwIfAborted();
          view = await app.observe();
          const sync = await unwrap(
            api.syncAssistantApp({
              path,
              body: {
                registrationId: chosen.id,
                clientId,
                enabled: true,
                grant,
                allowDraft: draft,
                view,
              },
              signal: current.signal,
            }),
          );
          current.signal.throwIfAborted();
          if (!sync.active) throw new Error("授权已过期，请重新连接应用");
          if (grant) {
            setEnabled(true);
            setConnecting(false);
            setStatus(`已连接 · ${chosen.manifest.name}`);
          }
          // Heartbeats are independent of a slow action; the server allows only one claim at a time.
          if (sync.action) void execute(sync.action);
          timer = setTimeout(() => void tick(), 650);
        } catch (e) {
          fail(e);
        }
      };
      await tick(true);
    } catch (e) {
      fail(e);
    }
  }
  const controls = (
    <Space wrap>
      <Checkbox
        checked={draft}
        disabled={
          enabled ||
          connecting ||
          !access?.permissions.includes(external ? "resource.edit" : "agent.edit")
        }
        onChange={(e) => setDraft(e.target.checked)}
      >
        允许修改未保存草稿
      </Checkbox>
      <Button
        type={enabled ? "default" : "primary"}
        icon={enabled ? <StopOutlined /> : <LinkOutlined />}
        loading={connecting}
        onClick={() => (enabled ? stop() : void connect())}
      >
        {enabled ? "停止协作" : "连接当前页面"}
      </Button>
    </Space>
  );
  return (
    <>
      <div className="assistant-ui-toggle">
        <AppstoreOutlined />
        <span>
          应用协作<small>读取页面、操作视图、填写草稿</small>
        </span>
        <Select
          aria-label="协作应用"
          value={selected}
          disabled={enabled || connecting}
          style={{ minWidth: 160 }}
          options={apps.map((a) => ({ label: a.manifest.name, value: a.id }))}
          onChange={(id) => {
            stop();
            setSelected(id);
            setDraft(false);
            setError("");
            setOpen(id !== platformAppRegistrationId);
          }}
        />
        {external ? <Button onClick={() => setOpen(true)}>打开应用</Button> : controls}
        {access?.permissions.includes("resource.manage") && (
          <Button type="text" onClick={() => setManage(true)}>
            接入应用
          </Button>
        )}
      </div>
      {error && <Alert type="warning" title={error} closable={{ onClose: () => setError("") }} />}
      <Drawer
        title={chosen?.manifest.name ?? "应用协作"}
        open={open && external}
        onClose={() => {
          stop();
          setOpen(false);
        }}
        size="min(54vw, 860px)"
        mask={false}
        focusable={{ trap: false, focusTriggerAfterClose: false }}
        rootClassName="assistant-app-drawer"
        destroyOnHidden
        footer={
          <div className="assistant-app-footer">
            {controls}
            <span role="status">{status || "先在应用页面中允许协作，再连接"}</span>
            {error && <Alert type="warning" title={error} />}
          </div>
        }
      >
        {chosen && (
          <div className="assistant-app-surface">
            <div className="assistant-app-origin">
              <Tag>独立应用</Tag>
              <span>{new URL(chosen.url).origin}</span>
            </div>
            <iframe
              key={chosen.id}
              ref={frame}
              title={`协作应用：${chosen.manifest.name}`}
              src={chosen.url}
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="no-referrer"
              onLoad={() => {
                if (enabled || connecting) stop();
              }}
            />
            {acting && (
              <BorderBeam className="assistant-app-beam" duration={3}>
                <div />
              </BorderBeam>
            )}
          </div>
        )}
      </Drawer>
      <Drawer title="接入应用" open={manage} onClose={() => setManage(false)} size={560}>
        <p>
          应用提供页面地址和能力清单，登记后由用户按任务连接。第三方应用使用独立域名，无需采用平台的组件或前端框架。
        </p>
        <p>
          粘贴包含 url 和 manifest 的接入配置。页面可读取的数据和动作参数会进入当前助手会话记录。
        </p>
        <Input.TextArea
          aria-label="应用接入配置"
          value={registration}
          rows={12}
          placeholder={'{"url":"https://app.example/agent","manifest":{...}}'}
          onChange={(e) => setRegistration(e.target.value)}
        />
        <Button
          type="primary"
          loading={saving}
          style={{ marginTop: 12 }}
          onClick={async () => {
            setSaving(true);
            try {
              const input = AgentAppRegistration.parse(JSON.parse(registration));
              if (new URL(input.url).origin === window.location.origin)
                throw new Error("请使用独立 origin 部署第三方应用");
              const saved = await unwrap(
                api.registerAssistantApp({ path: { projectId }, body: input }),
              );
              await reload();
              setSelected(saved.id);
              setRegistration("");
              setManage(false);
              setOpen(true);
              setError("");
            } catch (e) {
              setError(e instanceof Error ? e.message : "登记失败");
            } finally {
              setSaving(false);
            }
          }}
        >
          登记应用
        </Button>
        {error && <Alert type="error" title={error} />}
        {apps
          .filter((a) => a.id !== platformAppRegistrationId)
          .map((a) => (
            <div className="assistant-app-registration" key={a.id}>
              <span>
                {a.manifest.name}
                <small>
                  {new URL(a.url).origin} · {a.manifest.actions.length} 个动作
                </small>
              </span>
              <Button
                danger
                disabled={enabled && a.id === selected}
                onClick={async () => {
                  try {
                    await unwrap(api.removeAssistantApp({ path: { projectId, id: a.id } }));
                    if (selected === a.id) {
                      stop();
                      setOpen(false);
                      setSelected(platformAppRegistrationId);
                    }
                    await reload();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "移除失败");
                  }
                }}
              >
                移除
              </Button>
            </div>
          ))}
      </Drawer>
      {enabled &&
        !external &&
        createPortal(
          <div className="assistant-ui-overlay">
            {acting && (
              <BorderBeam className="assistant-ui-beam" duration={3} size="28%" lineWidth={2}>
                <div className="assistant-ui-frame" />
              </BorderBeam>
            )}
            <div className={`assistant-ui-status${acting ? " is-acting" : ""}`} role="status">
              <ControlOutlined />
              <span>{status}</span>
              <Button size="small" onClick={stop}>
                停止应用协作
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
