// Editable campus map. Stylised and conceptual: Gate 1 south, Gate 3 north, Gate 4 west,
// Gate 2 east. NOT geographically accurate — confirm against an approved campus plan.
//
// x, y are normalised 0..1 (north is up). Buildings have floors: a room's `level` is its storey
// (0 = ground). Squads climb the stairwell to reach upper floors. collapse = zone stage at which
// the location becomes dangerous (99 = never; Training Room 14 is the final safe zone).
import { BUILDINGS, building } from './campus.mjs';

export { BUILDINGS };

// Rooms: id, name, building, level, slot (0..2 north row, 3..5 south row; 2-column buildings use 0,1 / 2,3),
//        kind, risk, reward, tags, drop, loot
const ROOMS = [
  // Hexavarsity — 4 floors; Training Room 14 on the top floor is the finale arena
  ['hx_lobby', 'Hexavarsity Lobby', 'hexavarsity', 0, 4, 'building', 1, 'Learning loot', ['hexavarsity', 'learning'], true, ['medkit', 'shield']],
  ['hx_costa', 'Costa Coffee', 'hexavarsity', 0, 0, 'room', 1, 'Coins', ['costa', 'coffee', 'social'], true, ['medkit', 'beacon']],
  ['hx_help', 'Help Center', 'hexavarsity', 0, 1, 'room', 1, 'Support kits', ['hexavarsity', 'helpdesk'], false, ['medkit', 'scanner']],
  ['hx_tr1', 'Training Rooms 1–4', 'hexavarsity', 1, 0, 'room', 2, 'Weapons', ['hexavarsity', 'learning'], false, ['smg', 'medkit']],
  ['hx_tr5', 'Training Rooms 5–8', 'hexavarsity', 1, 2, 'room', 2, 'Weapons', ['hexavarsity', 'learning'], false, ['smg', 'shield']],
  ['hx_pantry1', 'F1 Pantry', 'hexavarsity', 1, 4, 'room', 1, 'Healing', ['food', 'healing'], false, ['medkit']],
  ['hx_tr_wing2', 'Training Rooms 9–13', 'hexavarsity', 2, 0, 'room', 2, 'Weapons', ['hexavarsity', 'learning'], false, ['smg', 'shield']],
  ['hx_library', 'Learning Library', 'hexavarsity', 2, 2, 'room', 2, 'Intel', ['learning', 'observation'], false, ['scanner']],
  ['hx_pantry2', 'F2 Pantry', 'hexavarsity', 2, 4, 'room', 1, 'Healing', ['food', 'healing'], false, ['medkit']],
  ['tr14', 'Training Room 14 — Final Battleground', 'hexavarsity', 3, 1, 'room', 3, 'The finale', ['finale', 'hexavarsity'], false, ['shield']],
  ['hx_tr_wing3', 'Training Rooms 15–19', 'hexavarsity', 3, 3, 'room', 2, 'Weapons', ['hexavarsity', 'learning'], false, ['sniper', 'shield']],
  ['hx_odc', 'ODC', 'hexavarsity', 3, 5, 'room', 2, 'Intel', ['office', 'stg'], false, ['scanner', 'jammer']],
  // Phase 2 Tower — 5 floors
  ['p2_lobby', 'Phase 2 Lobby', 'phase2', 0, 4, 'building', 1, 'Mixed', ['phase2'], true, ['pistol']],
  ['p2_cafe', 'Phase 2 Café', 'phase2', 0, 0, 'room', 1, 'Coins', ['coffee', 'social'], false, ['medkit']],
  ['p2_f1', 'P2 Floor 1 · Dev Bay', 'phase2', 1, 0, 'room', 2, 'Weapons', ['phase2', 'office'], false, ['smg']],
  ['p2_tr1', 'P2 Training Room A', 'phase2', 1, 4, 'room', 2, 'Weapons', ['phase2', 'learning'], false, ['smg', 'medkit']],
  ['p2_floors', 'P2 Floor 2 · QA Lab', 'phase2', 2, 1, 'room', 2, 'Transmissions', ['phase2', 'testing', 'stg'], false, ['scanner', 'smg']],
  ['p2_tr2', 'P2 Training Room B', 'phase2', 2, 3, 'room', 2, 'Weapons', ['phase2', 'learning'], false, ['shield']],
  ['p2_f3', 'P2 Floor 3 · Design Studio', 'phase2', 3, 0, 'room', 2, 'Intel', ['phase2', 'glass'], false, ['scanner']],
  ['p2_server', 'P2 Server Room', 'phase2', 3, 5, 'room', 3, 'High-value loot', ['phase2', 'testing'], false, ['jammer', 'shield']],
  ['p2_upper', 'P2 Floor 4 · Leadership Suite', 'phase2', 4, 1, 'room', 3, 'High-value loot', ['phase2', 'boardroom'], false, ['sniper', 'shield', 'beacon']],
  ['p2_sky', 'Sky Lounge', 'phase2', 4, 4, 'room', 3, 'Rare loot', ['terrace', 'observation'], false, ['sniper', 'beacon']],
  // Ratan Tata Building — 5 floors
  ['rt_lobby', 'Ratan Tata Building Lobby', 'rtb', 0, 4, 'building', 1, 'Mixed', ['office'], true, ['pistol', 'medkit']],
  ['rt_cec', 'CEC Boardroom', 'rtb', 0, 0, 'room', 2, 'Intel', ['boardroom'], false, ['scanner', 'jammer']],
  ['rt_floors', 'RTB Floor 1 · Delivery', 'rtb', 1, 0, 'room', 1, 'Coins', ['office'], false, ['medkit']],
  ['rt_tr', 'RTB Training Room', 'rtb', 1, 5, 'room', 2, 'Weapons', ['learning'], false, ['smg']],
  ['rt_f2', 'RTB Floor 2 · Finance', 'rtb', 2, 1, 'room', 1, 'Coins', ['office', 'hr'], false, ['medkit']],
  ['rt_war', 'War Room', 'rtb', 2, 4, 'room', 3, 'Intel', ['boardroom', 'stg'], false, ['scanner', 'sniper']],
  ['rt_f3', 'RTB Floor 3 · Cloud Ops', 'rtb', 3, 2, 'room', 2, 'Weapons', ['office', 'testing'], false, ['smg', 'shield']],
  ['rt_glass', 'Glass Reflection Zone', 'rtb', 4, 0, 'room', 2, 'Rare loot', ['glass', 'observation'], false, ['sniper', 'shield']],
  ['rt_exec', 'Executive Floor', 'rtb', 4, 4, 'room', 3, 'High-value loot', ['boardroom'], false, ['beacon', 'shield']],
  // EB1 / EB2 / EB3 — 4 floors each
  ['eb1_lobby', 'EB1 Lobby', 'eb1', 0, 3, 'building', 1, 'Mixed', ['office'], true, ['pistol', 'medkit']],
  ['eb1_cafe', 'EB1 Café', 'eb1', 0, 0, 'room', 1, 'Coins', ['coffee', 'social'], false, ['medkit']],
  ['eb1_floors', 'EB1 Floor 1 · Delivery', 'eb1', 1, 0, 'room', 1, 'Coins', ['office'], false, ['medkit', 'scanner']],
  ['eb1_tr', 'EB1 Training Room', 'eb1', 1, 3, 'room', 2, 'Weapons', ['learning'], false, ['smg']],
  ['eb1_lab', 'EB1 Innovation Lab', 'eb1', 2, 1, 'room', 2, 'Intel', ['testing', 'stg'], false, ['scanner']],
  ['eb1_terrace', 'EB1 Terrace Garden', 'eb1', 3, 2, 'room', 2, 'Rare loot', ['terrace', 'observation'], false, ['sniper', 'beacon']],
  ['eb2_lobby', 'EB2 Lobby', 'eb2', 0, 3, 'building', 1, 'Mixed', ['office'], true, ['pistol', 'medkit']],
  ['eb2_stg', 'EB2 STG Zone', 'eb2', 1, 0, 'room', 2, 'Weapons', ['stg', 'testing'], false, ['smg', 'scanner']],
  ['eb2_tr', 'EB2 Training Room', 'eb2', 1, 3, 'room', 2, 'Weapons', ['learning'], false, ['shield']],
  ['eb2_floors', 'EB2 Floor 2 · Team Bays', 'eb2', 2, 1, 'room', 1, 'Coins', ['office'], false, ['medkit']],
  ['eb2_terrace', 'EB2 Terrace Garden', 'eb2', 3, 2, 'room', 2, 'Rare loot', ['terrace', 'observation'], false, ['sniper', 'beacon']],
  ['eb3_lobby', 'EB3 Lobby', 'eb3', 0, 3, 'building', 1, 'Mixed', ['office'], true, ['pistol', 'medkit']],
  ['eb3_hr', 'EB3 HR Zone', 'eb3', 0, 0, 'room', 2, 'Trust', ['hr'], false, ['shield', 'scanner']],
  ['eb3_floors', 'EB3 Floor 1 · Team Bays', 'eb3', 1, 1, 'room', 1, 'Coins', ['office'], false, ['medkit']],
  ['eb3_tr', 'EB3 Training Room', 'eb3', 1, 2, 'room', 2, 'Weapons', ['learning'], false, ['smg']],
  ['eb3_quiet', 'EB3 Quiet Room', 'eb3', 2, 0, 'room', 2, 'Intel', ['observation'], false, ['jammer']],
  ['eb3_terrace', 'EB3 Terrace Garden', 'eb3', 3, 3, 'room', 2, 'Rare loot', ['terrace', 'observation'], false, ['sniper', 'beacon']],
  // single-storey buildings
  ['hexadine', 'Hexadine Market', 'foodcourt', 0, 0, 'amenity', 1, 'Market', ['market', 'food'], true, ['medkit', 'shield']],
  ['hexaraunt', 'Hexaraunt', 'foodcourt', 0, 1, 'amenity', 1, 'Healing', ['food', 'healing'], false, ['medkit', 'medkit']],
  ['hexacafe', 'Hexacafe', 'foodcourt', 0, 3, 'amenity', 1, 'Intel market', ['social', 'coffee'], false, ['scanner', 'jammer']],
  ['dc_hall', 'Data Center Hall', 'datacenter', 0, 0, 'room', 3, 'High-value loot', ['testing', 'stg'], true, ['jammer', 'shield']],
  ['dc_noc', 'Network Operations Center', 'datacenter', 0, 1, 'room', 2, 'Intel', ['helpdesk', 'testing'], false, ['scanner']],
  ['gym_floor', 'Fitness Center', 'gym', 0, 0, 'room', 1, 'Healing', ['sports', 'healing'], false, ['medkit']],
  ['gym_yoga', 'Yoga Studio', 'gym', 1, 1, 'room', 2, 'Rare loot', ['sports', 'observation'], false, ['shield']],
  ['sec_hq', 'Security Control Room', 'security', 0, 0, 'room', 2, 'Intel', ['access', 'helpdesk'], false, ['scanner', 'pistol']],
];

