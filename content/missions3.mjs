// Challenge pack 3 — Bottle Shoot (gun range mini-game), Memory Cards (card-flip mini-game),
// Poker Hands, Blackjack, Card Sharp, Safe Cracker, Morse, Word Scramble, Quick Maths,
// Number Sequences, Flags, Odd One Out and Clock puzzles.
// Same rule as packs 1–2: no single phone can solve a challenge; every role holds a piece.
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
const shuffle = (r, arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

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
const ROLE_NAMES = ['Scout', 'Decoder', 'Intel'];
const shape = (ans) => {
  const w = String(ans).trim().split(/\s+/);
  return w.length === 1 ? `${w[0].replace(/[^A-Z0-9]/gi, '').length} letters` : `${w.length} words: ${w.map((x) => x.replace(/[^A-Z0-9]/gi, '').length).join(' + ')}`;
};
// three independent panels, one per phone; the captain types all three answers
function triple({ id, kind, family, tags, category, title, objective, items, panel, hint, mono = false, big = false, starts = true, extra }) {
  const clues = {};
  ['scout', 'decoder', 'intel'].forEach((role, i) => {
    const it = items[i];
    const tail = starts ? `\n\n(${shape(it.a[0])} · starts with ${String(it.a[0])[0]})` : '';
    clues[role] = { title: `${panel} ${i + 1}`, body: `${it.q}${tail}`, mono, big: big && !mono, ...(extra ? extra(it, i) : {}) };
  });
  add({
    id, family, kind, tags, category, title, objective, clues,
    hint: starts ? `${hint} Answers start with: ${items.map((it) => String(it.a[0]).slice(0, 2) + '…').join(', ')}` : hint,
    parts: items.map((it, i) => ({ label: `${panel} ${i + 1} (${ROLE_NAMES[i]})`, accept: it.a })),
    explanation: items.map((it) => `${it.a[0]}: ${it.why}`).join(' | '),
  });
}
function packs(list, n, per, fn) {
  for (let i = 0; i < n; i++) fn(i, list.slice(i * per, i * per + per));
}

const TRANSFORMS = [
  { text: 'Add 1 to every digit (9 becomes 0).', f: (ds) => ds.map((x) => (x + 1) % 10), why: '+1 to each digit' },
  { text: 'Read the digits in REVERSE order.', f: (ds) => [...ds].reverse(), why: 'reversed' },
  { text: 'Subtract each digit from 9.', f: (ds) => ds.map((x) => 9 - x), why: '9 minus each digit' },
  { text: 'Keep the digits exactly as they are — no change.', f: (ds) => ds, why: 'unchanged' },
  { text: 'Swap the first two digits and the last two digits.', f: (ds) => [ds[1], ds[0], ds[3], ds[2]], why: 'pairs swapped' },
  { text: 'Add 2 to every digit and keep only the last digit (9 → 1).', f: (ds) => ds.map((x) => (x + 2) % 10), why: '+2 to each digit' },
];

// ───────────── Bottle Shoot: Scout shoots bottles, Intel knows the colour order, Decoder the rule ─────────────
const BOTTLES = [
  { c: 'red', n: 'Red' }, { c: 'blue', n: 'Blue' }, { c: 'green', n: 'Green' },
  { c: 'yellow', n: 'Yellow' }, { c: 'purple', n: 'Purple' }, { c: 'orange', n: 'Orange' },
];
function bottleShoot(n, kind, tags) {
  const r = rng(9100 + n * 17);
  const digits = shuffle(r, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).slice(0, 6);
  const bottles = BOTTLES.map((b, i) => ({ c: b.c, d: digits[i] }));
  const order = shuffle(r, bottles).slice(0, 4);
  const tf = TRANSFORMS[n % TRANSFORMS.length];
  const code = tf.f(order.map((x) => x.d)).join('');
  const nm = (c) => BOTTLES.find((b) => b.c === c).n;
  add({
    id: `${kind}-bottle-${n}`, family: 'bottle', kind, tags, category: 'game', difficulty: 1,
    title: kind === 'battle' ? 'Bottle Shoot Duel' : 'Bottle Shoot',
    objective: 'Scout is on the gun range: shoot the glass bottles — each colour hides one digit. Intel knows which colours open the safe, in order. Decoder knows how to scramble the code.',
    clues: {
      scout: {
        title: 'Gun range', body: 'Tap a bottle to shoot it. A broken bottle shows its digit; every bottle of that colour hides the same digit. 6 shots, then reload. Shout every colour and digit you find.',
        game: { type: 'bottle', bottles, ammo: 6 },
      },
      intel: { title: 'Safe order', body: order.map((x) => nm(x.c).toUpperCase()).join('  →  '), big: true },
      decoder: { title: 'Scramble rule', body: tf.text },
    },
    parts: [{ label: '4-digit safe code', accept: [code] }],
    hint: 'Scout: call out "red is 3, blue is 7…". Intel: read the four colours in order. Decoder: apply the rule last.',
    explanation: `${order.map((x) => `${nm(x.c)}=${x.d}`).join(' ')} → ${tf.why} → ${code}`,
    ...(kind === 'battle' ? { time_limit: 75 } : {}),
  });
}

// ───────────── Memory Cards: Scout flips cards to match pairs; each matched symbol shows a letter ─────────────
const SYMS = ['♠', '♥', '♦', '♣', '★', '●'];
const SYM_NAMES = { '♠': 'Spade', '♥': 'Heart', '♦': 'Diamond', '♣': 'Club', '★': 'Star', '●': 'Circle' };
const MEM_WORDS = ['CODE', 'BYTE', 'LOOP', 'DATA', 'GRID', 'NODE', 'JAVA', 'RUBY', 'TASK', 'TEAM', 'GOAL', 'WIFI', 'PING', 'LINK', 'FILE', 'SAVE', 'MAIL', 'DESK', 'CHIP', 'BOLT'];
function memoryCards(n, kind, tags) {
  const r = rng(5300 + n * 29);
  const word = MEM_WORDS[n % MEM_WORDS.length];
  const mode = n % 3; // 0 plain, 1 shifted +1, 2 reversed order
  const shift = (ch, k) => String.fromCharCode(((ch.charCodeAt(0) - 65 + k + 26) % 26) + 65);
  const order = shuffle(r, SYMS).slice(0, 4);
  const shown = mode === 1 ? word.split('').map((ch) => shift(ch, 1)) : word.split('');
  const seq = mode === 2 ? [...order].reverse() : order;
  // symbol → letter on its face; two spare symbols carry decoy letters
  const faces = {};
  seq.forEach((s, i) => { faces[s] = shown[i]; });
  for (const s of SYMS) if (!faces[s]) faces[s] = pick(r, 'XQZJVK'.split(''));
  const deck = shuffle(r, SYMS.flatMap((s) => [s, s])).map((s) => ({ s, l: faces[s] }));
  const rule = mode === 0 ? 'Read the letters exactly as they appear.' : mode === 1 ? 'Every letter was moved ONE step forward in the alphabet. Move each letter one step BACK (B → A, A → Z).' : 'Read the order Intel gives you BACKWARDS (last symbol first).';
  add({
    id: `${kind}-memcards-${n}`, family: 'cards', kind, tags, category: 'game', difficulty: 1,
    title: 'Memory Cards',
    objective: 'Scout flips cards to find matching pairs; every matched pair shows a letter. Intel knows which symbols spell the word. Decoder knows the twist.',
    clues: {
      scout: { title: 'Memory Cards', body: 'Tap two cards to flip them. A matching pair stays face up and shows its letter. Call out every symbol and letter.', game: { type: 'cards', deck } },
      intel: { title: 'Symbol order', body: `${order.join('   ')}\n(${order.map((s) => SYM_NAMES[s]).join(', ')})`, big: true },
      decoder: { title: 'The twist', body: rule },
    },
    parts: [{ label: '4-letter word', accept: [word] }],
    hint: 'Match all six pairs first, then let Intel read the symbols in order and the Decoder apply the twist.',
    explanation: `${order.map((s) => `${s}=${faces[s]}`).join(' ')} → ${rule.split('.')[0]} → ${word}`,
  });
}

// ───────────── Playing cards helpers ─────────────
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];
const DECK = SUITS.flatMap((s) => RANKS.map((rk) => rk + s));
const rankOf = (c) => c.slice(0, -1);
const suitOf = (c) => c.slice(-1);
const rv = (c) => RANKS.indexOf(rankOf(c)) + 1; // A=1 … K=13
const HANDS = {
  'STRAIGHT FLUSH': ['STRAIGHT FLUSH'], 'FOUR OF A KIND': ['FOUR OF A KIND', 'QUADS', 'FOUR KIND'],
  'FULL HOUSE': ['FULL HOUSE'], FLUSH: ['FLUSH'], STRAIGHT: ['STRAIGHT'],
  'THREE OF A KIND': ['THREE OF A KIND', 'TRIPS', 'THREE KIND', 'SET'], 'TWO PAIR': ['TWO PAIR', 'TWO PAIRS'],
  PAIR: ['PAIR', 'ONE PAIR'], 'HIGH CARD': ['HIGH CARD', 'NOTHING'],
};
function classify(hand) {
  const vals = hand.map(rv).sort((a, b) => a - b);
  const counts = Object.values(hand.reduce((m, c) => ({ ...m, [rankOf(c)]: (m[rankOf(c)] || 0) + 1 }), {})).sort((a, b) => b - a);
  const flush = new Set(hand.map(suitOf)).size === 1;
  const uniq = new Set(vals).size === 5;
  const straight = uniq && (vals[4] - vals[0] === 4 || vals.join() === '1,10,11,12,13');
  if (straight && flush) return 'STRAIGHT FLUSH';
  if (counts[0] === 4) return 'FOUR OF A KIND';
  if (counts[0] === 3 && counts[1] === 2) return 'FULL HOUSE';
  if (flush) return 'FLUSH';
  if (straight) return 'STRAIGHT';
  if (counts[0] === 3) return 'THREE OF A KIND';
  if (counts[0] === 2 && counts[1] === 2) return 'TWO PAIR';
  if (counts[0] === 2) return 'PAIR';
  return 'HIGH CARD';
}
function makeHand(r, type) {
  for (let tries = 0; tries < 20000; tries++) {
    let h;
    if (type === 'STRAIGHT FLUSH' || type === 'STRAIGHT') {
      const lo = 1 + Math.floor(r() * 9); const s = pick(r, SUITS);
      h = [0, 1, 2, 3, 4].map((k) => RANKS[lo - 1 + k] + (type === 'STRAIGHT FLUSH' ? s : pick(r, SUITS)));
    } else if (type === 'FLUSH') {
      const s = pick(r, SUITS); h = shuffle(r, RANKS).slice(0, 5).map((rk) => rk + s);
    } else {
      h = shuffle(r, DECK).slice(0, 5);
      if (['FOUR OF A KIND', 'FULL HOUSE', 'THREE OF A KIND', 'TWO PAIR', 'PAIR'].includes(type)) {
        const [a, b, c] = shuffle(r, RANKS);
        const pat = { 'FOUR OF A KIND': [a, a, a, a, b], 'FULL HOUSE': [a, a, a, b, b], 'THREE OF A KIND': [a, a, a, b, c], 'TWO PAIR': [a, a, b, b, c], PAIR: [a, a, b, c, pick(r, RANKS)] }[type];
        const used = new Set();
        h = pat.map((rk) => { let s; do { s = pick(r, SUITS); } while (used.has(rk + s)); used.add(rk + s); return rk + s; });
      }
    }
    if (new Set(h).size === 5 && classify(h) === type) return shuffle(r, h);
  }
  throw new Error(`could not deal ${type}`);
}
const HAND_LIST = 'High card · Pair · Two pair · Three of a kind · Straight · Flush · Full house · Four of a kind · Straight flush';
function poker(n, kind, tags) {
  const r = rng(6100 + n * 41);
  const pool = ['PAIR', 'TWO PAIR', 'THREE OF A KIND', 'STRAIGHT', 'FLUSH', 'FULL HOUSE', 'FOUR OF A KIND', 'HIGH CARD', 'STRAIGHT FLUSH'];
  const types = shuffle(r, pool).slice(0, 3);
  const items = types.map((ty) => { const h = makeHand(r, ty); return { q: h.join('  '), cards: h, a: HANDS[ty], why: ty.toLowerCase() }; });
  triple({
    id: `${kind}-poker-${n}`, kind, family: 'poker', tags, category: 'cards',
    title: kind === 'battle' ? 'Poker Face-Off' : 'Poker Hands',
    objective: `Each teammate is dealt one poker hand. Name all three. Possible hands: ${HAND_LIST}.`,
    items, panel: 'Hand', hint: 'Count matching ranks first (pairs, three, four), then check for five of one suit or five in a row.',
    starts: false, extra: (it) => ({ cards: it.cards }),
  });
}

