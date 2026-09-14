import type { RunWorkspace } from "@platform/sdk";
import { createContext } from "react";
export const ToolTraceContext = createContext<{
  projectId: string;
  conversationId: string;
  assistantMode?: boolean;
} | null>(null);
export const RunWorkspaceContext = createContext<RunWorkspace | undefined>(undefined);
