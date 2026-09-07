import { Pool, type QueryResultRow } from "pg";

const globalForDb = globalThis as unknown as { creatorPool?: Pool };

function pool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("未配置 DATABASE_URL，请先启动 PostgreSQL 并执行 npm run db:migrate");
  globalForDb.creatorPool ??= new Pool({ connectionString, max: 10 });
  return globalForDb.creatorPool;
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await pool().query<T>(text, values)).rows;
}

export async function queryOne<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T | null> {
  return (await query<T>(text, values))[0] ?? null;
}

export async function databaseHealth(): Promise<boolean> {
  try { await query("SELECT 1"); return true; } catch { return false; }
}