// Open-ground places: id, name, x, y, kind, risk, reward, tags, drop, loot
const OUTDOOR = [
  ['sipcot', 'SIPCOT Entrance', 0.47, 1.07, 'start', 0, 'Shuttle boarding', ['start'], false, []],
  ['gate_1', 'Gate 1', 0.47, 0.95, 'gate', 1, 'Access codes', ['gate', 'access'], false, ['medkit', 'pistol']],
  ['gate_2', 'Gate 2 Checkpoint', 0.955, 0.56, 'gate', 2, 'Access codes', ['gate', 'access'], true, ['scanner', 'smg']],
  ['gate_3', 'Gate 3 (Sealed Mystery Zone)', 0.47, 0.035, 'gate', 3, 'Rare intel', ['gate', 'access', 'transmission'], true, ['sniper', 'jammer']],
  ['gate_4', 'Gate 4 (Dark Signal Zone)', 0.035, 0.32, 'gate', 3, 'Rare intel', ['gate', 'access', 'transmission'], true, ['beacon', 'sniper']],
  ['fountain', 'Central Fountain', 0.47, 0.44, 'amenity', 3, 'Airdrops', ['airdrop', 'public'], true, ['beacon', 'sniper']],
  ['central_steps', 'Central Steps', 0.47, 0.53, 'hub', 1, 'Approach route', ['public', 'social'], true, ['medkit']],
  ['amphitheatre', 'Open-Air Amphitheatre', 0.565, 0.365, 'hub', 2, 'Crowd intel', ['public', 'social'], true, ['jammer']],
  ['cricket', 'Cricket Ground', 0.19, 0.19, 'sports', 2, 'Sports loot', ['sports'], true, ['sniper', 'pistol']],
  ['shuttle_court', 'Shuttle Court', 0.72, 0.475, 'sports', 2, 'Sports loot', ['sports'], true, ['smg']],
  ['pickleball', 'Pickleball Court', 0.585, 0.495, 'sports', 2, 'Sports loot', ['sports'], true, ['smg', 'medkit']],
  ['helipad', 'Helipad', 0.86, 0.13, 'amenity', 3, 'Airdrops', ['airdrop', 'public'], true, ['sniper', 'beacon']],
  ['solar', 'Solar Farm', 0.86, 0.245, 'amenity', 2, 'Supplies', ['public'], true, ['shield']],
  ['water_tower', 'Water Tower', 0.27, 0.27, 'amenity', 2, 'Lookout', ['observation'], true, ['sniper']],
  ['park_sw', 'South-West Parking Yard', 0.27, 0.89, 'parking', 1, 'Supplies', ['parking', 'access'], true, ['extract', 'medkit']],
  ['park_se', 'South-East Parking Yard', 0.73, 0.89, 'parking', 1, 'Supplies', ['parking', 'access'], true, ['extract', 'medkit']],
  ['park_dc', 'Data Center Parking', 0.7325, 0.40, 'parking', 1, 'Supplies', ['parking'], false, ['extract']],
  ['bus_bay', 'Shuttle Bus Bay', 0.40, 0.97, 'hub', 1, 'Supplies', ['parking', 'access', 'public'], false, ['medkit']],
  ['lotus_pond', 'Lotus Pond', 0.06, 0.9, 'amenity', 2, 'Healing', ['healing', 'public'], true, ['medkit']],
];

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const r3 = (v) => Math.round(v * 1000) / 1000;
const TR14 = (() => { const r = ROOMS.find((x) => x[0] === 'tr14'); const b = building(r[2]); return b.slots[r[4]]; })();
// legacy zone-stage collapse: far from Training Room 14 collapses first
const collapseAt = (x, y) => { const d = dist([x, y], TR14); return d > 0.5 ? 1 : d > 0.36 ? 2 : d > 0.24 ? 3 : d > 0.14 ? 4 : 5; };

