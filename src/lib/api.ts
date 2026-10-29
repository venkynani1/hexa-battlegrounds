import { supabase } from './supabase';

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
  AUTH: 'Your session ended. Rejoin with your squad number and PIN.',
  HOST_AUTH: 'Host login failed. Check the event code and host password.',
  SPECTATOR_AUTH: 'This projector link is invalid or was revoked by the host.',
  NO_EVENT: 'No event with that code. Check the code on the screen.',
  BAD_PIN: 'Squad number or PIN is wrong.',
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
  WEAK_SECRET: 'Host password must be at least 6 characters.',
  BAD_CODE: 'Event code: 3–12 letters or digits.',
  ALL_MAPS_FULL: 'All maps are full (15 squads each). Create the event with more maps.',
  NETWORK: 'Connection problem — retrying…',
  DUELS_LOCKED: 'Duels are locked until Phase 2 — First Contact.',
  TRIAL_ONLY: 'That control only works in a trial event.',
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

export async function rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new GameError('NOT_CONFIGURED');
  const { data, error } = await supabase.rpc(fn, args);
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

// Local session storage (per device)
export const store = {
  get: (k: string) => {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set: (k: string, v: string) => {
    try { localStorage.setItem(k, v); } catch { /* private mode */ }
  },
  del: (k: string) => {
    try { localStorage.removeItem(k); } catch { /* private mode */ }
  },
};
