import { Database } from "@platform/database";
import { required } from "./env.ts";

const db = new Database(required("DATABASE_URL"));
try {
  await db.migrate();
  console.log("Database migrations applied (Agent platform and knowledge storage).");
} finally {
  await db.close();
}
