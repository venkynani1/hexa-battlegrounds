// Runs every migration against your Supabase database directly (no SQL Editor needed).
// 1. Vercel → your project → Settings → Environment Variables → copy POSTGRES_URL_NON_POOLING
//    (or Supabase → Project Settings → Database → Connection string, "Session" / port 5432).
// 2. Run:  DATABASE_URL="postgres://..." npm run db:setup
// Safe to re-run: everything updates in place.
import { readFileSync, readdirSync } from 'node:fs';
import pg from 'pg';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!url) {
  console.error('Set DATABASE_URL to your Supabase Postgres connection string (POSTGRES_URL_NON_POOLING in Vercel).');
  process.exit(1);
}
const client = new pg.Client({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl: { rejectUnauthorized: false } });
await client.connect();
const dir = new URL('../supabase/migrations/', import.meta.url);
for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  process.stdout.write(`Running ${f} … `);
  await client.query(readFileSync(new URL(f, dir), 'utf8')); // simple protocol: multiple statements allowed
  console.log('ok');
}
const { rows } = await client.query('select count(*)::int as n from mission_templates');
console.log(`Done. ${rows[0].n} missions loaded. Redeploy on Vercel and open /host.`);
await client.end();
