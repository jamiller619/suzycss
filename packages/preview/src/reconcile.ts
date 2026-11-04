import { validateValue } from './mock.js'
import type {
  ComponentState,
  JsonValue,
  OrphanedCustomization,
  PreviewComponent,
  PreviewDocument,
  ReconciliationConflict,
} from './types.js'

const MISSING = Symbol('missing')
type MergeValue = unknown | typeof MISSING

export interface ReconciliationResult {
  document: PreviewDocument
  conflicts: ReconciliationConflict[]
  orphans: OrphanedCustomization[]
}

export async function reconcileDocuments(
  baseline: PreviewDocument,
  current: PreviewDocument,
  generated: PreviewDocument,
  projectRoot?: string,
): Promise<ReconciliationResult> {
  const conflicts: ReconciliationConflict[] = []
  const orphans: OrphanedCustomization[] = [...(current.orphans ?? [])]
  const baseComponents = new Map(
    baseline.components.map((component) => [component.id, component]),
  )
  const currentComponents = new Map(
    current.components.map((component) => [component.id, component]),
  )
  const generatedComponents = new Map(
    generated.components.map((component) => [component.id, component]),
  )
  const components: PreviewComponent[] = []
  for (const id of [...generatedComponents.keys()].sort()) {
    const next = generatedComponents.get(id) as PreviewComponent
    const previous = baseComponents.get(id)
    const edited = currentComponents.get(id)
    if (!previous && edited) {
      conflicts.push(
        conflict(
          `$.components[${JSON.stringify(id)}]`,
          'component-id-collision',
          'A manually added component now has the same stable ID as a discovered component; the manual version was preserved for review.',
          MISSING,
          edited,
          next,
        ),
      )
      components.push(structuredClone(edited))
      continue
    }
    if (!previous || !edited) {
      components.push(structuredClone(next))
      continue
    }
    components.push(
      await mergeComponent(
        previous,
        edited,
        next,
        conflicts,
        orphans,
        current.provenance.revision,
        projectRoot,
      ),
    )
  }
  for (const [id, previous] of baseComponents) {
    if (generatedComponents.has(id)) continue
    const edited = currentComponents.get(id)
    if (edited && !equal(edited, previous)) {
      orphans.push({
        path: `$.components[${JSON.stringify(id)}]`,
        reason: 'component-removed',
        value: json(edited),
        sourceRevision: current.provenance.revision,
      })
      conflicts.push(
        conflict(
          `$.components[${JSON.stringify(id)}]`,
          'component-removed-customized',
          'The component disappeared from source. Its customized document is preserved in orphans and was not matched by name.',
          previous,
          edited,
          MISSING,
        ),
      )
    }
  }
  for (const [id, edited] of currentComponents) {
    if (!baseComponents.has(id) && !generatedComponents.has(id))
      components.push(structuredClone(edited))
  }
  const document: PreviewDocument = {
    ...structuredClone(generated),
    ...extensionFields(
      mergeObject(
        extensionFields(baseline),
        extensionFields(current),
        extensionFields(generated),
        '$',
        conflicts,
      ),
    ),
    provenance: {
      ...generated.provenance,
      revision: current.provenance.revision + 1,
      baseRevision: current.provenance.revision,
    },
    components: components.sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics: [
      ...generated.diagnostics,
      ...conflicts.map((item) => ({
        severity: 'warning' as const,
        code: item.code,
        message: item.message,
        path: item.path,
      })),
    ],
    conflicts: [...(current.conflicts ?? []), ...conflicts],
    orphans,
  }
  return { document, conflicts, orphans }
}

async function mergeComponent(
  baseline: PreviewComponent,
  current: PreviewComponent,
  generated: PreviewComponent,
  conflicts: ReconciliationConflict[],
  orphans: OrphanedCustomization[],
  revision: number,
  projectRoot?: string,
): Promise<PreviewComponent> {
  const path = `$.components[${JSON.stringify(generated.id)}]`
  const merged = mergeObject(
    without(baseline, ['props', 'states']),
    without(current, ['props', 'states']),
    without(generated, ['props', 'states']),
    path,
    conflicts,
  ) as unknown as PreviewComponent
  const props: PreviewComponent['props'] = {}
  for (const name of Object.keys(generated.props).sort()) {
    const next = generated.props[name]
    if (!next) continue
    const previous = baseline.props[name]
    const edited = current.props[name]
    const propPath = `${path}.props.${escapePath(name)}`
    if (!previous && edited) {
      conflicts.push(
        conflict(
          propPath,
          'prop-id-collision',
          'A manually added prop now has the same name as a discovered prop; the manual definition was preserved.',
          MISSING,
          edited,
          next,
        ),
      )
      props[name] = structuredClone(edited)
      continue
    }
    if (!previous || !edited) {
      props[name] = structuredClone(next)
      continue
    }
    const prop = mergeObject(
      previous,
      edited,
      next,
      propPath,
      conflicts,
    ) as unknown as typeof next
    if (Object.hasOwn(prop, 'value') && prop.value !== undefined) {
      const issues = await validateValue(
        prop.value,
        next.type,
        next.validators,
        `${propPath}.value`,
        projectRoot,
      )
      if (issues.some((item) => item.severity === 'error'))
        conflicts.push(
          conflict(
            `${propPath}.value`,
            'custom-value-incompatible',
            `The customized value was preserved but no longer matches the inferred type or rules: ${issues.map((item) => item.message).join(' ')}`,
            previous.value ?? MISSING,
            prop.value,
            next.generated ?? MISSING,
          ),
        )
    }
    props[name] = prop
  }
  for (const [name, previous] of Object.entries(baseline.props)) {
    if (generated.props[name]) continue
    const edited = current.props[name]
    if (edited && !equal(edited, previous)) {
      const propPath = `${path}.props.${escapePath(name)}`
      orphans.push({
        path: propPath,
        reason: 'prop-removed',
        value: json(edited),
        sourceRevision: revision,
      })
      conflicts.push(
        conflict(
          propPath,
          'prop-removed-customized',
          'The prop disappeared from source. Its customized definition is preserved in orphans; no rename was inferred.',
          previous,
          edited,
          MISSING,
        ),
      )
    }
  }
  return {
    ...merged,
    id: generated.id,
    props,
    states: mergeStates(
      baseline.states,
      current.states,
      generated.states,
      `${path}.states`,
      conflicts,
      orphans,
      revision,
    ),
  }
}

