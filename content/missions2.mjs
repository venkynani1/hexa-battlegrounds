// Challenge pack 2 — picture riddles, riddles, emoji movies, tech quick-fire, 4×4 mini sudoku
// and the Fruit Slash mini-game. Same rule as pack 1: no single phone can solve a challenge;
// every role holds an indispensable piece. Seeded, so every build is identical.

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

const T = [];
const META = {
  mission: { time: 200, attempts: 3 }, battle: { time: 90, attempts: 3 }, recovery: { time: 120, attempts: 5 },
  airdrop: { time: 150, attempts: 3 }, relay: { time: 240, attempts: 3 },
};
function add(t) {
  const tpl = {
    category: 'logic', difficulty: 1, coins: 25, points: null, relay: false, hint: '', status: 'published',
    time_limit: META[t.kind].time, attempts: META[t.kind].attempts, ...t,
  };
  tpl.parts = tpl.parts.map((p) => ({ label: p.label, accept: [...new Set(p.accept.map(norm))] }));
  for (const role of ['scout', 'decoder', 'intel']) if (!tpl.clues[role]) throw new Error(`${tpl.id} missing ${role} clue`);
  if (T.find((x) => x.id === tpl.id)) throw new Error(`duplicate ${tpl.id}`);
  T.push(tpl);
}
const ROLE_NAMES = ['Scout', 'Decoder', 'Intel'];
// Three independent panels, one per phone; the captain types all three answers.
// "(9 letters)" / "(2 words: 4 + 4)" — printed under every word puzzle so it is easier to guess.
const shape = (ans) => {
  const w = String(ans).trim().split(/\s+/);
  return w.length === 1 ? `${w[0].replace(/[^A-Z0-9]/gi, '').length} letters` : `${w.length} words: ${w.map((x) => x.replace(/[^A-Z0-9]/gi, '').length).join(' + ')}`;
};
function triple({ id, family, kind, tags, category, title, objective, items, panelTitle, hint, mono = false, big = false }) {
  const clues = {};
  ['scout', 'decoder', 'intel'].forEach((role, i) => {
    clues[role] = { title: `${panelTitle} ${i + 1}`, body: `${items[i].q}\n\n(${shape(items[i].a[0])} · starts with ${items[i].a[0][0]})`, mono, big: big && !mono };
  });
  hint = `${hint} Answers start with: ${items.map((it) => it.a[0].slice(0, 2) + '…').join(', ')}`;
  add({
    id, family, kind, tags, category, title, objective, clues, hint,
    parts: items.map((it, i) => ({ label: `${panelTitle} ${i + 1} (${ROLE_NAMES[i]})`, accept: it.a })),
    explanation: items.map((it) => `${it.a[0]}: ${it.why}`).join(' | '),
  });
}

// ───────────── Picture riddles (emoji compound words) ─────────────
const PIC = [
  ['🪜 + 👨', ['STEPFATHER', 'STEP FATHER'], 'step + father'],
  ['🧈 + 🪰', ['BUTTERFLY'], 'butter + fly'],
  ['🍯 + 🌙', ['HONEYMOON'], 'honey + moon'],
  ['💡 + 🏠', ['LIGHTHOUSE'], 'light + house'],
  ['🔥 + 🧱', ['FIREWALL'], 'fire + wall'],
  ['🔥 + 🦊', ['FIREFOX'], 'fire + fox'],
  ['🌧️ + 🎀', ['RAINBOW'], 'rain + bow'],
  ['🦶 + ⚽', ['FOOTBALL'], 'foot + ball'],
  ['⭐ + 🐟', ['STARFISH'], 'star + fish'],
  ['🥚 + 🍆', ['EGGPLANT'], 'egg + plant'],
  ['🐎 + 👞', ['HORSESHOE'], 'horse + shoe'],
  ['✋ + 👜', ['HANDBAG'], 'hand + bag'],
  ['🦷 + 🖌️', ['TOOTHBRUSH'], 'tooth + brush'],
  ['🛏️ + 🪨', ['BEDROCK'], 'bed + rock'],
  ['🧠 + ⛈️', ['BRAINSTORM'], 'brain + storm'],
  ['☀️ + 🌻', ['SUNFLOWER'], 'sun + flower'],
  ['🔑 + 🎹', ['KEYBOARD'], 'key + board'],
  ['☁️ + 🖥️', ['CLOUD COMPUTING', 'CLOUDCOMPUTING', 'CLOUD COMPUTER'], 'cloud + computer → cloud computing'],
  ['🐝 + 🍃', ['BAYLEAF', 'BAY LEAF', 'BEELEAF'], 'bee (bay) + leaf'],
  ['🌊 + 🐎', ['SEAHORSE', 'SEA HORSE'], 'sea + horse'],
  ['🕷️ + 🕸️ + 🌐', ['WORLD WIDE WEB', 'WORLDWIDEWEB', 'WEBSITE', 'WWW'], 'the world-wide web'],
];

