export type Rgb = readonly [number, number, number]
/** Only opaque, explicitly understood colors are evaluated; other CSS stays unevaluated. */
export function parseColor(value: string): Rgb | undefined {
  const text = value.trim().toLowerCase()
  if (text === 'white') {
    return [255, 255, 255]
  }
  if (text === 'black') {
    return [0, 0, 0]
  }
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(text)?.[1]
  if (hex) {
    const expanded =
      hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
    return [0, 2, 4].map((i) =>
      parseInt(expanded.slice(i, i + 2), 16),
    ) as unknown as Rgb
  }
  const numeric = '(\\d+(?:\\.\\d+)?)'
  const comma = new RegExp(
    `^rgb\\(\\s*${numeric}\\s*,\\s*${numeric}\\s*,\\s*${numeric}\\s*\\)$`,
  )
  const spaces = new RegExp(
    `^rgb\\(\\s*${numeric}\\s+${numeric}\\s+${numeric}\\s*\\)$`,
  )
  const rgb = comma.exec(text) ?? spaces.exec(text)
  if (rgb) {
    const channels = rgb.slice(1).map(Number)
    if (channels.every((c) => c >= 0 && c <= 255)) {
      return channels as unknown as Rgb
    }
  }
  return undefined
}
function luminance(rgb: Rgb): number {
  const linear = (c: number): number => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return (
    linear(rgb[0]) * 0.2126 + linear(rgb[1]) * 0.7152 + linear(rgb[2]) * 0.0722
  )
}
export function contrastRatio(a: Rgb, b: Rgb): number {
  const x = luminance(a),
    y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
/** Maximize the worst contrast across default, hover, and active states. */
export function chooseForeground(backgrounds: readonly string[]): string {
  const colors = backgrounds.map(parseColor)
  if (!colors.every((c): c is Rgb => c !== undefined)) {
    return '#000000'
  }
  const score = (foreground: Rgb) =>
    Math.min(...colors.map((c) => contrastRatio(foreground, c)))
  return score([255, 255, 255]) >= score([0, 0, 0]) ? '#ffffff' : '#000000'
}
