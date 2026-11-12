import { useEffect, useState } from 'react';
import { rpc, store } from './api';

export type Role = 'captain' | 'scout' | 'decoder' | 'intel';

export const ROLES: Record<Role, { name: string; icon: string; color: string; blurb: string }> = {
  captain: { name: 'Captain', icon: '★', color: 'var(--gold)', blurb: 'Leads the squad. Only you can submit answers, move, fight, trade and negotiate.' },
  scout: { name: 'Scout', icon: '◉', color: 'var(--cyan)', blurb: 'The eyes. You receive visual evidence: grids, images, sequences and patterns.' },
  decoder: { name: 'Decoder', icon: '⌬', color: 'var(--violet)', blurb: 'The brain. You receive the rules: ciphers, conversions and logic.' },
  intel: { name: 'Intel Officer', icon: '◈', color: 'var(--green)', blurb: 'The insider. You receive constraints, warnings and the missing piece.' },
};
export const ROLE_ORDER: Role[] = ['captain', 'scout', 'decoder', 'intel'];

export const KIND_LABEL: Record<string, string> = {
  mission: 'Mission', relay: 'Intel exchange', airdrop: 'Airdrop', recovery: 'Recovery', battle: 'Battle',
  finale_entry: 'Final · Entry lock', finale_exchange: 'Final · Intelligence exchange',
  finale_battle: 'Final · Simultaneous battle', final_code: 'Final · The code',
};

export const TIER_COLOR: Record<string, string> = {
  common: '#9fb3c8', rare: '#3ea5ff', legendary: '#ffc23d', mystery: '#b07cff', cursed: '#ff4d5e', intel: '#5dff9e', vault: '#ff9d2e',
};

export const ZONE_TEXT = [
  'Entire campus is safe',
  'Safe circle shrinking — campus edges are unsafe',
  'Outer blocks are outside the circle',
  'Only the central circle is safe',
  'Final circle around Hexavarsity',
  'Training Room 14 is the last safe zone',
];

export const MATCH_PHASES = [
  { name: 'Deployment', theme: 'Arrival and reconnaissance', rules: 'Land, collect your buggy, intro missions. No shooting yet, no zone damage.' },
  { name: 'Exploration', theme: 'Explore and collect', rules: 'Gunfights are on. Standard missions and first airdrops. The whole campus is safe.' },
  { name: 'First Contact', theme: 'Competition begins', rules: 'The first white circle is marked — then the gas wall closes in.' },
  { name: 'Conflict & Intelligence', theme: 'Risk versus reward', rules: 'Harder missions pay more. The zone closes to central campus.' },
  { name: 'Final Convergence', theme: 'High-stakes comeback', rules: 'Only Hexavarsity stays safe. Make your last big plays.' },
  { name: 'Training Room 14', theme: 'Final showdown', rules: 'Every squad plays the synchronized finale.' },
];

export const FINALE_STAGES: Record<string, { name: string; text: string }> = {
  A: { name: 'Entry Lock', text: 'Every squad decodes its way into the final circle.' },
  B: { name: 'Intelligence Exchange', text: 'Captains trade codewords across squads.' },
  C: { name: 'Simultaneous Battle', text: 'All squads, one deadline, every second counts.' },
  D: { name: 'Final Lockdown', text: 'Every building seals except Hexavarsity. Room 14 is the last open room.' },
  E: { name: 'The Final Code', text: 'One last vault. The biggest prize of the night.' },
  F: { name: 'Champion', text: 'The last squad standing in Training Room 14.' },
};

export type Building = { id: string; name: string; x0: number; y0: number; x1: number; y1: number; floors: number; stairs: [number, number]; door: [number, number]; style: string };
export type MapData = {
  locations: { id: string; name: string; building: string | null; floor: string | null; level?: number; x: number; y: number; kind: string;
    collapse: number; risk: number; reward: string; tags: string[]; drop: boolean; enabled: boolean }[];
  buildings?: Building[];
  edges: [string, string, number][];
  items: { id: string; name: string; kind: string; description: string; price: number; params: any }[];
};

let mapCache: MapData | null = null;
export function useMapData(refreshKey = 0) {
  const [map, setMap] = useState<MapData | null>(mapCache);
  useEffect(() => {
    let alive = true;
    rpc<MapData>('map_data').then((m) => { mapCache = m; if (alive) setMap(m); }).catch(() => {});
    return () => { alive = false; };
  }, [refreshKey]);
  return map;
}