// ───────────── Blackjack: Scout sees the shoe, Decoder the values, Intel the house rule ─────────────
const bjValue = (cards) => {
  let t = 0; let aces = 0;
  for (const c of cards) { const v = rv(c); if (v === 1) { aces++; t += 11; } else t += Math.min(10, v); }
  while (t > 21 && aces) { t -= 10; aces--; }
  return t;
};
function blackjack(n, kind, tags) {
  const r = rng(4400 + n * 23);
  const stand = [16, 17, 18][n % 3];
  for (let tries = 0; tries < 5000; tries++) {
    const shoe = shuffle(r, DECK).slice(0, 8);
    const hand = [];
    for (const c of shoe) { if (bjValue(hand) >= stand) break; hand.push(c); }
    const total = bjValue(hand);
    if (hand.length < 3 || hand.length > 6 || total > 26) continue;
    add({
      id: `${kind}-blackjack-${n}`, family: 'blackjack', kind, tags, category: 'cards', difficulty: 2,
      title: 'Blackjack Table',
      objective: 'The dealer plays one hand from the shoe. Scout sees the cards in order, Decoder knows what each card is worth, Intel knows when the dealer stops. What is the dealer’s final total?',
      clues: {
        scout: { title: 'The shoe (top first)', body: shoe.join('  '), cards: shoe },
        decoder: { title: 'Card values', body: '2–10 are worth their number.\nJ, Q, K are worth 10.\nA is worth 11 — unless that takes the total over 21, then it is worth 1.' },
        intel: { title: 'House rule', body: `The dealer takes cards from the top, one at a time, and STOPS as soon as the total is ${stand} or more.\nThe answer is the final total (it may be over 21 — a bust).` },
      },
      parts: [{ label: 'Dealer’s final total', accept: [String(total)] }],
      hint: 'Add one card at a time and check the total after each card.',
      explanation: `${hand.join(' + ')} = ${total} (stops at ${stand}+)`,
    });
    return;
  }
  throw new Error('blackjack');
}

