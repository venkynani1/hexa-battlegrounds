// Offline game server for rehearsals and development — no Supabase account needed.
// Runs the real migrations in an embedded Postgres (PGlite) and answers the same
// RPC calls the browser makes to Supabase (POST /rest/v1/rpc/<function>).
// Realtime: client-to-client broadcast channels are emulated (enough for squad movement);
// database pings are not, so clients fall back to fast polling for state.
//
//   npm run local            → http://localhost:54321  (in-memory)
//   PERSIST=1 npm run local  → keeps data in ./.localdb between restarts
//
// Then run the app with VITE_SUPABASE_URL=http://localhost:54321 VITE_SUPABASE_ANON_KEY=local
import http from 'node:http';
import { createHash } from 'node:crypto';
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  // DEV_SQL=1 only: raw SQL for automated play-tests (never enabled by default)
  if (process.env.DEV_SQL === '1' && req.url === '/dev/sql' && req.method === 'POST') {
    let q = ''; for await (const c of req) q += c;
    try { const r = await db.query(q); res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify(r.rows)); }
    catch (e) { res.writeHead(400, cors); return res.end(JSON.stringify({ message: e.message })); }
  }
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
});

// ── Minimal Phoenix/Realtime websocket: join, heartbeat, broadcast relay ──
const topics = new Map(); // topic -> Set(socket)
function wsSend(sock, text) {
  const data = Buffer.from(text);
  const head = data.length < 126 ? Buffer.from([0x81, data.length])
    : data.length < 65536 ? Buffer.from([0x81, 126, data.length >> 8, data.length & 255])
    : Buffer.concat([Buffer.from([0x81, 127, 0, 0, 0, 0]), Buffer.from([(data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255])]);
  try { sock.write(Buffer.concat([head, data])); } catch { /* closed */ }
}
function relay(sock, topic, event, payload) {
  for (const other of topics.get(topic) || []) if (other !== sock) wsSend(other, JSON.stringify([null, null, topic, 'broadcast', { type: 'broadcast', event, payload }]));
}
function onMessage(sock, buf, binary) {
  if (binary) {
    // kind 3 = user broadcast push: [kind, joinRefLen, refLen, topicLen, eventLen, metaLen, encoding] + strings + payload
    if (buf[0] !== 3) return;
    let o = 7; const take = (n) => { const v = buf.subarray(o, o + n).toString(); o += n; return v; };
    take(buf[1]); take(buf[2]); const topic = take(buf[3]); const event = take(buf[4]); take(buf[5]);
    const raw = buf.subarray(o);
    let payload = {}; try { payload = buf[6] === 1 ? JSON.parse(raw.toString()) : {}; } catch { /* ignore */ }
    return relay(sock, topic, event, payload);
  }
  let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
  const [joinRef, ref, topic, event, payload] = msg;
  const reply = (response = {}) => wsSend(sock, JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response }]));
  if (event === 'phx_join') { if (!topics.has(topic)) topics.set(topic, new Set()); topics.get(topic).add(sock); sock.topics.add(topic); reply({ postgres_changes: [] }); }
  else if (event === 'phx_leave') { topics.get(topic)?.delete(sock); sock.topics.delete(topic); reply(); }
  else if (event === 'heartbeat' || event === 'access_token') reply();
  else if (event === 'broadcast') { reply(); relay(sock, topic, payload?.event, payload?.payload); }
}
server.on('upgrade', (req, sock) => {
  if (!req.url.startsWith('/realtime/v1/websocket')) return sock.destroy();
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.topics = new Set();
  let acc = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    while (acc.length >= 2) {
      const op = acc[0] & 15; let len = acc[1] & 127; let o = 2;
      if (len === 126) { if (acc.length < 4) return; len = acc.readUInt16BE(2); o = 4; } else if (len === 127) { if (acc.length < 10) return; len = Number(acc.readBigUInt64BE(2)); o = 10; }
      const masked = acc[1] & 128; const need = o + (masked ? 4 : 0) + len;
      if (acc.length < need) return;
      const mask = masked ? acc.subarray(o, o + 4) : null; const data = Buffer.from(acc.subarray(o + (masked ? 4 : 0), need));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      acc = acc.subarray(need);
      if (op === 8) { sock.end(); return; }
      if (op === 9) { sock.write(Buffer.from([0x8a, 0])); continue; }
      if (op === 1 || op === 2) onMessage(sock, data, op === 2);
    }
  });
  const drop = () => { for (const t of sock.topics) topics.get(t)?.delete(sock); };
  sock.on('close', drop); sock.on('error', drop);
});
server.listen(PORT, () => console.log(`Local game server on http://localhost:${PORT}`));
