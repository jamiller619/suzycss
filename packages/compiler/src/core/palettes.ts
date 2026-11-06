import * as radix from '@radix-ui/colors'
import type { Mode, Palette } from './config.js'

/** Named palette boundary; future arbitrary-color generation belongs here. */
export function resolvePalette(
  name: Palette,
  mode: Mode,
  alpha = false,
): readonly string[] {
  const key = `${name}${mode === 'dark' ? 'Dark' : ''}${alpha ? 'A' : ''}`
  const scale = (radix as unknown as Record<string, Record<string, string>>)[
    key
  ]
  if (!scale) {
    throw new Error(`Unknown Radix palette: ${key}`)
  }
  return Array.from({ length: 12 }, (_, i) => {
    const value = scale[`${name}${alpha ? 'A' : ''}${i + 1}`]
    if (!value) {
      throw new Error(`Missing step ${i + 1} in ${key}`)
    }
    return value
  })
}
