// Game API on Vercel for a plain Postgres database (Neon): POST /rest/v1/rpc/<function> (rewritten to
// /api/rpc?fn=<function>) runs public.<function>(p_… => …) and answers like Supabase's PostgREST.
// Only the functions the browser role "anon" may execute are reachable — same rule as on Supabase.
import pg from 'pg';

// Neon connected through Vercel Storage with the env prefix NEON (POSTGRES_* already belongs to Supabase)
const url = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
const pool = (globalThis.__hexaPool ||= url
  ? new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 20000, connectionTimeoutMillis: 10000, query_timeout: 15000 })
  : null);
if (pool && !globalThis.__hexaPoolErr) { globalThis.__hexaPoolErr = true; pool.on('error', () => {}); }

let allowed = null; let allowedAt = 0;
async function isAllowed(fn) {
  // refresh every 5 minutes, or at once (at most every 10 s) for a name not seen yet — right after a database upgrade
  if (!allowed || Date.now() - allowedAt > 300000 || (!allowed.has(fn) && Date.now() - allowedAt > 10000)) {
    const r = await pool.query(`select p.proname from pg_proc p
      where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute')`);
    allowed = new Set(r.rows.map((x) => x.proname)); allowedAt = Date.now();
  }
  return allowed.has(fn);
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'POST only' });
  if (!pool) return res.status(503).json({ message: 'NOT_CONFIGURED' });
  const fn = String(req.query.fn || '');
  if (!/^[a-z][a-z0-9_]{1,60}$/.test(fn)) return res.status(404).json({ message: 'not found' });
  let args = req.body;
  if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch { args = {}; } }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  const keys = Object.keys(args).filter((k) => /^p_[a-z0-9_]{1,40}$/.test(k));
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
  const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
  try {
    if (!(await isAllowed(fn))) return res.status(404).json({ message: 'not found' });
    const r = await pool.query(sql, vals);
    return res.status(200).json(r.rows[0]?.r ?? null);
  } catch (e) {
    const timeout = /timeout|timed out/i.test(String(e.message));
    return res.status(timeout ? 504 : 400).json({ code: e.code || 'P0001', message: String(e.message || 'error'), details: null, hint: null });
  }
}
