import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as radix from '@radix-ui/colors'

type Palette = Record<string, string>

const require = createRequire(import.meta.url)
const radixDirectory = dirname(require.resolve('@radix-ui/colors/package.json'))
const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const outputDirectory = join(packageDirectory, 'dist')
const radixExports: Record<string, unknown> = Object.fromEntries(
  Object.entries(radix),
)

function isPalette(value: unknown): value is Palette {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(
      ([name, color]) => /\d+$/.test(name) && typeof color === 'string',
    )
  )
}

function customProperty(name: string): string {
  const match = /^(.*?)(\d+)$/.exec(name)
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`Invalid Radix color token: ${name}`)
  }

  const kebabToken = match[1].replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
  return `--${kebabToken}${kebabToken.endsWith('-a') ? '' : '-'}${match[2]}`
}

function declarations(light: Palette, dark: Palette): string {
  const darkEntries = new Map(
    Object.entries(dark).map(([name, color]) => [customProperty(name), color]),
  )

  return Object.entries(light)
    .map(([token, lightValue]) => {
      const name = customProperty(token)
      const darkValue = darkEntries.get(name)
      if (darkValue === undefined) {
        throw new Error(`Missing dark value for ${name}`)
      }
      return `  ${name}: light-dark(${lightValue}, ${darkValue});`
    })
    .join('\n')
}

function palette(name: string): Palette {
  const value = radixExports[name]
  if (!isPalette(value)) {
    throw new Error(`Missing Radix palette export: ${name}`)
  }
  return value
}

function exportNames(filename: string): [string, string, string, string] {
  const stem = filename.replace(/\.css$/, '').replace(/-dark/, '')
  const alpha = stem.endsWith('-alpha')
  const family = stem.replace(/-alpha$/, '')
  const suffix = alpha ? 'A' : ''
  return [
    `${family}${suffix}`,
    `${family}Dark${suffix}`,
    `${family}P3${suffix}`,
    `${family}DarkP3${suffix}`,
  ]
}

function generateCss(filename: string): string {
  const [lightName, darkName, p3Name, darkP3Name] = exportNames(filename)
  const light = palette(lightName)
  const darkValue = radixExports[darkName]
  const dark = isPalette(darkValue) ? darkValue : light
  const p3Value = radixExports[p3Name]
  const darkP3Value = radixExports[darkP3Name]
  const p3 = isPalette(p3Value) ? p3Value : undefined
  const darkP3 = isPalette(darkP3Value) ? darkP3Value : p3

  const wideGamut =
    p3 === undefined || darkP3 === undefined
      ? ''
      : `\n\n@supports (color: color(display-p3 1 1 1)) {
  @media (color-gamut: p3) {
    :root {
      ${declarations(p3, darkP3)}
    }
  }
}`

  return `/* Generated from @radix-ui/colors. Do not edit by hand. */
:root {
  color-scheme: light dark;
  ${declarations(light, dark)}
}${wideGamut}\n`
}

await rm(outputDirectory, { force: true, recursive: true })
await mkdir(outputDirectory, { recursive: true })

const radixCssFiles = (await readdir(radixDirectory)).filter((name) =>
  name.endsWith('.css'),
)
const cssFiles = radixCssFiles.filter((name) => !name.includes('-dark'))

for (const relativePath of [
  ...radixCssFiles,
  'index.js',
  'index.mjs',
  'colors.png',
  'LICENSE',
  'types',
]) {
  await rm(join(packageDirectory, relativePath), {
    force: true,
    recursive: true,
  })
}

for (const filename of cssFiles) {
  await writeFile(join(outputDirectory, filename), generateCss(filename))
}

console.log(`Generated ${cssFiles.length} adaptive CSS entry points.`)
