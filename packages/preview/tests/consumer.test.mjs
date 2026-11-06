import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { analyzeProject } from '../dist/analysis.js'
import { validateDocument } from '../dist/document.js'
import { generateDocumentMocks } from '../dist/mock.js'
import { validateDocumentSemantics } from '../dist/persistence.js'

const consumers = resolve('examples/consumers')

function options(name, input = 'src/index.ts') {
  const projectRoot = resolve(consumers, name)
  return {
    projectRoot,
    input: resolve(projectRoot, input),
    inputKind: 'automatic',
    output: resolve(projectRoot, '.preview'),
    data: resolve(projectRoot, '.preview/preview.json'),
    runtime: resolve(projectRoot, '.preview/runtime'),
    baselines: resolve(projectRoot, '.preview/baselines'),
  }
}

test('React consumer covers imported unions, defaults, semantics, and extensions', async () => {
  const project = options('react', 'src/index.tsx')
  const analyzed = await analyzeProject(project)
  const component = analyzed.components.find(
    (candidate) => candidate.name === 'BillingCard',
  )
  assert.ok(component)
  assert.equal(component.props.audience.type.discriminator, 'kind')
  assert.deepEqual(
    component.props.audience.type.branches.map(
      (branch) => branch.properties.kind.enum[0],
    ),
    ['person', 'team'],
  )
  assert.equal(component.props.utilization.default, 0.5)
  assert.equal(component.props.emptyStateMessage.default, 'No milestones yet')
  assert.equal(component.props.onAssign.type.kind, 'function')

  component.props.outstandingBalance.generator = {
    $ref: 'generator',
    name: 'fixture-balance',
    module: {
      $ref: 'module',
      path: 'preview-extensions.mjs',
      export: 'balanceGenerator',
    },
  }
  component.props.outstandingBalance.validators = [
    {
      $ref: 'validator',
      module: {
        $ref: 'module',
        path: 'preview-extensions.mjs',
        export: 'nonNegative',
      },
    },
  ]
  analyzed.runtime = {
    styles: ['src/billing-card.css'],
    providers: [
      {
        $ref: 'module',
        path: 'src/PreviewProvider.tsx',
        export: 'PreviewProvider',
      },
    ],
  }
  const first = await generateDocumentMocks(analyzed, {
    projectRoot: project.projectRoot,
    seed: 'consumer-contract',
  })
  const second = await generateDocumentMocks(analyzed, {
    projectRoot: project.projectRoot,
    seed: 'consumer-contract',
  })
  const firstCard = first.document.components.find(
    (candidate) => candidate.name === 'BillingCard',
  )
  const secondCard = second.document.components.find(
    (candidate) => candidate.name === 'BillingCard',
  )
  assert.equal(
    firstCard.props.outstandingBalance.generated,
    secondCard.props.outstandingBalance.generated,
  )
  assert.equal(typeof firstCard.props.outstandingBalance.generated, 'number')
  assert.match(firstCard.props.renewalDate.generated, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(
    ['person', 'team'].includes(firstCard.props.audience.generated.kind),
  )
  assert.deepEqual(validateDocument(first.document), [])
  assert.deepEqual(
    await validateDocumentSemantics(first.document, project.projectRoot),
    [],
  )
})

test('Web Component consumer covers CEM mappings and unsupported registration', async () => {
  const project = options('web-components')
  const analyzed = await analyzeProject(project)
  assert.deepEqual(validateDocument(analyzed), [])
  assert.equal(analyzed.components.length, 1)
  const component = analyzed.components[0]
  assert.equal(component.source.tagName, 'account-chip')
  assert.equal(component.props.displayName.attribute, 'display-name')
  assert.equal(
    component.props.displayName.type.description,
    'Visible account owner name.',
  )
  assert.equal(component.props.account.type.kind, 'object')
  assert.ok(
    analyzed.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'web-component-dynamic-registration' &&
        /Add the component manually/.test(diagnostic.message),
    ),
  )
  analyzed.runtime = {
    styles: ['src/account-chip.css'],
    webComponents: {
      [component.id]: {
        properties: ['displayName', 'account'],
        attributes: { active: 'active' },
        events: ['account-select'],
      },
    },
  }
  const generated = await generateDocumentMocks(analyzed, {
    projectRoot: project.projectRoot,
  })
  assert.deepEqual(
    await validateDocumentSemantics(generated.document, project.projectRoot),
    [],
  )
})
