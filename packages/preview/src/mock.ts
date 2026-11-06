import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  ComponentState,
  JsonPrimitive,
  JsonValue,
  MockDiagnostic,
  MockGenerationOptions,
  PreviewComponent,
  PreviewDocument,
  PreviewValue,
  PropDefinition,
  TypeMetadata,
  ValueDescriptor,
} from './types.js'

type ValidatorDescriptor = NonNullable<PropDefinition['validators']>[number]
type Recipe = (context: RecipeContext) => PreviewValue
interface RecipeContext {
  random: () => number
  path: string
  tokens: string[]
  labelTokens?: string[]
  type: TypeMetadata
  attempt: number
}

const DEFAULT_SEED = 'heysuzy-preview-v1'
const DEFAULT_RETRIES = 20
const DEFAULT_STATE_CAP = 8
const OMIT: ValueDescriptor = { $ref: 'omit' }
const names = ['Alex Morgan', 'Jordan Lee', 'Sam Rivera', 'Taylor Kim']
const recipes: Record<string, Recipe> = {
  text: ({ tokens, labelTokens }) =>
    title(
      (labelTokens?.length ? labelTokens : tokens).length
        ? (labelTokens ?? tokens)
        : ['example'],
    ),
  person: ({ random }) => names[Math.floor(random() * names.length)] as string,
  money: ({ random }) => Math.round((250 + random() * 9750) * 100) / 100,
  percentage: ({ random }) => Math.round((35 + random() * 60) * 10) / 10,
  date: ({ random }) => {
    const date = new Date(Date.UTC(2028, 0, 1 + Math.floor(random() * 730)))
    return date.toISOString().slice(0, 10)
  },
  'date-time': ({ random }) => {
    const date = new Date(
      Date.UTC(2028, 0, 1 + Math.floor(random() * 730), 12, 0, 0),
    )
    return date.toISOString()
  },
  email: ({ random }) => `alex${Math.floor(random() * 900 + 100)}@example.com`,
  url: ({ random }) =>
    `https://example.com/item-${Math.floor(random() * 1000)}`,
  uuid: ({ path, attempt }) => deterministicUuid(`${path}:${attempt}`),
  emptyState: () => 'Nothing here yet',
}

export function registerRecipe(name: string, recipe: Recipe): void {
  if (!/^[a-z][a-zA-Z0-9-]*$/.test(name))
    throw new Error(`Invalid recipe name ${JSON.stringify(name)}`)
  recipes[name] = recipe
}

export async function generateDocumentMocks(
  document: PreviewDocument,
  options: MockGenerationOptions = {},
): Promise<{ document: PreviewDocument; diagnostics: MockDiagnostic[] }> {
  const next = structuredClone(document)
  const diagnostics: MockDiagnostic[] = []
  const selectedComponents = new Set(options.componentIds ?? [])
  for (const component of next.components) {
    if (selectedComponents.size && !selectedComponents.has(component.id))
      continue
    for (const name of Object.keys(component.props).sort()) {
      const prop = component.props[name] as PropDefinition
      const path = `${component.id}.${name}`
      if (!selected(path, options.paths) || prop.value !== undefined) continue
      const generated = await generateProp(
        component,
        name,
        prop,
        options,
        diagnostics,
      )
      if (generated !== undefined) prop.generated = generated
    }
    component.states = await representativeStates(
      component,
      options,
      diagnostics,
    )
  }
  return { document: next, diagnostics }
}

