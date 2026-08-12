import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const appStyles = readFileSync(fileURLToPath(new URL('./src/styles.css', import.meta.url)), 'utf8');

export default defineConfig({
  plugins: [
    {
      name: 'inline-app-styles',
      transformIndexHtml() {
        return [
          {
            tag: 'style',
            attrs: { 'data-app-styles': '' },
            children: appStyles,
            injectTo: 'head',
          },
        ];
      },
    },
  ],
  build: {
    outDir: 'public',
    emptyOutDir: true,
  },
  publicDir: 'static',
});
