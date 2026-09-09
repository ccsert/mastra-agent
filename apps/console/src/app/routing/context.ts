import type { Agent } from "@platform/sdk";
import { useOutletContext } from "react-router";
import type { Page } from "../../shared/navigation";
import type { EditorKind } from "../EditorHost";
export type ConsoleNavigation = {
  page: Page;
  openEditor(kind: EditorKind, agent?: Agent): void;
  registerGuard(guard?: () => "busy" | "dirty" | null): void;
};
export const useConsoleNavigation = () => useOutletContext<ConsoleNavigation>();
