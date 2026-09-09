import type { SkillVersion } from "@platform/sdk";
import { Input, Tree, type TreeDataNode } from "antd";
import { useMemo, useState } from "react";

function directory(files: SkillVersion["files"], search: string): TreeDataNode[] {
  const root: TreeDataNode[] = [];
  for (const file of files.filter((f) => f.path.toLowerCase().includes(search.toLowerCase()))) {
    const segments = file.path.split("/");
    let siblings = root;
    for (let i = 0; i < segments.length; i++) {
      const key = segments.slice(0, i + 1).join("/"),
        isLeaf = i === segments.length - 1;
      let node = siblings.find((n) => n.key === key);
      if (!node) {
        node = {
          key,
          title: segments[i],
          isLeaf,
          selectable: isLeaf,
          children: isLeaf ? undefined : [],
        };
        siblings.push(node);
      }
      siblings = node.children ?? [];
    }
  }
  function sort(nodes: TreeDataNode[]): TreeDataNode[] {
    return nodes
      .sort(
        (a, b) =>
          Number(!!a.isLeaf) - Number(!!b.isLeaf) || String(a.key).localeCompare(String(b.key)),
      )
      .map((n) => ({ ...n, children: n.children && sort(n.children) }));
  }
  return sort(root);
}

export function SkillFileTree({
  files,
  path,
  onSelect,
}: {
  files: SkillVersion["files"];
  path: string;
  onSelect(path: string): void;
}) {
  const [search, setSearch] = useState("");
  const treeData = useMemo(() => directory(files, search), [files, search]);
  return (
    <aside className="skill-file-tree" aria-label="Skill 文件目录">
      <header>
        <strong>文件目录</strong>
        <small>{files.length} 个文件</small>
      </header>
      <Input
        aria-label="搜索包内文件"
        placeholder="搜索文件或路径"
        allowClear
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {treeData.length ? (
        <Tree.DirectoryTree
          key={search}
          aria-label="Skill 文件"
          defaultExpandAll
          selectedKeys={[path]}
          treeData={treeData}
          onSelect={(_, { node }) => {
            if (node.isLeaf) onSelect(String(node.key));
          }}
        />
      ) : (
        <p className="muted">没有匹配的文件</p>
      )}
    </aside>
  );
}