// ───────────── Riddles ─────────────
const RIDDLES = [
  ['I have keys but open no locks. You type on me every day.', ['KEYBOARD'], 'a keyboard'],
  ['What has to be broken before you can use it? (Breakfast!)', ['EGG', 'AN EGG'], 'an egg'],
  ['I am tall when I am new and short when I am old. I give light.', ['CANDLE', 'A CANDLE'], 'a candle'],
  ['What has hands and a face but cannot clap or smile?', ['CLOCK', 'A CLOCK', 'WATCH'], 'a clock'],
  ['What has a neck and a cap but no head? You drink from it.', ['BOTTLE', 'A BOTTLE'], 'a bottle'],
  ['What gets wetter the more it dries? You use it after a bath.', ['TOWEL', 'A TOWEL'], 'a towel'],
  ['What has many teeth but never bites? It fixes your hair.', ['COMB', 'A COMB'], 'a comb'],
  ['What has four legs but cannot walk? You eat lunch on it.', ['TABLE', 'A TABLE'], 'a table'],
  ['What has a head and a tail but no body? It is money.', ['COIN', 'A COIN'], 'a coin'],
  ['What has one eye but cannot see? You use it with thread.', ['NEEDLE', 'A NEEDLE'], 'a needle'],
  ['What falls from the sky but never gets hurt? You need an umbrella.', ['RAIN'], 'rain'],
  ['What has many pages and words but never speaks?', ['BOOK', 'A BOOK'], 'a book'],
  ['I ring, I have a screen, and you carry me everywhere.', ['PHONE', 'MOBILE', 'CELLPHONE', 'A PHONE'], 'a phone'],
  ['I am full of holes but still hold water. I clean dishes.', ['SPONGE', 'A SPONGE'], 'a sponge'],
  ['What goes up when you get older, and never comes down?', ['AGE', 'YOUR AGE'], 'your age'],
];

// ───────────── Emoji movies ─────────────
const MOVIES = [
  ['🚢 🧊 💔', ['TITANIC'], 'ship, iceberg, heartbreak'],
  ['🦁 👑', ['THE LION KING', 'LION KING'], 'lion + crown'],
  ['🦖 🏞️ 🚙', ['JURASSIC PARK', 'JURASSIC WORLD'], 'dinosaur park'],
  ['🥋 🐼', ['KUNG FU PANDA', 'KUNGFU PANDA'], 'kung fu + panda'],
  ['❄️ 👸 ⛄', ['FROZEN'], 'ice queen + snowman'],
  ['🕷️ 👨 🏙️', ['SPIDERMAN', 'SPIDER MAN'], 'spider + man'],
  ['🔍 🐠', ['FINDING NEMO', 'NEMO'], 'finding + fish'],
  ['🧸 📖', ['TOY STORY'], 'toy + story'],
  ['3️⃣ 🤪 🎓', ['3 IDIOTS', 'THREE IDIOTS'], 'three idiots at college'],
  ['🤼‍♀️ 👨‍👧‍👧 🥇', ['DANGAL'], 'wrestling father and daughters'],
  ['⚡ 🧙‍♂️ 👓', ['HARRY POTTER'], 'scar, wizard, glasses'],
  ['🦈 🌊 🏊', ['JAWS'], 'shark attack'],
  ['🎈 🏠 👴', ['UP'], 'balloons lift a house'],
  ['🦇 🌃 🃏', ['THE DARK KNIGHT', 'DARK KNIGHT', 'BATMAN'], 'bat, night, joker'],
  ['🔥 💧 🤝', ['RRR'], 'fire and water, friendship'],
  ['🏴‍☠️ 🌴 💀', ['PIRATES OF THE CARIBBEAN', 'PIRATES'], 'pirates, islands'],
  ['👻 🚫 📞', ['GHOSTBUSTERS', 'GHOST BUSTERS'], 'who you gonna call'],
  ['🌀 💤 🏙️', ['INCEPTION'], 'dreams inside dreams'],
];

