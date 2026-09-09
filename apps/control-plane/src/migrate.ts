import { Database } from "@platform/database";
import { required } from "@platform/operations";

const db = new Database(required("DATABASE_URL"), process.env.DATABASE_SCHEMA ?? "public");
try {
  await db.migrate();
  console.log("Database migrations applied.");
} finally {
  await db.close();
}
