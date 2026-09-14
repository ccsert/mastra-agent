import {
  BookOpen,
  Calculator,
  ClipboardList,
  CodeXml,
  FilePenLine,
  FileSearch,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  History,
  Image,
  Keyboard,
  ListChecks,
  MousePointer2,
  Network,
  PackageOpen,
  Plug,
  Save,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";

/** Stable action identity, independent from the call's changing execution status. */
export function ProcessIcon({ name }: { name: string }) {
  const Icon =
    name === "platform_catalog"
      ? Network
      : name === "platform_read"
        ? FileSearch
        : name === "platform_skill"
          ? BookOpen
          : name === "platform_propose"
            ? ClipboardList
            : name === "platform_navigate" || name === "platform_ui"
              ? MousePointer2
              : name === "task_read_history"
                ? History
                : name === "task_progress" || name === "task_read_progress"
                  ? ListChecks
                  : name === "workspace_publish"
                    ? Save
                    : name === "workspace_checkpoint"
                      ? GitBranch
                      : name === "browser_press" ||
                          name === "browser_press_key" ||
                          name === "browser_fill"
                        ? Keyboard
                        : name === "browser_click"
                          ? MousePointer2
                          : name === "update_plan"
                            ? ClipboardList
                            : name === "delegate_task"
                              ? Network
                              : name === "skill"
                                ? PackageOpen
                                : name === "skill_read"
                                  ? BookOpen
                                  : name === "skill_search"
                                    ? FileSearch
                                    : name === "run_skill_script" ||
                                        name.includes("execute_command")
                                      ? Terminal
                                      : name === "knowledge_search" || name.includes("search")
                                        ? Search
                                        : name.includes("screenshot")
                                          ? Image
                                          : name.includes("browser") ||
                                              name.includes("http") ||
                                              name.includes("preview")
                                            ? Globe
                                            : name.includes("write_file") ||
                                                name.includes("edit_file") ||
                                                name.includes("patch")
                                              ? FilePenLine
                                              : name.includes("read_file")
                                                ? FileText
                                                : name.includes("list_files")
                                                  ? FolderOpen
                                                  : name.includes("build") || name.includes("test")
                                                    ? CodeXml
                                                    : name === "sum" || name.startsWith("sum_")
                                                      ? Calculator
                                                      : name.startsWith("mcp_")
                                                        ? Plug
                                                        : Wrench;
  return <Icon aria-hidden="true" className="chat-action-icon" />;
}
