import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { stableSerialize } from '../dist/document.js'
import {
  DocumentStore,
  ExternalWriteConflictError,
  InvalidDiskDocumentError,
  StaleDocumentError,
} from '../dist/persistence.js'

const string = (required = true) => ({
  text: 'string',
  kind: 'string',
  required,
})
const variant = (kinds = ['person', 'team']) => ({
  text: kinds.map((kind) => kind[0].toUpperCase() + kind.slice(1)).join(' | '),
  kind: 'object',
  required: true,
  discriminator: 'kind',
  branches: kinds.map((kind) => ({
    text: kind,
    kind: 'object',
    properties: {
      kind: { text: `'${kind}'`, kind: 'string', required: true, enum: [kind] },
      [kind === 'person' ? 'name' : 'title']: string(),
    },
  })),
})
function generated(version = 1) {
  const props = {
    title: {
      type: string(),
      generated: version === 1 ? 'Generated old' : 'Generated new',
    },
    settings: {
      type: {
        text: 'Settings',
        kind: 'object',
        required: true,
        properties: {
          label: string(),
          mode: {
            text: "'a' | 'b'",
            kind: 'string',
            required: true,
            enum: ['a', 'b'],
          },
        },
      },
      generated: {
        label: version === 1 ? 'Old label' : 'New label',
        mode: 'a',
      },
    },
    optional: { type: string(false), generated: 'Optional generated' },
    nullable: {
      type: {
        text: "'x' | null",
        kind: 'string',
        required: false,
        enum: ['x', null],
      },
      generated: 'x',
    },
    variant: {
      type: variant(version === 3 ? ['team'] : ['person', 'team']),
      generated:
        version === 3
          ? { kind: 'team', title: 'New team' }
          : { kind: 'person', name: 'Ada' },
    },
    ...(version === 1
      ? { obsolete: { type: string(), generated: 'Soon removed' } }
      : {}),
    ...(version >= 2
      ? { discovered: { type: string(), generated: 'New field' } }
      : {}),
  }
  return {
    schemaVersion: 1,
    project: { root: '.', entry: 'src/index.ts' },
    provenance: {
      generator: '@heysuzy/preview',
      generatorVersion: '0.1.0',
      generatedAt: '1970-01-01T00:00:00.000Z',
      revision: 1,
      sourceFingerprint: `source-${version}`,
    },
    components: [
      {
        id: 'src/card.tsx#Card',
        name: 'Card',
        framework: 'react',
        source: { path: 'src/card.tsx', export: 'Card' },
        import: { path: 'src/card.tsx', export: 'Card' },
        props,
        states: [{ name: 'default', generated: true }],
      },
    ],
    diagnostics: [],
  }
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'preview-persistence-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dataPath = join(dir, 'preview.json')
  const store = new DocumentStore({
    dataPath,
    baselinesDir: join(dir, 'baselines'),
    projectRoot: dir,
  })
  return { dir, dataPath, store }
}

test('external JSON edits three-way merge with new source and preserve explicit values', async (t) => {
  const { dataPath, store } = await fixture(t)
  await store.regenerate(generated(1))
  const edited = JSON.parse(await readFile(dataPath, 'utf8'))
  const props = edited.components[0].props
  props.title.value = 'Manual title'
  props.settings.value = { label: 'Nested manual', mode: 'b' }
  props.optional.value = { $ref: 'omit' }
  props.nullable.value = null
  props.obsolete.value = 'Recover me'
  props.title.validators = [
    { $ref: 'validator', name: 'minLength', options: { value: 3 } },
  ]
  props.title.generator = { $ref: 'generator', name: 'text' }
  edited.components[0].states.push({
    name: 'manual-state',
    values: { title: 'State title' },
  })
  await writeFile(dataPath, stableSerialize(edited))

  const result = await store.regenerate(generated(2))
  const merged = result.document.components[0]
  assert.equal(merged.props.title.value, 'Manual title')
  assert.equal(merged.props.title.generated, 'Generated new')
  assert.deepEqual(merged.props.settings.value, {
    label: 'Nested manual',
    mode: 'b',
  })
  assert.deepEqual(merged.props.optional.value, { $ref: 'omit' })
  assert.equal(merged.props.nullable.value, null)
  assert.ok(merged.props.title.validators)
  assert.equal(merged.props.title.generator.name, 'text')
  assert.ok(merged.props.discovered)
  assert.ok(merged.states.some((state) => state.name === 'manual-state'))
  assert.equal(merged.props.obsolete, undefined)
  assert.equal(result.reconciliation.orphans[0].reason, 'prop-removed')
  assert.equal(result.reconciliation.orphans[0].value.value, 'Recover me')
  assert.ok(
    result.reconciliation.conflicts.some(
      (item) => item.code === 'prop-removed-customized',
    ),
  )
})

test('deleting a customization resets to generated while newly discovered props remain distinct', async (t) => {
  const { dataPath, store } = await fixture(t)
  await store.regenerate(generated(1))
  const edited = JSON.parse(await readFile(dataPath, 'utf8'))
  edited.components[0].props.title.value = 'Temporary override'
  await writeFile(dataPath, stableSerialize(edited))
  delete edited.components[0].props.title.value
  await writeFile(dataPath, stableSerialize(edited))
  const result = await store.regenerate(generated(2))
  assert.equal(result.document.components[0].props.title.value, undefined)
  assert.equal(
    result.document.components[0].props.title.generated,
    'Generated new',
  )
  assert.equal(
    result.document.components[0].props.discovered.generated,
    'New field',
  )
})

