import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { chatVideoPlugin } from './chat-video-plugin';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const tokenServer = env.TOKEN_SERVER_URL || process.env.TOKEN_SERVER_URL || 'http://localhost:8787';
  const videoDir = process.env.VIDEO_DIR || env.VIDEO_DIR;
  return {
    plugins: [react(), tailwindcss(), ...(videoDir ? [chatVideoPlugin(videoDir)] : [])],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      host: true,
      // Single-user app reached via localhost, the LAN IP or the user's own tunnel hostname.
      allowedHosts: true,
      port: Number(env.WEB_PORT || 5173),
      proxy: { '/api': { target: tokenServer, changeOrigin: true } },
    },
    preview: {
      host: true,
      allowedHosts: true,
      proxy: { '/api': { target: tokenServer, changeOrigin: true } },
    },
  };
});
