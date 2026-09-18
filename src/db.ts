import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { CONFIG, Config } from './config';

@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool: Pool;
  constructor(@Inject(CONFIG) config: Config) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 10,
      connectionTimeoutMillis: 10000, statement_timeout: 15000,
      ssl: config.databaseSsl ? { rejectUnauthorized: true, ca: config.databaseCa } : false });
  }
  query(text: string, values: unknown[] = []) { return this.pool.query(text, values); }
  async transaction<T>(fn: (client: Pick<PoolClient, 'query'>) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async onModuleDestroy() { await this.pool.end(); }
}
