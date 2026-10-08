import { createApp } from "./app";
import { createDb } from "./db/client";

// Never print the URL itself — it may hold a password.
const url = process.env.DATABASE_URL ?? "";
if (!url) {
  console.error("DATABASE_URL is not set (use pglite:memory for local)");
  process.exit(1);
}

const app = createApp(await createDb(url));
// `||`, not `??`: Bun loads `.env` itself, and an empty `PORT=` there arrives as "" (TASK-A-001 Q1).
// This machine only unless HOST says otherwise: v1 has no login (SPEC-A-001 § Non-functional).
Bun.serve({ hostname: process.env.HOST || "127.0.0.1", port: Number(process.env.PORT || 4200), fetch: app.fetch });
