import { API_MODE, supabase } from './supabase';

export class GameError extends Error {
  code: string;
  detail: string;
  constructor(code: string, detail?: string) {
    super(code);
    this.code = code;
    this.detail = detail || code;
  }
}

const MESSAGES: Record<string, string> = {
  BAD_EMP_ID: 'Your employee ID must be exactly 10 digits.',
  BAD_EMAIL: 'Enter your company e-mail address (the one you use in Teams).',
  EMAIL_DOMAIN: 'Use your company e-mail address — other e-mail addresses are not accepted for this event.',
  EMP_ID_TAKEN: 'This employee ID is already checked in with a different e-mail. Use the same e-mail as before, or ask the organiser.',
  EMAIL_TAKEN: 'This e-mail is already checked in with a different employee ID. Use the same ID as before.',
  NOT_REGISTERED: 'No check-in found for this employee ID and e-mail. Check in as a new player.',
  GAME_STARTED: 'The game has already started — new squads cannot be created. Choose "Find me a squad" to fill an open seat.',
  NO_OPEN_SEATS: 'The game has started and every squad has landed. Please wait for the next game.',
  ALREADY_STARTED: 'The online game has already been started.',
  BAD_SQUAD_CODE: 'No squad has this code. Check the 4 letters with your friend.',
  SQUAD_GONE: 'That squad has already taken off. Find a new squad instead.',
  NOT_ONLINE_EVENT: 'This event code is for the in-person game. Use the online event code from the Teams call.',
  AUTH: 'Your session ended. Rejoin with your squad number and PIN.',
  HOST_AUTH: 'Host login failed. Check the event code and host password.',
  SPECTATOR_AUTH: 'This projector link is invalid or was revoked by the host.',
  NO_EVENT: 'No event with that code. Check the code on the screen.',
  BAD_PIN: 'That PIN does not match any squad on this map. Check the map number and the PIN on your squad card.',
  BAD_MAP: 'There is no such map in this event. Check the map number on your squad card.',
  PIN_AMBIGUOUS: 'Two squads share that PIN. Ask the organiser for a new PIN.',
  JUMP_FIRST: 'Jump from the plane first.',
  NOT_OVER_CAMPUS: 'The plane is not over the campus yet — wait a moment.',
  PLANE_GONE: 'The plane has left — your squad was dropped automatically.',
  TOO_FAR_TO_GLIDE: 'Too far to glide from the plane. Pick a spot inside the dashed circle.',
  BUGGY_TOO_FAR: 'Walk up to your buggy first.',
  NO_FIGHTS_YET: 'No shooting yet — gunfights start in Phase 1.',
  NO_FIGHTS_NOW: 'No shooting right now.',
  OUT_OF_RANGE: 'Out of range — get closer.',
  NO_LINE_OF_SIGHT: 'No clear shot — a wall is in the way.',
  TARGET_DOWN: 'That squad is already down.',
  ALLY: 'That squad is your ally.',
  NO_ROLE: 'Roles are handed out at take-off.',
  LOCKED_OUT: 'Too many wrong attempts. Wait 5 minutes or ask the host.',
  ROSTER_LOCKED: 'This squad is already complete. Ask the host if you are a replacement.',
  TEAM_FULL: 'This squad already has 4 players.',
  NAME_TAKEN: 'Someone in your squad already uses that name. Add an initial.',
  CONSENT_REQUIRED: 'Please accept the participation consent and the rules.',
  BAD_NAME: 'Enter a display name (1–40 characters).',
  ROLE_TAKEN: 'Too slow! Someone grabbed that role first.',
  ROLES_CLOSED: 'Role selection is closed.',
  ALREADY_HAS_ROLE: 'You already claimed a role.',
  NOT_CAPTAIN: 'Only your Captain can do that.',
  NOT_IN_PLAY: 'The game is not running right now.',
  PAUSED: 'The host has paused the game.',
  BUSY: 'Your squad is busy (travelling or recovering).',
  IN_BATTLE: 'Finish your battle first.',
  BAD_LOCATION: 'That location is not available.',
  ALREADY_HERE: 'You are already here.',
  DANGER_ZONE: 'That area is inside the danger zone.',
  NOT_CONNECTED: 'No direct route. Move to a neighbouring location first.',
  NO_MOVES_NOW: 'Movement is locked during this stage.',
  MISSION_ACTIVE: 'Finish (or leave) your current mission first.',
  AREA_EXHAUSTED: 'This area has been searched out. Move somewhere new.',
  NO_MISSIONS: 'Nothing more to find here.',
  NOT_ACTIVE: 'This mission already ended.',
  EXPIRED: 'Time ran out.',
  NOT_FOUND: 'Not found.',
  BAD_ANSWER_FORMAT: 'Fill in every answer box.',
  NOT_ENOUGH_COINS: 'Not enough coins.',
  NO_HINTS_IN_BATTLE: 'No hints during battles.',
  NO_ITEM: 'You do not have that item.',
  HP_FULL: 'HP is already full.',
  IN_RECOVERY: 'Finish recovery first.',
  ALREADY_ACTIVE: 'Already active.',
  NO_MARKET_HERE: 'There is no market at this location.',
  NOT_SOLD_HERE: 'That item is not sold here.',
  NO_BATTLES_NOW: 'Battles are disabled in this stage.',
  BAD_TARGET: 'Invalid target.',
  TARGET_UNAVAILABLE: 'That squad cannot be engaged right now.',
  NOT_IN_RANGE: 'You must be at the same location.',
  TAKE_THE_STAIRS: 'That place is on another floor — drive to the stairwell and climb.',
  NOT_AT_STAIRS: 'Drive onto the green STAIRS ring first.',
  NO_FLOOR: 'There is no floor that way.',
  SEALED: 'Sealed by a lockdown — find another way.',
  DROP_OUTSIDE: 'Parachute onto open ground or a ground floor first.',
  NOTHING_HERE: 'Nothing to search on the stairs.',
  HEXAVARSITY_NEVER_SEALS: 'Hexavarsity never seals — it hosts the finale.',
  NOTHING_LEFT_TO_SEAL: 'Every building that can seal is already sealed.',
  COOLDOWN: 'Weapon cooling down.',
  TARGET_PROTECTED: 'That squad has spawn protection.',
  ALREADY_IN_BATTLE: 'One of the squads is already in a battle.',
  AIRDROP_GONE: 'That airdrop is gone.',
  BLOCKED: 'That squad blocked your messages.',
  SLOW_DOWN: 'Slow down — message limit reached.',
  BAD_MESSAGE: 'Messages must be 1–280 characters.',
  TRUST_TOO_LOW: 'Your trust is too low to propose alliances.',
  ALREADY_PENDING: 'You already have an alliance or proposal with that squad.',
  ALREADY_ANSWERED: 'You already answered this offer.',
  WRONG_PHASE: 'Not possible in the current phase.',
  REASON_REQUIRED: 'A reason is required for manual changes.',
  LOCK_RESULTS_FIRST: 'Lock the results first.',
  LOCK_ALL_MAPS_FIRST: 'Lock results on every map first.',
  CODE_TAKEN: 'That event code is already in use.',
  DEMO_BUSY: 'Several demos were started in the last few minutes. Wait a little and try again.',
  NOT_DEMO: 'That only works inside a demo match.',
  WEAK_SECRET: 'Host password must be at least 6 characters.',
  BAD_CODE: 'Event code: 3–12 letters or digits.',
  ALL_MAPS_FULL: 'All maps are full (15 squads each). Ask the organiser to open another map.',
  NETWORK: 'Connection problem — retrying…',
  DUELS_LOCKED: 'Duels are locked until Phase 2 — First Contact.',
  NO_READY_SQUADS: 'No complete squad (4/4) on this map yet. Any number from 1 to 15 squads can play.',
  NO_REVEAL_HERE: 'Answers can’t be revealed in duels, airdrop races or the finale.',
  NOT_AT_LOCATION: 'Walk into a location ring first, then search.',
  RED_ZONE_ACTIVE: 'A red zone is already incoming on this map.',
  BAD_PHASE: 'Choose a phase between 0 and 4. The finale starts with Begin finale.',
  BAD_ROW: 'The squad file has a problem.',
  NOT_CONFIGURED: 'The game server is not configured yet (missing Supabase environment variables).',
};

