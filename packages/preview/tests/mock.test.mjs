import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  applyNestedOverrides,
  generateDocumentMocks,
  mockPolicy,
  validateComponentState,
  validateValue,
} from '../dist/mock.js'

const validator = (name, value) => ({
  $ref: 'validator',
  name,
  options: { value },
})
const objectBranch = (kind, fields) => ({
  text: `{ kind: '${kind}' }`,
  kind: 'object',
  properties: {
    kind: { text: `'${kind}'`, kind: 'string', required: true, enum: [kind] },
    ...fields,
  },
})
function fixture() {
  return {
    schemaVersion: 1,
    project: { root: '.', entry: 'src/index.ts' },
    provenance: {
      generator: '@heysuzy/preview',
      generatorVersion: '0.1.0',
      generatedAt: '1970-01-01T00:00:00.000Z',
      revision: 1,
    },
    diagnostics: [],
    components: [
      {
        id: 'src/dashboard.tsx#Dashboard',
        name: 'Dashboard',
        framework: 'react',
        source: { path: 'src/dashboard.tsx', export: 'Dashboard' },
        import: { path: 'src/dashboard.tsx', export: 'Dashboard' },
        props: {
          outstandingBalance: {
            type: { text: 'number', kind: 'number', required: true },
            validators: [validator('min', 0), validator('max', 10000)],
          },
          renewalDate: {
            type: { text: 'string', kind: 'string', required: true },
            validators: [validator('format', 'date')],
          },
          assignee: {
            type: { text: 'string', kind: 'string', required: true },
            value: 'Pinned Owner',
          },
          utilization: {
            type: { text: 'number', kind: 'number', required: true },
            validators: [validator('min', 0), validator('max', 100)],
          },
          milestones: {
            type: {
              text: 'Milestone[]',
              kind: 'array',
              required: true,
              items: {
                text: 'Milestone',
                kind: 'object',
                properties: {
                  label: { text: 'string', kind: 'string', required: true },
                  done: { text: 'boolean', kind: 'boolean', required: true },
                },
              },
            },
            validators: [validator('minLength', 2), validator('maxLength', 3)],
          },
          emptyStateMessage: {
            type: { text: 'string', kind: 'string', required: true },
          },
          status: {
            type: {
              text: "'draft' | 'active'",
              kind: 'string',
              required: true,
              enum: ['draft', 'active'],
            },
          },
          variant: {
            type: {
              text: 'Person | Team',
              kind: 'object',
              required: true,
              discriminator: 'kind',
              branches: [
                objectBranch('person', {
                  name: { text: 'string', kind: 'string', required: true },
                }),
                objectBranch('team', {
                  title: { text: 'string', kind: 'string', required: true },
                  members: {
                    text: 'string[]',
                    kind: 'array',
                    required: true,
                    items: { text: 'string', kind: 'string' },
                  },
                }),
              ],
            },
          },
          optionalNote: {
            type: {
              text: 'string | undefined',
              kind: 'string',
              required: false,
            },
          },
        },
        states: [
          {
            name: 'custom-invalid',
            values: { variant: { kind: 'person', title: 'Mixed branch' } },
          },
        ],
      },
    ],
  }
}

