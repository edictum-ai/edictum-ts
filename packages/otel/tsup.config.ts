import { defineConfig } from 'tsup'

const external = [
  '@opentelemetry/api',
  '@opentelemetry/sdk-trace-base',
  '@opentelemetry/sdk-metrics',
  '@opentelemetry/exporter-trace-otlp-grpc',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/exporter-metrics-otlp-grpc',
  '@opentelemetry/exporter-metrics-otlp-http',
  '@opentelemetry/resources',
  '@edictum/core',
]

// Split into two configs so the ESM build gets a top-level await banner
// that probes for @opentelemetry/api. This makes the sync hasOtel()
// function return accurate results in ESM contexts.
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    external,
    outExtension() {
      return { js: '.cjs' }
    },
  },
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: true,
    external,
    outExtension() {
      return { js: '.mjs' }
    },
    esbuildOptions(options) {
      // Top-level await: probe for @opentelemetry/api before any module code
      // runs. Sets globalThis.__edictum_has_otel so hasOtel() returns the
      // correct result in ESM (where require.resolve is not available).
      options.banner = {
        js: [
          '/* @edictum/otel ESM auto-init: probe for @opentelemetry/api */',
          'try {',
          '  await import("@opentelemetry/api");',
          '  globalThis.__edictum_has_otel = true;',
          '} catch { globalThis.__edictum_has_otel = false; }',
        ].join('\n'),
      }
    },
  },
])