test('incompatible union changes preserve custom data and mark the result conflicted', async (t) => {
  const { dataPath, store } = await fixture(t)
  await store.regenerate(generated(1))
  const valid = await store.read()
  const edited = JSON.parse(await readFile(dataPath, 'utf8'))
  edited.components[0].props.variant.value = {
    kind: 'person',
    name: 'Custom person',
  }
  await writeFile(dataPath, stableSerialize(edited))
  const result = await store.regenerate(generated(3))
  assert.deepEqual(result.document.components[0].props.variant.value, {
    kind: 'person',
    name: 'Custom person',
  })
  assert.ok(
    result.reconciliation.conflicts.some(
      (item) => item.code === 'custom-value-incompatible',
    ),
  )
  const read = await store.read()
  assert.equal(read.status, 'conflicted')
  assert.equal(
    read.lastValid.provenance.revision,
    valid.document.provenance.revision,
  )
})

test('removed customized components are recoverable and never name-matched', async (t) => {
  const { dataPath, store } = await fixture(t)
  const initial = generated(1)
  initial.components.push({
    id: 'src/old.tsx#Old',
    name: 'Old',
    framework: 'react',
    source: { path: 'src/old.tsx', export: 'Old' },
    import: { path: 'src/old.tsx', export: 'Old' },
    props: { label: { type: string(), generated: 'Old' } },
    states: [{ name: 'default', generated: true }],
  })
  await store.regenerate(initial)
  const edited = JSON.parse(await readFile(dataPath, 'utf8'))
  edited.components.find((component) =>
    component.id.endsWith('#Old'),
  ).props.label.value = 'Keep old data'
  await writeFile(dataPath, stableSerialize(edited))
  const result = await store.regenerate(generated(2))
  const orphan = result.reconciliation.orphans.find(
    (item) => item.reason === 'component-removed',
  )
  assert.equal(orphan.value.props.label.value, 'Keep old data')
  assert.ok(
    !result.document.components.some((component) =>
      component.id.endsWith('#Old'),
    ),
  )
})

test('stale revisions and same-revision external edits reject UI saves', async (t) => {
  const { dataPath, store } = await fixture(t)
  await store.regenerate(generated(1))
  const read = await store.read()
  const proposed = structuredClone(read.document)
  proposed.components[0].props.title.value = 'UI edit'
  const external = JSON.parse(await readFile(dataPath, 'utf8'))
  external.components[0].props.title.value =
    'External edit without revision bump'
  await writeFile(dataPath, stableSerialize(external))
  await assert.rejects(
    store.saveEditable(proposed, {
      revision: read.document.provenance.revision,
      etag: read.etag,
    }),
    StaleDocumentError,
  )
  assert.equal(
    JSON.parse(await readFile(dataPath, 'utf8')).components[0].props.title
      .value,
    'External edit without revision bump',
  )
})

test('invalid JSON remains on disk while the last valid in-memory document survives', async (t) => {
  const { dataPath, store } = await fixture(t)
  await store.regenerate(generated(1))
  const valid = await store.read()
  await writeFile(dataPath, '{ invalid json')
  const read = await store.read()
  assert.equal(read.status, 'invalid')
  assert.equal(
    read.lastValid.provenance.revision,
    valid.document.provenance.revision,
  )
  await assert.rejects(store.regenerate(generated(2)), InvalidDiskDocumentError)
  assert.equal(await readFile(dataPath, 'utf8'), '{ invalid json')
})

test('an invalid new generated config never becomes active', async (t) => {
  const { dataPath, store } = await fixture(t)
  await store.regenerate(generated(1))
  const before = await readFile(dataPath, 'utf8')
  const invalid = generated(2)
  invalid.components[0].props.title.generated = 42
  await assert.rejects(store.regenerate(invalid), InvalidDiskDocumentError)
  assert.equal(await readFile(dataPath, 'utf8'), before)
  assert.equal((await store.read()).status, 'valid')
})

test('interrupted atomic writes leave the prior file active and clean temporary files', async (t) => {
  const { dataPath, dir, store } = await fixture(t)
  await store.regenerate(generated(1))
  const before = await readFile(dataPath, 'utf8')
  const read = await store.read()
  const proposed = structuredClone(read.document)
  proposed.components[0].props.title.value = 'Never committed'
  await assert.rejects(
    store.saveEditable(
      proposed,
      { revision: read.document.provenance.revision, etag: read.etag },
      {
        beforeRename: () => {
          throw new Error('simulated interruption')
        },
      },
    ),
    /simulated interruption/,
  )
  assert.equal(await readFile(dataPath, 'utf8'), before)
  const { readdir } = await import('node:fs/promises')
  assert.ok(!(await readdir(dir)).some((name) => name.includes('.tmp-')))
})

test('a write appearing during atomic replacement is rejected, not reported merged', async (t) => {
  const { dataPath, store } = await fixture(t)
  await store.regenerate(generated(1))
  const read = await store.read()
  const proposed = structuredClone(read.document)
  proposed.components[0].props.title.value = 'UI'
  await assert.rejects(
    store.saveEditable(
      proposed,
      { revision: read.document.provenance.revision, etag: read.etag },
      {
        afterTemporaryWrite: async () => {
          const external = JSON.parse(await readFile(dataPath, 'utf8'))
          external.components[0].props.title.value = 'Racing external'
          await writeFile(dataPath, stableSerialize(external))
        },
      },
    ),
    ExternalWriteConflictError,
  )
  assert.equal(
    JSON.parse(await readFile(dataPath, 'utf8')).components[0].props.title
      .value,
    'Racing external',
  )
})
