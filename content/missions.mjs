// Challenge content library.
// Every template splits indispensable facts across Scout, Decoder and Intel Officer.
// Puzzles are generated from reviewed families with a fixed seed, so every variant
// is reproducible and its answer is computed (not hand-typed) wherever possible.

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
const shuffle = (r, arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const shiftWord = (w, k) => [...w].map((c) => ABC[(ABC.indexOf(c) + k + 26) % 26]).join('');

const T = [];
function add(t) {
  const base = {
    category: 'logic', difficulty: 1, attempts: 3, time_limit: 180, coins: 25, points: null,
    relay: false, hint: '', status: 'published',
  };
  const tpl = { ...base, ...t };
  tpl.parts = tpl.parts.map((p) => ({ label: p.label, accept: [...new Set(p.accept.map(norm))] }));
  for (const role of ['scout', 'decoder', 'intel']) {
    if (!tpl.clues[role]) throw new Error(`${tpl.id} missing ${role} clue`);
  }
  if (T.find((x) => x.id === tpl.id)) throw new Error(`duplicate ${tpl.id}`);
  T.push(tpl);
}

const KIND_META = {
  mission: { time: 200, attempts: 3 },
  battle: { time: 90, attempts: 3 },
  recovery: { time: 120, attempts: 5 },
  airdrop: { time: 150, attempts: 3 },
  relay: { time: 240, attempts: 3 },
  finale_entry: { time: 180, attempts: 4 },
  finale_exchange: { time: 240, attempts: 4 },
  finale_battle: { time: 150, attempts: 3 },
  final_code: { time: 240, attempts: 4 },
};

// ───────────────────────── Family: Signal Intercept (Caesar) ─────────────────────────
const CAESAR_WORDS = ['FALCON', 'HORIZON', 'QUANTUM', 'BEACON', 'NEBULA', 'CIPHER', 'VERTEX', 'PHOENIX',
  'ORBITAL', 'LANTERN', 'COMPASS', 'SUMMIT', 'RADIANT', 'ECLIPSE', 'ANCHOR', 'GLACIER', 'MERIDIAN',
  'SENTINEL', 'TEMPEST', 'AURORA', 'ZENITH', 'CASCADE'];
function caesar(n, kind, tags, opts = {}) {
  const r = rng(1000 + n * 17 + kind.length * 7);
  const words = shuffle(r, CAESAR_WORDS);
  const word = opts.word || words[0];
  const k = 2 + Math.floor(r() * 8);
  const freqs = shuffle(r, ['88.4', '91.1', '94.3', '98.7', '101.3', '104.9', '107.2']).slice(0, opts.easy ? 2 : 3);
  const genuine = Math.floor(r() * freqs.length);
  const lines = freqs.map((f, i) => {
    const w = i === genuine ? word : words[i + 1];
    const kk = i === genuine ? k : ((k + 3 + i * 5) % 25) + 1;
    return `[ ${f} MHz ]  ${shiftWord(w, kk)}`;
  });
  add({
    id: `${kind}-caesar-${n}`, family: 'caesar', kind, tags, category: 'decoding',
    difficulty: opts.difficulty || 1,
    title: 'Signal Intercept',
    objective: 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.',
    clues: {
      scout: { title: 'Intercepted signals', body: lines.join('\n'), mono: true },
      decoder: { title: 'Cipher manual', body: 'Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z.' },
      intel: { title: 'Verified intel', body: `Genuine frequency: ${freqs[genuine]} MHz\nEncryption key: ${k}\nAll other frequencies are decoys.` },
    },
    parts: [{ label: 'Decoded word', accept: [word] }],
    hint: `The answer has ${word.length} letters and starts with ${word[0]}.`,
    explanation: `${freqs[genuine]} MHz carries ${shiftWord(word, k)}; shifting back by ${k} gives ${word}.`,
    time_limit: opts.time || KIND_META[kind].time,
    attempts: KIND_META[kind].attempts,
  });
}

// ───────────────────────── Family: Badge Reader (5-bit binary) ─────────────────────────
const BIN_WORDS = ['CODE', 'BYTE', 'DATA', 'LOGIC', 'CLOUD', 'PIXEL', 'TOKEN', 'CACHE', 'DEBUG', 'QUERY',
  'MERGE', 'STACK', 'LINUX', 'ROUTER', 'SERVER', 'KERNEL', 'SCRIPT', 'BINARY'];
const TAGS = 'BDFGHJKMNPRTVWXZ'.split('');
function binary(n, kind, tags, opts = {}) {
  const r = rng(2000 + n * 31 + kind.length);
  const word = opts.word || shuffle(r, BIN_WORDS)[0];
  const labels = shuffle(r, TAGS).slice(0, word.length);
  const rows = [...word].map((c, i) => ({ tag: labels[i], bits: (ABC.indexOf(c) + 1).toString(2).padStart(5, '0') }));
  const display = shuffle(r, rows).map((x) => `Tag ${x.tag}:  ${x.bits.split('').map((b) => (b === '1' ? '●' : '○')).join(' ')}`);
  add({
    id: `${kind}-binary-${n}`, family: 'binary', kind, tags, category: 'tech',
    difficulty: opts.difficulty || 1,
    title: 'Badge Reader',
    objective: 'A stolen access badge flashed its lights. Rebuild the word it encodes.',
    clues: {
      scout: { title: 'Badge light capture', body: display.join('\n'), mono: true },
      decoder: { title: 'Reader protocol', body: '● = 1 and ○ = 0. Each row is a 5-bit binary number.\nBit values from left to right: 16 8 4 2 1.\nThe number is the letter\'s position in the alphabet (1 = A, 2 = B … 26 = Z).' },
      intel: { title: 'Read order', body: `Read the tags in this order:\n${labels.join(' → ')}` },
    },
    parts: [{ label: 'Badge word', accept: [word] }],
    hint: `It is a ${word.length}-letter tech word.`,
    explanation: `${rows.map((x) => `${x.tag}=${parseInt(x.bits, 2)}=${ABC[parseInt(x.bits, 2) - 1]}`).join(', ')} → ${word}.`,
    time_limit: opts.time || KIND_META[kind].time,
    attempts: KIND_META[kind].attempts,
  });
}

// ───────────────────────── Family: Coordinate Drop (grid) ─────────────────────────
const GRID_WORDS = ['RADAR', 'DRONE', 'ORBIT', 'GLIDE', 'SPARK', 'TOWER', 'FLARE', 'STORM', 'CRATE',
  'SUPPLY', 'SIGNAL', 'TARGET', 'POCKET', 'MARKER'];
function grid(n, kind, tags, opts = {}) {
  const r = rng(3000 + n * 13 + kind.length * 3);
  const word = opts.word || shuffle(r, GRID_WORDS)[0];
  const size = word.length > 6 ? 6 : 5;
  for (let tries = 0; tries < 200; tries++) {
    const g = Array.from({ length: size }, () => Array.from({ length: size }, () => ABC[Math.floor(r() * 26)]));
    const coords = [];
    const used = new Set();
    let ok = true;
    for (const c of word) {
      let placed = false;
      for (let a = 0; a < 50 && !placed; a++) {
        const col = 1 + Math.floor(r() * size);
        const row = 1 + Math.floor(r() * size);
        if (used.has(`${col},${row}`) || used.has(`${row},${col}`) || col === row) continue;
        used.add(`${col},${row}`);
        g[row - 1][col - 1] = c;
        coords.push([col, row]);
        placed = true;
      }
      if (!placed) ok = false;
    }
    if (!ok) continue;
    const swapped = coords.map(([col, row]) => g[col - 1][row - 1]).join('');
    if (swapped === word) continue;
    const header = '    ' + Array.from({ length: size }, (_, i) => i + 1).join(' ');
    const body = [header, ...g.map((row, i) => `${i + 1} | ${row.join(' ')}`)].join('\n');
    add({
      id: `${kind}-grid-${n}`, family: 'grid', kind, tags, category: 'observation',
      difficulty: opts.difficulty || 2,
      title: opts.title || 'Coordinate Drop',
      objective: opts.objective || 'A supply crate is marked on a letter grid. Read the drop code from the marked squares.',
      clues: {
        scout: { title: 'Aerial grid photo', body, mono: true },
        decoder: { title: 'Marked coordinates', body: coords.map(([a, b]) => `(${a}, ${b})`).join('  ') },
        intel: { title: 'Grid convention', body: 'Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed.' },
      },
      parts: [{ label: 'Drop code', accept: [word] }],
      hint: `The code is a ${word.length}-letter word ending in ${word.at(-1)}.`,
      explanation: `Reading (column,row) gives ${word}; reading it as (row,column) gives nonsense (${swapped}).`,
      time_limit: opts.time || KIND_META[kind].time,
      attempts: KIND_META[kind].attempts,
      points: opts.points ?? null,
    });
    return;
  }
  throw new Error('grid failed ' + n);
}

// ───────────────────────── Family: Order Slips (coffee / food) ─────────────────────────
const MENUS = {
  coffee: { name: 'Costa counter price card', items: { Latte: 12, Mocha: 14, Cappuccino: 11, Espresso: 8, Muffin: 9, Cookie: 5, Croissant: 10, 'Cold Brew': 13 } },
  food: { name: 'Canteen price board', items: { Biryani: 18, Dosa: 10, Idli: 6, Meals: 15, 'Paneer Roll': 12, Juice: 7, 'Curd Rice': 9, Vada: 5 } },
};
function orders(n, kind, tags, menuKey, opts = {}) {
  const r = rng(4000 + n * 19 + menuKey.length * 11 + kind.length);
  const menu = MENUS[menuKey];
  const names = Object.keys(menu.items);
  const tableNums = shuffle(r, [2, 3, 4, 5, 6, 7, 8, 9, 11, 12]).slice(0, 4).sort((a, b) => a - b);
  const tables = tableNums.map((t) => {
    const lines = shuffle(r, names).slice(0, 2 + Math.floor(r() * 2)).map((item) => ({ item, qty: 1 + Math.floor(r() * 3) }));
    return { t, lines };
  });
  const target = pick(r, tables);
  const ruleType = Math.floor(r() * 3);
  let rule; let total = target.lines.reduce((s, l) => s + l.qty * menu.items[l.item], 0);
  if (ruleType === 0) {
    const freeItem = pick(r, target.lines).item;
    rule = `House rule today: every ${freeItem} is free.`;
    total -= target.lines.filter((l) => l.item === freeItem).reduce((s, l) => s + l.qty * menu.items[l.item], 0);
  } else if (ruleType === 1) {
    rule = 'House rule today: add 5 coins for takeaway packing (once per order).';
    total += 5;
  } else {
    const dbl = pick(r, target.lines);
    rule = `Correction: the ${dbl.item} quantity on that slip was written as half. Double it.`;
    total += dbl.qty * menu.items[dbl.item];
  }
  const slipText = shuffle(r, tables).map((tb) => `Table ${tb.t}: ${tb.lines.map((l) => `${l.qty}× ${l.item}`).join(', ')}`).join('\n');
  add({
    id: `${kind}-orders-${menuKey}-${n}`, family: 'orders', kind, tags, category: 'memory',
    difficulty: 1,
    title: menuKey === 'coffee' ? 'Barista Rush' : 'Mess Hall Ledger',
    objective: 'Squad 00 swapped the bills. Calculate the correct total for the order your intel points to and enter the number.',
    clues: {
      scout: { title: 'Order slips on the counter', body: slipText, mono: true },
      decoder: { title: menu.name, body: Object.entries(menu.items).map(([k, v]) => `${k} — ${v}`).join('\n'), mono: true },
      intel: { title: 'Billing intel', body: `Bill Table ${target.t}.\n${rule}` },
    },
    parts: [{ label: 'Total', accept: [String(total)] }],
    hint: 'Multiply each quantity by its price, add them, then apply the house rule.',
    explanation: `Table ${target.t} with the rule applied totals ${total}.`,
    time_limit: opts.time || KIND_META[kind].time,
    attempts: KIND_META[kind].attempts,
  });
}

// ───────────────────────── Family: Tech Triad (one fact per role) ─────────────────────────
const TECH_BANK = [
  ['How many bits are in one byte?', 8], ['Binary 101 equals which decimal number?', 5],
  ['Hexadecimal F equals which decimal number?', 15], ['HTTP status code for "Not Found"?', 404],
  ['How many layers does the OSI model have?', 7], ['Binary 1111 equals which decimal number?', 15],
  ['Hexadecimal 10 equals which decimal number?', 16], ['Which port does HTTPS use by default?', 443],
  ['HTTP status code for "OK"?', 200], ['How many bits are in an IPv4 address?', 32],
  ['Hexadecimal FF equals which decimal number?', 255], ['Binary 1000 equals which decimal number?', 8],
  ['In most programming languages, the index of the first array element is?', 0],
  ['How many bytes are in one kibibyte (KiB)?', 1024], ['Function key that refreshes most browser pages: F?', 5],
  ['HTTP status code for "Internal Server Error"?', 500], ['Ctrl + which letter usually means Undo? Give its position in the alphabet (A=1).', 26],
  ['Binary 1010 equals which decimal number?', 10], ['How many hexadecimal digits exist (0 to F)?', 16],
  ['Which port does plain HTTP use by default?', 80], ['How many bits are in an IPv6 address?', 128],
  ['Hexadecimal 1A equals which decimal number?', 26], ['Binary 11 equals which decimal number?', 3],
  ['HTTP status code for "Forbidden"?', 403], ['How many characters does a standard SHA-256 hex digest have?', 64],
];
function triad(n, kind, tags, opts = {}) {
  const r = rng(5000 + n * 23 + kind.length * 5);
  const qs = shuffle(r, TECH_BANK).slice(0, 3);
  const roles = ['scout', 'decoder', 'intel'];
  const clues = {};
  roles.forEach((role, i) => { clues[role] = { title: `Code fragment ${i + 1} of 3`, body: `${qs[i][0]}\n\nTell your captain the number. It is part ${i + 1} of the code.` }; });
  const parts = qs.map((q, i) => ({ label: `Part ${i + 1} (${['Scout', 'Decoder', 'Intel'][i]})`, accept: [String(q[1])] }));
  let objective = 'Each teammate holds one tech question. Collect all three numbers and enter them in order.';
  if (opts.relay) {
    parts.unshift({ label: 'Partner codeword', accept: ['{KEY}'] });
    objective = 'Another squad\'s captain holds your access codeword. Get it through captain comms, then add the three-part tech code from your own squad. If no one helps, your Intel Officer receives a backup copy later (half reward).';
  }
  add({
    id: `${kind}-triad-${n}`, family: opts.relay ? 'relay' : 'triad', kind, tags, category: 'tech',
    difficulty: 1, relay: !!opts.relay,
    title: opts.relay ? 'Intelligence Exchange' : 'Tech Triad',
    objective,
    clues,
    parts,
    hint: `The three numbers have ${qs.map((q) => String(q[1]).length).join(', ')} digits.`,
    explanation: qs.map((q) => `${q[0]} → ${q[1]}`).join(' | '),
    time_limit: opts.time || KIND_META[kind].time,
    attempts: KIND_META[kind].attempts,
    points: opts.points ?? null,
  });
}

// ───────────────────────── Family: Triple Rebus ─────────────────────────
const REBUS = [
  ['FA\n   TH\n      ER', ['STEPFATHER', 'STEP FATHER'], 'The letters go down like steps.'],
  ['  MIND\n ──────\n MATTER', ['MIND OVER MATTER'], 'MIND sits over MATTER.'],
  ['  STAND\n ───────\n    I', ['I UNDERSTAND', 'I UNDER STAND'], 'I is under STAND.'],
  ['  HEAD\n ──────\n HEELS', ['HEAD OVER HEELS'], 'HEAD sits over HEELS.'],
  ['   MAN\n ───────\n  BOARD', ['MAN OVERBOARD', 'MAN OVER BOARD'], 'MAN is over BOARD.'],
  ['T\nO\nU\nC\nH', ['TOUCHDOWN', 'TOUCH DOWN'], 'TOUCH is written going down.'],
  ['BAN     ANA', ['BANANA SPLIT', 'SPLIT BANANA'], 'The word BANANA is split.'],
  ['  STOOD\n ───────\n   MIS', ['MISUNDERSTOOD'], 'MIS is under STOOD.'],
  ['CYCLE  CYCLE  CYCLE', ['TRICYCLE', 'THREE CYCLES'], 'Three cycles.'],
  ['DICE    DICE', ['PARADISE', 'PAIR OF DICE'], 'A pair of dice sounds like paradise.'],
  ['LE     VEL', ['SPLIT LEVEL', 'SPLITLEVEL'], 'LEVEL is split.'],
  ['  WORK\n ──────\n  TIME', ['WORK OVERTIME', 'OVERTIME WORK'], 'WORK is over TIME.'],
  ['E C N A L G', ['BACKWARD GLANCE', 'BACKWARDS GLANCE'], 'GLANCE written backward.'],
  ['D\nU\nC\nK', ['DUCK DOWN', 'DUCKDOWN'], 'DUCK is written going down.'],
  ['HISTORY  HISTORY', ['HISTORY REPEATS ITSELF', 'HISTORY REPEATS', 'REPEATED HISTORY'], 'HISTORY repeats.'],
  ['  EGGS\n ──────\n  EASY', ['EGGS OVER EASY'], 'EGGS over EASY.'],
];
function rebusTriple(n, kind, tags) {
  const set = REBUS.slice(n * 3, n * 3 + 3);
  if (set.length < 3) return;
  const roles = ['scout', 'decoder', 'intel'];
  const clues = {};
  roles.forEach((role, i) => { clues[role] = { title: `Rebus panel ${i + 1}`, body: set[i][0], mono: true }; });
  add({
    id: `${kind}-rebus-${n}`, family: 'rebus', kind, tags, category: 'rebus', difficulty: 1,
    title: 'Triple Rebus',
    objective: 'Each teammate holds one picture-word puzzle. Solve all three and enter each answer in its box.',
    clues,
    parts: set.map((s, i) => ({ label: `Panel ${i + 1} (${['Scout', 'Decoder', 'Intel'][i]})`, accept: s[1] })),
    hint: 'Look at the position of each word: over, under, split, repeated, reversed, going down.',
    explanation: set.map((s) => `${s[1][0]}: ${s[2]}`).join(' | '),
    time_limit: KIND_META[kind].time,
    attempts: KIND_META[kind].attempts,
  });
}

// ───────────────────────── Family: Corporate Scramble (anagrams) ─────────────────────────
const CORP = ['MEETING', 'DEADLINE', 'SYNERGY', 'BANDWIDTH', 'LEVERAGE', 'ROADMAP', 'STANDUP', 'ESCALATE',
  'HUDDLE', 'OFFSITE', 'BRAINSTORM', 'TIMESHEET', 'APPRAISAL', 'INVOICE', 'WORKFLOW'];
function anagram(n, kind, tags) {
  const r = rng(6000 + n * 29);
  const words = shuffle(r, CORP).slice(0, 3);
  const scr = (w) => { let s = w; let guard = 0; while (s === w && guard++ < 20) s = shuffle(r, [...w]).join(''); return s; };
  const roles = ['scout', 'decoder', 'intel'];
  const clues = {};
  roles.forEach((role, i) => { clues[role] = { title: `Shredded memo strip ${i + 1}`, body: `${scr(words[i]).split('').join(' ')}\n\n(One office buzzword, letters scrambled.)`, mono: true }; });
  add({
    id: `${kind}-anagram-${n}`, family: 'anagram', kind, tags, category: 'office', difficulty: 1,
    title: 'Corporate Scramble',
    objective: 'Squad 00 shredded a meeting memo into three strips. Unscramble each strip and enter the buzzwords.',
    clues,
    parts: words.map((w, i) => ({ label: `Strip ${i + 1} (${['Scout', 'Decoder', 'Intel'][i]})`, accept: [w] })),
    hint: `First letters: ${words.map((w) => w[0]).join(', ')}.`,
    explanation: words.join(', '),
    time_limit: KIND_META[kind].time,
    attempts: KIND_META[kind].attempts,
  });
}

// ───────────────────────── Family: Keypad (access code) ─────────────────────────
function keypad(n, kind, tags, opts = {}) {
  const r = rng(7000 + n * 37 + kind.length * 13);
  const len = opts.len || 4;
  const digits = shuffle(r, [1, 2, 3, 4, 5, 6, 7, 8, 9]).slice(0, len);
  const orderRules = [
    ['The code was typed from SMALLEST to LARGEST digit.', (d) => [...d].sort((a, b) => a - b)],
    ['The code was typed from LARGEST to SMALLEST digit.', (d) => [...d].sort((a, b) => b - a)],
    ['ODD digits come first (smallest to largest), then EVEN digits (largest to smallest).', (d) => [...d.filter((x) => x % 2).sort((a, b) => a - b), ...d.filter((x) => !(x % 2)).sort((a, b) => b - a)]],
  ];
  const tampers = [
    ['The wiring is faulty: swap the 1st and last digits before entering.', (c) => { const a = [...c]; [a[0], a[a.length - 1]] = [a[a.length - 1], a[0]]; return a; }],
    ['The wiring is faulty: the 2nd and 3rd digits are swapped.', (c) => { const a = [...c]; [a[1], a[2]] = [a[2], a[1]]; return a; }],
    ['The panel adds 1 to the LAST digit (9 becomes 0).', (c) => { const a = [...c]; a[a.length - 1] = (a[a.length - 1] + 1) % 10; return a; }],
    ['Enter the code in REVERSE order.', (c) => [...c].reverse()],
  ];
  const o = pick(r, orderRules);
  const t = pick(r, tampers);
  const code = t[1](o[1](digits)).join('');
  add({
    id: `${kind}-keypad-${n}`, family: 'keypad', kind, tags, category: 'decoding',
    difficulty: 1,
    title: 'Worn Keypad',
    objective: 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.',
    clues: {
      scout: { title: 'Keypad photo', body: `Worn (most-pressed) keys: ${shuffle(r, digits).join(', ')}\nEach worn key is used exactly once.` },
      decoder: { title: 'Guard\'s habit', body: o[0] },
      intel: { title: 'Maintenance report', body: t[0] },
    },
    parts: [{ label: 'Access code', accept: [code] }],
    hint: `The code has ${len} digits.`,
    explanation: `Ordered digits ${o[1](digits).join('')}, after the wiring fault ${code}.`,
    time_limit: opts.time || KIND_META[kind].time,
    attempts: KIND_META[kind].attempts,
  });
}

// ───────────────────────── Family: Scoreboard (cricket) ─────────────────────────
function cricket(n, kind, tags) {
  const r = rng(8000 + n * 41);
  const symbols = ['•', '1', '2', '4', '6', 'W', 'Wd', '1', '•', '2'];
  const value = (s) => (s === '•' ? 0 : s === 'W' ? -5 : s === 'Wd' ? 1 : Number(s));
  const overs = Array.from({ length: 4 }, () => Array.from({ length: 6 }, () => pick(r, symbols)));
  const choose = shuffle(r, [1, 2, 3, 4]).slice(0, 2).sort();
  const total = choose.reduce((s, o) => s + overs[o - 1].reduce((a, b) => a + value(b), 0), 0);
  add({
    id: `${kind}-cricket-${n}`, family: 'cricket', kind, tags, category: 'sports', difficulty: 1,
    title: 'Scoreboard Decode',
    objective: 'The sports-zone scoreboard hides a code. Calculate it and enter the number.',
    clues: {
      scout: { title: 'Ball-by-ball board', body: overs.map((o, i) => `Over ${i + 1}:  ${o.join('  ')}`).join('\n'), mono: true },
      decoder: { title: 'League scoring legend', body: '• = dot ball (0)\nNumber = runs scored\nW = wicket: this league DEDUCTS 5 runs\nWd = wide: 1 run' },
      intel: { title: 'Code rule', body: `The code is the total of overs ${choose[0]} and ${choose[1]} only.` },
    },
    parts: [{ label: 'Code', accept: [String(total)] }],
    hint: 'Remember: a wicket subtracts 5 in this league.',
    explanation: `Overs ${choose.join(' and ')} total ${total}.`,
    time_limit: KIND_META[kind].time,
    attempts: KIND_META[kind].attempts,
  });
}

// ───────────────────────── Family: Pattern Lock (sequences) ─────────────────────────
function sequence(n, kind, tags, opts = {}) {
  const r = rng(9000 + n * 43 + kind.length * 7);
  const gens = [
    () => { const a = 2 + Math.floor(r() * 6); const d = 3 + Math.floor(r() * 6); return Array.from({ length: 6 }, (_, i) => a + i * d); },
    () => { const a = 2 + Math.floor(r() * 3); return Array.from({ length: 6 }, (_, i) => a * 2 ** i); },
    () => { const a = 1 + Math.floor(r() * 3); return Array.from({ length: 6 }, (_, i) => (i + a) ** 2); },
    () => { let x = 1 + Math.floor(r() * 3); let y = x + 1 + Math.floor(r() * 2); const out = [x, y]; while (out.length < 6) { const z = x + y; out.push(z); x = y; y = z; } return out; },
    () => { let x = 1 + Math.floor(r() * 4); const out = [x]; while (out.length < 6) { x = x * 2 + 1; out.push(x); } return out; },
  ];
  const seqs = shuffle(r, gens).slice(0, 3).map((g) => g());
  const labels = ['ALPHA', 'BRAVO', 'CHARLIE'];
  const real = Math.floor(r() * 3);
  const next = seqs[real][5];
  const transforms = [
    ['Submit the missing number plus 10.', (x) => x + 10],
    ['Submit the missing number multiplied by 2.', (x) => x * 2],
    ['Submit the missing number minus 1.', (x) => x - 1],
  ];
  const tr = pick(r, transforms);
  const answer = tr[1](next);
  add({
    id: `${kind}-sequence-${n}`, family: 'sequence', kind, tags, category: 'logic',
    difficulty: opts.difficulty || 1,
    title: 'Pattern Lock',
    objective: 'Only one of the patterns on the lock is real. Find its missing number and convert it into the unlock code.',
    clues: {
      scout: { title: 'Lock display', body: seqs.map((s, i) => `${labels[i]}:  ${s.slice(0, 5).join(', ')}, ?`).join('\n'), mono: true },
      decoder: { title: 'Unlock conversion', body: tr[0] },
      intel: { title: 'Insider tip', body: `The genuine pattern is ${labels[real]}. The other two are decoys.` },
    },
    parts: [{ label: 'Unlock code', accept: [String(answer)] }],
    hint: 'Look at the difference (or ratio) between neighbouring numbers.',
    explanation: `${labels[real]} continues with ${next}; converted: ${answer}.`,
    time_limit: opts.time || KIND_META[kind].time,
    attempts: KIND_META[kind].attempts,
    points: opts.points ?? null,
  });
}

// ───────────────────────── Family: Flash Memory ─────────────────────────
const ICONS = ['☕', '🍩', '📎', '🖥️', '🔑', '📦', '🎧', '📱', '🧾', '🔋'];
function memory(n, kind, tags) {
  const r = rng(10000 + n * 47);
  const seq = shuffle(r, ICONS).slice(0, 7);
  const letters = shuffle(r, ABC.split('')).slice(0, ICONS.length);
  const keyMap = Object.fromEntries(ICONS.map((ic, i) => [ic, letters[i]]));
  const positions = shuffle(r, [1, 2, 3, 4, 5, 6, 7]).slice(0, 3).sort((a, b) => a - b);
  const answer = positions.map((p) => keyMap[seq[p - 1]]).join('');
  add({
    id: `${kind}-memory-${n}`, family: 'memory', kind, tags, category: 'memory', difficulty: 2,
    title: 'Flash Memory',
    objective: 'A security camera flashed a sequence of objects for a few seconds. Rebuild the code from it.',
    clues: {
      scout: { title: 'Camera flash (disappears after 20 s!)', body: seq.join('   '), reveal_seconds: 20 },
      decoder: { title: 'Object → letter key', body: ICONS.map((ic) => `${ic} = ${keyMap[ic]}`).join('    ') },
      intel: { title: 'Positions that matter', body: `Use only objects number ${positions.join(', ')} (counting from the left).` },
    },
    parts: [{ label: 'Letter code', accept: [answer] }],
    hint: 'Scout: say the objects out loud while they are visible.',
    explanation: `Positions ${positions.join(', ')} were ${positions.map((p) => seq[p - 1]).join(' ')} → ${answer}.`,
    time_limit: KIND_META[kind].time,
    attempts: KIND_META[kind].attempts,
  });
}

// ───────────────────────── Handcrafted: STG, Boardroom, HR ─────────────────────────
function handcrafted() {
  const bugs = [
    ['1  total = 0\n2  for i in range(1, 5):\n3      total = total + i\n4  print(total)',
      'Test log: the program printed 10.\nLanguage rule: range(a, b) stops BEFORE b.',
      'Spec: add the numbers 1 to 5 and print 15.', '2', '6', 'Line 2 should be range(1, 6).'],
    ['1  price = 200\n2  discount = 10\n3  final = price - price * discount\n4  print(final)',
      'Test log: the program printed -1800.\nRule: a percentage must be divided by 100 before multiplying.',
      'Spec: apply a 10% discount to 200. Report the bug line and the correct printed value.', '3', '180', 'Line 3 must use discount / 100, giving 180.'],
    ['1  names = ["Asha", "Ben", "Chen"]\n2  last = names[3]\n3  print(last)',
      'Test log: crashed with "index out of range".\nRule: list positions start at 0.',
      'Spec: print the LAST name. Report the bug line and the index that should be used.', '2', '2', 'Index 3 does not exist; the last item is at index 2.'],
  ];
  bugs.forEach(([code, dec, intel, line, fix, exp], i) => add({
    id: `mission-bughunt-${i}`, family: 'bughunt', kind: 'mission', tags: ['stg', 'testing', 'office'], category: 'tech', difficulty: 1,
    title: 'Bug Hunt',
    objective: 'A test failed in the STG lab. Find the buggy line and the value that fixes it.',
    clues: {
      scout: { title: 'Source code', body: code, mono: true },
      decoder: { title: 'Test log', body: dec },
      intel: { title: 'Requirement', body: intel },
    },
    parts: [{ label: 'Bug line number', accept: [line] }, { label: 'Correct value', accept: [fix] }],
    hint: 'Compare what the code does with what the requirement says.',
    explanation: exp, time_limit: 200, attempts: 3,
  }));

  const seating = {
    scout: { title: 'Boardroom seating chart', body: 'Round table, seats 1–6 clockwise.\nSeats directly opposite: 1–4, 2–5, 3–6.\nSeat 3: LEGAL\nSeat 5: OPS\nSeats 1, 2, 4, 6: unknown', mono: true },
    decoder: { title: 'Seating rules', body: 'Remaining guests: CTO, CFO, HR, SALES.\n• CTO sits directly opposite LEGAL.\n• HR sits directly next to OPS.\n• SALES is not in seat 1.' },
  };
  add({
    id: 'mission-boardroom-0', family: 'boardroom', kind: 'mission', tags: ['boardroom'], category: 'logic', difficulty: 2,
    title: 'Boardroom Mole', objective: 'Squad 00 planted a mole in the boardroom. Work out the seating and name the mole.',
    clues: { ...seating, intel: { title: 'Mole intel', body: 'The mole sits directly opposite the CFO. Submit the mole\'s role.' } },
    parts: [{ label: 'Mole\'s role', accept: ['HR', 'HUMAN RESOURCES'] }],
    hint: 'Place the CTO first, then HR.', explanation: 'CTO 6, HR 4, Sales 2, CFO 1 → opposite seat 1 is seat 4: HR.', time_limit: 220, attempts: 3,
  });
  add({
    id: 'mission-boardroom-1', family: 'boardroom', kind: 'mission', tags: ['boardroom'], category: 'logic', difficulty: 2,
    title: 'Boardroom Mole', objective: 'Squad 00 planted a mole in the boardroom. Work out the seating and name the mole.',
    clues: { ...seating, intel: { title: 'Mole intel', body: 'The mole sits directly opposite SALES. Submit the mole\'s role.' } },
    parts: [{ label: 'Mole\'s role', accept: ['OPS', 'OPERATIONS'] }],
    hint: 'Place the CTO first, then HR.', explanation: 'CTO 6, HR 4, Sales 2, CFO 1 → opposite seat 2 is seat 5: OPS.', time_limit: 220, attempts: 3,
  });
  add({
    id: 'mission-hr-0', family: 'scheduler', kind: 'mission', tags: ['hr', 'office'], category: 'logic', difficulty: 1,
    title: 'Room Booking Crisis', objective: 'HR needs a 1-hour room for an urgent team huddle. Find the right booking.',
    clues: {
      scout: { title: 'Room availability', body: '         9:00   10:00   11:00\nRoom A   free   busy    free\nRoom B   free   busy    free\nRoom C   free   free    busy\nRoom D   busy   free    free', mono: true },
      decoder: { title: 'Attendee constraints', body: '• The huddle needs a screen: only Rooms B and D have one.\n• The designer cannot attend at 9:00.' },
      intel: { title: 'Booking policy', body: 'Book the EARLIEST slot that works.\nSubmit as room letter + hour, e.g. A9.' },
    },
    parts: [{ label: 'Booking', accept: ['D10'] }],
    hint: 'Rule out 9:00 first.', explanation: 'Only B/D have screens, 9:00 is out, B is busy at 10 → D10.', time_limit: 180, attempts: 3,
  });
  add({
    id: 'mission-hr-1', family: 'scheduler', kind: 'mission', tags: ['hr', 'office'], category: 'logic', difficulty: 1,
    title: 'Room Booking Crisis', objective: 'HR needs a 1-hour room for an urgent team huddle. Find the right booking.',
    clues: {
      scout: { title: 'Room availability', body: '         9:00   10:00   11:00\nRoom A   free   free    busy\nRoom B   free   busy    free\nRoom C   busy   free    free\nRoom D   busy   busy    free', mono: true },
      decoder: { title: 'Attendee constraints', body: '• The huddle needs a screen: only Rooms B and D have one.\n• The designer cannot attend at 9:00.' },
      intel: { title: 'Booking policy', body: 'Book the EARLIEST slot that works. If two rooms tie, pick Room B (closest to HR).\nSubmit as room letter + hour, e.g. A9.' },
    },
    parts: [{ label: 'Booking', accept: ['B11'] }],
    hint: 'Check 10:00 for B and D first.', explanation: 'At 10 both B and D are busy; at 11 both are free → tie → B11.', time_limit: 180, attempts: 3,
  });
}

// ───────────────────────── Build the library ─────────────────────────
export function buildMissions() {
  T.length = 0;
  // Normal missions
  for (let i = 0; i < 10; i++) caesar(i, 'mission', i % 2 ? ['gate', 'access', 'transmission'] : ['transmission', 'boardroom', 'any']);
  for (let i = 0; i < 8; i++) binary(i, 'mission', ['hexavarsity', 'learning', 'phase2', 'stg', 'helpdesk']);
  for (let i = 0; i < 6; i++) grid(i, 'mission', ['terrace', 'glass', 'observation', 'public']);
  for (let i = 0; i < 5; i++) orders(i, 'mission', ['costa', 'coffee', 'social'], 'coffee');
  for (let i = 0; i < 5; i++) orders(i, 'mission', ['food', 'healing', 'market'], 'food');
  for (let i = 0; i < 8; i++) triad(i, 'mission', ['any', 'stg', 'testing', 'helpdesk', 'learning', 'office']);
  for (let i = 0; i < 5; i++) rebusTriple(i, 'mission', ['any', 'learning', 'social', 'office', 'coffee']);
  for (let i = 0; i < 5; i++) anagram(i, 'mission', ['office', 'hr', 'boardroom', 'parking', 'social']);
  for (let i = 0; i < 6; i++) keypad(i, 'mission', ['gate', 'access', 'parking']);
  for (let i = 0; i < 5; i++) cricket(i, 'mission', ['sports']);
  for (let i = 0; i < 5; i++) sequence(i, 'mission', ['learning', 'office', 'glass', 'phase2', 'any']);
  for (let i = 0; i < 4; i++) memory(i, 'mission', ['food', 'healing', 'costa', 'learning']);
  for (let i = 0; i < 6; i++) triad(100 + i, 'relay', ['social', 'coffee', 'public', 'market'], { relay: true });
  handcrafted();
  // Battles (weapon-specific)
  for (let i = 0; i < 6; i++) triad(200 + i, 'battle', ['duel_pistol'], { time: 90 });
  for (let i = 0; i < 4; i++) keypad(200 + i, 'battle', ['duel_pistol'], { time: 90 });
  for (let i = 0; i < 6; i++) keypad(300 + i, 'battle', ['duel_smg'], { time: 50, len: 3 });
  for (let i = 0; i < 4; i++) caesar(400 + i, 'battle', ['duel_sniper'], { difficulty: 2, time: 120 });
  for (let i = 0; i < 4; i++) grid(400 + i, 'battle', ['duel_sniper'], { time: 120 });
  // Recovery (easier)
  for (let i = 0; i < 5; i++) keypad(500 + i, 'recovery', ['any'], { len: 3 });
  for (let i = 0; i < 4; i++) caesar(500 + i, 'recovery', ['any'], { easy: true });
  // Airdrops
  for (let i = 0; i < 8; i++) grid(600 + i, 'airdrop', ['any'], { title: 'Airdrop Lock', objective: 'The airdrop crate is locked with a grid code. First squad to crack it takes the loot.' });
  // Finale
  for (let i = 0; i < 3; i++) caesar(700 + i, 'finale_entry', ['finale'], { difficulty: 2 });
  for (let i = 0; i < 3; i++) triad(800 + i, 'finale_exchange', ['finale'], { relay: true });
  for (let i = 0; i < 3; i++) orders(900 + i, 'finale_battle', ['finale'], i % 2 ? 'food' : 'coffee');
  for (let i = 0; i < 3; i++) sequence(900 + i, 'finale_battle', ['finale'], { difficulty: 2 });
  for (let i = 0; i < 3; i++) binary(900 + i, 'finale_battle', ['finale'], { difficulty: 2 });
  ['SIRUSERI', 'ZEROHOUR', 'CHAMPION', 'HEXAWARE'].forEach((w, i) => grid(1000 + i, 'final_code', ['finale'], {
    word: w, title: 'The Final Code', objective: 'Squad 00\'s master vault. Read the final code from the grid. This is worth the most points of the night.',
  }));
  return T;
}

export { norm };
