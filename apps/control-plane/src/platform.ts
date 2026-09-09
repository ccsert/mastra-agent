import type { Database } from "@platform/database";
import { Agents } from "./agents.ts";
import { Applications } from "./applications.ts";
import { Conversations } from "./conversations.ts";
import type { Vault } from "./crypto.ts";
import { Identity } from "./identity.ts";
import { Projects } from "./projects.ts";
import { Resources } from "./resources.ts";
import { Runtimes } from "./runtimes.ts";
import { Skills } from "./skills.ts";

/** Composition root: domain modules depend on explicit collaborators, never on this object. */
export class Platform {
  readonly identity: Identity;
  readonly projects: Projects;
  readonly resources: Resources;
  readonly agents: Agents;
  readonly skills: Skills;
  readonly conversations: Conversations;
  readonly applications: Applications;
  readonly runtimes: Runtimes;
  constructor(
    readonly db: Database,
    readonly vault: Vault,
    readonly runtimeId = "hosted-local",
  ) {
    this.identity = new Identity(db);
    this.projects = new Projects(db);
    this.resources = new Resources(db, vault, this.projects);
    this.skills = new Skills(db, this.projects, runtimeId);
    this.agents = new Agents(db, this.projects, this.resources, this.skills);
    this.conversations = new Conversations(db, this.projects, this.resources, runtimeId);
    this.applications = new Applications(db, vault, this.projects);
    this.runtimes = new Runtimes(db, runtimeId);
  }
  async initialize() {
    await this.db.migrate();
    await this.db.query("INSERT INTO runtimes(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING", [
      this.runtimeId,
      "平台托管 Runtime",
    ]);
  }
}