// ───────────── Card Sharp: Scout sees a row of cards, Intel the positions, Decoder the scoring ─────────────
const SHARP_RULES = [
  { text: 'A=1, J=11, Q=12, K=13. RED cards (♥ ♦) count DOUBLE.', f: (c) => rv(c) * ('♥♦'.includes(suitOf(c)) ? 2 : 1), why: 'red ×2' },
  { text: 'A=1, J=11, Q=12, K=13. Every ♠ spade counts 0.', f: (c) => (suitOf(c) === '♠' ? 0 : rv(c)), why: 'spades 0' },
  { text: 'A=1, J=11, Q=12, K=13. Face cards (J, Q, K) count 10 instead.', f: (c) => (rv(c) > 10 ? 10 : rv(c)), why: 'faces 10' },
  { text: 'A=1, J=11, Q=12, K=13. Add 5 for every ♣ club.', f: (c) => rv(c) + (suitOf(c) === '♣' ? 5 : 0), why: 'clubs +5' },
];
function cardSharp(n, kind, tags) {
  const r = rng(7300 + n * 31);
  const row = shuffle(r, DECK).slice(0, 6);
  const pos = shuffle(r, [1, 2, 3, 4, 5, 6]).slice(0, 3).sort((a, b) => a - b);
  const rule = SHARP_RULES[n % SHARP_RULES.length];
  const total = pos.reduce((s, p) => s + rule.f(row[p - 1]), 0);
  add({
    id: `${kind}-cardsharp-${n}`, family: 'cardsharp', kind, tags, category: 'cards', difficulty: 1,
    title: 'Card Sharp',
    objective: 'Six cards lie face up. Intel knows which three count, Decoder knows how to score them. Add up the score.',
    clues: {
      scout: { title: 'The table (left to right)', body: row.map((c, i) => `${i + 1}: ${c}`).join('   '), cards: row },
      intel: { title: 'Cards that count', body: `Positions ${pos.join(', ')} (counting from the LEFT).`, big: true },
      decoder: { title: 'Scoring', body: rule.text },
    },
    parts: [{ label: 'Total score', accept: [String(total)] }],
    hint: 'Scout reads out the three cards Intel names; Decoder scores each one; the captain adds.',
    explanation: `${pos.map((p) => `${row[p - 1]}=${rule.f(row[p - 1])}`).join(' + ')} = ${total} (${rule.why})`,
  });
}

