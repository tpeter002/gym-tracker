import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** Writes dist/sw.js from sw.template.js, listing every built file for offline use. */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'gym-tracker-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const files = (readdirSync(outDir, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => relative(outDir, join(entry.parentPath, entry.name)).split('\\').join('/'))
        .filter((file) => file !== 'sw.js' && !file.startsWith('.'))
        .sort();
      // The version changes whenever any file does, which is what makes browsers fetch the new build.
      const version = createHash('sha256');
      for (const file of files) version.update(file).update(readFileSync(join(outDir, file)));
      const urls = ['./', ...files.filter((file) => file !== 'index.html').map((file) => `./${file}`)];
      const source = readFileSync('sw.template.js', 'utf8')
        .replace('__VERSION__', version.digest('hex').slice(0, 12))
        .replace('__FILES__', JSON.stringify(urls));
      writeFileSync(join(outDir, 'sw.js'), source);
    },
  };
}

const ANALYZER = 'http://localhost:8787';

export default defineConfig({
  // Relative paths, so the build works from any folder of any static host.
  base: './',
  plugins: [react(), serviceWorker()],
  server: {
    // `npm run dev` next to a running analyzer (uv run ../server/analyzer.py).
    // The browser tests switch this off: an analyzer that happens to be running
    // on this machine must not answer in place of the ones they stand in.
    proxy: process.env.GYM_TRACKER_NO_ANALYZER_PROXY
      ? undefined
      : { '/health': ANALYZER, '/analyze': ANALYZER, '/models': ANALYZER },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
  },
});
