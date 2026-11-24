// Challenge pack 5 — battle royale life, Free Fire style. Every answer is computed, every challenge needs all
// three phones:
//   Loadout Math   (Scout: the enemy's HP and armour · Decoder: the gun table · Intel: what you are carrying)
//   Zone Run       (Scout: distance to the safe zone · Decoder: running and buggy speeds · Intel: time left)
//   Airdrop Code   (Scout: the crate's light strip · Decoder: colour → digit key · Intel: which lights count)
//   Med Triage     (Scout: the squad's HP · Decoder: what each item heals · Intel: the bag)
//   Radio Freq     (Scout: base frequency · Decoder: the hop rules · Intel: today's channel)
// Seeded, so every build is identical. Run directly to self-check every answer.

const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const shuffle = (r, arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const T = [];
const META = { mission: { time: 200, attempts: 3 }, battle: { time: 90, attempts: 3 }, recovery: { time: 120, attempts: 5 }, airdrop: { time: 150, attempts: 3 } };
function add(t) {
  const tpl = { category: 'game', difficulty: 1, coins: 25, points: null, relay: false, hint: '', status: 'published',
    time_limit: META[t.kind].time, attempts: META[t.kind].attempts, ...t };
  tpl.parts = tpl.parts.map((p) => ({ label: p.label, accept: [...new Set(p.accept.map(norm))] }));
  for (const role of ['scout', 'decoder', 'intel']) if (!tpl.clues[role]) throw new Error(`${tpl.id} missing ${role} clue`);
  for (const p of tpl.parts) if (!p.accept.length || p.accept.some((a) => !a)) throw new Error(`${tpl.id} empty answer`);
  if (T.find((x) => x.id === tpl.id)) throw new Error(`duplicate ${tpl.id}`);
  T.push(tpl);
}
const ANY = (...tags) => [...tags, 'any'];

// ───────────── Loadout Math ─────────────
const GUNS = [['Pistol', 3], ['SMG', 3], ['Shotgun', 9], ['Assault Rifle', 4], ['Sniper', 16]];
const VEST = [0, 10, 20, 30];
function loadout(n, kind, tags) {
  const r = rng(51000 + n * 29);
  const hp = int(r, 4, 10) * 10; const shield = pick(r, [0, 10, 20, 30]); const vest = int(r, 0, 3);
  const carry = shuffle(r, GUNS).slice(0, 3);
  const gun = pick(r, carry);
  const per = Math.max(1, Math.round(gun[1] * (1 - VEST[vest] / 100)));
  const shots = Math.ceil((hp + shield) / per);
  add({
    id: `${kind}-loadout-${n}`, family: 'loadout', kind, tags, category: 'game', difficulty: 2,
    title: 'Loadout Math',
    objective: 'A rival squad is pinned behind a car. How many hits does it take to knock them out with the gun you choose?',
    clues: {
      scout: { title: 'Through the scope', body: `Rival squad: ${hp} HP + ${shield} shield\nWearing: ${vest ? `Vest level ${vest}` : 'no vest'}`, big: true },
      decoder: { title: 'Gun table (damage per hit)', body: GUNS.map(([g, d]) => `${g.padEnd(14)} ${d}`).join('\n') + '\n\nVest 1 / 2 / 3 cuts every hit by 10 / 20 / 30 %, rounded to the nearest whole number (at least 1).', mono: true },
      intel: { title: 'In your hands', body: `You are carrying: ${carry.map((c) => c[0]).join(', ')}.\nThe captain says: use the ${gun[0]}.` },
    },
    parts: [{ label: 'Hits needed', accept: [String(shots)] }],
    hint: 'Damage per hit after the vest, then divide HP + shield by it and round up.',
    explanation: `${gun[0]} ${gun[1]} → ${per} per hit through vest ${vest}; ${hp + shield} ÷ ${per} → ${shots}`,
  });
}

// ───────────── Zone Run ─────────────
function zoneRun(n, kind, tags) {
  const r = rng(52000 + n * 31);
  const run = pick(r, [5, 6]); const buggy = pick(r, [12, 15, 18]);
  const dist = int(r, 12, 40) * 10; const left = int(r, 20, 70);
  const toBuggy = pick(r, [0, 30, 60]);
  const runT = Math.ceil(dist / run);
  const buggyT = toBuggy ? Math.ceil(toBuggy / run) + Math.ceil((dist) / buggy) : Math.ceil(dist / buggy);
  const best = Math.min(runT, buggyT); const how = buggyT < runT ? 'BUGGY' : 'RUN';
  const make = best <= left ? 'YES' : 'NO';
  add({
    id: `${kind}-zonerun-${n}`, family: 'zonerun', kind, tags, category: 'maths', difficulty: 2,
    title: 'Zone Run',
    objective: 'The gas wall is coming. Do you make it into the safe zone, and is it faster to run or to take the buggy?',
    clues: {
      scout: { title: 'Range finder', body: `Safe zone edge: ${dist} m away.\nYour buggy: ${toBuggy ? `${toBuggy} m behind you (you must run to it first)` : 'right next to you'}.`, big: true },
      decoder: { title: 'Speeds', body: `Running: ${run} m/s\nBuggy: ${buggy} m/s\nRound every leg UP to whole seconds.`, mono: true },
      intel: { title: 'Zone timer', body: `The wall reaches you in ${left} seconds.` },
    },
    parts: [{ label: 'RUN or BUGGY (the faster one)', accept: [how] }, { label: 'Do you make it? YES / NO', accept: [make] }],
    hint: 'Running time = distance ÷ run speed. Buggy time = time to reach the buggy + distance ÷ buggy speed.',
    explanation: `run ${runT}s, buggy ${buggyT}s → ${how}; ${best}s vs ${left}s → ${make}`,
  });
}

// ───────────── Airdrop Code ─────────────
const COLOURS = ['RED', 'BLUE', 'GREEN', 'YELLOW', 'WHITE', 'PURPLE'];
function airdropCode(n, kind, tags) {
  const r = rng(53000 + n * 37);
  const strip = Array.from({ length: 7 }, () => pick(r, COLOURS));
  const key = Object.fromEntries(shuffle(r, COLOURS).map((c, i) => [c, i + 1]));
  const rule = pick(r, ['odd', 'even', 'first4', 'last4']);
  const idx = rule === 'odd' ? [0, 2, 4, 6] : rule === 'even' ? [1, 3, 5] : rule === 'first4' ? [0, 1, 2, 3] : [3, 4, 5, 6];
  const code = idx.map((i) => key[strip[i]]).join('');
  const ruleText = { odd: 'Read lights 1, 3, 5 and 7 (left to right).', even: 'Read lights 2, 4 and 6 (left to right).', first4: 'Read the first four lights.', last4: 'Read the last four lights.' }[rule];
  add({
    id: `${kind}-dropcode-${n}`, family: 'dropcode', kind, tags, category: 'decoding', difficulty: 1,
    title: 'Airdrop Code',
    objective: 'The supply crate is locked with a light strip. Turn the lights into the code.',
    clues: {
      scout: { title: 'Crate light strip', body: strip.join(' · '), big: true },
      decoder: { title: 'Colour key', body: COLOURS.map((c) => `${c} = ${key[c]}`).join('\n'), mono: true },
      intel: { title: 'Which lights count', body: ruleText },
    },
    parts: [{ label: 'Crate code', accept: [code] }],
    hint: 'Pick the lights Intel names, then swap each colour for its digit.',
    explanation: `${idx.map((i) => strip[i]).join(' ')} → ${code}`,
  });
}

// ───────────── Med Triage ─────────────
function triage(n, kind, tags) {
  const r = rng(54000 + n * 41);
  const target = 100; const hp = int(r, 2, 8) * 10;
  const kit = pick(r, [25, 30, 40]); const spray = pick(r, [10, 15, 20]);
  const kits = int(r, 0, 3); const sprays = int(r, 1, 6);
  const need = target - hp;
  // fewest items that reach 100 (overheal allowed), kits first because they heal more
  let best = null;
  for (let k = 0; k <= kits; k++) for (let s = 0; s <= sprays; s++) {
    if (k * kit + s * spray >= need && (best === null || k + s < best)) best = k + s;
  }
  const ans = best === null ? 'NO' : String(best);
  add({
    id: `${kind}-triage-${n}`, family: 'triage', kind, tags, category: 'maths', difficulty: 1,
    title: 'Med Triage',
    objective: 'Your squad is hurt before the final circle. Fewest items to get back to full 100 HP? (NO if you cannot.)',
    clues: {
      scout: { title: 'Squad health', body: `${hp} / 100 HP`, big: true },
      decoder: { title: 'Item card', body: `Med kit: +${kit} HP\nHealing spray: +${spray} HP\nHealing above 100 is wasted but allowed.`, mono: true },
      intel: { title: 'In the bag', body: `${kits} med kit${kits === 1 ? '' : 's'} and ${sprays} healing spray${sprays === 1 ? '' : 's'}.` },
    },
    parts: [{ label: 'Fewest items (or NO)', accept: [ans] }],
    hint: 'Missing HP = 100 − current. Use the bigger heals first, then top up.',
    explanation: `need ${need}; kits ${kit}×≤${kits}, sprays ${spray}×≤${sprays} → ${ans}`,
  });
}

// ───────────── Radio Frequency ─────────────
function radio(n, kind, tags) {
  const r = rng(55000 + n * 43);
  const base = int(r, 120, 180) + pick(r, [0, 0.5]);
  const ch = int(r, 1, 9); const hop = pick(r, [0.5, 1.5, 2.5]); const odd = pick(r, ['add', 'sub']);
  const f = base + ch * hop + (ch % 2 === 1 ? (odd === 'add' ? 3 : -3) : 0);
  const ans = (Math.round(f * 10) / 10).toFixed(1);
  add({
    id: `${kind}-radio-${n}`, family: 'radio', kind, tags, category: 'logic', difficulty: 2,
    title: 'Radio Frequency',
    objective: 'Tune the squad radio to the rally channel. Answer with one decimal, like 141.5.',
    clues: {
      scout: { title: 'Base frequency (painted on the tower)', body: `${base.toFixed(1)} MHz`, big: true },
      decoder: { title: 'Hop rules', body: `Every channel adds ${hop} MHz to the base.\nOdd channels then ${odd === 'add' ? 'ADD' : 'SUBTRACT'} 3 MHz.`, mono: true },
      intel: { title: "Today's channel", body: `Rally on channel ${ch}.` },
    },
    parts: [{ label: 'Frequency (MHz)', accept: [ans, ans.replace(/\.0$/, '')] }],
    hint: 'Base + channel × hop, then the odd-channel rule.',
    explanation: `${base} + ${ch}×${hop}${ch % 2 ? (odd === 'add' ? ' + 3' : ' − 3') : ''} = ${ans}`,
  });
}

export function buildMissions5() {
  T.length = 0;
  for (let i = 0; i < 20; i++) loadout(i, 'mission', ANY('testing', 'access', 'phase2', 'public'));
  for (let i = 0; i < 6; i++) loadout(40 + i, 'battle', ['duel_pistol', 'duel_smg', 'duel_sniper']);
  for (let i = 0; i < 20; i++) zoneRun(i, 'mission', ANY('public', 'terrace', 'gate', 'observation'));
  for (let i = 0; i < 5; i++) zoneRun(40 + i, 'recovery', ['any']);
  for (let i = 0; i < 20; i++) airdropCode(i, 'mission', ANY('access', 'office', 'stg', 'learning'));
  for (let i = 0; i < 8; i++) airdropCode(40 + i, 'airdrop', ['any']);
  for (let i = 0; i < 20; i++) triage(i, 'mission', ANY('helpdesk', 'social', 'food', 'coffee'));
  for (let i = 0; i < 5; i++) triage(40 + i, 'recovery', ['any']);
  for (let i = 0; i < 20; i++) radio(i, 'mission', ANY('transmission', 'boardroom', 'gate', 'terrace'));
  for (let i = 0; i < 4; i++) radio(40 + i, 'battle', ['duel_smg', 'duel_sniper']);
  return T;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = buildMissions5();
  console.log(all.length, 'templates', all.reduce((m, t) => ({ ...m, [`${t.kind}:${t.family}`]: (m[`${t.kind}:${t.family}`] || 0) + 1 }), {}));
  for (const fam of ['loadout', 'zonerun', 'dropcode', 'triage', 'radio']) {
    const t = all.find((x) => x.family === fam);
    console.log(`\n[${fam}] ${t.id} → ${t.parts.map((p) => p.accept[0]).join(' / ')} · ${t.explanation}`);
    for (const [k, v] of Object.entries(t.clues)) console.log(`  ${k}: ${v.body.replace(/\n/g, ' | ')}`);
  }
}
export { norm };