// ───────────── Tech quick-fire ─────────────
const TECH = [
  ['Which company\'s logo is a bitten fruit?', ['APPLE'], 'Apple'],
  ['Ctrl + Z does what?', ['UNDO'], 'Undo'],
  ['Smallest unit of data — a single 0 or 1.', ['BIT'], 'a bit'],
  ['Google\'s mobile operating system.', ['ANDROID'], 'Android'],
  ['8 bits make one ___.', ['BYTE'], 'a byte'],
  ['HTML = HyperText ___ Language.', ['MARKUP'], 'Markup'],
  ['Programming language with a coffee-cup logo.', ['JAVA'], 'Java'],
  ['Language named after a British comedy group, not a snake.', ['PYTHON'], 'Python (Monty Python)'],
  ['Ctrl + C copies. Ctrl + ___ pastes.', ['V', 'CTRL V'], 'Ctrl + V'],
  ['Number system that uses only 0 and 1.', ['BINARY', 'BASE 2'], 'binary'],
  ['Company that owns WhatsApp and Instagram.', ['META', 'FACEBOOK'], 'Meta'],
  ['Mbps = megabits per ___.', ['SECOND', 'SEC'], 'second'],
  ['Unwanted bulk email is called ___.', ['SPAM'], 'spam'],
  ['Key you press to refresh most browsers.', ['F5', 'F 5'], 'F5'],
  ['What does the "I" in AI stand for?', ['INTELLIGENCE'], 'Intelligence'],
  ['Fake login emails that steal passwords are called ___.', ['PHISHING'], 'phishing'],
  ['A problem in code is nicknamed a ___.', ['BUG'], 'bug'],
  ['What does "www" stand for? World Wide ___', ['WEB'], 'Web'],
];

function packTriples(list, size, fn) {
  for (let i = 0; i * 3 + 3 <= list.length && i < size; i++) fn(i, list.slice(i * 3, i * 3 + 3).map(([q, a, why]) => ({ q, a, why })));
}

// ───────────── 4×4 mini sudoku (rows split between Scout and Decoder; Intel knows which cells form the code) ─────────────
function sudokuSolutions(grid) {
  const out = [];
  const g = grid.map((r) => [...r]);
  const ok = (r, c, v) => {
    for (let i = 0; i < 4; i++) if (g[r][i] === v || g[i][c] === v) return false;
    const br = r - (r % 2); const bc = c - (c % 2);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) if (g[br + i][bc + j] === v) return false;
    return true;
  };
  const solve = (k) => {
    if (out.length > 1) return;
    if (k === 16) { out.push(g.map((r) => [...r])); return; }
    const r = Math.floor(k / 4); const c = k % 4;
    if (g[r][c]) return solve(k + 1);
    for (let v = 1; v <= 4; v++) if (ok(r, c, v)) { g[r][c] = v; solve(k + 1); g[r][c] = 0; }
  };
  solve(0);
  return out;
}
function sudoku(n, kind, tags) {
  const r = rng(9100 + n * 7);
  // a valid 4×4 solution: permute digits, rows inside bands, bands, columns inside stacks
  const d = shuffle(r, [1, 2, 3, 4]);
  let sol = [[1, 2, 3, 4], [3, 4, 1, 2], [2, 1, 4, 3], [4, 3, 2, 1]].map((row) => row.map((v) => d[v - 1]));
  if (r() < 0.5) sol = [sol[1], sol[0], sol[2], sol[3]];
  if (r() < 0.5) sol = [sol[2], sol[3], sol[0], sol[1]];
  if (r() < 0.5) sol = sol.map((row) => [row[1], row[0], row[2], row[3]]);
  // remove cells while the combined puzzle stays uniquely solvable
  const puzzle = sol.map((row) => [...row]);
  let blanks0 = 0;
  for (const k of shuffle(r, [...Array(16).keys()])) {
    if (blanks0 >= 8) break; // easier: at least 8 of 16 numbers are given
    const rr = Math.floor(k / 4); const cc = k % 4;
    const keep = puzzle[rr][cc]; puzzle[rr][cc] = 0;
    if (sudokuSolutions(puzzle).length !== 1) puzzle[rr][cc] = keep; else blanks0++;
  }
  // code cells: 4 blank cells, one per row where possible
  const zeros = [];
  for (let k = 0; k < 16; k++) if (puzzle[Math.floor(k / 4)][k % 4] === 0) zeros.push([Math.floor(k / 4), k % 4]);
  const blanks = [];
  for (let rr = 0; rr < 4; rr++) { const z = shuffle(r, zeros.filter(([a]) => a === rr))[0]; if (z) blanks.push(z); }
  for (const z of shuffle(r, zeros)) if (blanks.length < 4 && !blanks.includes(z)) blanks.push(z);
  const order = shuffle(r, blanks).slice(0, 4);
  const code = order.map(([rr, cc]) => sol[rr][cc]).join('');
  const LET = 'ABCD';
  const rowTxt = (rr) => puzzle[rr].map((v) => (v ? String(v) : '·')).join(' ');
  const cellName = ([rr, cc]) => `row ${rr + 1}, column ${cc + 1}`;
  add({
    id: `${kind}-sudoku-${n}`, family: 'sudoku', kind, tags, category: 'logic', difficulty: 2,
    title: 'Mini Sudoku Vault',
    objective: 'A 4×4 sudoku: every row, column and 2×2 box holds 1, 2, 3, 4 once. Scout holds the top half, Decoder the bottom half. Intel knows which cells make the code.',
    clues: {
      scout: { title: 'Top half (rows 1–2)', body: `${rowTxt(0)}\n${rowTxt(1)}\n— — — —\n? ? ? ?\n? ? ? ?`, mono: true, grid: { rows: [puzzle[0], puzzle[1], null, null] } },
      decoder: { title: 'Bottom half (rows 3–4)', body: `? ? ? ?\n? ? ? ?\n— — — —\n${rowTxt(2)}\n${rowTxt(3)}`, mono: true, grid: { rows: [null, null, puzzle[2], puzzle[3]] } },
      intel: { title: 'Code cells', body: order.map((c, i) => `${LET[i]} = ${cellName(c)}`).join('\n') + '\n\nCode = A B C D', mono: true },
    },
    parts: [{ label: '4-digit code', accept: [code] }],
    hint: 'Fill the cells you are sure of first: a row or 2×2 box with three numbers has only one choice left.',
    explanation: `Solved grid: ${sol.map((row) => row.join('')).join(' / ')} → ${code}`,
    time_limit: kind === 'battle' ? 120 : META[kind].time + 40,
  });
}

