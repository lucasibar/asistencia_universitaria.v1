import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : {
      rejectUnauthorized: true, ca: process.env.DATABASE_CA?.replace(/\\n/g, '\n'),
    } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(87234123)');
    await client.query('CREATE TABLE IF NOT EXISTS public.attendance_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    const directory = resolve(__dirname, '../migrations');
    for (const name of readdirSync(directory).filter(f => f.endsWith('.sql')).sort()) {
      if ((await client.query('SELECT 1 FROM public.attendance_migrations WHERE name=$1', [name])).rowCount) continue;
      await client.query(readFileSync(resolve(directory, name), 'utf8'));
      await client.query('INSERT INTO public.attendance_migrations(name) VALUES($1)', [name]);
      console.log(`Applied ${name}`);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await pool.end(); }
}
main().catch((error: unknown) => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown database error';
  console.error(`Migration failed: ${detail}`);
  process.exitCode = 1;
});