async function generateProp(
  component: PreviewComponent,
  name: string,
  prop: PropDefinition,
  options: MockGenerationOptions,
  diagnostics: MockDiagnostic[],
  suffix = '',
): Promise<PreviewValue | undefined> {
  const path = `${component.id}.${name}${suffix}`
  const contradiction = ruleContradiction(prop)
  if (contradiction) {
    diagnostics.push(issue(path, 'validation-unsatisfiable', contradiction))
    return
  }
  if (prop.generator?.$ref === 'generator') {
    const custom = await customGenerated(
      prop.generator,
      component,
      name,
      prop,
      options,
      path,
      diagnostics,
    )
    if (custom !== undefined) {
      const found = await validateValue(
        custom,
        prop.type,
        prop.validators,
        path,
        options.projectRoot,
      )
      if (!found.some((item) => item.severity === 'error')) return custom
      diagnostics.push(...found)
      return
    }
    if (prop.generator.module) return
  }
  if (prop.default !== undefined) {
    const found = await validateValue(
      prop.default,
      prop.type,
      prop.validators,
      path,
      options.projectRoot,
    )
    if (!found.some((item) => item.severity === 'error')) return prop.default
    diagnostics.push(
      issue(
        path,
        'default-invalid',
        'The declared default does not satisfy the resolved type and validation rules; generation continued with a recipe.',
      ),
    )
  }
  const retryCap = options.retryCap ?? DEFAULT_RETRIES
  for (let attempt = 0; attempt < retryCap; attempt++) {
    const candidate = generateType(
      prop.type,
      name,
      path,
      options.seed,
      attempt,
      prop,
    )
    const found = await validateValue(
      candidate,
      prop.type,
      prop.validators,
      path,
      options.projectRoot,
    )
    if (!found.some((item) => item.severity === 'error')) return candidate
  }
  diagnostics.push(
    issue(
      path,
      'generation-retries-exhausted',
      `Could not generate a valid value in ${retryCap} attempts. Pin a value or choose a compatible recipe.`,
    ),
  )
}

function generateType(
  type: TypeMetadata,
  name: string,
  path: string,
  seed: string | number | undefined,
  attempt: number,
  prop?: PropDefinition,
): PreviewValue {
  const allowed = allowedValues(prop?.validators)
  const literals = intersectLiterals(type.enum, allowed)
  if (literals?.length)
    return literals[
      Math.floor(randomFor(seed, path, attempt)() * literals.length)
    ] as JsonPrimitive
  if (type.enum && type.enum.length === 0) return OMIT
  const branch = chooseBranch(type, path, seed, attempt)
  if (branch !== type) return generateType(branch, name, path, seed, attempt)
  const labelTokens = normalizeName(name)
  const tokens = [
    ...new Set([
      ...labelTokens,
      ...normalizeName(path),
      ...normalizeName(type.text),
    ]),
  ]
  const random = randomFor(seed, path, attempt)
  const context = { random, path, tokens, labelTokens, type, attempt }
  if (type.kind === 'function') return { $ref: 'function', behavior: 'log' }
  if (type.kind === 'node')
    return {
      $ref: 'react-node',
      element: 'span',
      children: [semanticString(tokens, context)],
    }
  if (type.kind === 'boolean') return random() >= 0.5
  if (type.kind === 'number')
    return constrainedNumber(tokens, random, prop?.validators)
  if (type.kind === 'string')
    return constrainedString(tokens, context, prop?.validators)
  if (type.kind === 'array') {
    const length = constrainedLength(prop?.validators, 3)
    return Array.from({ length }, (_, index) =>
      generateType(
        type.items ?? { text: 'unknown', kind: 'unknown' },
        singular(name),
        `${path}/${index}`,
        seed,
        attempt,
      ),
    ) as PreviewValue
  }
  if (type.kind === 'object' && type.properties) {
    return Object.fromEntries(
      Object.keys(type.properties)
        .sort()
        .flatMap((key) => {
          const child = type.properties?.[key]
          if (
            !child ||
            (!child.required &&
              randomFor(seed, `${path}/${key}`, attempt)() < 0.35)
          )
            return []
          return [
            [key, generateType(child, key, `${path}/${key}`, seed, attempt)],
          ]
        }),
    ) as PreviewValue
  }
  return OMIT
}

