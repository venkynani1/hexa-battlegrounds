// One codebase, two websites. The online site is built with VITE_EDITION=online (Vercel env var):
// players sign in with their employee ID and e-mail, squads form by code or matchmaking, maps open
// by themselves, and squads talk over Microsoft Teams. The in-person site is unchanged.
const env = import.meta.env as Record<string, string | undefined>;
export const ONLINE = (env.VITE_EDITION || env.NEXT_PUBLIC_EDITION || '').toLowerCase() === 'online';

/** Microsoft Teams deep links (documented by Microsoft): a group video call and a group chat with the teammates. */
export function teamsCall(emails: string[]) {
  return `https://teams.microsoft.com/l/call/0/0?users=${emails.map(encodeURIComponent).join(',')}&withVideo=true&source=HexaBattlegrounds`;
}
export function teamsChat(emails: string[], topic: string, message?: string) {
  return `https://teams.microsoft.com/l/chat/0/0?users=${emails.map(encodeURIComponent).join(',')}&topicName=${encodeURIComponent(topic)}${message ? `&message=${encodeURIComponent(message)}` : ''}`;
}
