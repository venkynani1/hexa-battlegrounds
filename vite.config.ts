import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// NEXT_PUBLIC_ prefix lets the env vars injected by Vercel's Supabase integration work as-is.
export default defineConfig({
  plugins: [react()],
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  build: { chunkSizeWarningLimit: 900 },
  // local development against scripts' API harness (VITE_API_RPC=1 + DEV_API=http://localhost:54399)
  server: process.env.DEV_API ? { proxy: { '/rest': process.env.DEV_API } } : undefined,
});
