import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = `http://127.0.0.1:${process.env.JIRAFFE_PORT ?? 4317}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target,
        // The server only accepts its own Host and Origin (DNS rebinding guard), so the dev
        // proxy presents the target as both.
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.headers.origin) proxyReq.setHeader('origin', target);
          });
        },
      },
    },
  },
});
