// Campus layout shared by the database content (scripts/build-content.mjs) and the 3D world
// (src/three). Coordinates are normalised 0..1 (x east, y south); the 3D world is S = 560 units
// wide and the maps show it as a 1.6 km campus. Stylised, not a survey of the real campus.
//
// Streets: a grid at x = 0.08 / 0.30 / 0.64 / 0.92 and y = 0.06 / 0.32 / 0.56 / 0.79,
// plus the Gate 1 boulevard (x = 0.47) and the gate spurs.

export const FLOOR_H = 4.2; // world units per storey

// id, name, x0, y0, x1, y1, floors, style
export const BUILDINGS = [
  ['hexavarsity', 'Hexavarsity', 0.37, 0.60, 0.57, 0.74, 4, 'learning'],
  ['phase2', 'Phase 2 Tower', 0.70, 0.60, 0.84, 0.75, 5, 'tower'],
  ['rtb', 'Ratan Tata Building', 0.38, 0.12, 0.56, 0.26, 5, 'brick'],
  ['eb1', 'EB1', 0.68, 0.10, 0.80, 0.24, 4, 'office'],
  ['eb2', 'EB2', 0.11, 0.60, 0.23, 0.74, 4, 'office'],
  ['eb3', 'EB3', 0.11, 0.36, 0.23, 0.50, 4, 'office'],
  ['foodcourt', 'Food Court', 0.32, 0.37, 0.41, 0.51, 1, 'pavilion'],
  ['datacenter', 'Data Center', 0.78, 0.36, 0.90, 0.46, 1, 'datacenter'],
  ['gym', 'Fitness Center', 0.245, 0.35, 0.29, 0.47, 2, 'pavilion'],
  ['security', 'Security HQ', 0.50, 0.835, 0.555, 0.875, 1, 'office'],
];

export const building = (id) => {
  const b = BUILDINGS.find((x) => x[0] === id);
  if (!b) return null;
  const [bid, name, x0, y0, x1, y1, floors, style] = b;
  const w = x1 - x0; const d = y1 - y0;
  const cols = w >= 0.14 ? [0.2, 0.5, 0.8] : w >= 0.08 ? [0.3, 0.7] : [0.5];
  const narrow = cols.length === 1;
  const rows = narrow ? [0.15, 0.85] : [0.28, 0.72];
  const corridor = y0 + d * 0.5;
  const stairs = narrow ? [x0 + w * 0.5, corridor] : [x1 - w * 0.1, corridor];
  return {
    id: bid, name, x0, y0, x1, y1, w, d, floors, style, corridor, stairs,
    door: [x0 + w / 2, y1 + 0.014],
    // room slots: N1..Nn (north row) then S1..Sn (south row)
    slots: [...rows.flatMap((r) => cols.map((c) => [x0 + w * c, y0 + d * r]))],
  };
};

// Streets as polylines [x, y][] with a width in campus units.
export const ROADS = [
  { w: 0.016, pts: [[0.08, 0.06], [0.92, 0.06], [0.92, 0.79], [0.08, 0.79], [0.08, 0.06]] }, // ring
  { w: 0.014, pts: [[0.30, 0.06], [0.30, 0.79]] },
  { w: 0.014, pts: [[0.64, 0.06], [0.64, 0.79]] },
  { w: 0.014, pts: [[0.03, 0.32], [0.92, 0.32]] }, // to Gate 4
  { w: 0.014, pts: [[0.08, 0.56], [0.97, 0.56]] }, // to Gate 2
  { w: 0.02, pts: [[0.47, 0.79], [0.47, 1.0]] },   // Gate 1 boulevard
  { w: 0.012, pts: [[0.47, 0.0], [0.47, 0.06]] },  // Gate 3 spur
];

// Parking yards: rectangle + rows of bays (cars drawn inside), all open ground
export const LOTS = [
  { id: 'park_sw', x0: 0.12, y0: 0.83, x1: 0.42, y1: 0.95, rows: 4, roof: true },
  { id: 'park_se', x0: 0.58, y0: 0.83, x1: 0.88, y1: 0.95, rows: 4, roof: false },
  { id: 'park_dc', x0: 0.70, y0: 0.37, x1: 0.765, y1: 0.43, rows: 2, roof: false },
];

// Plaza paving, sports grounds, water and other open-ground features drawn by the 3D world
export const FEATURES = [
  { kind: 'plaza', x: 0.47, y: 0.44, r: 0.07 },
  { kind: 'fountain', x: 0.47, y: 0.44, r: 0.022 },
  { kind: 'steps', x: 0.47, y: 0.555, w: 0.09, d: 0.03 },
  { kind: 'cricket', x: 0.19, y: 0.19, rx: 0.085, ry: 0.1 },
  { kind: 'court', x: 0.72, y: 0.475, w: 0.06, d: 0.04 },
  { kind: 'court', x: 0.585, y: 0.495, w: 0.045, d: 0.03 },
  { kind: 'amphi', x: 0.565, y: 0.365, r: 0.035 },
  { kind: 'helipad', x: 0.86, y: 0.13, r: 0.03 },
  { kind: 'solar', x0: 0.82, y0: 0.2, x1: 0.9, y1: 0.29 },
  { kind: 'pond', x: 0.06, y: 0.9, rx: 0.035, ry: 0.05 },
  { kind: 'tower', x: 0.27, y: 0.27, r: 0.012 },
  { kind: 'busbay', x0: 0.36, y0: 0.955, x1: 0.44, y1: 0.985 },
];
