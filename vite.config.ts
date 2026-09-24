import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages under /<repo>/ as well as at a root domain.
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
});