function semanticString(tokens: string[], context: RecipeContext): string {
  const recipe = semanticRecipe(tokens, context.type)
  return String((recipes[recipe] ?? recipes.text)?.(context) ?? 'Example')
}
function semanticRecipe(tokens: string[], type: TypeMetadata): string {
  if (includesAll(tokens, ['empty', 'state', 'message'])) return 'emptyState'
  if (
    includesAll(tokens, ['outstanding', 'balance']) ||
    tokens.includes('amount') ||
    tokens.includes('price')
  )
    return 'money'
  if (
    includesAll(tokens, ['renewal', 'date']) ||
    tokens.some((token) => ['date', 'deadline', 'birthday'].includes(token))
  )
    return 'date'
  if (tokens.includes('assignee') || includesAll(tokens, ['owner', 'name']))
    return 'person'
  if (tokens.includes('email')) return 'email'
  if (tokens.includes('url') || tokens.includes('website')) return 'url'
  if (tokens.includes('uuid')) return 'uuid'
  if (type.text.includes('Date')) return 'date'
  return 'text'
}

function constrainedString(
  tokens: string[],
  context: RecipeContext,
  validators?: ValidatorDescriptor[],
): string {
  const format = ruleOption(validators, 'format', 'value')
  const recipe =
    typeof format === 'string' && recipes[format]
      ? format
      : semanticRecipe(tokens, context.type)
  let value = String((recipes[recipe] ?? recipes.text)?.(context) ?? 'Example')
  const pattern = ruleOption(validators, 'pattern', 'value')
  if (typeof pattern === 'string')
    value = patternCandidate(pattern, context) ?? value
  const minimum = numericRule(validators, 'minLength') ?? 0
  const maximum =
    numericRule(validators, 'maxLength') ?? Number.POSITIVE_INFINITY
  if (value.length < minimum) value = value.padEnd(minimum, 'x')
  if (value.length > maximum) value = value.slice(0, maximum)
  return value
}
function constrainedNumber(
  tokens: string[],
  random: () => number,
  validators?: ValidatorDescriptor[],
): number {
  const minimum =
    numericRule(validators, 'min') ??
    (tokens.includes('utilization') || tokens.includes('percent') ? 0 : 1)
  const maximum =
    numericRule(validators, 'max') ??
    (tokens.includes('utilization') || tokens.includes('percent') ? 100 : 10000)
  const raw = includesAll(tokens, ['outstanding', 'balance'])
    ? recipes.money?.({
        random,
        path: '',
        tokens,
        type: { text: 'number' },
        attempt: 0,
      })
    : tokens.includes('utilization')
      ? recipes.percentage?.({
          random,
          path: '',
          tokens,
          type: { text: 'number' },
          attempt: 0,
        })
      : minimum + random() * (maximum - minimum)
  return Math.min(
    maximum,
    Math.max(minimum, Math.round(Number(raw) * 100) / 100),
  )
}

export async function validateValue(
  value: PreviewValue,
  type: TypeMetadata,
  validators: ValidatorDescriptor[] = [],
  path = '$',
  projectRoot?: string,
): Promise<MockDiagnostic[]> {
  const diagnostics = shapeIssues(value, type, path)
  diagnostics.push(...ruleIssues(value, validators, path))
  for (const validator of validators.filter((item) => item.module))
    diagnostics.push(
      ...(await customValidation(value, validator, path, projectRoot)),
    )
  return diagnostics
}

export async function validateComponentState(
  component: PreviewComponent,
  state: ComponentState,
  projectRoot?: string,
): Promise<MockDiagnostic[]> {
  const diagnostics: MockDiagnostic[] = []
  for (const name of Object.keys(state.values ?? {}))
    if (!component.props[name])
      diagnostics.push(
        issue(
          `${component.id}.states.${state.name}.${name}`,
          'unknown-prop',
          `Unknown prop ${JSON.stringify(name)}.`,
        ),
      )
  for (const [name, prop] of Object.entries(component.props)) {
    const value =
      state.values?.[name] ??
      prop.value ??
      prop.generated ??
      prop.default ??
      OMIT
    diagnostics.push(
      ...(await validateValue(
        value,
        prop.type,
        prop.validators,
        `${component.id}.states.${state.name}.${name}`,
        projectRoot,
      )),
    )
  }
  return diagnostics
}

