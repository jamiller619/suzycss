import { readFileSync } from 'node:fs'

// Bundle the reset into generated themes so consumers do not need CSS imports or
// a bundler. Keeping it here also makes the reset and Suzy's base styles distinct.
export const resetCss = readFileSync(
  new URL(import.meta.resolve('modern-css-reset')),
  'utf8',
)
