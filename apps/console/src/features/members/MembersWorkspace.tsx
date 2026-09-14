import {
  CopyOutlined,
  PlusOutlined,
  ReloadOutlined,
  TeamOutlined,
  UserAddOutlined,
} from "@ant-design/icons";
import type { Principal, ProjectMember, ProjectRole, TeamMember } from "@platform/sdk";
import * as api from "@platform/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Form, Input, Modal, Select, Switch, Table, Tabs, Tag } from "antd";
import { useDeferredValue, useState } from "react";
import { projectRoleOptions, roleNames } from "../../shared/access";
import { timestamp, unwrap } from "../../shared/api";
import { useProjectId } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import { useOperation } from "../../shared/useOperation";

const auditLabels: Record<string, string> = {
  "knowledge.import": "导入知识资料版本",
  "skill.import": "导入 Skill 版本",
  "member.updated": "修改账号角色或状态",
  "member.sessions_revoked": "撤销登录会话",
  "team.owner_transferred": "移交团队所有权",
  "project.member_updated": "更新项目成员",
  "project.member_removed": "移除项目成员",
  "invitation.created": "创建邀请",
  "invitation.accepted": "接受邀请",
  "invitation.revoked": "撤销邀请",
  "agent.published": "发布 Agent",
  "agent.preview_created": "创建草稿试用",
};
export function MembersWorkspace({ scope, user }: { scope: "team" | "project"; user: Principal }) {
  const projectId = useProjectId(),
    team = scope === "team",
    { modal, message } = App.useApp(),
    client = useQueryClient();
  const key = ["members", user.tenantId, team ? "team" : projectId];
  const members = useQuery({
    queryKey: [...key, "list"],
    queryFn: ({ signal }) =>
      team
        ? unwrap(api.listTeamMembers({ signal }))
        : unwrap(api.listProjectMembers({ path: { projectId }, signal })),
  });
  const invitations = useQuery({
    queryKey: [...key, "invitations"],
    queryFn: ({ signal }) =>
      team
        ? unwrap(api.listTeamInvitations({ signal }))
        : unwrap(api.listProjectInvitations({ path: { projectId }, signal })),
  });
  const audit = useQuery({
    queryKey: [...key, "audit"],
    queryFn: ({ signal }) =>
      team
        ? unwrap(api.listTeamAudit({ signal }))
        : unwrap(api.listProjectAudit({ path: { projectId }, signal })),
  });
  const [tab, setTab] = useState("members"),
    [inviting, setInviting] = useState(false),
    [adding, setAdding] = useState(false),
    [editing, setEditing] = useState<TeamMember>();
  const [inviteLink, setInviteLink] = useState(""),
    [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search),
    [inviteForm] = Form.useForm(),
    [memberForm] = Form.useForm(),
    [addForm] = Form.useForm();
  const operation = useOperation();
  const candidates = useQuery({
    queryKey: [...key, "candidates", deferredSearch],
    queryFn: ({ signal }) =>
      unwrap(
        api.findProjectMemberCandidates({
          path: { projectId },
          query: { q: deferredSearch },
          signal,
        }),
      ),
    enabled: adding,
  });
  const self = members.data?.find((m) => m.id === user.id),
    owner = (self?.role ?? user.tenantRole) === "owner";
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["members", user.tenantId] });
    await client.invalidateQueries({ queryKey: ["project", projectId, "access"] });
  };
  const act = (fn: () => Promise<unknown>) =>
    void operation.run(async () => {
      await fn();
      await refresh();
    });
  async function projectRole(member: TeamMember, role: ProjectRole | null) {
    if (
      !(await modal.confirm({
        title: role
          ? `将 ${member.displayName} 设为${roleNames[role]}？`
          : `移除 ${member.displayName} 的项目访问权？`,
        content: "变更会影响该成员后续的项目操作，个人会话不会转交给其他成员。",
        okText: "确认变更",
        cancelText: "取消",
      }))
    )
      return;
    act(() => unwrap(api.setProjectMember({ path: { projectId, id: member.id }, body: { role } })));
  }
  return (
    <section className="members-workspace">
      <div className="members-intro">
        <div>
          <TeamOutlined />
          <h2>{team ? "团队成员" : "项目成员与权限"}</h2>
          <p>
            {team
              ? "每位成员使用独立账号，项目中的访问范围由角色决定。"
              : "管理员负责发布和授权，编辑者配置与试用，使用者运行正式 Agent。"}
          </p>
        </div>
        <div>
          {!team && (
            <Button
              icon={<PlusOutlined />}
              onClick={() => {
                addForm.resetFields();
                setAdding(true);
              }}
            >
              添加已有成员
            </Button>
          )}
          <Button
            type="primary"
            icon={<UserAddOutlined />}
            onClick={() => {
              inviteForm.resetFields();
              setInviteLink("");
              setInviting(true);
            }}
          >
            邀请新成员
          </Button>
          <Button aria-label="刷新成员" icon={<ReloadOutlined />} onClick={() => void refresh()} />
        </div>
      </div>
      {operation.error && (
        <Alert
          type="error"
          showIcon
          title={operation.error}
          closable={{ onClose: () => operation.setError("") }}
        />
      )}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "members",
            label: `成员 · ${members.data?.length ?? "—"}`,
            children: (
              <QueryState label="成员" query={members}>
                <Table<TeamMember>
                  rowKey="id"
                  dataSource={members.data}
                  pagination={{ pageSize: 10 }}
                  columns={[
                    {
                      title: "成员",
                      key: "name",
                      render: (_, member) => (
                        <div className="member-name">
                          <span className="member-avatar">
                            {member.displayName[0]?.toUpperCase()}
                          </span>
                          <div>
                            <strong>
                              {member.displayName}
                              {member.id === user.id && <small> 你</small>}
                            </strong>
                            <small>{member.username}</small>
                          </div>
                        </div>
                      ),
                    },
                    {
                      title: "角色",
                      key: "role",
                      render: (_, member) =>
                        team ? (
                          <Tag>
                            {member.role === "member" ? "团队成员" : roleNames[member.role]}
                          </Tag>
                        ) : member.role !== "member" ? (
                          <>
                            <Tag>管理员</Tag>
                            <small>继承自团队</small>
                          </>
                        ) : (
                          <Select
                            aria-label={`${member.displayName} 的项目角色`}
                            value={(member as ProjectMember).projectRole}
                            disabled={operation.busy || member.id === user.id}
                            options={projectRoleOptions}
                            onChange={(role) => void projectRole(member, role)}
                          />
                        ),
                    },
                    {
                      title: "账号状态",
                      key: "state",
                      render: (_, member) => (
                        <Tag color={member.active ? "success" : "default"}>
                          {member.active ? "已启用" : "已停用"}
                        </Tag>
                      ),
                    },
                    {
                      title: "操作",
                      key: "actions",
                      render: (_, member) =>
                        team ? (
                          <div className="member-actions">
                            {member.id !== user.id &&
                              member.role !== "owner" &&
                              (owner || member.role === "member") && (
                                <Button
                                  type="link"
                                  onClick={() => {
                                    setEditing(member);
                                    memberForm.setFieldsValue({
                                      role: member.role,
                                      active: member.active,
                                    });
                                  }}
                                >
                                  管理账号
                                </Button>
                              )}
                            {(owner || member.role === "member" || member.id === user.id) && (
                              <Button
                                type="link"
                                disabled={operation.busy}
                                onClick={() => {
                                  void modal.confirm({
                                    title: `撤销 ${member.displayName} 的登录会话？`,
                                    content: "该成员需要重新登录。账号及项目角色保持不变。",
                                    okText: "撤销会话",
                                    cancelText: "取消",
                                    onOk: () =>
                                      operation.run(async () => {
                                        await unwrap(
                                          api.revokeMemberSessions({
                                            path: { id: member.id },
                                            body: {},
                                          }),
                                        );
                                        await refresh();
                                      }),
                                  });
                                }}
                              >
                                撤销会话
                              </Button>
                            )}
                          </div>
                        ) : (
                          member.role === "member" &&
                          member.id !== user.id && (
                            <Button
                              type="link"
                              danger
                              disabled={operation.busy}
                              onClick={() => void projectRole(member, null)}
                            >
                              移除
                            </Button>
                          )
                        ),
                    },
                  ]}
                />
              </QueryState>
            ),
          },
          {
            key: "invitations",
            label: "邀请记录",
            children: (
              <QueryState label="邀请" query={invitations}>
                <Table
                  rowKey="id"
                  dataSource={invitations.data}
                  pagination={{ pageSize: 10 }}
                  columns={[
                    { title: "邀请备注", dataIndex: "label" },
                    {
                      title: "范围",
                      render: (_, row) =>
                        row.projectId
                          ? `项目 · ${roleNames[row.projectRole ?? "member"]}`
                          : "团队成员",
                    },
                    {
                      title: "状态",
                      render: (_, row) => (
                        <Tag>
                          {
                            {
                              pending: "待加入",
                              accepted: "已加入",
                              revoked: "已撤销",
                              expired: "已过期",
                            }[row.status]
                          }
                        </Tag>
                      ),
                    },
                    { title: "有效期至", render: (_, row) => timestamp(row.expiresAt) },
                    {
                      title: "操作",
                      render: (_, row) =>
                        row.status === "pending" && (
                          <Button
                            type="link"
                            disabled={operation.busy}
                            onClick={() =>
                              act(() =>
                                unwrap(api.revokeInvitation({ path: { id: row.id }, body: {} })),
                              )
                            }
                          >
                            撤销邀请
                          </Button>
                        ),
                    },
                  ]}
                />
              </QueryState>
            ),
          },
          {
            key: "audit",
            label: "操作记录",
            children: (
              <QueryState label="操作记录" query={audit}>
                <p className="form-note">
                  显示最近 100 条成员、邀请与 Agent 发布操作，不包含对话正文和凭据。
                </p>
                <Table
                  rowKey="id"
                  dataSource={audit.data}
                  pagination={{ pageSize: 15 }}
                  columns={[
                    { title: "时间", render: (_, row) => timestamp(row.createdAt) },
                    { title: "操作者", dataIndex: "actorName" },
                    { title: "操作", render: (_, row) => auditLabels[row.action] ?? row.action },
                    {
                      title: "对象",
                      render: (_, row) =>
                        members.data?.find((m) => m.id === row.targetId)?.displayName ?? (
                          <span title={row.targetId}>{row.targetId.slice(0, 8)}</span>
                        ),
                    },
                  ]}
                />
              </QueryState>
            ),
          },
        ]}
      />
      <Modal
        title={inviteLink ? "邀请已创建" : "邀请新成员"}
        open={inviting}
        onCancel={() => {
          if (!operation.busy) setInviting(false);
        }}
        closable={!operation.busy}
        mask={{ closable: !operation.busy }}
        cancelButtonProps={{ disabled: operation.busy }}
        footer={
          inviteLink ? (
            <Button type="primary" onClick={() => setInviting(false)}>
              完成
            </Button>
          ) : undefined
        }
        okText="创建邀请链接"
        confirmLoading={operation.busy}
        onOk={() => inviteForm.submit()}
      >
        {inviteLink ? (
          <>
            <p>将链接交给这位成员，对方设置个人账号后即可加入。链接仅在这里展示。</p>
            <Input aria-label="邀请链接" value={inviteLink} readOnly />
            <Button
              icon={<CopyOutlined />}
              onClick={() => {
                void navigator.clipboard.writeText(inviteLink).then(
                  () => message.success("邀请链接已复制"),
                  () => message.info("请选中链接手动复制"),
                );
              }}
            >
              复制邀请链接
            </Button>
            <p className="form-note">3 天内有效，只能使用一次。可在邀请记录中撤销。</p>
          </>
        ) : (
          <Form
            disabled={operation.busy}
            form={inviteForm}
            layout="vertical"
            initialValues={{ projectRole: "member" }}
            onFinish={(v: { label: string; projectRole: ProjectRole }) =>
              act(async () => {
                const result = await unwrap(
                  api.createInvitation({
                    body: {
                      label: v.label,
                      projectRole: v.projectRole ?? "member",
                      ...(team ? {} : { projectId }),
                    },
                  }),
                );
                const url = new URL("/join", window.location.origin);
                url.hash = new URLSearchParams({ invite: result.token }).toString();
                setInviteLink(url.toString());
              })
            }
          >
            <Form.Item
              name="label"
              label="邀请备注"
              rules={[{ required: true, whitespace: true, message: "请输入成员姓名或用途" }]}
            >
              <Input placeholder="例如：产品团队 · 小林" maxLength={80} />
            </Form.Item>
            {!team && (
              <Form.Item name="projectRole" label="加入后的项目角色">
                <Select options={projectRoleOptions} />
              </Form.Item>
            )}
            {team && <Alert type="info" title="新账号以团队成员加入，之后可添加到具体项目。" />}
          </Form>
        )}
        {operation.error && <Alert type="error" title={operation.error} />}
      </Modal>
      <Modal
        title="添加已有成员"
        open={adding}
        onCancel={() => {
          if (!operation.busy) setAdding(false);
        }}
        closable={!operation.busy}
        mask={{ closable: !operation.busy }}
        cancelButtonProps={{ disabled: operation.busy }}
        okText="添加到项目"
        confirmLoading={operation.busy}
        onOk={() => addForm.submit()}
      >
        <Form
          disabled={operation.busy}
          form={addForm}
          layout="vertical"
          initialValues={{ role: "member" }}
          onFinish={(v: { userId: string; role: ProjectRole }) =>
            act(async () => {
              await unwrap(
                api.setProjectMember({ path: { projectId, id: v.userId }, body: { role: v.role } }),
              );
              setAdding(false);
            })
          }
        >
          <Form.Item
            name="userId"
            label="团队成员"
            rules={[{ required: true, message: "请选择成员" }]}
          >
            <Select
              showSearch={{ filterOption: false, onSearch: setSearch }}
              loading={candidates.isFetching}
              placeholder="搜索名称或账号"
              options={candidates.data
                ?.filter(
                  (m) =>
                    m.role === "member" && !members.data?.some((existing) => existing.id === m.id),
                )
                .map((m) => ({ value: m.id, label: `${m.displayName} · ${m.username}` }))}
            />
          </Form.Item>
          <Form.Item name="role" label="项目角色">
            <Select options={projectRoleOptions} />
          </Form.Item>
        </Form>
        <QueryState label="团队成员搜索" query={candidates}>
          {null}
        </QueryState>
        {operation.error && <Alert type="error" title={operation.error} />}
      </Modal>
      <Modal
        title={`管理 ${editing?.displayName ?? "成员"}`}
        open={!!editing}
        onCancel={() => {
          if (!operation.busy) setEditing(undefined);
        }}
        closable={!operation.busy}
        mask={{ closable: !operation.busy }}
        cancelButtonProps={{ disabled: operation.busy }}
        okText="保存变更"
        confirmLoading={operation.busy}
        onOk={() => memberForm.submit()}
      >
        <Form
          disabled={operation.busy}
          form={memberForm}
          layout="vertical"
          onFinish={(v: { role: "admin" | "member"; active: boolean }) => {
            if (editing)
              act(async () => {
                await unwrap(api.updateTeamMember({ path: { id: editing.id }, body: v }));
                setEditing(undefined);
              });
          }}
        >
          <Form.Item name="role" label="团队角色">
            <Select
              disabled={!owner}
              options={[
                { value: "member", label: "团队成员 · 按项目授权" },
                { value: "admin", label: "团队管理员 · 管理成员与全部项目" },
              ]}
            />
          </Form.Item>
          <Form.Item name="active" label="启用账号" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Alert type="info" title="变更后将撤销该成员的现有登录会话" />
        </Form>
        {owner && editing?.active && (
          <Button
            type="link"
            onClick={() => {
              const target = editing;
              void modal.confirm({
                title: `将团队所有权移交给 ${target.displayName}？`,
                content: "对方将成为唯一所有者，你将保留团队管理员角色。",
                okText: "移交所有权",
                cancelText: "取消",
                onOk: () =>
                  operation.run(async () => {
                    await unwrap(api.transferTeamOwner({ body: { userId: target.id } }));
                    setEditing(undefined);
                    await refresh();
                  }),
              });
            }}
          >
            移交团队所有权
          </Button>
        )}
        {operation.error && <Alert type="error" title={operation.error} />}
      </Modal>
    </section>
  );
}
