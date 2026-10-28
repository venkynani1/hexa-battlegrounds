// Packs every migration into a few files for the Supabase SQL Editor, which accepts at most
// 100,000 characters per query. Run them in order: part-1, part-2, …
// Run: npm run db:bundle  → supabase/setup/part-N.sql
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
const LIMIT = 95000;
const dir = new URL('../supabase/migrations/', import.meta.url);
const out = new URL('../supabase/setup/', import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
rmSync(new URL('../supabase/setup.sql', import.meta.url), { force: true });
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const parts = [];
let cur = [];
let len = 0;
for (const f of files) {
  const body = `-- ───────────── ${f} ─────────────\n${readFileSync(new URL(f, dir), 'utf8')}\n`;
  if (body.length > LIMIT) throw new Error(`${f} alone exceeds ${LIMIT} characters — split it`);
  if (len + body.length > LIMIT && cur.length) { parts.push(cur); cur = []; len = 0; }
  cur.push(body); len += body.length;
}
if (cur.length) parts.push(cur);
parts.forEach((p, i) => {
  const head = `-- HEXA BATTLEGROUNDS database setup — PART ${i + 1} OF ${parts.length}.\n-- Supabase → SQL Editor → New query → paste → Run. Run the parts in order. Safe to re-run.\n\n`;
  const text = head + p.join('\n');
  writeFileSync(new URL(`part-${i + 1}.sql`, out), text);
  console.log(`supabase/setup/part-${i + 1}.sql  ${text.length.toLocaleString()} characters`);
});
