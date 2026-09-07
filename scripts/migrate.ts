import { Database } from "@platform/database";
import { required } from "./env.ts";

const db = new Database(required("DATABASE_URL"));
try {
  await db.migrate();
  console.log("Database migration 1 applied.");
} finally {
  await db.close();
}
