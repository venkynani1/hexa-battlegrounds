// Packs every migration into a few files for the Supabase SQL Editor.
// Each part is minified onto ONE line: the editor accepts at most 100,000 characters per query,
// and some editors/paste paths auto-indent every new line, which can blow a multi-line script past
// that limit and truncate it ("unterminated dollar-quoted string"). One line can't be re-indented.
// Run: npm run db:bundle  → supabase/setup/part-N.sql (run them in order)
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

const LIMIT = 90000;

// Remove -- comments and collapse whitespace, never touching '…' strings or "…" identifiers.
export function minify(sql) {
  let out = '';
  let i = 0;
  let pendingSpace = false;
  const emit = (s) => {
    if (pendingSpace && out.length && !/\s$/.test(out)) out += ' ';
    pendingSpace = false;
    out += s;
  };
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      emit(sql.slice(i, j + 1));
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      pendingSpace = true;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      pendingSpace = true;
    } else if (/\s/.test(c)) {
      pendingSpace = true;
      i++;
    } else {
      emit(c);
      i++;
    }
  }
  return out.trim();
}

const dir = new URL('../supabase/migrations/', import.meta.url);
const outDir = new URL('../supabase/setup/', import.meta.url);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const parts = [];
let cur = '';
for (const f of files) {
  const body = minify(readFileSync(new URL(f, dir), 'utf8')) + ' ';
  if (body.length > LIMIT) throw new Error(`${f} alone exceeds ${LIMIT} characters after minifying — split it`);
  if (cur.length + body.length > LIMIT && cur) { parts.push(cur); cur = ''; }
  cur += body;
}
if (cur) parts.push(cur);
parts.forEach((p, i) => {
  const text = `/* HEXA BATTLEGROUNDS setup — PART ${i + 1} OF ${parts.length}. Run parts in order. Safe to re-run. */ ${p.trim()}\n`;
  writeFileSync(new URL(`part-${i + 1}.sql`, outDir), text);
  console.log(`supabase/setup/part-${i + 1}.sql  ${text.length.toLocaleString()} characters, ${text.split('\n').length - 1} line`);
});