async function representativeStates(
  component: PreviewComponent,
  options: MockGenerationOptions,
  diagnostics: MockDiagnostic[],
): Promise<ComponentState[]> {
  const cap = Math.max(1, Math.min(options.stateCap ?? DEFAULT_STATE_CAP, 32))
  const developer = component.states.filter((state) => state.generated !== true)
  const preservedGenerated = options.paths?.length
    ? component.states.filter(
        (state) =>
          state.generated === true &&
          state.name !== 'default' &&
          Object.keys(state.values ?? {}).every(
            (name) => !selected(`${component.id}.${name}`, options.paths),
          ),
      )
    : []
  const generated: ComponentState[] = [
    { name: 'default', generated: true },
    ...preservedGenerated,
  ].slice(0, cap)
  const candidates: ComponentState[] = []
  for (const name of Object.keys(component.props).sort()) {
    const prop = component.props[name] as PropDefinition
    if (prop.value !== undefined) continue
    const path = `${component.id}.${name}`
    if (!selected(path, options.paths)) continue
    const branches =
      prop.type.branches?.filter((branch) => branch.text !== 'undefined') ?? []
    branches.forEach((branch, index) => {
      candidates.push({
        name: `${slug(name)}-${slug(branchLabel(branch, index))}`,
        generated: true,
        values: {
          [name]: generateType(
            branch,
            name,
            `${path}/branch-${index}`,
            options.seed,
            0,
          ),
        },
      })
    })
    if (prop.type.kind === 'boolean')
      candidates.push(
        { name: `${slug(name)}-on`, generated: true, values: { [name]: true } },
        {
          name: `${slug(name)}-off`,
          generated: true,
          values: { [name]: false },
        },
      )
    for (const literal of prop.type.enum?.slice(1) ?? [])
      candidates.push({
        name: `${slug(name)}-${slug(String(literal))}`,
        generated: true,
        values: { [name]: literal },
      })
    if (!prop.type.required)
      candidates.push({
        name: `${slug(name)}-omitted`,
        generated: true,
        values: { [name]: OMIT },
      })
  }
  for (const candidate of candidates) {
    if (generated.length >= cap) break
    const found = await validateComponentState(
      component,
      candidate,
      options.projectRoot,
    )
    if (found.some((item) => item.severity === 'error'))
      diagnostics.push(...found)
    else generated.push(candidate)
  }
  for (const state of developer) {
    const found = await validateComponentState(
      component,
      state,
      options.projectRoot,
    )
    state.diagnostics = [...(state.diagnostics ?? []), ...found]
    diagnostics.push(...found)
  }
  return [...developer, ...generated].slice(0, Math.max(cap, developer.length))
}

