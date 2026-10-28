import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// NEXT_PUBLIC_ prefix lets the env vars injected by Vercel's Supabase integration work as-is.
export default defineConfig({
  plugins: [react()],
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  build: { chunkSizeWarningLimit: 900 },
});
