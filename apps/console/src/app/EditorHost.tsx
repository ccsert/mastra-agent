import type { Agent } from "@platform/sdk";
import { AgentEditor } from "../features/agents/index";
import { ModelEditor } from "../features/models/index";
import { ProjectEditor } from "../features/projects/index";
import { ToolEditor } from "../features/tools/index";
import type { EditorCallbacks } from "../shared/EditorForm";
export type EditorKind = "project" | "agent" | "model" | "tool";
export function EditorHost({
  kind,
  ...props
}: EditorCallbacks & { kind: EditorKind | null; projectId: string; agent?: Agent }) {
  switch (kind) {
    case "agent":
      return <AgentEditor {...props} />;
    case "model":
      return <ModelEditor {...props} />;
    case "tool":
      return <ToolEditor {...props} />;
    case "project":
      return <ProjectEditor {...props} />;
    default:
      return null;
  }
}
