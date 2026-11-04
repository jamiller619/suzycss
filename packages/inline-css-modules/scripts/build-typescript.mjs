import { build } from 'esbuild'

// tsserver loads plugins with require(); bundle the shared ESM parser into CJS.
await build({
  entryPoints: ['src/typescript.cts'],
  outfile: 'dist/typescript.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
})
