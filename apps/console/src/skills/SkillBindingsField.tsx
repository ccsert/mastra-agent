import type { SkillBinding } from "@platform/sdk";
import { Checkbox, Select, Tag } from "antd";
import { useProjectQuery } from "../data/ProjectData";
import { QueryState } from "../data/QueryState";
export function SkillBindingsField({
  value = [],
  onChange,
}: {
  value?: SkillBinding[];
  onChange?: (value: SkillBinding[]) => void;
}) {
  const query = useProjectQuery("skills"),
    skills = query.data ?? [];
  return (
    <div className="skill-bindings">
      <QueryState label="Skill 版本" query={query}>
        <Select
          mode="multiple"
          aria-label="绑定 Skill 版本"
          style={{ width: "100%" }}
          placeholder="选择已导入的固定版本"
          value={value.map((v) => v.versionId)}
          options={skills.map((s) => ({
            value: s.id,
            label: `${s.name} · v${s.version}${s.enabled ? "" : " · 已停用"}`,
            disabled:
              !s.enabled ||
              value.some(
                (v) =>
                  v.versionId !== s.id && skills.find((i) => i.id === v.versionId)?.name === s.name,
              ),
          }))}
          onChange={(ids: string[]) =>
            onChange?.(
              ids.map(
                (id) => value.find((v) => v.versionId === id) ?? { versionId: id, entrypoints: [] },
              ),
            )
          }
        />
        {value.map((binding) => {
          const skill = skills.find((s) => s.id === binding.versionId);
          return (
            <div key={binding.versionId} className="skill-binding">
              <strong>
                {skill?.name ?? "版本不可用"} {skill && <Tag>v{skill.version}</Tag>}
              </strong>
              <p>指令和包内资料可按需读取。勾选后允许自主执行以下脚本：</p>
              <Checkbox.Group
                value={binding.entrypoints}
                options={(skill?.entrypoints ?? []).map((path) => ({ value: path, label: path }))}
                onChange={(paths) =>
                  onChange?.(
                    value.map((v) =>
                      v.versionId === binding.versionId
                        ? { ...v, entrypoints: paths.map(String) }
                        : v,
                    ),
                  )
                }
              />
              {!skill?.entrypoints.length && (
                <span className="form-note">此版本没有支持的脚本入口</span>
              )}
            </div>
          );
        })}
      </QueryState>
    </div>
  );
}
