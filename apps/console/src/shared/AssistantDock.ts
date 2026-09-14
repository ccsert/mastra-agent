import { createContext, useContext } from "react";

/** Coordinate page-owned auxiliary panes without coupling features to the assistant. */
export const AssistantDockContext = createContext({ open: false, close: () => {} });
export const useAssistantDock = () => useContext(AssistantDockContext);