// ───────────── Safe Cracker: classic 3-digit lock riddle split across three phones ─────────────
function feedback(guess, code) {
  let right = 0; let wrongPlace = 0;
  for (let i = 0; i < 3; i++) { if (guess[i] === code[i]) right++; else if (code.includes(guess[i])) wrongPlace++; }
  return [right, wrongPlace];
}
const fbText = ([r, w]) => {
  if (r === 0 && w === 0) return 'nothing is correct';
  const parts = [];
  if (r) parts.push(`${r} correct, right place`);
  if (w) parts.push(`${w} correct, wrong place`);
  return parts.join(' + ');
};
const ALL3 = [];
for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) for (let c = 0; c < 10; c++) if (a !== b && b !== c && a !== c) ALL3.push(`${a}${b}${c}`);
function safeCracker(n, kind, tags) {
  const r = rng(8800 + n * 37);
  for (let tries = 0; tries < 400; tries++) {
    const code = pick(r, ALL3);
    const guesses = [];
    let cands = ALL3;
    for (let g = 0; g < 40 && guesses.length < 6 && cands.length > 1; g++) {
      const gs = pick(r, ALL3);
      if (gs === code || guesses.find((x) => x.g === gs)) continue;
      const fb = feedback(gs, code);
      const next = cands.filter((c) => { const f = feedback(gs, c); return f[0] === fb[0] && f[1] === fb[1]; });
      if (next.length === cands.length) continue;
      guesses.push({ g: gs, fb }); cands = next;
    }
    if (cands.length !== 1 || guesses.length < 4 || guesses.length > 6) continue;
    // every phone holds at least one line; no phone alone can open it
    const split = [[], [], []];
    guesses.forEach((x, i) => split[i % 3].push(`${x.g.split('').join(' ')}\n  → ${fbText(x.fb)}`));
    add({
      id: `${kind}-safe-${n}`, family: 'safe', kind, tags, category: 'logic', difficulty: 2,
      title: kind === 'battle' ? 'Safe Cracker Duel' : 'Safe Cracker',
      objective: 'A 3-digit lock. Each teammate holds some of the lock’s clues. Together they point to exactly one code. Digits never repeat.',
      clues: {
        scout: { title: 'Lock clues A', body: split[0].join('\n'), mono: true },
        decoder: { title: 'Lock clues B', body: split[1].join('\n'), mono: true },
        intel: { title: 'Lock clues C', body: `${split[2].join('\n')}\n\nThe code has 3 different digits.`, mono: true },
      },
      parts: [{ label: '3-digit code', accept: [code] }],
      hint: 'Start with "Nothing is correct" lines: cross those digits out everywhere. Then test the remaining digits against each clue.',
      explanation: `Only ${code} fits every clue.`,
      time_limit: kind === 'battle' ? 120 : 240,
    });
    return;
  }
  throw new Error(`safe ${n}`);
}

// ───────────── Morse: Scout hears the signal, Decoder and Intel each hold half the alphabet ─────────────
const MORSE = { A: '·−', B: '−···', C: '−·−·', D: '−··', E: '·', F: '··−·', G: '−−·', H: '····', I: '··', J: '·−−−', K: '−·−', L: '·−··', M: '−−', N: '−·', O: '−−−', P: '·−−·', Q: '−−·−', R: '·−·', S: '···', T: '−', U: '··−', V: '···−', W: '·−−', X: '−··−', Y: '−·−−', Z: '−−··' };
const MORSE_WORDS = ['ZONE', 'LOOT', 'DROP', 'SQUAD', 'RADIO', 'MEDIC', 'SHIELD', 'SNIPER', 'VAULT', 'ESCAPE', 'TOWER', 'ROUTE', 'GATE', 'TRAIN', 'HEXA', 'NORTH'];
function morse(n, kind, tags) {
  const word = MORSE_WORDS[n % MORSE_WORDS.length];
  const half = (from, to) => Object.entries(MORSE).filter(([k]) => k >= from && k <= to).map(([k, v]) => `${k} ${v}`).join('\n');
  add({
    id: `${kind}-morse-${n}`, family: 'morse', kind, tags, category: 'decoding', difficulty: 2,
    title: 'Radio Morse',
    objective: 'A Morse signal came over the squad radio. Scout copied it; Decoder holds letters A–M and Intel letters N–Z. Decode the word.',
    clues: {
      scout: { title: 'Intercepted signal', body: `${word.split('').map((ch) => MORSE[ch]).join('   /   ')}\n\n(${word.length} letters, “/” separates letters)`, mono: true, big: true },
      decoder: { title: 'Codebook A–M', body: half('A', 'M'), mono: true },
      intel: { title: 'Codebook N–Z', body: half('N', 'Z'), mono: true },
    },
    parts: [{ label: 'Decoded word', accept: [word] }],
    hint: '· is a short beep, − is a long beep. Read one letter at a time and ask both codebooks.',
    explanation: word.split('').map((ch) => `${MORSE[ch]}=${ch}`).join(' '),
  });
}

