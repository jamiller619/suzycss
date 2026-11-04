import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  mergeRegeneration,
  stableSerialize,
  validateDocument,
} from '../dist/document.js'

const example = async (name) =>
  JSON.parse(
    await readFile(new URL(`../examples/${name}`, import.meta.url), 'utf8'),
  )
test('hand-authored examples validate', async () => {
  assert.deepEqual(validateDocument(await example('react.preview.json')), [])
  assert.deepEqual(
    validateDocument(await example('web-component.preview.json')),
    [],
  )
})
test('malformed documents report precise paths and future versions fail', async () => {
  const document = await example('react.preview.json')
  document.schemaVersion = 2
  document.components[0].props.children.type.text = 42
  assert.deepEqual(
    validateDocument(document).map((issue) => issue.path),
    ['$.schemaVersion', '$.components[0].props.children.type.text'],
  )
  assert.match(validateDocument(document)[0].message, /unsupported future/)
})
test('serialization is stable and regeneration preserves developer ownership', async () => {
  const current = await example('react.preview.json')
  current.components[0].props.children.value = 'Developer choice'
  current.components[0].props.children.validators = [
    { $ref: 'validator', name: 'custom' },
  ]
  current.components[0]['x-team'] = { note: 'keep' }
  const generated = structuredClone(current)
  generated.provenance.revision = 1
  generated.components[0].props.children.generated = 'New suggestion'
  delete generated.components[0].props.children.value
  delete generated.components[0].props.children.validators
  delete generated.components[0]['x-team']
  const merged = mergeRegeneration(current, generated)
  assert.equal(merged.components[0].props.children.value, 'Developer choice')
  assert.equal(merged.components[0].props.children.generated, 'New suggestion')
  assert.equal(merged.components[0]['x-team'].note, 'keep')
  assert.equal(merged.provenance.baseRevision, 1)
  assert.equal(
    stableSerialize({ b: 1, a: { z: 2, y: 1 } }),
    stableSerialize({ a: { y: 1, z: 2 }, b: 1 }),
  )
})
