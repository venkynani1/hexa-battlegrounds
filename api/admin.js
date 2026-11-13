// One-off database setup for the Neon database. Disabled unless the project has HEXA_SETUP_KEY set;
// the caller must send the same value in the x-setup-key header. Remove HEXA_SETUP_KEY after setup.
import pg from 'pg';

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  const key = process.env.HEXA_SETUP_KEY;
  if (!key || key.length < 24 || req.headers['x-setup-key'] !== key || req.method !== 'POST') return res.status(404).json({ message: 'not found' });
  const url = process.env.NEON_DATABASE_URL_UNPOOLED || process.env.DATABASE_URL_UNPOOLED || process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) return res.status(503).json({ message: 'no database connected' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const client = new pg.Client({ connectionString: url });
  const notices = [];
  client.on('notice', (n) => { if (notices.length < 200) notices.push(n.message); });
  try {
    await client.connect();
    if (body?.info) {
      const host = new URL(url).hostname.replace(/^[^.]+\./, '');
      const v = await client.query(`select version() v, current_user u, (select setting from pg_settings where name = 'max_connections') mc,
        (select count(*) from pg_proc where pronamespace = 'public'::regnamespace) fns`);
      return res.status(200).json({ host, ...v.rows[0] });
    }
    const out = await client.query(String(body?.sql || 'select 1'));
    const last = Array.isArray(out) ? out[out.length - 1] : out;
    return res.status(200).json({ ok: true, notices, rows: (last?.rows || []).slice(0, 100) });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message, where: e.where, notices });
  } finally {
    client.end().catch(() => {});
  }
}