test('semantic recipes are plausible, constrained, and stable by field path', async () => {
  const first = await generateDocumentMocks(fixture(), {
    seed: 'stable',
    stateCap: 7,
  })
  const reordered = fixture()
  reordered.components[0].props = Object.fromEntries(
    Object.entries(reordered.components[0].props).reverse(),
  )
  const second = await generateDocumentMocks(reordered, {
    seed: 'stable',
    stateCap: 7,
  })
  const a = first.document.components[0].props
  const b = second.document.components[0].props
  assert.equal(a.outstandingBalance.generated, b.outstandingBalance.generated)
  assert.equal(a.renewalDate.generated, b.renewalDate.generated)
  assert.match(a.renewalDate.generated, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(
    a.outstandingBalance.generated >= 0 &&
      a.outstandingBalance.generated <= 10000,
  )
  assert.ok(a.utilization.generated >= 0 && a.utilization.generated <= 100)
  assert.equal(a.milestones.generated.length, 3)
  assert.equal(a.emptyStateMessage.generated, 'Nothing here yet')
  assert.ok(['draft', 'active'].includes(a.status.generated))
  assert.equal(a.assignee.value, 'Pinned Owner')
  assert.equal(a.assignee.generated, undefined)
  assert.ok(first.document.components[0].states.length <= 7)
  assert.equal(mockPolicy.stateCap, 8)
})

test('selective regeneration changes only selected generated fields', async () => {
  const initial = (await generateDocumentMocks(fixture(), { seed: 'one' }))
    .document
  const beforeBalance = initial.components[0].props.outstandingBalance.generated
  const beforeDate = initial.components[0].props.renewalDate.generated
  const beforeStates = initial.components[0].states
    .filter((state) => state.generated && !state.values?.renewalDate)
    .map((state) => state.name)
  const next = (
    await generateDocumentMocks(initial, {
      seed: 'two',
      paths: ['src/dashboard.tsx#Dashboard.renewalDate'],
    })
  ).document
  assert.equal(
    next.components[0].props.outstandingBalance.generated,
    beforeBalance,
  )
  assert.notEqual(next.components[0].props.renewalDate.generated, beforeDate)
  assert.equal(next.components[0].props.assignee.value, 'Pinned Owner')
  assert.deepEqual(
    next.components[0].states
      .filter((state) => state.generated && !state.values?.renewalDate)
      .map((state) => state.name),
    beforeStates,
  )
})

test('union branches stay whole and complete states are validated', async () => {
  const result = await generateDocumentMocks(fixture(), {
    seed: 42,
    stateCap: 8,
  })
  const component = result.document.components[0]
  const unionStates = component.states.filter(
    (state) => state.generated && state.name.startsWith('variant-'),
  )
  assert.ok(unionStates.length >= 2)
  for (const state of unionStates)
    assert.deepEqual(await validateComponentState(component, state), [])
  const manual = component.states.find(
    (state) => state.name === 'custom-invalid',
  )
  assert.ok(manual.diagnostics.some((item) => item.code === 'union'))
})

test('contradictions and supported validation rules return path diagnostics', async () => {
  const document = fixture()
  document.components[0].props.utilization.validators = [
    validator('min', 80),
    validator('max', 20),
  ]
  const generated = await generateDocumentMocks(document, { retryCap: 3 })
  assert.ok(
    generated.diagnostics.some(
      (item) =>
        item.code === 'validation-unsatisfiable' &&
        item.path.endsWith('.utilization'),
    ),
  )
  const rules = [
    validator('required', true),
    validator('minLength', 4),
    validator('maxLength', 8),
    validator('pattern', '^[A-Z]+$'),
    {
      $ref: 'validator',
      name: 'allowed',
      options: { values: ['GOOD', 'BEST'] },
    },
  ]
  assert.deepEqual(
    await validateValue(
      'GOOD',
      { text: 'string', kind: 'string', required: true },
      rules,
      '$.code',
    ),
    [],
  )
  const invalid = await validateValue(
    'bad',
    { text: 'string', kind: 'string', required: true },
    rules,
    '$.code',
  )
  assert.ok(invalid.every((item) => item.path === '$.code'))
  assert.ok(invalid.some((item) => item.code === 'min-length'))
  assert.ok(invalid.some((item) => item.code === 'pattern'))
  assert.ok(invalid.some((item) => item.code === 'allowed-value'))
})

test('custom module generators/validators fail clearly and nested overrides replace datasets', async () => {
  const root = resolve('tests/fixtures')
  const document = fixture()
  document.components[0].props.ticket = {
    type: { text: 'string', kind: 'string', required: true },
    generator: {
      $ref: 'generator',
      name: 'ticket',
      module: {
        $ref: 'module',
        path: './mock-extensions.mjs',
        export: 'ticketGenerator',
      },
    },
    validators: [
      {
        $ref: 'validator',
        module: {
          $ref: 'module',
          path: './mock-extensions.mjs',
          export: 'startsWithTicket',
        },
      },
    ],
  }
  const result = await generateDocumentMocks(document, {
    projectRoot: root,
    seed: 'custom',
  })
  assert.match(result.document.components[0].props.ticket.generated, /^TICKET-/)
  assert.deepEqual(
    await validateValue(
      result.document.components[0].props.ticket.generated,
      document.components[0].props.ticket.type,
      document.components[0].props.ticket.validators,
      '$.ticket',
      root,
    ),
    [],
  )
  const base = { profile: { name: 'Before', tags: ['one'] } }
  assert.deepEqual(
    applyNestedOverrides(base, {
      '/profile/name': 'After',
      '/profile/tags': ['complete', 'replacement'],
    }),
    { profile: { name: 'After', tags: ['complete', 'replacement'] } },
  )
  assert.throws(
    () => applyNestedOverrides(base, { '/profile/tags/0': 'patched' }),
    /replace the complete array/,
  )
})