export function friendly(e: unknown): string {
  const code = e instanceof GameError ? e.code : String((e as any)?.message || e);
  // messages such as "BAD_ROW: row 3 — squad 4 appears twice" carry a useful detail after the code
  if (e instanceof GameError && e.detail.startsWith(code + ':')) return e.detail.slice(code.length + 1).trim();
  return MESSAGES[code] || code.replace(/_/g, ' ').toLowerCase();
}

function parseCode(message: string): string {
  const m = /^([A-Z_]{3,})(:|$)/.exec(message.trim());
  if (m) return m[1];
  if (/fetch|network|Failed to fetch|timeout/i.test(message)) return 'NETWORK';
  return message;
}

async function apiRpc(fn: string, args: Record<string, unknown>): Promise<{ data: any; error: { message: string } | null }> {
  let r: Response;
  try {
    r = await fetch(`/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  } catch (e) {
    return { data: null, error: { message: 'NETWORK: ' + String((e as any)?.message || e) } };
  }
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!r.ok) return { data: null, error: { message: String(body?.message || (r.status >= 500 ? 'NETWORK: server busy (' + r.status + ')' : 'HTTP ' + r.status)) } };
  return { data: body, error: null };
}

export async function rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!API_MODE && !supabase) throw new GameError('NOT_CONFIGURED');
  const { data, error } = API_MODE ? await apiRpc(fn, args) : await supabase!.rpc(fn, args);
  if (error) throw new GameError(parseCode(error.message), error.message);
  if (data && typeof data === 'object' && (data as any).error && (data as any).ok === undefined) {
    throw new GameError(parseCode((data as any).error), (data as any).error);
  }
  return data as T;
}

export function newKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// A demo view runs in its own tab or frame with its session in the address (#demo=… for a dummy
// player's phone, #host=… for the demo's host console). It never touches the sessions saved on
// this device, so a real squad or host login in another tab is left alone.
const hashParam = (k: string) => {
  try { const m = new RegExp(`[#&]${k}=([A-Za-z0-9_-]{8,200})`).exec(window.location.hash); return m ? m[1] : null; } catch { return null; }
};
const TAB: Record<string, string | null> = { hb_token: hashParam('demo'), hb_host_token: hashParam('host') };
/** True when this tab/frame is showing a dummy player's phone in demo mode. */
export const demoTab = !!TAB.hb_token;
export const demoHostTab = !!TAB.hb_host_token;

// Local session storage (per device)
export const store = {
  get: (k: string) => {
    if (TAB[k]) return TAB[k];
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set: (k: string, v: string) => {
    if (TAB[k]) return;
    try { localStorage.setItem(k, v); } catch { /* private mode */ }
  },
  del: (k: string) => {
    if (TAB[k]) { TAB[k] = null; return; }
    try { localStorage.removeItem(k); } catch { /* private mode */ }
  },
};