function shapeIssues(
  value: PreviewValue,
  type: TypeMetadata,
  path: string,
): MockDiagnostic[] {
  if (descriptor(value, 'omit'))
    return type.required
      ? [issue(path, 'required', 'A required value cannot be omitted.')]
      : []
  if (descriptor(value, 'function'))
    return type.kind === 'function'
      ? []
      : [
          issue(
            path,
            'type',
            `Expected ${type.text}, not a function descriptor.`,
          ),
        ]
  if (descriptor(value, 'react-node'))
    return type.kind === 'node'
      ? []
      : [
          issue(
            path,
            'type',
            `Expected ${type.text}, not a React-node descriptor.`,
          ),
        ]
  if (type.enum && !type.enum.some((literal) => Object.is(literal, value)))
    return [
      issue(
        path,
        'allowed-value',
        `Value must be one of ${type.enum.map((item) => JSON.stringify(item)).join(', ')}.`,
      ),
    ]
  if (type.branches?.length) {
    const branchResults = type.branches.map((branch) =>
      shapeIssues(value, branch, path),
    )
    if (!branchResults.some((result) => result.length === 0))
      return [
        issue(
          path,
          'union',
          `Value does not match any complete branch of ${type.text}.`,
        ),
      ]
    return []
  }
  if (type.kind === 'string' || type.kind === 'node')
    return typeof value === 'string' ||
      (type.kind === 'node' && descriptor(value, 'react-node'))
      ? []
      : [issue(path, 'type', `Expected ${type.kind}.`)]
  if (type.kind === 'number')
    return typeof value === 'number' && Number.isFinite(value)
      ? []
      : [issue(path, 'type', 'Expected a finite number.')]
  if (type.kind === 'boolean')
    return typeof value === 'boolean'
      ? []
      : [issue(path, 'type', 'Expected a boolean.')]
  if (type.kind === 'function')
    return [issue(path, 'type', 'Expected a function descriptor.')]
  if (type.kind === 'array') {
    if (!Array.isArray(value))
      return [issue(path, 'type', 'Expected an array.')]
    return value.flatMap((item, index) =>
      shapeIssues(
        item as PreviewValue,
        type.items ?? { text: 'unknown', kind: 'unknown' },
        `${path}[${index}]`,
      ),
    )
  }
  if (type.kind === 'object' && type.properties) {
    if (!plainObject(value) || '$ref' in value)
      return [issue(path, 'type', 'Expected an object.')]
    const found: MockDiagnostic[] = []
    for (const key of Object.keys(value))
      if (!type.properties[key])
        found.push(
          issue(
            `${path}.${key}`,
            'unknown-property',
            `Property ${JSON.stringify(key)} is not declared by ${type.text}.`,
          ),
        )
    for (const [key, child] of Object.entries(type.properties))
      found.push(
        ...shapeIssues(
          (value[key] as PreviewValue | undefined) ?? OMIT,
          child,
          `${path}.${key}`,
        ),
      )
    return found
  }
  return []
}

function ruleIssues(
  value: PreviewValue,
  validators: ValidatorDescriptor[],
  path: string,
): MockDiagnostic[] {
  const found: MockDiagnostic[] = []
  const required = validators.some((rule) => rule.name === 'required')
  if (required && (descriptor(value, 'omit') || value === null || value === ''))
    found.push(issue(path, 'required', 'Value is required.'))
  if (typeof value === 'number') {
    const min = numericRule(validators, 'min')
    const max = numericRule(validators, 'max')
    if (min !== undefined && value < min)
      found.push(issue(path, 'min', `Value must be at least ${min}.`))
    if (max !== undefined && value > max)
      found.push(issue(path, 'max', `Value must be at most ${max}.`))
  }
  if (typeof value === 'string' || Array.isArray(value)) {
    const min = numericRule(validators, 'minLength')
    const max = numericRule(validators, 'maxLength')
    if (min !== undefined && value.length < min)
      found.push(issue(path, 'min-length', `Length must be at least ${min}.`))
    if (max !== undefined && value.length > max)
      found.push(issue(path, 'max-length', `Length must be at most ${max}.`))
  }
  if (typeof value === 'string') {
    const pattern = ruleOption(validators, 'pattern', 'value')
    if (typeof pattern === 'string')
      try {
        if (!new RegExp(pattern).test(value))
          found.push(issue(path, 'pattern', `Value must match /${pattern}/.`))
      } catch {
        found.push(
          issue(
            path,
            'pattern-invalid',
            `Pattern ${JSON.stringify(pattern)} is not a valid regular expression.`,
          ),
        )
      }
    const format = ruleOption(validators, 'format', 'value')
    if (typeof format === 'string') {
      if (!supportedFormats.has(format))
        found.push(
          issue(
            path,
            'format-unsupported',
            `Format ${JSON.stringify(format)} is unsupported; use a custom validator or manual value.`,
          ),
        )
      else if (!validFormat(value, format))
        found.push(
          issue(path, 'format', `Value is not a supported ${format} format.`),
        )
    }
  }
  const allowed = allowedValues(validators)
  if (allowed && !allowed.some((item) => Object.is(item, value)))
    found.push(
      issue(
        path,
        'allowed-value',
        `Value must be one of ${allowed.map((item) => JSON.stringify(item)).join(', ')}.`,
      ),
    )
  return found
}