// id, name, building, floor, x, y, kind, collapse, risk, reward, tags, drop, loot, level
export const LOCATIONS = [];
for (const [id, name, x, y, kind, risk, reward, tags, drop, loot] of OUTDOOR) {
  LOCATIONS.push([id, name, null, null, x, y, kind, kind === 'start' ? 0 : collapseAt(x, y), risk, reward, tags, drop, loot, 0]);
}
for (const [id, name, bid, level, slot, kind, risk, reward, tags, drop, loot] of ROOMS) {
  const b = building(bid);
  const slots = b.slots;
  if (slot >= slots.length) throw new Error(`${id}: slot ${slot} does not exist in ${bid}`);
  const [x, y] = slots[slot];
  const floor = level === 0 ? 'G' : String(level);
  LOCATIONS.push([id, name, bid, floor, r3(x), r3(y), kind, id === 'tr14' ? 99 : collapseAt(x, y), risk, reward, [...tags, bid], drop && level === 0, loot, level]);
}
// stairwells (ground floor) for every multi-storey building: squads run here, then climb
for (const [bid, name, , , , , floors] of BUILDINGS) {
  if (floors < 2) continue;
  const b = building(bid);
  LOCATIONS.push([`${bid}_stairs`, `${name} Stairwell`, bid, 'G', r3(b.stairs[0]), r3(b.stairs[1]), 'stairs', collapseAt(...b.stairs), 1, 'Stairs to every floor', ['stairs', bid], false, [], 0]);
}
// sanity: no two places on the same floor of the same building overlap (radius 0.018)
for (const a of LOCATIONS) for (const b of LOCATIONS) {
  if (a === b || a[13] !== b[13] || (a[2] || '') !== (b[2] || '') || a[6] === 'start') continue;
  if (dist([a[4], a[5]], [b[4], b[5]]) < 0.036) throw new Error(`${a[0]} overlaps ${b[0]}`);
}