// ───────────── Word Scramble (tech & office words) ─────────────
const SCRAMBLE = [
  ['LAPTOP', 'portable computer'], ['SERVER', 'machine that serves requests'], ['BROWSER', 'opens web pages'], ['KEYBOARD', 'you type on it'],
  ['MONITOR', 'a screen'], ['PRINTER', 'puts pages on paper'], ['NETWORK', 'connected computers'], ['PASSWORD', 'keep it secret'],
  ['MEETING', 'calendar invite'], ['DEADLINE', 'due date'], ['MANAGER', 'leads a team'], ['TRAINING', 'learning session'],
  ['PROJECT', 'a piece of work'], ['SPRINT', 'agile iteration'], ['BACKLOG', 'list of work items'], ['RELEASE', 'shipping a version'],
  ['DATABASE', 'stores rows'], ['FIREWALL', 'blocks bad traffic'], ['BACKUP', 'safety copy'], ['ROUTER', 'directs packets'],
  ['DESKTOP', 'home screen of a PC'], ['CHARGER', 'refills the battery'], ['HEADSET', 'mic + headphones'], ['WEBCAM', 'video call camera'],
  ['CLOUD', 'someone else’s servers'], ['PYTHON', 'snake-named language'], ['JAVASCRIPT', 'language of the browser'], ['COMPILER', 'turns code into programs'],
  ['TERMINAL', 'type commands here'], ['FUNCTION', 'reusable block of code'], ['VARIABLE', 'named value'], ['DEBUGGER', 'steps through code'],
  ['CANTEEN', 'office food place'], ['PANTRY', 'office snacks and tea'], ['LIBRARY', 'books, or reusable code'], ['ELEVATOR', 'goes between floors'],
  ['STAIRCASE', 'climb between floors'], ['RECEPTION', 'front desk'], ['VISITOR', 'guest badge'], ['PARKING', 'where cars wait'],
  ['FOUNTAIN', 'water feature'], ['SHUTTLE', 'campus bus'], ['CAFETERIA', 'lunch hall'], ['WHITEBOARD', 'markers and ideas'],
  ['PROJECTOR', 'shows slides on a wall'], ['SPEAKER', 'makes sound'], ['ANTENNA', 'catches signals'], ['SATELLITE', 'orbits the earth'],
  ['HELIPAD', 'H marks the spot'], ['GENERATOR', 'backup power'], ['SECURITY', 'guards and badges'], ['BADGE', 'swipe to enter'],
  ['TICKET', 'helpdesk request'], ['INVOICE', 'a bill'], ['PAYROLL', 'salary processing'], ['APPRAISAL', 'yearly review'],
  ['ONBOARDING', 'first days at work'], ['HACKATHON', 'build fast, win prizes'], ['WORKSHOP', 'hands-on session'], ['CERTIFICATE', 'proof you passed'],
];
function scrambleWord(r, w) {
  for (let i = 0; i < 50; i++) { const s = shuffle(r, w.split('')).join(''); if (s !== w) return s; }
  return w.split('').reverse().join('');
}
function scramble(i, kind, tags, items) {
  const r = rng(3100 + i * 7);
  triple({
    id: `${kind}-scramble-${i}`, kind, family: 'scramble', tags, category: 'words',
    title: kind === 'battle' ? 'Scramble Duel' : 'Word Scramble',
    objective: 'Each teammate holds one scrambled office or tech word. Unscramble all three.',
    items: items.map(([w, why]) => ({ q: `${scrambleWord(r, w).split('').join(' ')}\n\nClue: ${why}`, a: [w], why: `unscrambled (${why})` })),
    panel: 'Word', hint: 'Say the clue out loud first — it narrows the word down.', mono: true,
  });
}

// ───────────── Quick Maths ─────────────
function mathQ(r) {
  const k = Math.floor(r() * 6);
  const a = 2 + Math.floor(r() * 11); const b = 2 + Math.floor(r() * 11); const c = 1 + Math.floor(r() * 20);
  switch (k) {
    case 0: return { q: `${a} × ${b} + ${c}`, v: a * b + c };
    case 1: return { q: `${a * b} ÷ ${a} + ${c}`, v: b + c };
    case 2: return { q: `(${a} + ${b}) × 3 − ${c % 10}`, v: (a + b) * 3 - (c % 10) };
    case 3: return { q: `${a}² − ${b}`, v: a * a - b };
    case 4: return { q: `Half of ${a * 2 * 10} plus ${c}`, v: a * 10 + c };
    default: return { q: `${c * 4} − ${a} × ${b % 5 + 1}`, v: c * 4 - a * (b % 5 + 1) };
  }
}
function quickMaths(n, kind, tags) {
  const r = rng(2200 + n * 13);
  const items = [];
  while (items.length < 3) { const m = mathQ(r); if (m.v > 0 && m.v < 400 && !items.find((x) => x.q === m.q)) items.push({ q: `${m.q} = ?`, a: [String(m.v)], why: `${m.q} = ${m.v}` }); }
  triple({
    id: `${kind}-maths-${n}`, kind, family: 'maths', tags, category: 'maths',
    title: kind === 'battle' ? 'Maths Duel' : kind === 'recovery' ? 'Field Medic Maths' : 'Quick Maths',
    objective: 'Three quick sums, one per teammate. Multiply and divide before you add and subtract.',
    items, panel: 'Sum', hint: 'No calculators needed — multiply first, then add or subtract.', starts: false, mono: true, big: true,
  });
}