function ruleContradiction(prop: PropDefinition): string | undefined {
  const min = numericRule(prop.validators, 'min')
  const max = numericRule(prop.validators, 'max')
  if (min !== undefined && max !== undefined && min > max)
    return `Minimum ${min} exceeds maximum ${max}.`
  const minLength = numericRule(prop.validators, 'minLength')
  const maxLength = numericRule(prop.validators, 'maxLength')
  if (
    minLength !== undefined &&
    maxLength !== undefined &&
    minLength > maxLength
  )
    return `Minimum length ${minLength} exceeds maximum length ${maxLength}.`
  const allowed = allowedValues(prop.validators)
  if (allowed?.length === 0) return 'Allowed values cannot be empty.'
  if (
    allowed &&
    prop.type.enum &&
    intersectLiterals(prop.type.enum, allowed)?.length === 0
  )
    return 'Allowed values do not intersect the declared literal type.'
  return
}

async function customGenerated(
  descriptor: Extract<ValueDescriptor, { $ref: 'generator' }>,
  component: PreviewComponent,
  name: string,
  prop: PropDefinition,
  options: MockGenerationOptions,
  path: string,
  diagnostics: MockDiagnostic[],
): Promise<PreviewValue | undefined> {
  if (!descriptor.module) {
    const recipe = recipes[descriptor.name]
    if (!recipe) {
      diagnostics.push(
        issue(
          path,
          'generator-unknown',
          `Unknown generator recipe ${JSON.stringify(descriptor.name)}.`,
        ),
      )
      return
    }
    return recipe({
      random: randomFor(options.seed, path, 0),
      path,
      tokens: normalizeName(name),
      type: prop.type,
      attempt: 0,
    })
  }
  if (!options.projectRoot) {
    diagnostics.push(
      issue(
        path,
        'generator-root-required',
        'A project root is required to resolve a custom generator module.',
      ),
    )
    return
  }
  try {
    const module = await import(
      pathToFileURL(resolve(options.projectRoot, descriptor.module.path)).href
    )
    const generator = module[descriptor.module.export]
    if (typeof generator !== 'function')
      throw new Error(`export ${descriptor.module.export} is not a function`)
    const value = await generator(
      Object.freeze({
        seed: hash(`${options.seed ?? DEFAULT_SEED}:${path}`),
        path,
        componentId: component.id,
        prop: name,
        type: structuredClone(prop.type),
        default: structuredClone(prop.default),
        options: structuredClone(descriptor.options ?? {}),
      }),
    )
    if (!jsonCompatible(value)) throw new Error('returned a non-JSON value')
    return value as PreviewValue
  } catch (error) {
    diagnostics.push(
      issue(
        path,
        'generator-custom-error',
        `Custom generator ${descriptor.module.path}#${descriptor.module.export} failed: ${(error as Error).message}`,
      ),
    )
    return
  }
}