// Old ids that no longer exist: kept in the database (disabled) so history stays valid.
export const RETIRED = ['eb2_parking', 'p2_parking', 'rt_parking', 'eb1_parking', 'eb3_parking'];

// Edges (travel graph for "nearest safe place"): each place links to the 3 nearest places it can
// reach on its own floor, upper floors link through their building's stairwell / lobby.
export const EDGES = (() => {
  const out = new Map();
  const add = (a, b) => {
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (out.has(k)) return;
    const A = LOCATIONS.find((l) => l[0] === a); const B = LOCATIONS.find((l) => l[0] === b);
    out.set(k, [a < b ? a : b, a < b ? b : a, Math.max(4, Math.round(dist([A[4], A[5]], [B[4], B[5]]) / 0.016))]);
  };
  const ground = LOCATIONS.filter((l) => l[13] === 0 && l[6] !== 'start');
  for (const l of ground) {
    ground.filter((o) => o !== l).sort((p, q) => dist([l[4], l[5]], [p[4], p[5]]) - dist([l[4], l[5]], [q[4], q[5]]))
      .slice(0, 3).forEach((o) => add(l[0], o[0]));
  }
  for (const l of LOCATIONS.filter((x) => x[13] > 0)) {
    const sameFloor = LOCATIONS.filter((o) => o !== l && o[2] === l[2] && o[13] === l[13]);
    sameFloor.forEach((o) => add(l[0], o[0]));
    const below = LOCATIONS.filter((o) => o[2] === l[2] && o[13] === l[13] - 1);
    if (below.length) add(l[0], below[0][0]);
    const st = LOCATIONS.find((o) => o[0] === `${l[2]}_stairs`);
    if (st && l[13] === 1) add(l[0], st[0]);
  }
  add('sipcot', 'gate_1');
  return [...out.values()];
})();

