// Free Fire style safe zone on the screens: while the gas wall closes in, the circle is
// interpolated between where it was (prev) and the white target circle (cur), by server time.
export type ZoneData = {
  stage?: number; cur?: number[] | null; next?: number[] | null; next_at?: string | null;
  prev?: number[] | null; shrink_from?: string | null; shrink_until?: string | null; dps?: number;
} | null | undefined;

/** cur = the circle right now; next = the white circle to run to (shown while waiting AND while the wall moves) */
export function zoneNow(z: ZoneData, now: number): { cur: number[] | null; next: number[] | null; shrinking: boolean; until: number | null } {
  if (!z) return { cur: null, next: null, shrinking: false, until: null };
  const a = z.shrink_from ? new Date(z.shrink_from).getTime() : 0;
  const b = z.shrink_until ? new Date(z.shrink_until).getTime() : 0;
  if (z.prev && z.cur && b > now && b > a) {
    const p = Math.max(0, Math.min(1, (now - a) / (b - a)));
    const c = [0, 1, 2].map((i) => z.prev![i] + (z.cur![i] - z.prev![i]) * p);
    return { cur: c, next: z.cur, shrinking: true, until: b };
  }
  return { cur: z.cur || null, next: z.next || null, shrinking: false, until: null };
}
