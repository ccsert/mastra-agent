import type { Agent, Model, Tool } from "@platform/sdk";
import { AgentEditor } from "../features/agents/index";
import { ModelEditor } from "../features/models/index";
import { ProjectEditor } from "../features/projects/index";
import { ToolEditor } from "../features/tools/index";
import type { EditorCallbacks } from "../shared/EditorForm";
export type EditorKind = "project" | "agent" | "model" | "tool";
export function EditorHost({
  kind,
  agent,
  model,
  tool,
  ...props
}: EditorCallbacks & {
  kind: EditorKind | null;
  projectId: string;
  agent?: Agent;
  model?: Model;
  tool?: Tool;
}) {
  switch (kind) {
    case "agent":
      return <AgentEditor {...props} agent={agent} />;
    case "model":
      return <ModelEditor {...props} model={model} />;
    case "tool":
      return <ToolEditor {...props} tool={tool} />;
    case "project":
      return <ProjectEditor {...props} />;
    default:
      return null;
  }
}