async function customValidation(
  value: PreviewValue,
  validator: ValidatorDescriptor,
  path: string,
  projectRoot?: string,
): Promise<MockDiagnostic[]> {
  if (!validator.module) return []
  if (!projectRoot)
    return [
      issue(
        path,
        'validator-root-required',
        'A project root is required to resolve a custom validator module.',
      ),
    ]
  try {
    const module = await import(
      pathToFileURL(resolve(projectRoot, validator.module.path)).href
    )
    const validate = module[validator.module.export]
    if (typeof validate !== 'function')
      throw new Error(`export ${validator.module.export} is not a function`)
    const result = await validate(
      structuredClone(value),
      Object.freeze({
        path,
        options: structuredClone(validator.options ?? {}),
      }),
    )
    return result === true || result === undefined
      ? []
      : [
          issue(
            path,
            'validator-custom',
            typeof result === 'string'
              ? result
              : `Custom validator ${validator.module.export} rejected the value.`,
          ),
        ]
  } catch (error) {
    return [
      issue(
        path,
        'validator-custom-error',
        `Custom validator ${validator.module.path}#${validator.module.export} failed: ${(error as Error).message}`,
      ),
    ]
  }
}

export function applyNestedOverrides(
  base: PreviewValue,
  overrides: Record<string, JsonValue>,
): PreviewValue {
  const next = structuredClone(base)
  for (const [pointer, value] of Object.entries(overrides)) {
    if (!pointer.startsWith('/'))
      throw new Error(
        `Override path ${JSON.stringify(pointer)} must be a JSON Pointer.`,
      )
    const parts = pointer
      .slice(1)
      .split('/')
      .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    let cursor: unknown = next
    for (const part of parts.slice(0, -1)) {
      if (Array.isArray(cursor))
        throw new Error(
          `Array items cannot be patched at ${pointer}; replace the complete array.`,
        )
      if (plainObject(cursor) && Array.isArray(cursor[part]))
        throw new Error(
          `Array items cannot be patched at ${pointer}; replace the complete array.`,
        )
      if (!plainObject(cursor) || !plainObject(cursor[part]))
        throw new Error(
          `Override path ${pointer} does not address an existing object.`,
        )
      cursor = cursor[part]
    }
    if (Array.isArray(cursor))
      throw new Error(
        `Array items cannot be patched at ${pointer}; replace the complete array.`,
      )
    if (!plainObject(cursor))
      throw new Error(`Override path ${pointer} does not address an object.`)
    const leaf = parts.at(-1)
    if (!leaf)
      throw new Error(
        'The root value must be replaced directly, not through an empty pointer.',
      )
    cursor[leaf] = structuredClone(value)
  }
  return next
}

