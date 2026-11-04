import type {
  PreviewComponent,
  PreviewDocument,
  ValidationIssue,
} from './types.js'

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const pushType = (
  issues: ValidationIssue[],
  path: string,
  value: unknown,
  type: string,
) => {
  if (
    (type === 'object' && !object(value)) ||
    (type === 'array' && !Array.isArray(value)) ||
    (type !== 'object' && type !== 'array' && typeof value !== type)
  )
    issues.push({ path, message: `expected ${type}` })
}
export function validateDocument(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!object(value)) return [{ path: '$', message: 'expected object' }]
  if (value.schemaVersion !== 1)
    issues.push({
      path: '$.schemaVersion',
      message:
        typeof value.schemaVersion === 'number' && value.schemaVersion > 1
          ? `unsupported future schema version ${value.schemaVersion}; this version supports 1`
          : 'expected literal 1',
    })
  pushType(issues, '$.project', value.project, 'object')
  if (object(value.project)) {
    pushType(issues, '$.project.root', value.project.root, 'string')
    pushType(issues, '$.project.entry', value.project.entry, 'string')
  }
  pushType(issues, '$.provenance', value.provenance, 'object')
  if (object(value.provenance)) {
    for (const key of ['generator', 'generatorVersion', 'generatedAt'])
      pushType(issues, `$.provenance.${key}`, value.provenance[key], 'string')
    pushType(
      issues,
      '$.provenance.revision',
      value.provenance.revision,
      'number',
    )
    if (value.provenance.baseline !== undefined) {
      pushType(
        issues,
        '$.provenance.baseline',
        value.provenance.baseline,
        'object',
      )
      if (object(value.provenance.baseline)) {
        pushType(
          issues,
          '$.provenance.baseline.fingerprint',
          value.provenance.baseline.fingerprint,
          'string',
        )
        pushType(
          issues,
          '$.provenance.baseline.path',
          value.provenance.baseline.path,
          'string',
        )
      }
    }
  }
  pushType(issues, '$.components', value.components, 'array')
  if (Array.isArray(value.components)) {
    const ids = new Set<string>()
    value.components.forEach((component, index) => {
      validateComponent(component, `$.components[${index}]`, issues, ids)
    })
  }
  pushType(issues, '$.diagnostics', value.diagnostics, 'array')
  validateReviewEntries(value.conflicts, '$.conflicts', issues, [
    'path',
    'code',
    'message',
  ])
  validateReviewEntries(value.orphans, '$.orphans', issues, ['path', 'reason'])
  return issues
}
function validateReviewEntries(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  stringKeys: string[],
) {
  if (value === undefined) return
  pushType(issues, path, value, 'array')
  if (!Array.isArray(value)) return
  value.forEach((entry, index) => {
    if (!object(entry)) {
      issues.push({ path: `${path}[${index}]`, message: 'expected object' })
      return
    }
    for (const key of stringKeys)
      pushType(issues, `${path}[${index}].${key}`, entry[key], 'string')
    if (path === '$.orphans')
      pushType(
        issues,
        `${path}[${index}].sourceRevision`,
        entry.sourceRevision,
        'number',
      )
  })
}
function validateComponent(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  ids: Set<string>,
) {
  if (!object(value)) {
    issues.push({ path, message: 'expected object' })
    return
  }
  for (const key of ['id', 'name'])
    pushType(issues, `${path}.${key}`, value[key], 'string')
  if (typeof value.id === 'string') {
    if (ids.has(value.id))
      issues.push({
        path: `${path}.id`,
        message: `duplicate component id ${JSON.stringify(value.id)}`,
      })
    ids.add(value.id)
  }
  if (value.framework !== 'react' && value.framework !== 'web-component')
    issues.push({
      path: `${path}.framework`,
      message: 'expected "react" or "web-component"',
    })
  for (const key of ['source', 'import', 'props'])
    pushType(issues, `${path}.${key}`, value[key], 'object')
  pushType(issues, `${path}.states`, value.states, 'array')
  if (object(value.source)) {
    pushType(issues, `${path}.source.path`, value.source.path, 'string')
    pushType(issues, `${path}.source.export`, value.source.export, 'string')
  }
  if (object(value.import)) {
    pushType(issues, `${path}.import.path`, value.import.path, 'string')
    pushType(issues, `${path}.import.export`, value.import.export, 'string')
  }
  if (object(value.props))
    for (const [name, prop] of Object.entries(value.props)) {
      if (!object(prop))
        issues.push({
          path: `${path}.props.${name}`,
          message: 'expected object',
        })
      else if (!object(prop.type) || typeof prop.type.text !== 'string')
        issues.push({
          path: `${path}.props.${name}.type.text`,
          message: 'expected string',
        })
    }
  if (Array.isArray(value.states))
    value.states.forEach((state, index) => {
      if (!object(state))
        issues.push({
          path: `${path}.states[${index}]`,
          message: 'expected object',
        })
      else
        pushType(issues, `${path}.states[${index}].name`, state.name, 'string')
    })
}
export function assertDocument(
  value: unknown,
): asserts value is PreviewDocument {
  const issues = validateDocument(value)
  if (issues.length)
    throw new Error(
      `Invalid preview document:\n${issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n')}`,
    )
}
export function stableSerialize(value: unknown): string {
  const sort = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sort)
      : object(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sort(item[key])]),
          )
        : item
  return `${JSON.stringify(sort(value), null, 2)}\n`
}
/** Generated fields advance; developer values, states, validators, wrappers, and extensions win. */
export function mergeRegeneration(
  current: PreviewDocument,
  generated: PreviewDocument,
): PreviewDocument {
  assertDocument(current)
  assertDocument(generated)
  const old = new Map(
    current.components.map((component) => [component.id, component]),
  )
  return {
    ...current,
    ...generated,
    provenance: {
      ...generated.provenance,
      baseRevision: current.provenance.revision,
      revision: current.provenance.revision + 1,
    },
    components: generated.components.map((next) =>
      mergeComponent(old.get(next.id), next),
    ),
  }
}
function mergeComponent(
  current: PreviewComponent | undefined,
  generated: PreviewComponent,
): PreviewComponent {
  if (!current) return generated
  const props = Object.fromEntries(
    Object.entries(generated.props).map(([name, prop]) => {
      const previous = current.props[name]
      return [
        name,
        previous
          ? {
              ...prop,
              ...previous,
              type: prop.type,
              attribute: prop.attribute,
              default: prop.default,
              generated: prop.generated,
              diagnostics: prop.diagnostics,
            }
          : prop,
      ]
    }),
  )
  return {
    ...generated,
    ...current,
    source: generated.source,
    import: generated.import,
    props,
    states: [
      ...current.states.filter(
        (state) =>
          state.generated !== true &&
          !(
            state.name === 'default' &&
            !state.values &&
            !state.wrapper &&
            !state.description
          ),
      ),
      ...generated.states.filter((state) => state.generated === true),
    ],
    diagnostics: generated.diagnostics,
  }
}

export type * from './types.js'