// ───────────── Number sequences ─────────────
function seqQ(r) {
  const k = Math.floor(r() * 6);
  const a = 1 + Math.floor(r() * 9); const d = 2 + Math.floor(r() * 7);
  let s; let why;
  if (k === 0) { s = [0, 1, 2, 3, 4, 5].map((i) => a + d * i); why = `+${d} each time`; }
  else if (k === 1) { s = [0, 1, 2, 3, 4, 5].map((i) => a * 2 ** i); why = 'doubles'; }
  else if (k === 2) { s = [1, 2, 3, 4, 5, 6].map((i) => (i + a % 4) ** 2); why = 'square numbers'; }
  else if (k === 3) { s = [a, a + 1]; while (s.length < 6) s.push(s[s.length - 1] + s[s.length - 2]); why = 'each is the sum of the two before'; }
  else if (k === 4) { s = [0, 1, 2, 3, 4, 5].map((i) => a + (i * (i + 1)) / 2); why = 'add 1, 2, 3, 4, 5'; }
  else { s = [0, 1, 2, 3, 4, 5].map((i) => 100 - (a + d) * i); why = `−${a + d} each time`; }
  return { q: `${s.slice(0, 5).join(', ')}, ?`, a: [String(s[5])], why };
}
function sequences(n, kind, tags) {
  const r = rng(1700 + n * 19);
  const items = [];
  while (items.length < 3) { const q = seqQ(r); if (!items.find((x) => x.why === q.why)) items.push(q); }
  triple({
    id: `${kind}-numseq-${n}`, kind, family: 'numseq', tags, category: 'maths',
    title: kind === 'battle' ? 'Sequence Duel' : 'Next Number',
    objective: 'Each teammate holds a number pattern. Find the next number in all three.',
    items, panel: 'Pattern', hint: 'Look at the gap between neighbours. If the gaps grow, look at the gaps of the gaps.', starts: false, mono: true, big: true,
  });
}

// ───────────── Flags (emoji) ─────────────
const FLAGS = [
  ['🇮🇳', ['INDIA'], 'saffron, white, green'], ['🇯🇵', ['JAPAN'], 'red sun'], ['🇧🇷', ['BRAZIL'], 'green & yellow'], ['🇨🇦', ['CANADA'], 'maple leaf'],
  ['🇫🇷', ['FRANCE'], 'blue white red'], ['🇩🇪', ['GERMANY'], 'black red gold'], ['🇮🇹', ['ITALY'], 'green white red'], ['🇬🇧', ['UNITED KINGDOM', 'UK', 'BRITAIN', 'GREAT BRITAIN'], 'union jack'],
  ['🇺🇸', ['USA', 'UNITED STATES', 'AMERICA', 'US'], 'stars and stripes'], ['🇦🇺', ['AUSTRALIA'], 'southern cross'], ['🇨🇳', ['CHINA'], 'five stars'], ['🇰🇷', ['SOUTH KOREA', 'KOREA'], 'taegeuk'],
  ['🇪🇸', ['SPAIN'], 'red yellow red'], ['🇲🇽', ['MEXICO'], 'eagle'], ['🇿🇦', ['SOUTH AFRICA'], 'Y shape'], ['🇸🇬', ['SINGAPORE'], 'crescent and stars'],
  ['🇳🇵', ['NEPAL'], 'two pennants'], ['🇱🇰', ['SRI LANKA'], 'lion'], ['🇧🇩', ['BANGLADESH'], 'red disc on green'], ['🇵🇹', ['PORTUGAL'], 'armillary sphere'],
  ['🇳🇱', ['NETHERLANDS', 'HOLLAND'], 'red white blue'], ['🇸🇪', ['SWEDEN'], 'yellow cross on blue'], ['🇨🇭', ['SWITZERLAND'], 'white cross on red'], ['🇦🇷', ['ARGENTINA'], 'sun of May'],
  ['🇪🇬', ['EGYPT'], 'eagle of Saladin'], ['🇹🇷', ['TURKEY', 'TURKIYE'], 'crescent & star'], ['🇳🇿', ['NEW ZEALAND'], 'red stars'], ['🇰🇪', ['KENYA'], 'shield & spears'],
  ['🇬🇷', ['GREECE'], 'blue stripes'], ['🇮🇪', ['IRELAND'], 'green white orange'], ['🇳🇴', ['NORWAY'], 'cross on red'], ['🇫🇮', ['FINLAND'], 'blue cross'],
  ['🇵🇱', ['POLAND'], 'white over red'], ['🇺🇦', ['UKRAINE'], 'blue over yellow'], ['🇻🇳', ['VIETNAM'], 'yellow star'], ['🇹🇭', ['THAILAND'], 'red white blue bands'],
  ['🇲🇾', ['MALAYSIA'], 'crescent, stripes'], ['🇮🇩', ['INDONESIA'], 'red over white'], ['🇵🇭', ['PHILIPPINES'], 'sun & stars'], ['🇯🇲', ['JAMAICA'], 'gold saltire'],
  ['🇳🇬', ['NIGERIA'], 'green white green'], ['🇧🇪', ['BELGIUM'], 'black yellow red'], ['🇩🇰', ['DENMARK'], 'white cross'], ['🇦🇪', ['UAE', 'UNITED ARAB EMIRATES'], 'red vertical band'],
  ['🇸🇦', ['SAUDI ARABIA'], 'sword'],
];
function flags(i, kind, tags, items) {
  triple({
    id: `${kind}-flags-${i}`, kind, family: 'flags', tags, category: 'world',
    title: 'Flag Signals', objective: 'Each teammate sees one flag. Name all three countries.',
    items: items.map(([f, a, why]) => ({ q: f, a, why })), panel: 'Flag', hint: 'Describe the colours out loud — someone in the squad will know.', big: true,
  });
}

