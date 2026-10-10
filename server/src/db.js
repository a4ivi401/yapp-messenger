import pg from 'pg';
import 'dotenv/config';

const connectionString =
  process.env.DATABASE_URL || 'postgres://yapp:yapp_dev@localhost:5433/yapp';

export const pool = new pg.Pool({ connectionString });

export const query = (text, params) => pool.query(text, params);