import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      resource_key TEXT UNIQUE NOT NULL,
      bemovil_id BIGINT,
      name TEXT,
      label TEXT,
      description TEXT,
      price NUMERIC NOT NULL,
      checkout_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      last_webhook JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS transaction_id TEXT;
    CREATE TABLE IF NOT EXISTS webhook_logs (
      id SERIAL PRIMARY KEY,
      payload JSONB,
      signature_valid BOOLEAN NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
