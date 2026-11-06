import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const radixDirectory = dirname(require.resolve('@radix-ui/colors/package.json'))
const outputDirectory = new URL('../dist/', import.meta.url)

test('dist contains only the regular Radix CSS entry points', async () => {
  const radixFiles = (await readdir(radixDirectory))
    .filter((name) => name.endsWith('.css') && !name.includes('-dark'))
    .sort()
  const packageFiles = (
    await readdir(outputDirectory, { recursive: true })
  ).sort()

  assert.deepEqual(packageFiles, radixFiles)
})

test('every CSS entry point is adaptive without theme selectors', async () => {
  const cssFiles = (await readdir(radixDirectory)).filter(
    (name) => name.endsWith('.css') && !name.includes('-dark'),
  )

  for (const filename of cssFiles) {
    const css = await readFile(
      new URL(`../dist/${filename}`, import.meta.url),
      'utf8',
    )
    assert.match(css, /:root/)
    assert.match(css, /color-scheme: light dark/)
    assert.match(css, /light-dark\(/)
    assert.doesNotMatch(css, /\.light|\.dark|theme/)
  }

  const publishedFiles = await readdir(outputDirectory)
  assert.equal(
    publishedFiles.some(
      (name) => name.includes('-dark') && name.endsWith('.css'),
    ),
    false,
  )
})

test('pairs light, dark, alpha, and Display-P3 values', async () => {
  const gray = await readFile(
    new URL('../dist/gray.css', import.meta.url),
    'utf8',
  )
  const grayAlpha = await readFile(
    new URL('../dist/gray-alpha.css', import.meta.url),
    'utf8',
  )

  assert.match(gray, /--gray-1: light-dark\(#fcfcfc, #111111\)/)
  assert.match(
    gray,
    /--gray-1: light-dark\(color\(display-p3 0\.988 0\.988 0\.988\), color\(display-p3 0\.067 0\.067 0\.067\)\)/,
  )
  assert.match(grayAlpha, /--gray-a1: light-dark\(#00000003, #00000000\)/)
})
