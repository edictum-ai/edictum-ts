import { defineConfig } from 'tsup'

// Split into two configs so the ESM build gets a top-level await banner
// that eagerly loads js-yaml. This makes the sync YAML API (fromYamlString,
// loadBundleString) work transparently in ESM without requiring the caller
// to call ensureYamlLoaded() first.
//
// In CJS, require('js-yaml') works synchronously — no banner needed.
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    outExtension() {
      return { js: '.cjs' }
    },
  },
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true, // Need .d.ts (not just .d.cts) for downstream ESM consumers
    clean: false, // Don't clean — CJS output is already there
    sourcemap: true,
    outExtension() {
      return { js: '.mjs' }
    },
    esbuildOptions(options) {
      // Top-level await: eagerly load js-yaml before any module code runs.
      // In ESM, require() is not available, so the esbuild __require shim
      // throws. This banner uses dynamic import() to populate a globalThis
      // cache that requireYamlSync() checks first.
      options.banner = {
        js: [
          '/* @edictum/core ESM auto-init: pre-load js-yaml for sync API */',
          'try {',
          '  const __ey = await import("js-yaml");',
          '  globalThis.__edictum_yaml = __ey.default ?? __ey;',
          '} catch { /* js-yaml not installed — will error on first YAML call */ }',
        ].join('\n'),
      }
    },
  },
])
