// Packs every migration into a few files for the Supabase SQL Editor.
// Each part is minified onto ONE line: the editor accepts at most 100,000 characters per query,
// and some editors/paste paths auto-indent every new line, which can blow a multi-line script past
// that limit and truncate it ("unterminated dollar-quoted string"). One line can't be re-indented.
// Run: npm run db:bundle  → supabase/setup/part-N.sql (run them in order)
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

// 18k: some copy paths (file previews, clipboards) silently cut text at 20,000 characters.
const LIMIT = 18000;
// Upgrade parts are kept small (one or two functions each) so a slow dashboard connection can't drop them.
const UP_LIMIT = 7000;

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

// Split minified SQL into top-level statements (ignoring ; inside strings and $$ bodies).
function statements(sql) {
  const out = [];
  let start = 0; let i = 0; let inDollar = false;
  while (i < sql.length) {
    const c = sql[i];
    if (!inDollar && (c === "'" || c === '"')) {
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; }
      i = j + 1; continue;
    }
    if (c === '$' && sql[i + 1] === '$') { inDollar = !inDollar; i += 2; continue; }
    if (inDollar && (c === "'")) { // strings inside function bodies
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; }
      i = j + 1; continue;
    }
    if (!inDollar && c === ';') { out.push(sql.slice(start, i + 1).trim()); start = i + 1; }
    i++;
  }
  if (sql.slice(start).trim()) out.push(sql.slice(start).trim());
  return out;
}

const dir = new URL('../supabase/migrations/', import.meta.url);
const outDir = new URL('../supabase/setup/', import.meta.url);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const parts = [];
let cur = '';
for (const f of files) {
  for (const st of statements(minify(readFileSync(new URL(f, dir), 'utf8')))) {
    if (st.length > LIMIT) throw new Error(`a statement in ${f} is ${st.length} characters (> ${LIMIT}) — split it`);
    if (cur.length + st.length + 1 > LIMIT && cur) { parts.push(cur); cur = ''; }
    cur += st + ' ';
  }
}
if (cur) parts.push(cur);
// Upgrade bundle: only the incremental migrations (0100+), for databases that already ran the original setup.
const upDir = new URL('../supabase/upgrade/', import.meta.url);
rmSync(upDir, { recursive: true, force: true });
mkdirSync(upDir, { recursive: true });
const upParts = [];
let upCur = '';
for (const f of files.filter((f) => Number(f.slice(0, 4)) >= 100)) {
  for (const st of statements(minify(readFileSync(new URL(f, dir), 'utf8')))) {
    if (upCur.length + st.length + 1 > UP_LIMIT && upCur) { upParts.push(upCur); upCur = ''; }
    upCur += st + ' ';
  }
}
if (upCur) upParts.push(upCur);
upParts.forEach((p, i) => {
  const text = `/* HEXA BATTLEGROUNDS upgrade — PART ${i + 1} OF ${upParts.length}. Only for databases that already ran setup part-01…; run in order. Safe to re-run. */ ${p.trim()}\n`;
  writeFileSync(new URL(`upgrade-${String(i + 1).padStart(2, '0')}.sql`, upDir), text);
  console.log(`supabase/upgrade/upgrade-${String(i + 1).padStart(2, '0')}.sql  ${text.length.toLocaleString()} characters`);
});

parts.forEach((p, i) => {
  const text = `/* HEXA BATTLEGROUNDS setup — PART ${i + 1} OF ${parts.length}. Run parts in order. Safe to re-run. */ ${p.trim()}\n`;
  writeFileSync(new URL(`part-${String(i + 1).padStart(2, "0")}.sql`, outDir), text);
  console.log(`supabase/setup/part-${String(i + 1).padStart(2, "0")}.sql  ${text.length.toLocaleString()} characters, ${text.split('\n').length - 1} line`);
});
