import type { Database } from "@platform/database";
import type { Vault } from "./crypto.ts";
/** Infrastructure required to assign work and resolve secrets on the control plane. */
export interface ExecutionContext {
  readonly db: Database;
  readonly vault: Vault;
  readonly runtimeId: string;
}
