import { defineConfig } from 'vite'
import path from 'path'
import { readFileSync } from 'fs'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as { version: string }

function figmaAssetResolver() {
  return {
    name: 'figma-asset-resolver',
    resolveId(id) {
      if (id.startsWith('figma:asset/')) {
        const filename = id.replace('figma:asset/', '')
        return path.resolve(__dirname, 'src/assets', filename)
      }
    },
  }
}

const YAHOO_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    figmaAssetResolver(),
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/react-router/')) {
            return 'vendor-react';
          }
          if (id.includes('/recharts/') || id.includes('/d3-')) {
            return 'vendor-charts';
          }
          if (id.includes('/motion/')) {
            return 'vendor-motion';
          }
          if (id.includes('/lucide-react/')) {
            return 'vendor-icons';
          }
          return undefined;
        },
      },
    },
  },
  esbuild: {
    drop: ['debugger'],
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],

  server: {
    proxy: {
      // Proxy Yahoo Finance chart/quote requests — browser cannot set User-Agent
      // so direct requests return 429. The Node proxy adds proper headers.
      "/api/yahoo": {
        target: "https://query1.finance.yahoo.com",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/api\/yahoo/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("User-Agent", YAHOO_UA);
            proxyReq.setHeader("Accept", "application/json,text/plain,*/*");
            proxyReq.setHeader("Referer", "https://finance.yahoo.com/");
            proxyReq.setHeader("Origin", "https://finance.yahoo.com");
          });
        },
      },
      // Proxy Tencent quote endpoint — no CORS headers on qt.gtimg.cn so browser
      // blocks direct fetch. Node proxy forwards without CORS restriction.
      "/api/tencent": {
        target: "https://qt.gtimg.cn",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/tencent/, ""),
      },
      // Proxy EastMoney push2delay (real-time quotes & trade status)
      "/api/eastmoney/push2delay": {
        target: "https://push2delay.eastmoney.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/eastmoney\/push2delay/, ""),
      },
      // Proxy EastMoney push2his (K-line history)
      "/api/eastmoney/push2his": {
        target: "https://push2his.eastmoney.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/eastmoney\/push2his/, ""),
      },
      // Proxy EastMoney searchapi (securities search)
      "/api/eastmoney/searchapi": {
        target: "https://searchapi.eastmoney.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/eastmoney\/searchapi/, ""),
      },
      // Proxy EastMoney fund F10 pages (fund purchase / DCA status)
      "/api/eastmoney/fundf10": {
        target: "https://fundf10.eastmoney.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/eastmoney\/fundf10/, ""),
      },
    },
  },
})