// ───────────── Fruit Slash (Scout plays; Intel names the fruits; Decoder transforms) ─────────────
const FRUITS = ['🍉', '🍌', '🍓', '🍍', '🍎', '🥝', '🍊', '🍇', '🥭', '🍒'];
const FRUIT_NAMES = { '🍉': 'Watermelon', '🍌': 'Banana', '🍓': 'Strawberry', '🍍': 'Pineapple', '🍎': 'Apple', '🥝': 'Kiwi', '🍊': 'Orange', '🍇': 'Grapes', '🥭': 'Mango', '🍒': 'Cherry' };
const TRANSFORMS = [
  { text: 'Add 1 to every digit (9 becomes 0).', f: (ds) => ds.map((x) => (x + 1) % 10), why: '+1 to each digit' },
  { text: 'Read the digits in REVERSE order.', f: (ds) => [...ds].reverse(), why: 'reversed' },
  { text: 'Subtract each digit from 9.', f: (ds) => ds.map((x) => 9 - x), why: '9 minus each digit' },
  { text: 'Add 3 to every digit and keep only the last digit (8 → 1).', f: (ds) => ds.map((x) => (x + 3) % 10), why: '+3 to each digit, last digit only' },
  { text: 'Swap the first two digits and the last two digits.', f: (ds) => [ds[1], ds[0], ds[3], ds[2]], why: 'pairs swapped' },
];
function fruitSlash(n, kind, tags) {
  const r = rng(7700 + n * 13);
  const fruits = shuffle(r, FRUITS).slice(0, 6);
  const digits = shuffle(r, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).slice(0, 6);
  const map = fruits.map((f, i) => ({ f, d: digits[i] }));
  const target = shuffle(r, map).slice(0, 4);
  const tf = TRANSFORMS[n % TRANSFORMS.length];
  const code = tf.f(target.map((x) => x.d)).join('');
  add({
    id: `${kind}-fruit-${n}`, family: 'fruit', kind, tags, category: 'game', difficulty: 1,
    title: 'Fruit Slash',
    objective: 'Scout plays Fruit Slash: slicing a fruit reveals its hidden digit. Intel knows which fruits make the vault code. Decoder knows how to scramble it.',
    clues: {
      scout: {
        title: 'Fruit Slash', body: 'Swipe across flying fruit to slice it. Each fruit type always hides the same digit. Avoid the 💣 (it just costs you time). Call out what you find.',
        game: { type: 'fruit', fruits: map, bomb: true, seconds: 30 },
      },
      intel: { title: 'Vault order', body: `${target.map((x) => x.f).join('   ')}\n(${target.map((x) => FRUIT_NAMES[x.f]).join(', ')})`, big: true },
      decoder: { title: 'Scramble rule', body: tf.text },
    },
    parts: [{ label: '4-digit vault code', accept: [code] }],
    hint: 'Scout: shout every fruit and digit you slice. Intel: tell everyone which four fruits matter, in order.',
    explanation: `${target.map((x) => `${x.f}=${x.d}`).join(' ')} → ${tf.why} → ${code}`,
  });
}

