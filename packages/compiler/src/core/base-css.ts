import { readFileSync } from 'node:fs'

// Opinionated Suzy defaults live here; browser normalization lives in reset-css.ts.
// Low-specificity defaults stay easy to override within or outside Suzy's layer.
export const baseCss = readFileSync(
  new URL('./base.css', import.meta.url),
  'utf8',
)
