import { defineConfig } from 'tsup'

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
    dts: true,
    clean: false, // Don't clean — CJS output is already there
    sourcemap: true,
    outExtension() {
      return { js: '.mjs' }
    },
  },
])