function chooseBranch(
  type: TypeMetadata,
  path: string,
  seed: string | number | undefined,
  attempt: number,
) {
  const branches = type.branches?.filter(
    (branch) => branch.text !== 'undefined' && branch.text !== 'null',
  )
  return branches?.length
    ? (branches[
        Math.floor(
          randomFor(seed, `${path}/branch`, attempt)() * branches.length,
        )
      ] as TypeMetadata)
    : type
}
function selected(path: string, paths?: string[]) {
  return (
    !paths?.length ||
    paths.some(
      (selectedPath) =>
        path === selectedPath || path.startsWith(`${selectedPath}/`),
    )
  )
}
function normalizeName(value: string): string[] {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}
function includesAll(values: string[], expected: string[]) {
  return expected.every((value) => values.includes(value))
}
function title(values: string[]) {
  const text = values.join(' ')
  return text ? text[0]?.toUpperCase() + text.slice(1) : 'Example'
}
function singular(value: string) {
  return value.replace(/ies$/, 'y').replace(/s$/, '')
}
function slug(value: string) {
  return normalizeName(value).join('-') || 'value'
}
function branchLabel(branch: TypeMetadata, index: number) {
  const discriminator =
    branch.discriminator && branch.properties?.[branch.discriminator]?.enum?.[0]
  return discriminator ? String(discriminator) : `branch-${index + 1}`
}
function constrainedLength(
  validators: ValidatorDescriptor[] | undefined,
  fallback: number,
) {
  const min = numericRule(validators, 'minLength') ?? 0
  const max = numericRule(validators, 'maxLength') ?? Math.max(fallback, min)
  return Math.max(min, Math.min(max, fallback))
}
function numericRule(
  validators: ValidatorDescriptor[] | undefined,
  name: string,
) {
  const value = ruleOption(validators, name, 'value')
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
function ruleOption(
  validators: ValidatorDescriptor[] | undefined,
  name: string,
  option: string,
): JsonValue | undefined {
  return validators?.find((rule) => rule.name === name)?.options?.[option]
}
function allowedValues(
  validators?: ValidatorDescriptor[],
): JsonPrimitive[] | undefined {
  const values = ruleOption(validators, 'allowed', 'values')
  return Array.isArray(values) &&
    values.every(
      (value) =>
        value === null ||
        ['string', 'number', 'boolean'].includes(typeof value),
    )
    ? (values as JsonPrimitive[])
    : undefined
}
function intersectLiterals(
  type: JsonPrimitive[] | undefined,
  allowed: JsonPrimitive[] | undefined,
) {
  if (!type) return allowed
  if (!allowed) return type
  return type.filter((value) => allowed.some((item) => Object.is(item, value)))
}
function patternCandidate(
  pattern: string,
  context: RecipeContext,
): string | undefined {
  const simple = /^\^\[([A-Za-z])-([A-Za-z])\]\{(\d+)\}\\d\{(\d+)\}\$$/.exec(
    pattern,
  )
  if (!simple) return
  const letters = Number(simple[3])
  const digits = Number(simple[4])
  return `${String.fromCharCode((simple[1] as string).charCodeAt(0) + Math.floor(context.random() * ((simple[2] as string).charCodeAt(0) - (simple[1] as string).charCodeAt(0) + 1))).repeat(letters)}${Array.from({ length: digits }, () => Math.floor(context.random() * 10)).join('')}`
}
function validFormat(value: string, format: string) {
  if (format === 'date')
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    )
  if (format === 'date-time')
    return !Number.isNaN(Date.parse(value)) && /T/.test(value)
  if (format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  if (format === 'url')
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol)
    } catch {
      return false
    }
  if (format === 'uuid')
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  return true
}
const supportedFormats = new Set(['date', 'date-time', 'email', 'url', 'uuid'])
function descriptor(
  value: unknown,
  ref: string,
): value is Record<string, JsonValue> {
  return plainObject(value) && value.$ref === ref
}
function plainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function jsonCompatible(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined
  } catch {
    return false
  }
}
function issue(path: string, code: string, message: string): MockDiagnostic {
  return { severity: 'error', code, message, path }
}
function hash(value: string) {
  let state = 2166136261
  for (let index = 0; index < value.length; index++) {
    state ^= value.charCodeAt(index)
    state = Math.imul(state, 16777619)
  }
  return state >>> 0
}
function randomFor(
  seed: string | number | undefined,
  path: string,
  attempt: number,
) {
  let state = hash(`${seed ?? DEFAULT_SEED}:${path}:${attempt}`)
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
function deterministicUuid(value: string) {
  const parts = [0, 1, 2, 3].map((index) =>
    hash(`${value}:${index}`).toString(16).padStart(8, '0'),
  )
  return `${parts[0]}-${parts[1]?.slice(0, 4)}-4${parts[1]?.slice(5, 8)}-a${parts[2]?.slice(1, 4)}-${parts[2]?.slice(4)}${parts[3]}`.slice(
    0,
    36,
  )
}

export const mockPolicy = Object.freeze({
  defaultSeed: DEFAULT_SEED,
  retryCap: DEFAULT_RETRIES,
  stateCap: DEFAULT_STATE_CAP,
  stateSelection:
    'baseline, then one-field union branches, boolean poles, alternate literals, and optional omission in stable prop order',
})
