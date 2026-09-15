import type { Database } from "@platform/database";
import type { Vault } from "./infrastructure/crypto.ts";
import { Agents } from "./modules/agents/index.ts";
import { Applications } from "./modules/applications/index.ts";
import { Conversations } from "./modules/conversations/index.ts";
import { Identity } from "./modules/identity/index.ts";
import { Members } from "./modules/members/index.ts";
import { Projects } from "./modules/projects/index.ts";
import { Resources } from "./modules/resources/index.ts";
import { Runtimes } from "./modules/runtimes/index.ts";
import { Skills } from "./modules/skills/index.ts";

/** Composition root: domain modules depend on explicit collaborators, never on this object. */
export class Platform {
  readonly identity: Identity;
  readonly members: Members;
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
    this.members = new Members(db, this.projects.access);
    this.resources = new Resources(db, vault, this.projects);
    this.skills = new Skills(db, this.projects, runtimeId);
    this.agents = new Agents(db, this.projects, this.resources, this.skills);
    this.conversations = new Conversations(
      db,
      this.projects,
      this.resources,
      runtimeId,
      this.skills,
    );
    this.applications = new Applications(db, vault, this.projects);
    this.runtimes = new Runtimes(db, runtimeId, this.projects.access);
  }
  async initialize() {
    await this.db.migrate();
    await this.db.query("INSERT INTO runtimes(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING", [
      this.runtimeId,
      "平台托管 Runtime",
    ]);
  }
}