function mergeStates(
  baseline: ComponentState[],
  current: ComponentState[],
  generated: ComponentState[],
  path: string,
  conflicts: ReconciliationConflict[],
  orphans: OrphanedCustomization[],
  revision: number,
): ComponentState[] {
  const old = new Map(baseline.map((state) => [state.name, state]))
  const edited = new Map(current.map((state) => [state.name, state]))
  const next = new Map(generated.map((state) => [state.name, state]))
  const states: ComponentState[] = []
  for (const name of [...next.keys()].sort()) {
    const generatedState = next.get(name) as ComponentState
    const baselineState = old.get(name)
    const currentState = edited.get(name)
    states.push(
      baselineState && currentState
        ? (mergeObject(
            baselineState,
            currentState,
            generatedState,
            `${path}.${escapePath(name)}`,
            conflicts,
          ) as unknown as ComponentState)
        : structuredClone(currentState ?? generatedState),
    )
  }
  for (const [name, currentState] of edited) {
    if (next.has(name)) continue
    const baselineState = old.get(name)
    if (!baselineState) {
      states.push(structuredClone(currentState))
      continue
    }
    if (!equal(currentState, baselineState)) {
      const statePath = `${path}.${escapePath(name)}`
      const preserved = { ...structuredClone(currentState), generated: false }
      states.push(preserved)
      orphans.push({
        path: statePath,
        reason: 'state-removed',
        value: json(currentState),
        sourceRevision: revision,
      })
      conflicts.push(
        conflict(
          statePath,
          'state-removed-customized',
          'A generated state disappeared, but its customization remains as a developer state and in orphans.',
          baselineState,
          currentState,
          MISSING,
        ),
      )
    }
  }
  return states.sort((a, b) => a.name.localeCompare(b.name))
}

function mergeObject(
  baseline: object,
  current: object,
  generated: object,
  path: string,
  conflicts: ReconciliationConflict[],
): Record<string, unknown> {
  const baselineRecord = baseline as Record<string, unknown>
  const currentRecord = current as Record<string, unknown>
  const generatedRecord = generated as Record<string, unknown>
  const result: Record<string, unknown> = {}
  const keys = new Set([
    ...Object.keys(baselineRecord),
    ...Object.keys(currentRecord),
    ...Object.keys(generatedRecord),
  ])
  for (const key of [...keys].sort()) {
    const value = mergeNode(
      Object.hasOwn(baselineRecord, key) ? baselineRecord[key] : MISSING,
      Object.hasOwn(currentRecord, key) ? currentRecord[key] : MISSING,
      Object.hasOwn(generatedRecord, key) ? generatedRecord[key] : MISSING,
      `${path}.${escapePath(key)}`,
      conflicts,
    )
    if (value !== MISSING) result[key] = value
  }
  return result
}

function mergeNode(
  baseline: MergeValue,
  current: MergeValue,
  generated: MergeValue,
  path: string,
  conflicts: ReconciliationConflict[],
): MergeValue {
  if (equal(current, baseline)) return cloneValue(generated)
  if (equal(generated, baseline) || equal(current, generated))
    return cloneValue(current)
  if (record(baseline) && record(current) && record(generated))
    return mergeObject(baseline, current, generated, path, conflicts)
  conflicts.push(
    conflict(
      path,
      'concurrent-field-change',
      'Source generation and the editable document changed this field differently. The editable value was preserved for review.',
      baseline,
      current,
      generated,
    ),
  )
  return cloneValue(current)
}

function conflict(
  path: string,
  code: string,
  message: string,
  baseline: MergeValue,
  current: MergeValue,
  generated: MergeValue,
): ReconciliationConflict {
  return {
    path,
    code,
    message,
    ...(baseline === MISSING ? {} : { baseline: json(baseline) }),
    ...(current === MISSING ? {} : { current: json(current) }),
    ...(generated === MISSING ? {} : { generated: json(generated) }),
  }
}

function without(value: object, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  )
}
function extensionFields(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key.startsWith('x-')),
  )
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function equal(left: MergeValue, right: MergeValue): boolean {
  if (left === MISSING || right === MISSING) return left === right
  return JSON.stringify(sort(left)) === JSON.stringify(sort(right))
}
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort)
  if (!record(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sort(value[key])]),
  )
}
function cloneValue(value: MergeValue): MergeValue {
  return value === MISSING ? MISSING : structuredClone(value)
}
function json(value: unknown): JsonValue {
  return structuredClone(value) as JsonValue
}
function escapePath(value: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(value) ? value : `[${JSON.stringify(value)}]`
}