export function buildMissions2() {
  T.length = 0;
  // Picture riddles
  packTriples(PIC.slice(0, 15), 5, (i, items) => triple({ id: `mission-pic-${i}`, family: 'picture', kind: 'mission', tags: ['any', 'learning', 'social', 'office', 'coffee', 'public'], category: 'picture', title: 'Picture Riddles', objective: 'Each teammate holds one picture riddle: two pictures make one word. Solve all three.', items, panelTitle: 'Picture', hint: 'Say each emoji out loud and join the words: 🪜 + 👨 = STEP + FATHER.', big: true }));
  packTriples(PIC.slice(15, 21), 2, (i, items) => triple({ id: `recovery-pic-${i}`, family: 'picture', kind: 'recovery', tags: ['any'], category: 'picture', title: 'Picture Riddles', objective: 'Get back on your feet: two pictures make one word. Solve all three.', items, panelTitle: 'Picture', hint: 'Say the emoji out loud and join the words.', big: true }));
  // Riddles
  packTriples(RIDDLES, 5, (i, items) => triple({ id: `mission-riddle-${i}`, family: 'riddle', kind: 'mission', tags: ['any', 'learning', 'office', 'social', 'hr', 'glass'], category: 'riddle', title: 'Riddle Room', objective: 'Each teammate holds one riddle. Answer all three — one or two words each.', items, panelTitle: 'Riddle', hint: 'Think of everyday objects. Answers are short nouns.' }));
  // Emoji movies
  packTriples(MOVIES.slice(0, 12), 4, (i, items) => triple({ id: `mission-movie-${i}`, family: 'movie', kind: 'mission', tags: ['any', 'social', 'food', 'costa', 'sports', 'public'], category: 'movies', title: 'Emoji Cinema', objective: 'Each teammate holds a movie told in emoji. Name all three films.', items, panelTitle: 'Film', hint: 'Mix of Hollywood and Indian blockbusters. Spelling of "The" is optional.', big: true }));
  packTriples(MOVIES.slice(12, 18), 2, (i, items) => triple({ id: `battle-movie-${i}`, family: 'movie', kind: 'battle', tags: ['duel_pistol'], category: 'movies', title: 'Emoji Cinema Duel', objective: 'Duel! Name all three films before the other squad does.', items, panelTitle: 'Film', hint: 'Say the emoji out loud.', big: true }));
  // Tech quick-fire
  packTriples(TECH.slice(0, 12), 4, (i, items) => triple({ id: `mission-tech-${i}`, family: 'techquick', kind: 'mission', tags: ['any', 'stg', 'testing', 'helpdesk', 'learning', 'phase2', 'hexavarsity'], category: 'tech', title: 'Tech Quick-Fire', objective: 'Three quick tech questions, one per teammate. One word each.', items, panelTitle: 'Question', hint: 'Every answer is one short word.' }));
  packTriples(TECH.slice(12, 18), 2, (i, items) => triple({ id: `battle-tech-${i}`, family: 'techquick', kind: 'battle', tags: ['duel_smg'], category: 'tech', title: 'Tech Quick-Fire Duel', objective: 'Rapid fire! Three one-word tech answers — fastest squad wins.', items, panelTitle: 'Question', hint: 'One word each.' }));
  // Sudoku
  for (let i = 0; i < 6; i++) sudoku(i, 'mission', ['any', 'learning', 'office', 'glass', 'observation', 'phase2']);
  for (let i = 0; i < 3; i++) sudoku(10 + i, 'battle', ['duel_sniper']);
  for (let i = 0; i < 3; i++) sudoku(20 + i, 'airdrop', ['any']);
  // Fruit Slash
  for (let i = 0; i < 6; i++) fruitSlash(i, 'mission', ['any', 'food', 'healing', 'social', 'costa', 'sports', 'market']);
  for (let i = 0; i < 4; i++) fruitSlash(10 + i, 'airdrop', ['any']);
  return T;
}

// self-check when run directly: every sudoku is unique, every code matches its explanation
if (import.meta.url === `file://${process.argv[1]}`) {
  const all = buildMissions2();
  console.log(all.length, 'templates', all.reduce((m, t) => ({ ...m, [t.family]: (m[t.family] || 0) + 1 }), {}));
  for (const t of all.filter((x) => x.family === 'sudoku')) console.log(t.id, t.parts[0].accept[0], t.explanation);
}
export { norm };
