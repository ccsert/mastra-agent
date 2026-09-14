import type { Agent, Model, Principal, Tool } from "@platform/sdk";
import { useOutletContext } from "react-router";
import type { Page } from "../../shared/navigation";
import type { EditorKind } from "../EditorHost";
export type EditorResource = Agent | Model | Tool;
export type ConsoleNavigation = {
  page: Page;
  user: Principal;
  /** Omit the resource to create, pass one to edit it. */
  openEditor(kind: EditorKind, resource?: EditorResource): void;
  registerGuard(guard?: () => "busy" | "dirty" | null): void;
};
export const useConsoleNavigation = () => useOutletContext<ConsoleNavigation>();