// ───────────── Odd One Out ─────────────
const ODD = [
  ['Mercury · Venus · Moon · Mars', 'MOON', 'not a planet'], ['Python · Java · Cobra · Rust', 'COBRA', 'not a programming language'], ['Chennai · Mumbai · Kerala · Delhi', 'KERALA', 'a state, not a city'],
  ['Square · Circle · Triangle · Cube', 'CUBE', '3D, not flat'], ['Mango · Carrot · Banana · Apple', 'CARROT', 'a vegetable'], ['Tiger · Lion · Wolf · Leopard', 'WOLF', 'not a big cat'],
  ['Violin · Guitar · Flute · Cello', 'FLUTE', 'not a string instrument'], ['Monday · July · Friday · Sunday', 'JULY', 'a month'], ['Rupee · Dollar · Euro · Kilogram', 'KILOGRAM', 'not money'],
  ['Eagle · Penguin · Sparrow · Parrot', 'PENGUIN', 'cannot fly'], ['Excel · Word · Chrome · PowerPoint', 'CHROME', 'not Office'], ['Red · Blue · Yellow · Purple', 'PURPLE', 'not a primary colour'],
  ['Shark · Dolphin · Whale · Seal', 'SHARK', 'a fish, not a mammal'], ['Cricket · Hockey · Chess · Football', 'CHESS', 'not a field sport'], ['Iron · Gold · Wood · Copper', 'WOOD', 'not a metal'],
  ['HTML · CSS · JPEG · JavaScript', 'JPEG', 'an image format'], ['Pune · Paris · Rome · Madrid', 'PUNE', 'not a capital'], ['Taj Mahal · Eiffel Tower · Big Ben · Mount Everest', 'MOUNT EVEREST', 'not built by people'],
  ['Hammer · Spanner · Screwdriver · Spoon', 'SPOON', 'not a tool'], ['Rain · Snow · Hail · Wind', 'WIND', 'not falling water'], ['Two · Four · Seven · Eight', 'SEVEN', 'odd number'],
  ['Mouse · Keyboard · Scanner · Speaker', 'SPEAKER', 'output, not input'], ['Rose · Tulip · Lotus · Oak', 'OAK', 'a tree'], ['Nile · Amazon · Ganga · Sahara', 'SAHARA', 'a desert'],
  ['Ant · Bee · Spider · Butterfly', 'SPIDER', 'eight legs, not an insect'], ['Salt · Sugar · Pepper · Water', 'WATER', 'not a solid'], ['Bus · Train · Car · Plane', 'PLANE', 'does not run on the ground'],
  ['Kilo · Mega · Giga · Volt', 'VOLT', 'a unit, not a prefix'], ['North · South · Up · West', 'UP', 'not a compass point'], ['Gmail · Outlook · Yahoo Mail · Zoom', 'ZOOM', 'not email'],
  ['Linux · Windows · macOS · Oracle', 'ORACLE', 'not an operating system'], ['Copper · Silver · Bronze · Gold', 'BRONZE', 'an alloy'], ['Triangle · Hexagon · Pentagon · Circle', 'CIRCLE', 'no straight sides'],
  ['Inch · Metre · Litre · Mile', 'LITRE', 'volume, not length'], ['Cat · Cow · Goat · Hen', 'HEN', 'two legs'],
  ['Laptop · Tablet · Phone · Toaster', 'TOASTER', 'not a computer'], ['Mars · Snickers · Twix · Pepsi', 'PEPSI', 'a drink'], ['Hexagon · Hexaware · Hexadecimal · Pentagon', 'PENTAGON', 'no "hexa"'],
  ['SQL · Oracle · MySQL · Photoshop', 'PHOTOSHOP', 'not a database thing'], ['Coffee · Tea · Juice · Bread', 'BREAD', 'not a drink'], ['Winter · Summer · Autumn · Morning', 'MORNING', 'not a season'],
  ['Cotton · Silk · Wool · Steel', 'STEEL', 'not a fabric'], ['Piano · Drum · Tabla · Bongo', 'PIANO', 'not a drum'], ['Ruby · Emerald · Sapphire · Marble', 'MARBLE', 'not a gemstone'],
  ['Kolkata · Chennai · Kochi · Bhopal', 'BHOPAL', 'not on the coast'],
];
function oddOne(i, kind, tags, items) {
  triple({
    id: `${kind}-odd-${i}`, kind, family: 'odd', tags, category: 'logic',
    title: 'Odd One Out', objective: 'Each teammate sees four words. One does not belong. Name the odd one out in all three lists.',
    items: items.map(([q, a, why]) => ({ q, a: [a], why })), panel: 'List', hint: 'Find what three of the words have in common.', big: true, starts: false,
  });
}

