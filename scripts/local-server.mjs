// Offline game server for rehearsals and development — no Supabase account needed.
// Runs the real migrations in an embedded Postgres (PGlite) and answers the same
// RPC calls the browser makes to Supabase (POST /rest/v1/rpc/<function>).
// Realtime is not emulated; clients fall back to fast polling automatically.
//
//   npm run local            → http://localhost:54321  (in-memory)
//   PERSIST=1 npm run local  → keeps data in ./.localdb between restarts
//
// Then run the app with VITE_SUPABASE_URL=http://localhost:54321 VITE_SUPABASE_ANON_KEY=local
import http from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const PORT = Number(process.env.PORT || 54321);
const dir = process.env.PERSIST ? './.localdb' : undefined;
const fresh = !dir || !existsSync(dir);
const db = new PGlite(dir);
const MIG = new URL('../supabase/migrations/', import.meta.url);

if (fresh) {
  await db.exec(`do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
                 do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;`);
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  }
  console.log('Database migrated.');
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(req.url.split('?')[0]);
  if (!m || req.method !== 'POST') { res.writeHead(404, cors); return res.end('{"message":"not found"}'); }
  let body = '';
  for await (const chunk of req) body += chunk;
  let args = {};
  try { args = body ? JSON.parse(body) : {}; } catch { /* empty */ }
  const keys = Object.keys(args).filter((k) => /^p_[a-z_]+$/.test(k));
  const sql = `select public.${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
  const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
  try {
    const out = await db.transaction(async (tx) => {
      await tx.query('set local role anon'); // same privileges as the browser key on Supabase
      return (await tx.query(sql, vals)).rows[0].r;
    });
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out ?? null));
  } catch (e) {
    res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: e.code || 'P0001', message: e.message, details: null, hint: null }));
  }
}).listen(PORT, () => console.log(`Local game server on http://localhost:${PORT}`));
