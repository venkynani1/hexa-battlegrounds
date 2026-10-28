import { createClient, SupabaseClient } from '@supabase/supabase-js';

const env = import.meta.env as Record<string, string | undefined>;

export const SUPABASE_URL = env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
export const SUPABASE_KEY =
  env.VITE_SUPABASE_ANON_KEY ||
  env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const configured = Boolean(SUPABASE_URL && SUPABASE_KEY);

// The browser key only has EXECUTE on the game API functions. Tables are locked by RLS.
export const supabase: SupabaseClient | null = configured
  ? createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 5 } },
    })
  : null;
