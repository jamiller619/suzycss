import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { runCommand } from '../dist/command.js'

const packageDir = resolve('.')
async function fixture(t) {
  const fixtures = resolve('../../test-results')
  await mkdir(fixtures, { recursive: true })
  const dir = await mkdtemp(join(fixtures, 'preview-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
test('no arguments work and a project discovers conventional entry/default output', async (t) => {
  assert.match(await runCommand([], packageDir), /Project:/)
  const dir = await fixture(t)
  await mkdir(join(dir, 'src'))
  await writeFile(join(dir, 'package.json'), '{}')
  await writeFile(join(dir, 'src/index.ts'), '')
  const result = await runCommand(['--root', dir], packageDir)
  assert.match(result, /Input: src\/index.ts/)
  assert.match(
    result,
    new RegExp(
      `Data: ${dir.replaceAll('\\', '\\\\')}\\/.preview\\/preview.json`,
    ),
  )
})
test('CLI beats config', async (t) => {
  const dir = await fixture(t)
  const nested = join(dir, 'settings')
  await mkdir(nested)
  await writeFile(join(dir, 'package.json'), '{}')
  await writeFile(
    join(nested, 'preview.json'),
    JSON.stringify({
      root: '..',
      input: '../from-config.ts',
      output: './configured',
    }),
  )
  const result = await runCommand(
    [
      '--config',
      join(nested, 'preview.json'),
      '--input',
      join(dir, 'from-cli.ts'),
    ],
    packageDir,
  )
  assert.match(result, /Input: from-cli.ts/)
  assert.match(result, /settings\/configured\/preview.json/)
})
test('ambiguity and validation errors are actionable', async (t) => {
  const dir = await fixture(t)
  await mkdir(join(dir, 'src'))
  await writeFile(join(dir, 'package.json'), '{}')
  await writeFile(join(dir, 'src/index.ts'), '')
  await writeFile(join(dir, 'src/index.tsx'), '')
  await assert.rejects(
    runCommand(['--root', dir], packageDir),
    /Ambiguous conventional source entry[\s\S]*--input/,
  )
  const malformed = join(dir, 'bad.json')
  await writeFile(
    malformed,
    JSON.stringify({
      schemaVersion: 1,
      project: {},
      provenance: {},
      components: [{}],
      diagnostics: [],
    }),
  )
  await assert.rejects(
    runCommand(['--validate', malformed], packageDir),
    /\$\.project\.entry[\s\S]*\$\.components\[0\]\.framework/,
  )
})
