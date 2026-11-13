import { createClient, SupabaseClient } from '@supabase/supabase-js';

const env = import.meta.env as Record<string, string | undefined>;

export const SUPABASE_URL = env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
export const SUPABASE_KEY =
  env.VITE_SUPABASE_ANON_KEY ||
  env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// VITE_API_RPC=1: game calls go to this website's own /rest/v1/rpc (Vercel function + Neon Postgres);
// Supabase, if configured, is then only used for the client-to-client Realtime channels.
export const API_MODE = /^(1|true|yes)$/i.test(env.VITE_API_RPC || env.NEXT_PUBLIC_API_RPC || '');

export const configured = API_MODE || Boolean(SUPABASE_URL && SUPABASE_KEY);

// The browser key only has EXECUTE on the game API functions. Tables are locked by RLS.
export const supabase: SupabaseClient | null = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 5 } },
    })
  : null;
