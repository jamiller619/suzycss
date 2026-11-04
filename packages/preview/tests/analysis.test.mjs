import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { analyzeProject } from '../dist/analysis.js'
import { stableSerialize, validateDocument } from '../dist/document.js'
import { hasDeveloperEdits, writeAnalysis } from '../dist/write.js'

const root = resolve('tests/fixtures/mixed')
const options = (
  inputKind = 'automatic',
  input = resolve(root, 'src/index.ts'),
) => ({
  projectRoot: root,
  input,
  inputKind,
  output: resolve(root, '.preview'),
  data: resolve(root, '.preview/preview.json'),
  runtime: resolve(root, '.preview/runtime'),
})

test('mixed-framework analysis follows aliases/re-exports with stable identities', async () => {
  const first = await analyzeProject(options())
  const second = await analyzeProject(options())
  assert.deepEqual(validateDocument(first), [])
  assert.equal(stableSerialize(first), stableSerialize(second))
  assert.deepEqual(
    first.components.map((component) => component.id),
    ['src/card.tsx#Card', 'src/card.tsx#default', 'src/elements.ts#user-chip'],
  )
  const card = first.components.find((component) =>
    component.id.endsWith('#Card'),
  )
  assert.equal(card.props.children.default, 'Hello')
  assert.equal(card.props.children.generated.$ref, 'react-node')
  assert.equal(card.props.onSelect.type.kind, 'function')
  assert.equal(card.props.variant.type.discriminator, 'kind')
  assert.equal(card.props.variant.type.branches.length, 2)
  assert.equal(
    card.props.variant.type.branches[0].properties.address.properties.city.kind,
    'string',
  )
  assert.match(
    card.props.tree.diagnostics.map((item) => item.code).join(','),
    /type-circular/,
  )
  const element = first.components.find(
    (component) => component.framework === 'web-component',
  )
  assert.equal(element.props.displayName.attribute, 'display-name')
  assert.equal(element.props.displayName.type.description, 'Name from CEM.')
  assert.ok(
    element.diagnostics.some(
      (item) => item.code === 'custom-elements-manifest',
    ),
  )
  assert.ok(
    first.diagnostics.some(
      (item) => item.code === 'web-component-dynamic-registration',
    ),
  )
})

test('file and directory scope follow documented rules', async () => {
  const file = await analyzeProject(
    options('file', resolve(root, 'src/reexport.ts')),
  )
  assert.deepEqual(
    file.components.map((component) => component.id),
    ['src/card.tsx#Card', 'src/card.tsx#default'],
  )
  const directory = await analyzeProject(
    options('directory', resolve(root, 'src')),
  )
  assert.deepEqual(
    directory.components.map((component) => component.id),
    ['src/card.tsx#Card', 'src/card.tsx#default', 'src/elements.ts#user-chip'],
  )
})

test('writer refuses developer edits instead of destructive reconciliation', async (t) => {
  const document = await analyzeProject(options())
  const path = resolve(root, '.preview/test.json')
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(resolve(root, '.preview'), { recursive: true, force: true })
  })
  await writeAnalysis(path, document)
  const regenerated = await writeAnalysis(path, document)
  assert.equal(regenerated.provenance.revision, 2)
  const edited = JSON.parse(await readFile(path, 'utf8'))
  edited.components[0].props.children.value = 'mine'
  await writeFile(path, stableSerialize(edited))
  assert.equal(hasDeveloperEdits(edited), true)
  await assert.rejects(
    writeAnalysis(path, document),
    /contains developer-owned values/,
  )
  assert.equal(
    JSON.parse(await readFile(path, 'utf8')).components[0].props.children.value,
    'mine',
  )
})