// ───────────── Clock puzzles ─────────────
const fmt = (m) => { m = ((m % 1440) + 1440) % 1440; const h = Math.floor(m / 60); const mm = m % 60; return `${String(h).padStart(2, '0')}${String(mm).padStart(2, '0')}`; };
const show = (m) => { const s = fmt(m); return `${s.slice(0, 2)}:${s.slice(2)}`; };
function clockQ(r) {
  const k = Math.floor(r() * 3);
  const start = (6 + Math.floor(r() * 14)) * 60 + 5 * Math.floor(r() * 12);
  const add = 25 + 5 * Math.floor(r() * 40);
  if (k === 0) return { q: `It is ${show(start)}. The meeting starts in ${Math.floor(add / 60)} h ${add % 60} min. What time does it start? (24-hour, like 14:35)`, a: [fmt(start + add), show(start + add)], why: `${show(start)} + ${add} min` };
  if (k === 1) return { q: `The shuttle arrives at ${show(start)}. It left ${add} minutes earlier. When did it leave? (24-hour, like 09:05)`, a: [fmt(start - add), show(start - add)], why: `${show(start)} − ${add} min` };
  const end = start + add;
  return { q: `A training runs from ${show(start)} to ${show(end)}. How many MINUTES long is it?`, a: [String(add)], why: `${add} minutes` };
}
function clocks(n, kind, tags) {
  const r = rng(6600 + n * 11);
  triple({
    id: `${kind}-clock-${n}`, kind, family: 'clock', tags, category: 'maths',
    title: 'Shift Clock', objective: 'Three time puzzles, one per teammate. Times are 24-hour (type 14:35 or 1435).',
    items: [clockQ(r), clockQ(r), clockQ(r)], panel: 'Clock', hint: 'Do hours first, then minutes. 60 minutes make an hour.', starts: false, mono: true,
  });
}

export function buildMissions3() {
  T.length = 0;
  const ANY = (...t) => ['any', ...t];
  for (let i = 0; i < 12; i++) bottleShoot(i, 'mission', ANY('sports', 'access', 'gate', 'parking', 'testing', 'stg'));
  for (let i = 0; i < 6; i++) bottleShoot(20 + i, 'airdrop', ['any']);
  for (let i = 0; i < 4; i++) bottleShoot(40 + i, 'battle', ['duel_smg']);
  for (let i = 0; i < 14; i++) memoryCards(i, 'mission', ANY('social', 'coffee', 'food', 'learning', 'office', 'hr'));
  for (let i = 0; i < 4; i++) memoryCards(20 + i, 'airdrop', ['any']);
  for (let i = 0; i < 15; i++) poker(i, 'mission', ANY('social', 'boardroom', 'coffee', 'market', 'public'));
  for (let i = 0; i < 5; i++) poker(20 + i, 'battle', ['duel_pistol']);
  for (let i = 0; i < 8; i++) blackjack(i, 'mission', ANY('social', 'boardroom', 'market', 'coffee'));
  for (let i = 0; i < 2; i++) blackjack(10 + i, 'recovery', ['any']);
  for (let i = 0; i < 10; i++) cardSharp(i, 'mission', ANY('office', 'learning', 'social', 'glass'));
  for (let i = 0; i < 3; i++) cardSharp(10 + i, 'battle', ['duel_pistol']);
  for (let i = 0; i < 15; i++) safeCracker(i, 'mission', ANY('boardroom', 'access', 'testing', 'observation', 'phase2', 'glass'));
  for (let i = 0; i < 5; i++) safeCracker(20 + i, 'battle', ['duel_sniper']);
  for (let i = 0; i < 12; i++) morse(i, 'mission', ANY('transmission', 'access', 'gate', 'observation', 'terrace'));
  packs(SCRAMBLE.slice(0, 48), 16, 3, (i, items) => scramble(i, 'mission', ANY('office', 'learning', 'helpdesk', 'hr', 'stg'), items));
  packs(SCRAMBLE.slice(48, 60), 4, 3, (i, items) => scramble(20 + i, 'battle', ['duel_smg'], items));
  for (let i = 0; i < 12; i++) quickMaths(i, 'mission', ANY('office', 'learning', 'market', 'food'));
  for (let i = 0; i < 4; i++) quickMaths(20 + i, 'battle', ['duel_smg']);
  for (let i = 0; i < 4; i++) quickMaths(40 + i, 'recovery', ['any']);
  for (let i = 0; i < 12; i++) sequences(i, 'mission', ANY('learning', 'testing', 'observation', 'glass'));
  for (let i = 0; i < 3; i++) sequences(20 + i, 'battle', ['duel_sniper']);
  packs(FLAGS, 15, 3, (i, items) => flags(i, 'mission', ANY('public', 'social', 'coffee', 'sports', 'gate'), items));
  packs(ODD, Math.floor(ODD.length / 3), 3, (i, items) => oddOne(i, 'mission', ANY('learning', 'hr', 'office', 'social', 'food'), items));
  for (let i = 0; i < 10; i++) clocks(i, 'mission', ANY('office', 'parking', 'access', 'learning'));
  return T;
}

// self-check when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const all = buildMissions3();
  console.log(all.length, 'templates', all.reduce((m, t) => ({ ...m, [`${t.kind}:${t.family}`]: (m[`${t.kind}:${t.family}`] || 0) + 1 }), {}));
  for (const t of all.filter((x) => ['safe', 'blackjack', 'cardsharp', 'bottle', 'cards'].includes(x.family)).slice(0, 8)) console.log(t.id, t.parts.map((p) => p.accept[0]).join('/'), '·', t.explanation);
  for (const t of all.filter((x) => x.family === 'poker').slice(0, 2)) console.log(t.id, t.explanation, t.clues.scout.body);
}
export { norm };
