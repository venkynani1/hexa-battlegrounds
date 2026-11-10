// Walls for walking on foot (client-side, presentation): buildings are entered through the front
// door; rooms through their door on the corridor. Same layout as the 3D interiors (world.ts).
import type { Building, MapData } from './game';

const S = 560; // campus width in world units (world.ts)
type Room = { x0: number; x1: number; y0: number; y1: number; doorY: number; dx0: number; dx1: number };
const cache = new Map<string, Room[]>();

export function roomsOf(map: MapData, b: Building, level: number): Room[] {
  const key = `${b.id}|${level}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const w = (b.x1 - b.x0) * S; const d = (b.y1 - b.y0) * S;
  const cellW = Math.min(w / 3.2, 22) / S; const cellD = Math.min((d - 6) / 2 - 0.5, 16) / S;
  const cy = (b.y0 + b.y1) / 2; const half = 2.5 / S; const gap = 1.6 / S;
  const out: Room[] = [];
  for (const l of map.locations) {
    if (l.building !== b.id || l.kind === 'stairs' || !l.enabled || (l.level || 0) !== level) continue;
    const north = l.y < cy;
    const y0 = north ? cy - half - cellD : cy + half; const y1 = north ? cy - half : cy + half + cellD;
    out.push({ x0: l.x - cellW / 2, x1: l.x + cellW / 2, y0, y1, doorY: north ? y1 : y0, dx0: l.x - gap, dx1: l.x + gap });
  }
  cache.set(key, out);
  return out;
}

const inside = (r: { x0: number; x1: number; y0: number; y1: number }, x: number, y: number) => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1;

/** true when a step on foot from a to b would go through a wall */
export function walkBlocked(map: MapData, a: [number, number], b: [number, number], level: number, bldg: string | null): boolean {
  const bs = map.buildings || [];
  if (level === 0) {
    for (const B of bs) {
      const ia = inside(B, a[0], a[1]); const ib = inside(B, b[0], b[1]);
      if (ia !== ib) {
        // only through the front door (middle of the south side)
        const doorOk = Math.abs(a[0] - B.door[0]) < 0.0045 && Math.abs(b[0] - B.door[0]) < 0.0045 && Math.min(a[1], b[1]) < B.y1 + 0.002;
        if (!doorOk) return true;
      }
      if (ia || ib) for (const r of roomsOf(map, B, 0)) if (inside(r, a[0], a[1]) !== inside(r, b[0], b[1]) && !(a[0] > r.dx0 && a[0] < r.dx1 && b[0] > r.dx0 && b[0] < r.dx1)) return true;
    }
    return false;
  }
  const B = bs.find((x) => x.id === bldg);
  if (!B) return false;
  for (const r of roomsOf(map, B, level)) if (inside(r, a[0], a[1]) !== inside(r, b[0], b[1]) && !(a[0] > r.dx0 && a[0] < r.dx1 && b[0] > r.dx0 && b[0] < r.dx1)) return true;
  return false;
}

export const inBuilding = (map: MapData | null, x: number, y: number) => (map?.buildings || []).find((B) => inside(B, x, y)) || null;
