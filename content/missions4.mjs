// Challenge pack 4 — new kinds of puzzles:
//   Bomb Defusal (Scout sees the bomb, Decoder has the manual, Intel the override rule)
//   Signal Lights (Scout watches a flashing lamp sequence; Decoder the colour key; Intel the reading rule)
//   Pattern Lock (Intel sees a phone unlock pattern; Scout knows how the photo is turned; Decoder the keypad)
//   Code Breaker (Intel has earlier guesses with feedback; Decoder the legend; Scout one known fact)
//   Balance Scales (Scout sees two scales; Intel one weight; Decoder the question)
//   Keyboard Cipher (Scout has the scrambled word; Decoder the keyboard rows; Intel the shift)
//   World Clock (Scout the meeting time; Intel the client's city; Decoder the time offsets)
//   Escape Route (Intel sees a floor grid; Scout knows start and exit; Decoder the moving rules)
// Same rule as packs 1–3: no single phone can solve a challenge. Seeded, so every build is identical.
// Run directly to self-check every answer.

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
const shuffle = (r, arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

const T = [];
const META = {
  mission: { time: 200, attempts: 3 }, battle: { time: 90, attempts: 3 }, recovery: { time: 120, attempts: 5 },
  airdrop: { time: 150, attempts: 3 },
};
function add(t) {
  const tpl = {
    category: 'logic', difficulty: 1, coins: 25, points: null, relay: false, hint: '', status: 'published',
    time_limit: META[t.kind].time, attempts: META[t.kind].attempts, ...t,
  };
  tpl.parts = tpl.parts.map((p) => ({ label: p.label, accept: [...new Set(p.accept.map(norm))] }));
  for (const role of ['scout', 'decoder', 'intel']) if (!tpl.clues[role]) throw new Error(`${tpl.id} missing ${role} clue`);
  for (const p of tpl.parts) if (!p.accept.length || p.accept.some((a) => !a)) throw new Error(`${tpl.id} empty answer`);
  if (T.find((x) => x.id === tpl.id)) throw new Error(`duplicate ${tpl.id}`);
  T.push(tpl);
}
const ANY = (...tags) => [...tags, 'any'];

// ───────────── Bomb Defusal ─────────────
const WIRE = { red: 'Red', blue: 'Blue', yellow: 'Yellow', white: 'White', black: 'Black', green: 'Green' };
const LEDS = ['red', 'blue', 'green'];
function bombAnswer(w, serial, led, override) {
  const last = Number(serial[serial.length - 1]);
  const count = (c) => w.filter((x) => x === c).length;
  if (override.when(w, serial, led)) return { pos: override.cut(w), why: `override: ${override.text}` };
  if (count('red') > 1) return { pos: w.lastIndexOf('red') + 1, why: 'more than one red → last red' };
  if (last % 2 === 1 && w.includes('blue')) return { pos: w.indexOf('blue') + 1, why: 'serial ends odd and there is blue → first blue' };
  if (led === 'green') return { pos: w.length, why: 'LED green → last wire' };
  if (!w.includes('yellow')) return { pos: 2, why: 'no yellow → second wire' };
  return { pos: 1, why: 'otherwise → first wire' };
}
const OVERRIDES = [
  { text: 'If there is a WHITE wire and the LED is RED, cut the white wire — ignore the manual.', when: (w, s, l) => w.includes('white') && l === 'red', cut: (w) => w.indexOf('white') + 1 },
  { text: 'If the serial number contains the digit 7, cut the THIRD wire — ignore the manual.', when: (w, s) => s.includes('7'), cut: () => 3 },
  { text: 'If there are exactly two BLACK wires, cut the FIRST black wire — ignore the manual.', when: (w) => w.filter((x) => x === 'black').length === 2, cut: (w) => w.indexOf('black') + 1 },
  { text: 'If the LED is BLUE and the first wire is YELLOW, cut the LAST wire — ignore the manual.', when: (w, s, l) => l === 'blue' && w[0] === 'yellow', cut: (w) => w.length },
  { text: 'If there are no RED wires at all, cut the wire just ABOVE the last one — ignore the manual.', when: (w) => !w.includes('red'), cut: (w) => w.length - 1 },
];
const MANUAL = [
  '1. More than one RED wire → cut the LAST red wire.',
  '2. Otherwise, if the serial number ends in an ODD digit and there is a BLUE wire → cut the FIRST blue wire.',
  '3. Otherwise, if the LED is GREEN → cut the LAST wire.',
  '4. Otherwise, if there is no YELLOW wire → cut the SECOND wire.',
  '5. Otherwise → cut the FIRST wire.',
].join('\n');
function bomb(n, kind, tags) {
  const r = rng(41000 + n * 31);
  const len = int(r, 4, 6);
  const wires = Array.from({ length: len }, () => pick(r, Object.keys(WIRE)));
  const serial = `${pick(r, ['HX', 'SR', 'OM', 'TN'])}${int(r, 10, 99)}${pick(r, ['A', 'K', 'Q', 'Z'])}${int(r, 0, 9)}`;
  const led = pick(r, LEDS);
  const ov = OVERRIDES[n % OVERRIDES.length];
  const ans = bombAnswer(wires, serial, led, ov);
  add({
    id: `${kind}-bomb-${n}`, family: 'bomb', kind, tags, category: 'game', difficulty: n % 3 === 2 ? 2 : 1,
    title: kind === 'battle' ? 'Defuse Duel' : 'Bomb Defusal',
    objective: 'A device is ticking. Scout can see it, Decoder holds the bomb manual, Intel has a special order from HQ. Agree on ONE wire and cut it.',
    clues: {
      scout: { title: 'The device', body: `Wires from the TOP: ${wires.map((w) => WIRE[w]).join(', ')}.\nSerial number: ${serial}.  LED: ${led.toUpperCase()}.`, game: { type: 'bomb', wires, serial, led } },
      decoder: { title: 'Bomb manual', body: MANUAL },
      intel: { title: 'Order from HQ (check first!)', body: ov.text },
    },
    parts: [{ label: 'Wire to cut (number from the top)', accept: [String(ans.pos)] }],
    hint: 'Intel first: does HQ\'s order apply? If not, Decoder walks down the manual from rule 1. Scout describes every wire top to bottom.',
    explanation: `${wires.join(',')} · ${serial} · ${led} → ${ans.why} → wire ${ans.pos}`,
    ...(kind === 'battle' ? { time_limit: 80 } : {}),
  });
}

// ───────────── Signal Lights ─────────────
const LAMP = ['red', 'green', 'blue', 'yellow', 'purple', 'white'];
const READ = [
  { text: 'Read the flashes in REVERSE order (last flash first).', f: (s) => [...s].reverse() },
  { text: 'Use only every SECOND flash (the 2nd, 4th, 6th…).', f: (s) => s.filter((_, i) => i % 2 === 1) },
  { text: 'Ignore every WHITE flash, then read the rest in order.', f: (s) => s.filter((c) => c !== 'white') },
  { text: 'Read them in order, but skip any colour you have already read once.', f: (s) => s.filter((c, i) => s.indexOf(c) === i) },
  { text: 'Use only the first FOUR flashes, in order.', f: (s) => s.slice(0, 4) },
];
function signal(n, kind, tags) {
  const r = rng(52000 + n * 13);
  const key = Object.fromEntries(shuffle(r, LAMP).map((c, i) => [c, (i + int(r, 1, 3)) % 10]));
  const rule = READ[n % READ.length];
  let seq; let out;
  do { seq = Array.from({ length: int(r, 6, 7) }, () => pick(r, LAMP)); out = rule.f(seq); } while (out.length < 3);
  const code = out.map((c) => key[c]).join('');
  add({
    id: `${kind}-signal-${n}`, family: 'signal', kind, tags, category: 'game', difficulty: 1,
    title: 'Signal Lights',
    objective: 'A lamp on the roof is flashing a code. Scout watches it, Decoder knows what each colour means, Intel knows how to read it.',
    clues: {
      scout: { title: 'Rooftop lamp', body: 'Press Play and watch the lamp. Call out every colour as it flashes. You can replay it three times.', game: { type: 'signal', seq, replays: 3 } },
      decoder: { title: 'Colour key', body: LAMP.map((c) => `${c[0].toUpperCase()}${c.slice(1)} = ${key[c]}`).join('\n') },
      intel: { title: 'How to read it', body: rule.text },
    },
    parts: [{ label: 'Code', accept: [code] }],
    hint: 'Scout: write the colours down as they flash. Intel: apply the reading rule. Decoder: turn colours into digits last.',
    explanation: `${seq.join(',')} → ${out.join(',')} → ${code}`,
  });
}

// ───────────── Pattern Lock ─────────────
const ADJ = (a, b) => Math.max(Math.abs((a % 3) - (b % 3)), Math.abs(Math.floor(a / 3) - Math.floor(b / 3))) === 1;
const TURN = [
  { text: 'Intel\'s photo of the lock is the right way up.', f: (i) => i },
  { text: 'Intel\'s photo of the lock was taken UPSIDE DOWN (turned 180°).', f: (i) => 8 - i },
  { text: 'Intel\'s photo is a MIRROR image (left and right swapped).', f: (i) => Math.floor(i / 3) * 3 + (2 - (i % 3)) },
  { text: 'Intel\'s photo is turned 90° CLOCKWISE (the top row of the photo is the left column of the lock).', f: (i) => { const rr = Math.floor(i / 3); const c = i % 3; return (2 - c) * 3 + rr; } },
];
function pattern(n, kind, tags) {
  const r = rng(63000 + n * 7);
  let path;
  for (;;) {
    path = [int(r, 0, 8)];
    while (path.length < int(r, 4, 6)) {
      const opts = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((x) => !path.includes(x) && ADJ(path[path.length - 1], x));
      if (!opts.length) break;
      path.push(pick(r, opts));
    }
    if (path.length >= 4) break;
  }
  const keypad = n % 2 ? [7, 8, 9, 4, 5, 6, 1, 2, 3] : shuffle(r, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const turn = TURN[n % TURN.length];
  // what Intel sees is the true pattern seen through the turned photo
  const inv = (j) => [0, 1, 2, 3, 4, 5, 6, 7, 8].find((i) => turn.f(i) === j);
  const shown = path.map(inv);
  const code = path.map((i) => keypad[i]).join('');
  add({
    id: `${kind}-pattern-${n}`, family: 'pattern', kind, tags, category: 'logic', difficulty: n % 4 === 3 ? 2 : 1,
    title: 'Pattern Lock',
    objective: 'An abandoned phone is locked with a swipe pattern. Intel has a photo of the pattern, Scout knows how the photo was taken, Decoder knows the numbers behind the dots.',
    clues: {
      intel: { title: 'Photo of the swipe', body: 'The line starts at the green dot. Describe each dot in order.', game: { type: 'pattern', path: shown } },
      scout: { title: 'How the photo was taken', body: turn.text },
      decoder: { title: 'This phone\'s keypad', body: `The 9 dots carry these numbers (top row first):\n${keypad.slice(0, 3).join('  ')}\n${keypad.slice(3, 6).join('  ')}\n${keypad.slice(6).join('  ')}` },
    },
    parts: [{ label: 'PIN from the pattern', accept: [code] }],
    hint: 'First turn Intel\'s picture back the right way using Scout\'s note, then read Decoder\'s number for each dot in order.',
    explanation: `true path ${path.join('-')} → ${code}`,
  });
}

// ───────────── Code Breaker ─────────────
const fb = (secret, g) => {
  let hit = 0; let near = 0;
  g.forEach((d, i) => { if (secret[i] === d) hit++; else if (secret.includes(d)) near++; });
  return [hit, near];
};
const FACTS = [
  { text: 'The code has NO digit above 6.', ok: (c) => c.every((d) => d <= 6) },
  { text: 'The FIRST digit is odd.', ok: (c) => c[0] % 2 === 1 },
  { text: 'The digits add up to an EVEN number.', ok: (c) => (c[0] + c[1] + c[2]) % 2 === 0 },
  { text: 'The LAST digit is bigger than the first.', ok: (c) => c[2] > c[0] },
  { text: 'The middle digit is 4 or more.', ok: (c) => c[1] >= 4 },
];
function codebreaker(n, kind, tags) {
  const r = rng(74000 + n * 19);
  const all = [];
  for (let a = 1; a <= 8; a++) for (let b = 1; b <= 8; b++) for (let c = 1; c <= 8; c++) if (a !== b && b !== c && a !== c) all.push([a, b, c]);
  for (let attempt = 0; attempt < 400; attempt++) {
    const fact = FACTS[(n + attempt) % FACTS.length];
    const pool = all.filter(fact.ok);
    const secret = pick(r, pool);
    const guesses = [];
    let cand = pool;
    for (let k = 0; k < 6 && cand.length > 1; k++) {
      const g = pick(r, all);
      if (guesses.find((x) => x.g.join() === g.join()) || g.join() === secret.join()) continue;
      const f = fb(secret, g);
      guesses.push({ g, f });
      cand = cand.filter((c) => { const h = fb(c, g); return h[0] === f[0] && h[1] === f[1]; });
    }
    // without Scout's fact there must be more than one answer
    const noFact = all.filter((c) => guesses.every(({ g, f }) => { const h = fb(c, g); return h[0] === f[0] && h[1] === f[1]; }));
    if (cand.length !== 1 || noFact.length < 2 || guesses.length < 3 || guesses.length > 5) continue;
    add({
      id: `${kind}-codebreak-${n}`, family: 'codebreak', kind, tags, category: 'logic', difficulty: guesses.length >= 5 ? 2 : 1,
      title: kind === 'battle' ? 'Code Breaker Duel' : 'Code Breaker',
      objective: 'Someone already tried to open this keypad. Intel has their tries and the keypad\'s answers, Decoder knows what the lights mean, Scout found one fact about the code.',
      clues: {
        intel: { title: 'Earlier tries', body: guesses.map(({ g, f }) => `${g.join(' ')}   →   ${'●'.repeat(f[0])}${'○'.repeat(f[1])}${f[0] + f[1] === 0 ? '—' : ''}`).join('\n'), big: true },
        decoder: { title: 'What the lights mean', body: '● = a right digit in the right place\n○ = a right digit in the wrong place\n— = no digit right\nThe code has 3 different digits from 1 to 8.' },
        scout: { title: 'What you found', body: fact.text },
      },
      parts: [{ label: '3-digit code', accept: [secret.join('')] }],
      hint: 'Start with the try that has no lights at all: those digits are out. Then use the ● tries to pin positions. Scout\'s fact settles the last choice.',
      explanation: `secret ${secret.join('')} (${fact.text})`,
      ...(kind === 'battle' ? { time_limit: 90 } : {}),
    });
    return;
  }
  throw new Error(`codebreaker ${n}: no puzzle`);
}

// ───────────── Balance Scales ─────────────
const ITEMS = [['🍎', 'apple'], ['🍌', 'banana'], ['🍇', 'grapes'], ['🥥', 'coconut'], ['🍍', 'pineapple'], ['🍉', 'melon'], ['☕', 'coffee mug'], ['💻', 'laptop'], ['📦', 'parcel']];
function scales(n, kind, tags) {
  const r = rng(85000 + n * 23);
  const [A, B, C] = shuffle(r, ITEMS).slice(0, 3);
  const a = int(r, 2, 6); const b = a * int(r, 2, 3); const c = b + a * int(r, 1, 2);
  // scale 1: k·A = B ; scale 2: B + A·m = C
  const k = b / a; const m = (c - b) / a;
  const q = [int(r, 1, 2), int(r, 0, 2), int(r, 1, 2)];
  const total = q[0] * a + q[1] * b + q[2] * c;
  const say = (cnt, it) => (cnt ? `${it[0].repeat(cnt)}` : '');
  add({
    id: `${kind}-scales-${n}`, family: 'scales', kind, tags, category: 'maths', difficulty: 1,
    title: 'Balance Scales',
    objective: 'The canteen store-room scales are balanced. Scout sees them, Intel knows one weight, Decoder has the delivery note.',
    clues: {
      scout: { title: 'The two scales', body: `Scale 1:  ${A[0].repeat(k)}   ⚖   ${B[0]}\nScale 2:  ${B[0]}${A[0].repeat(m)}   ⚖   ${C[0]}`, big: true },
      intel: { title: 'Known weight', body: `One ${A[1]} ${A[0]} weighs ${a} kg.` },
      decoder: { title: 'Delivery note', body: `How many kg is this box?   ${[say(q[0], A), say(q[1], B), say(q[2], C)].filter(Boolean).join(' + ')}` },
    },
    parts: [{ label: 'Weight in kg', accept: [String(total)] }],
    hint: 'Work out B from scale 1, then C from scale 2, then add up the box.',
    explanation: `${A[1]}=${a}, ${B[1]}=${b}, ${C[1]}=${c} → ${total}`,
  });
}

// ───────────── Keyboard Cipher ─────────────
const ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
const shiftKey = (ch, d) => { for (const row of ROWS) { const i = row.indexOf(ch); if (i >= 0) return row[(i + d + row.length) % row.length]; } return ch; };
const KWORDS = ['SERVER', 'CLOUD', 'PYTHON', 'BACKUP', 'PORTAL', 'SPRINT', 'DEPLOY', 'TICKET', 'BRANCH', 'MODULE', 'SCRIPT', 'BINARY', 'CACHE', 'KERNEL',
  'LAPTOP', 'ROUTER', 'BADGE', 'LOUNGE', 'CANTEEN', 'PARKING', 'LIFT', 'STAIRS', 'TERRACE', 'FOUNTAIN', 'SHUTTLE', 'HELIPAD', 'CRICKET', 'PANTRY'];
function qwerty(n, kind, tags) {
  const r = rng(96000 + n * 11);
  const word = KWORDS[n % KWORDS.length];
  const d = pick(r, [1, -1, 2, -2]);
  const enc = [...word].map((ch) => shiftKey(ch, d)).join('');
  add({
    id: `${kind}-qwerty-${n}`, family: 'qwerty', kind, tags, category: 'cipher', difficulty: Math.abs(d) === 2 ? 2 : 1,
    title: 'Keyboard Cipher',
    objective: 'A message was typed with the hands in the wrong place on the keyboard. Scout has the message, Intel knows how far the hands slipped, Decoder has the keyboard.',
    clues: {
      scout: { title: 'Scrambled message', body: enc, big: true },
      intel: { title: 'Where the hands were', body: `The typist's hands were ${Math.abs(d)} key${Math.abs(d) > 1 ? 's' : ''} to the ${d > 0 ? 'RIGHT' : 'LEFT'} of where they should be, on the same row. Each row wraps around at the ends.` },
      decoder: { title: 'The keyboard', body: `Top row:     ${ROWS[0].split('').join(' ')}\nMiddle row:  ${ROWS[1].split('').join(' ')}\nBottom row:  ${ROWS[2].split('').join(' ')}` },
    },
    parts: [{ label: 'The real word', accept: [word] }],
    hint: 'For each letter, find it on Decoder\'s keyboard and move back the other way.',
    explanation: `${enc} shifted ${-d} → ${word}`,
  });
}

// ───────────── World Clock ─────────────
const CITIES = [['London', 0], ['New York', -5], ['Dubai', 4], ['Singapore', 8], ['Sydney', 11], ['Frankfurt', 1], ['Toronto', -5], ['Tokyo', 9], ['Johannesburg', 2], ['Chicago', -6]];
function worldClock(n, kind, tags) {
  const r = rng(107000 + n * 29);
  const [city, off] = CITIES[n % CITIES.length];
  const ist = int(r, 7, 22) * 60 + pick(r, [0, 15, 30, 45]);
  let t = ist - 330 + off * 60;
  t = ((t % 1440) + 1440) % 1440;
  const hh = String(Math.floor(t / 60)).padStart(2, '0'); const mm = String(t % 60).padStart(2, '0');
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  add({
    id: `${kind}-clock2-${n}`, family: 'worldclock', kind, tags, category: 'maths', difficulty: off < 0 ? 2 : 1,
    title: 'World Clock',
    objective: 'A client call is booked from Siruseri. Scout has the time in India, Intel knows where the client sits, Decoder has the time offsets. What time is it for the client?',
    clues: {
      scout: { title: 'Call time in India (IST)', body: fmt(ist), big: true },
      intel: { title: 'Client office', body: `The client joins from ${city}.` },
      decoder: { title: 'Offsets from UTC (use exactly these)', body: `India (IST) = UTC +5:30\n${CITIES.map(([c, o]) => `${c} = UTC ${o >= 0 ? '+' : '−'}${Math.abs(o)}`).join('\n')}` },
    },
    parts: [{ label: 'Client\'s local time (24-hour, HH:MM)', accept: [`${hh}${mm}`, `${hh}:${mm}`] }],
    hint: 'Go from IST to UTC first (subtract 5 h 30 min), then add the client\'s offset. Wrap past midnight.',
    explanation: `${fmt(ist)} IST → ${city} ${hh}:${mm}`,
  });
}

// ───────────── Escape Route ─────────────
function route(n, kind, tags) {
  const r = rng(118000 + n * 37);
  for (;;) {
    const W = 6; const H = 5;
    const wall = Array.from({ length: W * H }, () => r() < 0.28);
    const s = int(r, 0, H - 1) * W; const e = int(r, 0, H - 1) * W + W - 1;
    wall[s] = false; wall[e] = false;
    const dist = new Array(W * H).fill(-1); dist[s] = 0; const qu = [s];
    while (qu.length) {
      const c = qu.shift();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = (c % W) + dx; const y = Math.floor(c / W) + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const nI = y * W + x;
        if (wall[nI] || dist[nI] >= 0) continue;
        dist[nI] = dist[c] + 1; qu.push(nI);
      }
    }
    if (dist[e] < W + 1) continue;
    const col = (i) => 'ABCDEF'[i % W]; const row = (i) => Math.floor(i / W) + 1;
    const grid = Array.from({ length: H }, (_, y) => `${y + 1} ${Array.from({ length: W }, (_, x) => (wall[y * W + x] ? '⬛' : '⬜')).join('')}`).join('\n');
    add({
      id: `${kind}-route-${n}`, family: 'route', kind, tags, category: 'logic', difficulty: dist[e] > 9 ? 2 : 1,
      title: 'Escape Route',
      objective: 'The floor is filling with smoke. Intel has the floor plan, Scout knows where you are and where the exit is, Decoder knows how you may move. How many steps is the shortest way out?',
      clues: {
        intel: { title: 'Floor plan (⬛ = blocked)', body: `   A B C D E F\n${grid}`, big: true },
        scout: { title: 'Where you are', body: `You are at ${col(s)}${row(s)}. The exit is at ${col(e)}${row(e)}.` },
        decoder: { title: 'How you may move', body: 'One step = one square up, down, left or right. No diagonal steps. You cannot step on a blocked square.' },
      },
      parts: [{ label: 'Fewest steps to the exit', accept: [String(dist[e])] }],
      hint: 'Intel: read the plan row by row. Count steps from the start, square by square, like a flood spreading.',
      explanation: `${col(s)}${row(s)} → ${col(e)}${row(e)} in ${dist[e]} steps`,
    });
    return;
  }
}

export function buildMissions4() {
  T.length = 0;
  for (let i = 0; i < 30; i++) bomb(i, 'mission', ANY('access', 'testing', 'office', 'phase2', 'glass', 'observation'));
  for (let i = 0; i < 6; i++) bomb(40 + i, 'battle', ['duel_pistol', 'duel_smg']);
  for (let i = 0; i < 4; i++) bomb(60 + i, 'recovery', ['any']);
  for (let i = 0; i < 6; i++) bomb(80 + i, 'airdrop', ['any']);
  for (let i = 0; i < 25; i++) signal(i, 'mission', ANY('transmission', 'terrace', 'observation', 'gate', 'public'));
  for (let i = 0; i < 20; i++) pattern(i, 'mission', ANY('office', 'helpdesk', 'learning', 'social'));
  for (let i = 0; i < 4; i++) pattern(40 + i, 'airdrop', ['any']);
  for (let i = 0; i < 25; i++) codebreaker(i, 'mission', ANY('boardroom', 'access', 'testing', 'learning'));
  for (let i = 0; i < 6; i++) codebreaker(40 + i, 'battle', ['duel_sniper']);
  for (let i = 0; i < 4; i++) codebreaker(60 + i, 'airdrop', ['any']);
  for (let i = 0; i < 20; i++) scales(i, 'mission', ANY('food', 'market', 'coffee', 'social'));
  for (let i = 0; i < 6; i++) scales(40 + i, 'recovery', ['any']);
  for (let i = 0; i < 20; i++) qwerty(i, 'mission', ANY('office', 'learning', 'helpdesk', 'stg'));
  for (let i = 0; i < 4; i++) qwerty(40 + i, 'battle', ['duel_smg']);
  for (let i = 0; i < 20; i++) worldClock(i, 'mission', ANY('boardroom', 'office', 'public', 'coffee'));
  for (let i = 0; i < 5; i++) worldClock(40 + i, 'recovery', ['any']);
  for (let i = 0; i < 15; i++) route(i, 'mission', ANY('office', 'phase2', 'access', 'testing'));
  for (let i = 0; i < 5; i++) route(40 + i, 'recovery', ['any']);
  return T;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = buildMissions4();
  console.log(all.length, 'templates', all.reduce((m, t) => ({ ...m, [`${t.kind}:${t.family}`]: (m[`${t.kind}:${t.family}`] || 0) + 1 }), {}));
  for (const fam of ['bomb', 'signal', 'pattern', 'codebreak', 'scales', 'qwerty', 'worldclock', 'route']) {
    const t = all.find((x) => x.family === fam);
    console.log(`\n[${fam}] ${t.id} → ${t.parts[0].accept[0]} · ${t.explanation}`);
    for (const [k, v] of Object.entries(t.clues)) console.log(`  ${k}: ${v.body.replace(/\n/g, ' | ')}`);
  }
}
export { norm };