export function locName(map: MapData | null, id?: string | null) {
  if (!id) return '—';
  return map?.locations.find((l) => l.id === id)?.name || id;
}

export function neighbors(map: MapData | null, id?: string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!map || !id) return out;
  for (const [a, b, s] of map.edges) {
    if (a === id) out.set(b, s);
    if (b === id) out.set(a, s);
  }
  return out;
}

export const floorLabel = (level?: number | null) => (!level ? 'Ground floor' : `Floor ${level}`);
export const floorName = (building: string, level?: number | null) => (level === null || level === undefined ? building : `${building} ${floorLabel(level)}`);
// one distinct colour per squad number (15 squads per map)
export const SQUAD_HEX = ['#ff4d4d', '#ffb02e', '#ffe14d', '#7ddf4a', '#2fd67b', '#2ad1c9', '#33a8ff', '#4f6dff', '#9a5cff', '#d54dff',
  '#ff5fb2', '#c98a5a', '#f2f2f2', '#8fa3b8', '#ff7a3d'];
export const squadHex = (n: number) => SQUAD_HEX[(Math.max(1, n) - 1) % SQUAD_HEX.length];

export function feedText(type: string, p: any, map: MapData | null): { text: string; tone: string } | null {
  const L = (id: string) => locName(map, id);
  switch (type) {
    case 'team.ready': return { text: `Squad ${p.team} is ready (4/4)`, tone: 'good' };
    case 'player.joined': return { text: `Squad ${p.team}: ${p.count}/4 joined`, tone: 'info' };
    case 'shuttle.assigned': return { text: `${p.squads} squads boarding the shuttles`, tone: 'info' };
    case 'shuttle.departed': return { text: 'Shuttles departed from SIPCOT', tone: 'info' };
    case 'shuttle.arrived': return { text: 'Shuttles arrived at Gate 1', tone: 'info' };
    case 'map.revealed': return { text: 'Campus map revealed — drop now!', tone: 'warn' };
    case 'squad.movement.started': return { text: `Squad ${p.team} → ${L(p.to)}`, tone: 'info' };
    case 'squad.arrived': return { text: `Squad ${p.team} reached ${L(p.location)}`, tone: 'info' };
    case 'squad.jumped': return { text: p.to ? `🪂 Squad ${p.team} jumped — gliding to ${L(p.to)}` : `🪂 Squad ${p.team} jumped`, tone: 'info' };
    case 'online.sealed': return { text: `🤝 Small squads merged for take-off (${p.moved} player${p.moved === 1 ? '' : 's'} moved)`, tone: 'info' };
    case 'squad.landed': return { text: `🪂 Squad ${p.team} landed${p.location ? ` at ${L(p.location)}` : ''}`, tone: 'info' };
    case 'squad.buggy': return { text: `🚙 Squad ${p.team} collected their buggy`, tone: 'info' };
    case 'plane.over': return { text: '✈ The plane is over Hexaware — squads are jumping', tone: 'warn' };
    case 'squad.gunfight': return { text: `🔫 Gunfight: Squad ${p.a} vs Squad ${p.b}${p.location ? ` at ${L(p.location)}` : ''}`, tone: 'bad' };
    case 'squad.knocked': return { text: `💀 Squad ${p.by} knocked out Squad ${p.team}${p.shooter ? ` (${p.shooter}, ${String(p.weapon || '').toUpperCase()})` : ''}`, tone: 'bad' };
    case 'encounter.detected': return { text: `ENEMY CONTACT at ${L(p.location)} (${p.squads} squads)`, tone: 'bad' };
    case 'mission.completed': return { text: `Squad ${p.team} cleared “${p.title}” +${p.points}`, tone: 'good' };
    case 'mission.failed': return { text: `Squad ${p.team} failed a mission`, tone: 'bad' };
    case 'battle.started': return { text: `⚔ Squad ${p.attacker} attacked Squad ${p.defender} (${p.weapon})`, tone: 'bad' };
    case 'battle.resolved': return p.winner
      ? { text: `⚔ Squad ${p.winner} won the duel (${p.attacker} vs ${p.defender}) — ${p.damage} damage`, tone: 'bad' }
      : { text: `⚔ Duel ${p.attacker} vs ${p.defender} ended in a draw`, tone: 'info' };
    case 'recovery.started': return { text: `Squad ${p.team} is down — recovery mode`, tone: 'bad' };
    case 'recovery.completed': return { text: `Squad ${p.team} is back in action`, tone: 'good' };
    case 'airdrop.spawned': return { text: `✈ ${String(p.tier).toUpperCase()} airdrop at ${L(p.location)}`, tone: 'warn' };
    case 'airdrop.contested': return { text: `Squad ${p.team} is cracking the airdrop at ${L(p.location)}`, tone: 'warn' };
    case 'airdrop.claimed': return { text: p.tier === 'vault' ? `Squad ${p.team} cracked the VAULT!` : `Squad ${p.team} claimed the ${p.tier} airdrop!`, tone: 'good' };
    case 'zone.warning': return { text: `⚠ New safe zone marked — the wall moves soon (stage ${p.stage})`, tone: 'bad' };
    case 'zone.collapsed': return { text: `☢ The zone is closing in — stage ${p.stage}`, tone: 'bad' };
    case 'zone.relocated': return { text: `Squad ${p.team} evacuated to ${L(p.to)}`, tone: 'info' };
    case 'zone.outside': return { text: `☢ ${p.squads} squad${p.squads === 1 ? '' : 's'} caught outside the safe zone`, tone: 'bad' };
    case 'redzone.warning': return { text: `💥 Red zone incoming${p.location ? ` near ${L(p.location)}` : ''}`, tone: 'bad' };
    case 'redzone.strike': return { text: p.hits?.length ? `💥 Red zone hit Squad ${p.hits.join(', ')}` : '💥 Red zone strike — nobody hit', tone: 'bad' };
    case 'zone.cancelled': return { text: 'Zone collapse cancelled', tone: 'info' };
    case 'intel.shared': return { text: `Squad ${p.from} shared intel with Squad ${p.to}`, tone: 'good' };
    case 'alliance.created': return { text: `🤝 Squads ${p.a} & ${p.b} formed an alliance`, tone: 'good' };
    case 'alliance.betrayed': return { text: `🗡 Squad ${p.by} BETRAYED Squad ${p.victim}`, tone: 'bad' };
    case 'lockdown.warning': return { text: `🚨 LOCKDOWN: ${floorName(p.name, p.level)} seals in ${p.seconds}s — get out!`, tone: 'bad' };
    case 'lockdown.sealed': return { text: p.caught?.length ? `🔒 ${floorName(p.name, p.level)} sealed — Squad ${p.caught.join(', ')} caught inside` : `🔒 ${floorName(p.name, p.level)} sealed`, tone: 'bad' };
    case 'lockdown.final': return { text: '🔒 FINAL LOCKDOWN — only Hexavarsity is still open', tone: 'warn' };
    case 'lockdown.lifted': return { text: 'Lockdowns lifted by the host', tone: 'info' };
    case 'vault.opened': return { text: `🟧 Vault unlocked in ${L(p.location)}`, tone: 'warn' };
    case 'story.broadcast': return { text: `📣 ${p.text}`, tone: 'warn' };
    case 'game.paused': return { text: 'Game paused by host', tone: 'info' };
    case 'game.resumed': return { text: 'Game resumed', tone: 'info' };
    case 'phase.started': return { text: `▶ Phase ${p.phase}: ${MATCH_PHASES[p.phase]?.name || ''}`, tone: 'warn' };
    case 'final.started': return { text: 'FINALE — all squads converge on Training Room 14', tone: 'warn' };
    case 'final.stage': return { text: `Final stage ${p.stage}: ${FINALE_STAGES[p.stage]?.name || ''}`, tone: 'warn' };
    case 'sync.started': return { text: 'Synchronized challenge started — all squads!', tone: 'warn' };
    case 'sync.closed': return { text: 'Synchronized challenge closed', tone: 'info' };
    case 'results.locked': return { text: 'Results locked', tone: 'info' };
    case 'winner.revealed': return { text: `🏆 Squad ${p.team} is the champion!`, tone: 'good' };
    default: return null;
  }
}

// Accessibility preferences (stored per device)
export function applyPrefs() {
  const root = document.documentElement;
  root.classList.toggle('reduced-motion', store.get('hb_motion') === 'reduced' ||
    (store.get('hb_motion') !== 'full' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches));
  root.classList.toggle('big-text', store.get('hb_text') === 'big');
}
