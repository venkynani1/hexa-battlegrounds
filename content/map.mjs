// Editable campus map. Stylised and conceptual: positions follow the organiser's
// described relationships (Gate 1 south, Gate 3 north, Gate 4 west, Gate 2 east)
// and are NOT geographically accurate. Confirm against an approved campus plan.
//
// x, y are normalised 0..1 (north is up). collapse = zone stage at which the
// location becomes dangerous (99 = never; TR14 is the final safe zone).

export const LOCATIONS = [
  // id, name, building, floor, x, y, kind, collapse, risk, reward, tags, drop, loot
  ['sipcot', 'SIPCOT Entrance', null, null, 0.5, 1.07, 'start', 0, 0, 'Shuttle boarding', ['start'], false, []],
  ['gate_1', 'Gate 1', null, null, 0.5, 0.93, 'gate', 3, 1, 'Access codes', ['gate', 'access'], false, ['medkit', 'pistol']],
  ['gate_2', 'Gate 2 Checkpoint', null, null, 0.93, 0.5, 'gate', 1, 2, 'Access codes', ['gate', 'access'], true, ['scanner', 'smg']],
  ['gate_3', 'Gate 3 (Sealed Mystery Zone)', null, null, 0.5, 0.07, 'gate', 1, 3, 'Rare intel', ['gate', 'access', 'transmission'], true, ['sniper', 'jammer']],
  ['gate_4', 'Gate 4 (Dark Signal Zone)', null, null, 0.07, 0.5, 'gate', 1, 3, 'Rare intel', ['gate', 'access', 'transmission'], true, ['beacon', 'sniper']],

  ['hx_lobby', 'Hexavarsity Lobby', 'hexavarsity', '0', 0.5, 0.74, 'building', 5, 1, 'Learning loot', ['hexavarsity', 'learning'], true, ['medkit', 'shield']],
  ['hx_help', 'Help Center (B1)', 'hexavarsity', '-1', 0.44, 0.79, 'room', 5, 1, 'Support kits', ['hexavarsity', 'helpdesk'], false, ['medkit', 'scanner']],
  ['hx_costa', 'Costa Coffee (G)', 'hexavarsity', '0', 0.56, 0.79, 'room', 5, 1, 'Coins', ['costa', 'coffee'], true, ['medkit', 'beacon']],
  ['hx_tr_wing2', 'Training Rooms 1–13 (F2)', 'hexavarsity', '2', 0.44, 0.69, 'room', 5, 2, 'Weapons', ['hexavarsity', 'learning'], false, ['smg', 'shield']],
  ['hx_pantry2', 'F2 Pantry', 'hexavarsity', '2', 0.4, 0.73, 'room', 5, 1, 'Healing', ['food', 'healing'], false, ['medkit']],
  ['hx_tr_wing3', 'Training Rooms 15–19 (F3)', 'hexavarsity', '3', 0.56, 0.69, 'room', 5, 2, 'Weapons', ['hexavarsity', 'learning'], false, ['sniper', 'shield']],
  ['hx_odc', 'ODC (F3)', 'hexavarsity', '3', 0.6, 0.73, 'room', 5, 2, 'Intel', ['office', 'stg'], false, ['scanner', 'jammer']],
  ['tr14', 'Training Room 14 — Final Battleground', 'hexavarsity', '3', 0.5, 0.65, 'room', 99, 3, 'The finale', ['finale', 'hexavarsity'], false, ['shield']],

  ['eb2_lobby', 'EB2 Entrance', 'eb2', '0', 0.27, 0.74, 'building', 3, 1, 'Mixed', ['office'], true, ['pistol', 'medkit']],
  ['eb2_stg', 'EB2 STG Zone (F1)', 'eb2', '1', 0.22, 0.7, 'room', 3, 2, 'Weapons', ['stg', 'testing'], false, ['smg', 'scanner']],
  ['eb2_floors', 'EB2 Team Floors', 'eb2', '2–5', 0.22, 0.78, 'room', 3, 1, 'Coins', ['office'], false, ['medkit']],
  ['eb2_terrace', 'EB2 Terrace Garden', 'eb2', 'T', 0.17, 0.74, 'room', 2, 2, 'Rare loot', ['terrace', 'observation'], false, ['sniper', 'beacon']],
  ['eb2_parking', 'EB2 Parking', 'eb2', 'B', 0.3, 0.8, 'room', 2, 1, 'Supplies', ['parking', 'access'], false, ['extract', 'medkit']],

  ['p2_lobby', 'Phase 2 Entrance', 'phase2', '0', 0.76, 0.84, 'building', 2, 1, 'Mixed', ['phase2'], true, ['pistol']],
  ['p2_parking', 'Phase 2 Basement Parking', 'phase2', 'B', 0.82, 0.88, 'room', 2, 1, 'Supplies', ['parking', 'access'], false, ['extract', 'medkit']],
  ['p2_floors', 'Phase 2 Floors 1–2', 'phase2', '1–2', 0.82, 0.8, 'room', 2, 2, 'Transmissions', ['phase2', 'transmission'], false, ['scanner', 'smg']],
  ['p2_upper', 'Phase 2 Floors 3–5', 'phase2', '3–5', 0.87, 0.76, 'room', 2, 3, 'High-value loot', ['phase2', 'transmission'], false, ['sniper', 'shield', 'beacon']],

  ['rt_lobby', 'Ratan Tata Building', 'rtb', '0', 0.5, 0.22, 'building', 3, 1, 'Mixed', ['office'], true, ['pistol', 'medkit']],
  ['rt_cec', 'CEC Boardroom (G)', 'rtb', '0', 0.44, 0.18, 'room', 3, 2, 'Intel', ['boardroom'], false, ['scanner', 'jammer']],
  ['rt_floors', 'RTB Team Floors', 'rtb', '1–4', 0.56, 0.18, 'room', 3, 1, 'Coins', ['office'], false, ['medkit']],
  ['rt_glass', 'Glass Reflection Zone', 'rtb', '4', 0.6, 0.14, 'room', 3, 2, 'Rare loot', ['glass', 'observation'], false, ['sniper', 'shield']],
  ['rt_parking', 'RTB Parking', 'rtb', 'B', 0.4, 0.14, 'room', 2, 1, 'Supplies', ['parking', 'access'], false, ['extract']],

  ['eb1_lobby', 'EB1 Entrance', 'eb1', '0', 0.75, 0.26, 'building', 2, 1, 'Mixed', ['office'], true, ['pistol', 'medkit']],
  ['eb1_floors', 'EB1 Team Floors', 'eb1', '1–5', 0.8, 0.21, 'room', 2, 1, 'Coins', ['office'], false, ['medkit', 'scanner']],
  ['eb1_terrace', 'EB1 Terrace Garden', 'eb1', 'T', 0.85, 0.25, 'room', 2, 2, 'Rare loot', ['terrace', 'observation'], false, ['sniper', 'beacon']],
  ['eb1_parking', 'EB1 Parking', 'eb1', 'B', 0.78, 0.31, 'room', 2, 1, 'Supplies', ['parking', 'access'], false, ['extract']],

  ['eb3_lobby', 'EB3 Entrance', 'eb3', '0', 0.22, 0.45, 'building', 3, 1, 'Mixed', ['office'], true, ['pistol', 'medkit']],
  ['eb3_hr', 'EB3 HR Zone (G)', 'eb3', '0', 0.17, 0.41, 'room', 3, 2, 'Trust', ['hr'], false, ['shield', 'scanner']],
  ['eb3_floors', 'EB3 Team Floors', 'eb3', '1–5', 0.17, 0.49, 'room', 3, 1, 'Coins', ['office'], false, ['medkit']],
  ['eb3_terrace', 'EB3 Terrace Garden', 'eb3', 'T', 0.13, 0.45, 'room', 2, 2, 'Rare loot', ['terrace', 'observation'], false, ['sniper', 'beacon']],
  ['eb3_parking', 'EB3 Parking', 'eb3', 'B', 0.26, 0.5, 'room', 2, 1, 'Supplies', ['parking', 'access'], false, ['extract']],

  ['central_steps', 'Central Steps', 'central', '0', 0.47, 0.58, 'hub', 5, 1, 'Approach route', ['public', 'social'], true, ['medkit']],
  ['hexadine', 'Hexadine', 'central', '0', 0.45, 0.47, 'amenity', 4, 1, 'Market', ['market', 'food'], true, ['medkit', 'shield']],
  ['hexaraunt', 'Hexaraunt (B)', 'central', '-1', 0.4, 0.51, 'amenity', 4, 1, 'Healing', ['food', 'healing'], false, ['medkit', 'medkit']],
  ['hexacafe', 'Hexacafe (B)', 'central', '-1', 0.53, 0.51, 'amenity', 4, 1, 'Intel market', ['social', 'coffee'], false, ['scanner', 'jammer']],
  ['fountain', 'Central Fountain', 'central', '0', 0.53, 0.41, 'amenity', 4, 3, 'Airdrops', ['airdrop', 'public'], true, ['beacon', 'sniper']],

  ['shuttle_court', 'Shuttle Court', 'sports', '0', 0.33, 0.33, 'sports', 1, 2, 'Sports loot', ['sports'], true, ['smg']],
  ['pickleball', 'Pickleball Court', 'sports', '0', 0.68, 0.64, 'sports', 1, 2, 'Sports loot', ['sports'], true, ['smg', 'medkit']],
  ['cricket', 'Cricket Ground', 'sports', '0', 0.12, 0.66, 'sports', 1, 2, 'Sports loot', ['sports'], true, ['sniper', 'pistol']],
];

