import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import 'dotenv/config';

const connectionString =
  process.env.DATABASE_URL || 'postgres://yapp:yapp_dev@localhost:5433/yapp';
const client = new pg.Client({ connectionString });

const migrationsDir = path.join(import.meta.dirname, 'migrations');

async function run() {
  await client.connect();

  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await client.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('migrated:', file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }

  console.log('DB up to date.');
  await client.end();
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});