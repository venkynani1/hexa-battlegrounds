// Concatenates every migration into one file you can paste into the Supabase SQL Editor.
// Run: npm run db:bundle  → supabase/setup.sql
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const dir = new URL('../supabase/migrations/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const out = [`-- HEXA BATTLEGROUNDS — complete database setup (generated ${new Date().toISOString().slice(0, 10)}).`,
  '-- Paste into Supabase → SQL Editor → Run. Safe to re-run: it updates functions and content in place.', '']
  .concat(files.map((f) => `-- ───────────── ${f} ─────────────\n${readFileSync(new URL(f, dir), 'utf8')}`)).join('\n');
writeFileSync(new URL('../supabase/setup.sql', import.meta.url), out);
console.log(`supabase/setup.sql written from ${files.length} migrations (${Math.round(out.length / 1024)} KB)`);