// [a, b, travel seconds]
export const EDGES = [
  ['gate_1', 'hx_lobby', 15], ['gate_1', 'p2_lobby', 20], ['gate_1', 'eb2_lobby', 25],
  ['hx_lobby', 'hx_costa', 8], ['hx_lobby', 'hx_help', 8], ['hx_lobby', 'hx_tr_wing2', 12],
  ['hx_tr_wing2', 'hx_pantry2', 6], ['hx_tr_wing2', 'hx_tr_wing3', 10], ['hx_tr_wing3', 'tr14', 6],
  ['hx_tr_wing3', 'hx_odc', 6], ['tr14', 'hx_odc', 6],
  ['hx_lobby', 'central_steps', 15], ['hx_lobby', 'pickleball', 15], ['hx_lobby', 'eb2_lobby', 20],
  ['eb2_lobby', 'eb2_stg', 8], ['eb2_lobby', 'eb2_floors', 10], ['eb2_floors', 'eb2_terrace', 10],
  ['eb2_lobby', 'eb2_parking', 10], ['eb2_lobby', 'cricket', 25], ['eb2_lobby', 'eb3_lobby', 25],
  ['p2_lobby', 'p2_parking', 8], ['p2_lobby', 'p2_floors', 10], ['p2_floors', 'p2_upper', 10],
  ['p2_lobby', 'pickleball', 15], ['p2_lobby', 'gate_2', 25],
  ['central_steps', 'hexadine', 8], ['central_steps', 'hexacafe', 8], ['hexadine', 'hexaraunt', 6],
  ['hexacafe', 'hexaraunt', 6], ['hexadine', 'fountain', 10], ['hexacafe', 'fountain', 10],
  ['central_steps', 'eb3_lobby', 18], ['central_steps', 'pickleball', 15],
  ['fountain', 'rt_lobby', 15], ['fountain', 'eb1_lobby', 20], ['fountain', 'shuttle_court', 18],
  ['rt_lobby', 'rt_cec', 8], ['rt_lobby', 'rt_floors', 10], ['rt_floors', 'rt_glass', 10],
  ['rt_lobby', 'rt_parking', 10], ['rt_lobby', 'eb1_lobby', 15], ['rt_lobby', 'gate_3', 20],
  ['rt_lobby', 'shuttle_court', 15],
  ['eb1_lobby', 'eb1_floors', 10], ['eb1_floors', 'eb1_terrace', 10], ['eb1_lobby', 'eb1_parking', 10],
  ['eb1_lobby', 'gate_2', 25],
  ['eb3_lobby', 'eb3_hr', 8], ['eb3_lobby', 'eb3_floors', 10], ['eb3_floors', 'eb3_terrace', 10],
  ['eb3_lobby', 'eb3_parking', 10], ['eb3_lobby', 'gate_4', 20], ['eb3_lobby', 'shuttle_court', 15],
  ['gate_4', 'cricket', 15],
];

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
