// Packs every migration into a few files for the Supabase SQL Editor.
// Each part is minified onto ONE line: the editor accepts at most 100,000 characters per query,
// and some editors/paste paths auto-indent every new line, which can blow a multi-line script past
// that limit and truncate it ("unterminated dollar-quoted string"). One line can't be re-indented.
// Run: npm run db:bundle  → supabase/RUN-ME-IN-SUPABASE.sql (one paste), supabase/full/ (complete script),
//                          supabase/setup/part-N.sql (manual fallback: run them in order)
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

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
// Old incremental upgrade folders are superseded by the one-file upgrade below.
for (const old of ['upgrade', 'upgrade-2', 'upgrade-3']) rmSync(new URL(`../supabase/${old}/`, import.meta.url), { recursive: true, force: true });

// ── One file ───────────────────────────────────────────────────────────────────
// supabase/full/hexa-battlegrounds-v4.sql: every migration, in order, one statement per line. Running it
// on ANY earlier install (or an empty project) brings the database to the latest version and keeps data.
// supabase/RUN-ME-IN-SUPABASE.sql: the single paste for the Supabase SQL Editor. It downloads that file
// from GitHub at a pinned commit, checks its SHA-256 and runs it in one transaction (all or nothing).
const fullDir = new URL('../supabase/full/', import.meta.url);
mkdirSync(fullDir, { recursive: true });
const FULL = 'hexa-battlegrounds-v4.sql';
let full = `-- HEXA BATTLEGROUNDS — complete database (v4: vast campus, floors, Collapsing Campus, challenge pack 3).\n` +
  `-- Brings any earlier install, or an empty project, to the latest version. Keeps events, squads and scores. Safe to re-run.\n`;
for (const f of files) {
  full += `\n-- ═══ ${f} ═══\n`;
  for (const st of statements(minify(readFileSync(new URL(f, dir), 'utf8')))) full += st + '\n';
}
writeFileSync(new URL(FULL, fullDir), full);
const sha = createHash('sha256').update(Buffer.from(full, 'utf8')).digest('hex');
const ref = process.env.HEXA_REF || 'main';
const repo = process.env.HEXA_REPO || 'venkynani1/hexa-battlegrounds';
const url = `https://raw.githubusercontent.com/${repo}/${ref}/supabase/full/${FULL}`;
const boot = `-- ════════════════════════════════════════════════════════════════════════════
-- HEXA BATTLEGROUNDS × OPERATION SIRUSERI — ONE-FILE DATABASE UPGRADE (v4)
--
-- Supabase → SQL Editor → New query → paste this whole file → Run. That's all.
--   • Works on a brand-new project and on every earlier version (setup, upgrade 1/2/3, half-run upgrades).
--   • Keeps every event, squad, PIN and score. Everything runs in ONE transaction: all or nothing.
--   • It downloads the full script (${(full.length / 1024).toFixed(0)} KB, too big to paste) from GitHub, checks its
--     SHA-256 fingerprint so nothing else can run, then executes it.
-- Expected result: "Success. No rows returned" and a notice: Hexa Battlegrounds database is up to date (v4).
-- If your project blocks outbound HTTP, run supabase/full/${FULL} instead
-- (psql, or: DATABASE_URL="<POSTGRES_URL_NON_POOLING>" npm run db:setup).
-- ════════════════════════════════════════════════════════════════════════════
create extension if not exists http with schema extensions;
create extension if not exists pgcrypto with schema extensions;

do $hexa$
declare
  v_url text := '${url}';
  v_sha text := '${sha}';
  v_status int;
  v_sql text;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '120');
  select r.status, r.content into v_status, v_sql from extensions.http_get(v_url) r;
  if v_status is distinct from 200 then
    raise exception 'Could not download the upgrade (HTTP %) from %', v_status, v_url;
  end if;
  if encode(extensions.digest(convert_to(v_sql, 'UTF8'), 'sha256'), 'hex') <> v_sha then
    raise exception 'The downloaded file does not match the expected fingerprint. Get the latest RUN-ME-IN-SUPABASE.sql from GitHub and try again.';
  end if;
  execute v_sql;
  raise notice 'Hexa Battlegrounds database is up to date (v4).';
end
$hexa$;
`;
writeFileSync(new URL('../supabase/RUN-ME-IN-SUPABASE.sql', import.meta.url), boot);
console.log(`supabase/full/${FULL}  ${full.length.toLocaleString()} characters · sha256 ${sha.slice(0, 12)}…`);
console.log(`supabase/RUN-ME-IN-SUPABASE.sql  ${boot.length.toLocaleString()} characters · ref ${ref}`);

parts.forEach((p, i) => {
  const text = `/* HEXA BATTLEGROUNDS setup — PART ${i + 1} OF ${parts.length}. Run parts in order. Safe to re-run. */ ${p.trim()}\n`;
  writeFileSync(new URL(`part-${String(i + 1).padStart(2, "0")}.sql`, outDir), text);
  console.log(`supabase/setup/part-${String(i + 1).padStart(2, "0")}.sql  ${text.length.toLocaleString()} characters, ${text.split('\n').length - 1} line`);
});
