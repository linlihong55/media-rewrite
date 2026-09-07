import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL");
const client = new pg.Client({ connectionString });
await client.connect();
try {
  const dir = path.join(process.cwd(), "db", "migrations");
  for (const name of (await fs.readdir(dir)).filter((x) => x.endsWith(".sql")).sort()) {
    await client.query(await fs.readFile(path.join(dir, name), "utf8"));
    console.log(`migrated ${name}`);
  }
} finally {
  await client.end();
}