export const ITEMS = [
  // id, name, kind, description, params, price
  ['pistol', 'Pistol', 'weapon', 'Starts a standard puzzle duel. Never used up.', { damage: 25, tag: 'duel_pistol', seconds: 90, consumable: false }, 0],
  ['smg', 'SMG', 'weapon', 'Fast duel: short timer, lower damage. One use.', { damage: 20, tag: 'duel_smg', seconds: 50, consumable: true }, 40],
  ['sniper', 'Sniper', 'weapon', 'Hard logic duel: long timer, high damage. One use.', { damage: 40, tag: 'duel_sniper', seconds: 120, consumable: true }, 60],
  ['shield', 'Shield', 'defense', 'Absorbs the next 30 damage.', { shield: 30 }, 35],
  ['medkit', 'Med Kit', 'heal', 'Restores 30 HP (max 100).', { heal: 30 }, 30],
  ['scanner', 'Intel Scanner', 'intel', 'Reveals every squad position (even jammed) for 60 s.', { seconds: 60 }, 30],
  ['jammer', 'Signal Jammer', 'stealth', 'Hides your squad from the public map for 120 s.', { seconds: 120 }, 30],
  ['beacon', 'Airdrop Beacon', 'airdrop', 'Your next airdrop win gives double coins.', {}, 25],
  ['extract', 'Emergency Extract', 'move', 'Instantly relocate to the nearest safe zone location.', {}, 40],
];
