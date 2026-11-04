import type {
  ComponentState,
  JsonValue,
  MockDiagnostic,
  PreviewComponent,
  PreviewDocument,
  PreviewValue,
  PropDefinition,
  TypeMetadata,
} from './types.js'

declare global {
  var __SUZY_PREVIEW_TOKEN__: string

  interface ImportMeta {
    readonly hot?: {
      on(event: string, callback: (data: { message: string }) => void): void
    }
  }
}

const CHANNEL = 'heysuzy-preview'
const VERSION = 1
const DRAFT_KEY = 'heysuzy-preview-valid-draft'
const token = globalThis.__SUZY_PREVIEW_TOKEN__
const elements = {
  components: required<HTMLElement>('components'),
  frame: required<HTMLIFrameElement>('preview-frame'),
  diagnostics: required<HTMLElement>('diagnostics'),
  events: required<HTMLOListElement>('events'),
  state: required<HTMLSelectElement>('state-select'),
  stateName: required<HTMLInputElement>('new-state-name'),
  saveState: required<HTMLButtonElement>('save-state'),
  status: required<HTMLElement>('save-status'),
  save: required<HTMLButtonElement>('save-document'),
  regenerate: required<HTMLButtonElement>('regenerate-component'),
  props: required<HTMLElement>('props'),
  controlsTab: required<HTMLButtonElement>('controls-tab'),
  jsonTab: required<HTMLButtonElement>('json-tab'),
  controlsPanel: required<HTMLElement>('controls-panel'),
  jsonPanel: required<HTMLElement>('json-panel'),
  json: required<HTMLTextAreaElement>('json-editor'),
  jsonErrors: required<HTMLElement>('json-errors'),
  applyJson: required<HTMLButtonElement>('apply-json'),
  external: required<HTMLElement>('external-banner'),
}

let saved: PreviewDocument
let draft: PreviewDocument
let lastValidDraft: PreviewDocument
let etag = ''
let dirty = false
let valid = true
let saving = false
let selectedComponentId = ''
let selectedStateName = ''
let reloadCounter = 0
let activeTab: 'controls' | 'json' = 'controls'
let documentText = ''
let documentTextInvalid = false
let diagnostics: MockDiagnostic[] = []
let externalPending:
  | { document: PreviewDocument; etag: string; revision: number }
  | undefined
const fieldDrafts = new Map<string, string>()

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing explorer element #${id}`)
  return element as T
}
function clone<T>(value: T): T {
  return structuredClone(value)
}
async function api<T>(
  path: string,
  body?: unknown,
  method = 'POST',
): Promise<T> {
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    headers: body
      ? {
          'content-type': 'application/json',
          'x-suzy-token': token,
        }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const value = (await response.json()) as T & { error?: string }
  if (!response.ok)
    throw new Error(value.error ?? `Request failed: ${response.status}`)
  return value
}
async function fetchDocument() {
  return api<{
    document: PreviewDocument
    etag: string
    revision: number
    diskStatus: string
  }>('/__preview/api/document', undefined, 'GET')
}

async function loadInitial() {
  const response = await fetchDocument()
  const cachedText = localStorage.getItem(DRAFT_KEY)
  let cached: PreviewDocument | undefined
  if (cachedText) {
    try {
      cached = JSON.parse(cachedText) as PreviewDocument
    } catch {
      localStorage.removeItem(DRAFT_KEY)
    }
  }
  adopt(response.document, response.etag)
  if (
    cached &&
    cached.schemaVersion === response.document.schemaVersion &&
    cached.provenance.revision === response.document.provenance.revision &&
    cached.project.root === response.document.project.root &&
    cached.project.entry === response.document.project.entry &&
    formatted(cached) !== formatted(response.document)
  ) {
    draft = clone(cached)
    lastValidDraft = clone(cached)
    dirty = true
    documentText = formatted(draft)
    localStorage.setItem(DRAFT_KEY, JSON.stringify(lastValidDraft))
    render()
    reloadFrame()
  }
}
function adopt(documentValue: PreviewDocument, nextEtag: string) {
  saved = clone(documentValue)
  draft = clone(documentValue)
  lastValidDraft = clone(documentValue)
  etag = nextEtag
  dirty = false
  valid = true
  diagnostics = []
  fieldDrafts.clear()
  documentTextInvalid = false
  documentText = formatted(draft)
  externalPending = undefined
  selectedComponentId =
    draft.components.find((item) => item.id === selectedComponentId)?.id ??
    draft.components[0]?.id ??
    ''
  const component = selectedComponent()
  selectedStateName =
    component?.states.find((item) => item.name === selectedStateName)?.name ??
    component?.states[0]?.name ??
    ''
  localStorage.setItem(DRAFT_KEY, JSON.stringify(lastValidDraft))
  render()
  reloadFrame()
}

function selectedComponent(
  documentValue = draft,
): PreviewComponent | undefined {
  return documentValue.components.find(
    (item) => item.id === selectedComponentId,
  )
}
function selectedState(
  component = selectedComponent(),
): ComponentState | undefined {
  return component?.states.find((item) => item.name === selectedStateName)
}
function valueSource(
  prop: PropDefinition,
  state: ComponentState | undefined,
  name: string,
) {
  if (state?.values && Object.hasOwn(state.values, name))
    return { value: state.values[name], source: 'state override', own: true }
  if (Object.hasOwn(prop, 'value'))
    return { value: prop.value, source: 'saved override', own: true }
  if (Object.hasOwn(prop, 'generated'))
    return { value: prop.generated, source: 'generated', own: false }
  if (Object.hasOwn(prop, 'default'))
    return { value: prop.default, source: 'default', own: false }
  return {
    value: { $ref: 'omit' } as PreviewValue,
    source: 'omitted',
    own: false,
  }
}
function editStateScope(): boolean {
  const state = selectedState()
  return Boolean(state && state.name !== 'default')
}

async function mutate(
  operation: (documentValue: PreviewDocument) => void,
  options: { preserveText?: boolean } = {},
) {
  const next = clone(draft)
  operation(next)
  draft = next
  dirty = true
  if (!options.preserveText) {
    documentText = formatted(draft)
    documentTextInvalid = false
  }
  await validateAndRender()
}
async function validateAndRender() {
  try {
    const result = await api<{ valid: boolean; diagnostics: MockDiagnostic[] }>(
      '/__preview/api/validate',
      { document: draft },
    )
    diagnostics = result.diagnostics
    valid = result.valid && !documentTextInvalid && fieldDrafts.size === 0
  } catch (error) {
    diagnostics = [
      {
        severity: 'error',
        code: 'validation-request',
        path: '$',
        message: (error as Error).message,
      },
    ]
    valid = false
  }
  if (valid) {
    lastValidDraft = clone(draft)
    localStorage.setItem(DRAFT_KEY, JSON.stringify(lastValidDraft))
    reloadFrame()
  }
  render()
}

function reloadFrame() {
  const component = selectedComponent(lastValidDraft)
  if (!component) {
    elements.frame.src = 'about:blank'
    return
  }
  const state =
    component.states.find((item) => item.name === selectedStateName) ??
    component.states[0]
  const query = new URLSearchParams({
    component: component.id,
    state: state?.name ?? 'default',
    reload: String(reloadCounter++),
  })
  elements.frame.src = `/__preview/frame?${query}`
}

function render() {
  renderNavigation()
  renderStateSelector()
  renderStatus()
  renderExternal()
  renderDiagnostics()
  renderTabs()
  if (activeTab === 'controls') renderProps()
  else renderJson()
}
function renderNavigation() {
  elements.components.replaceChildren(
    ...draft.components.map((component) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'component-button'
      button.dataset.componentId = component.id
      button.setAttribute('aria-label', component.name)
      button.setAttribute(
        'aria-current',
        String(component.id === selectedComponentId),
      )
      const name = document.createElement('span')
      name.textContent = component.name
      const framework = document.createElement('span')
      framework.className = 'framework'
      framework.textContent = component.framework === 'react' ? 'React' : 'WC'
      button.append(name, framework)
      button.addEventListener('click', () => {
        selectedComponentId = component.id
        selectedStateName = component.states[0]?.name ?? ''
        render()
        reloadFrame()
      })
      return button
    }),
  )
}
function renderStateSelector() {
  const component = selectedComponent()
  elements.state.replaceChildren(
    ...(component?.states ?? []).map((state) => {
      const option = document.createElement('option')
      option.value = state.name
      option.textContent = `${state.name}${state.generated ? ' · automatic' : ' · named'}`
      option.selected = state.name === selectedStateName
      return option
    }),
  )
  elements.state.disabled = !component
}
function renderStatus() {
  elements.status.textContent = !valid
    ? 'Invalid draft · preview kept last valid values'
    : dirty
      ? 'Unsaved draft'
      : 'Saved'
  elements.status.className = `status ${dirty ? 'dirty' : 'saved'}`
  elements.save.disabled =
    !dirty || !valid || saving || Boolean(externalPending)
  elements.regenerate.disabled = !valid || fieldDrafts.size > 0
}
function renderExternal() {
  if (!externalPending) {
    elements.external.hidden = true
    elements.external.replaceChildren()
    return
  }
  elements.external.hidden = false
  const message = document.createElement('span')
  message.textContent =
    'The preview document changed outside this explorer. Your draft is preserved.'
  const merge = actionButton(
    'Merge external changes',
    () => void mergeExternal(),
  )
  const reload = actionButton('Reload and discard draft', () =>
    reloadExternal(),
  )
  reload.classList.add('danger')
  elements.external.replaceChildren(message, merge, reload)
}
function renderDiagnostics() {
  const conflictText = (draft.conflicts ?? [])
    .slice(-5)
    .map((item) => `${item.path}: ${item.message}`)
  const validationText = diagnostics
    .filter((item) => item.severity === 'error')
    .slice(0, 8)
    .map((item) => `${item.path}: ${item.message}`)
  elements.diagnostics.textContent = [...conflictText, ...validationText].join(
    '\n',
  )
}
function renderTabs() {
  const controls = activeTab === 'controls'
  elements.controlsTab.setAttribute('aria-selected', String(controls))
  elements.jsonTab.setAttribute('aria-selected', String(!controls))
  elements.controlsPanel.hidden = !controls
  elements.jsonPanel.hidden = controls
}

function renderProps() {
  const component = selectedComponent()
  const state = selectedState(component)
  if (!component) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'No component selected.'
    elements.props.replaceChildren(empty)
    return
  }
  elements.props.replaceChildren(
    ...Object.entries(component.props).map(([name, prop]) =>
      propEditor(component, state, name, prop),
    ),
  )
}
function propEditor(
  component: PreviewComponent,
  state: ComponentState | undefined,
  name: string,
  prop: PropDefinition,
): HTMLElement {
  const card = document.createElement('section')
  card.className = 'prop-card'
  card.dataset.prop = name
  const head = document.createElement('div')
  head.className = 'prop-head'
  const title = document.createElement('span')
  title.className = 'prop-name'
  title.textContent = name
  const source = valueSource(prop, state, name)
  const badge = document.createElement('span')
  badge.className = 'badge'
  badge.textContent = source.source
  head.append(title, badge)
  const type = document.createElement('div')
  type.className = 'framework'
  type.textContent = prop.type.text
  card.append(head, type)

  const modeLabel = label('Value source')
  const mode = document.createElement('select')
  mode.setAttribute('aria-label', `${name} value source`)
  const descriptorRef = descriptor(source.value)
  const currentMode = source.own
    ? descriptorRef === 'omit'
      ? 'omit'
      : source.value === null
        ? 'null'
        : 'override'
    : 'generated'
  const modes: Array<[string, string]> = [
    ['generated', 'Use generated/default'],
    ['override', 'Override value'],
    ['omit', 'Explicitly omit'],
    ['null', 'Explicit null'],
  ]
  if (prop.default !== undefined)
    modes.splice(1, 0, ['default', 'Use declared default'])
  for (const [value, text] of modes) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = text
    option.selected = value === currentMode
    mode.append(option)
  }
  mode.addEventListener('change', () => {
    const next = mode.value
    if (next === 'generated')
      void setOverride(component.id, name, undefined, true)
    else if (next === 'omit')
      void setOverride(component.id, name, { $ref: 'omit' })
    else if (next === 'null') void setOverride(component.id, name, null)
    else if (next === 'default')
      void setOverride(component.id, name, clone(prop.default))
    else
      void setOverride(
        component.id,
        name,
        initialValue(prop.type, source.value),
      )
  })
  modeLabel.append(mode)
  card.append(modeLabel)

  if (currentMode === 'override')
    card.append(valueControl(component, name, prop, source.value))
  if (prop.type.branches?.length && currentMode === 'override')
    card.insertBefore(
      unionControl(component, name, prop, source.value),
      card.lastElementChild,
    )

  card.append(generatorControl(component, name, prop))
  card.append(validationControl(component, name, prop))
  const actions = document.createElement('div')
  actions.className = 'actions'
  const regenerate = actionButton(
    'Regenerate field',
    () => void regeneratePaths([`${component.id}.${name}`]),
  )
  regenerate.disabled = source.own || !valid
  const reset = actionButton(
    'Reset override',
    () => void setOverride(component.id, name, undefined, true),
  )
  reset.disabled = !source.own
  actions.append(regenerate, reset)
  card.append(actions)
  const errors = issuesFor(name)
  for (const item of errors) {
    const error = document.createElement('p')
    error.className = 'field-error'
    error.textContent = item.message
    card.append(error)
  }
  return card
}

function valueControl(
  component: PreviewComponent,
  name: string,
  prop: PropDefinition,
  value: PreviewValue | undefined,
): HTMLElement {
  const path = `${component.id}.${selectedStateName}.${name}.value`
  const wrapper = document.createElement('div')
  const type = prop.type
  if (type.kind === 'boolean') {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = value === true
    input.setAttribute('aria-label', `${name} value`)
    input.addEventListener(
      'change',
      () => void setOverride(component.id, name, input.checked),
    )
    const controlLabel = label('Boolean value')
    controlLabel.append(input)
    wrapper.append(controlLabel)
    return wrapper
  }
  if (type.enum?.length) {
    const select = document.createElement('select')
    select.setAttribute('aria-label', `${name} literal value`)
    for (const literal of type.enum) {
      const option = document.createElement('option')
      option.value = JSON.stringify(literal)
      option.textContent = String(literal)
      option.selected = Object.is(literal, value)
      select.append(option)
    }
    select.addEventListener(
      'change',
      () =>
        void setOverride(
          component.id,
          name,
          JSON.parse(select.value) as JsonValue,
        ),
    )
    const controlLabel = label('Allowed value')
    controlLabel.append(select)
    wrapper.append(controlLabel)
    return wrapper
  }
  if (type.kind === 'number') {
    const input = document.createElement('input')
    input.type = 'number'
    input.value = fieldDrafts.get(path) ?? String(value ?? '')
    input.setAttribute('aria-label', `${name} number value`)
    input.addEventListener('change', () => {
      const number = Number(input.value)
      if (!input.value || !Number.isFinite(number)) {
        fieldDrafts.set(path, input.value)
        dirty = true
        valid = false
        render()
        return
      }
      fieldDrafts.delete(path)
      void setOverride(component.id, name, number)
    })
    const controlLabel = label('Number value')
    controlLabel.append(input)
    wrapper.append(controlLabel)
    return wrapper
  }
  if (type.kind === 'string') {
    const input = document.createElement('input')
    input.type = 'text'
    input.value = String(value ?? '')
    input.setAttribute('aria-label', `${name} text value`)
    input.addEventListener(
      'change',
      () => void setOverride(component.id, name, input.value),
    )
    const controlLabel = label('Text value')
    controlLabel.append(input)
    wrapper.append(controlLabel)
    return wrapper
  }
  const textarea = document.createElement('textarea')
  textarea.value = fieldDrafts.get(path) ?? JSON.stringify(value, null, 2)
  textarea.setAttribute(
    'aria-label',
    `${name} ${type.kind === 'array' ? 'dataset' : descriptor(value) ? 'descriptor' : 'structured'} value`,
  )
  textarea.addEventListener('change', () => {
    try {
      const parsed = JSON.parse(textarea.value) as PreviewValue
      fieldDrafts.delete(path)
      void setOverride(component.id, name, parsed)
    } catch (error) {
      fieldDrafts.set(path, textarea.value)
      dirty = true
      valid = false
      diagnostics = [
        ...diagnostics.filter((item) => item.path !== path),
        {
          severity: 'error',
          code: 'json-draft',
          path,
          message: (error as Error).message,
        },
      ]
      render()
    }
  })
  const controlLabel = label(
    type.kind === 'array'
      ? 'Dataset JSON · replaces the complete array'
      : descriptor(value)
        ? 'Descriptor JSON'
        : 'Structured JSON',
  )
  controlLabel.append(textarea)
  wrapper.append(controlLabel)
  return wrapper
}

function unionControl(
  component: PreviewComponent,
  name: string,
  prop: PropDefinition,
  value: PreviewValue | undefined,
): HTMLElement {
  const select = document.createElement('select')
  select.setAttribute('aria-label', `${name} union branch`)
  const discriminator = prop.type.discriminator
  const current =
    discriminator && object(value)
      ? (value as Record<string, JsonValue>)[discriminator]
      : undefined
  for (const [index, branch] of (prop.type.branches ?? []).entries()) {
    if (branch.text === 'undefined' || branch.text === 'null') continue
    const option = document.createElement('option')
    option.value = String(index)
    const literal = discriminator
      ? branch.properties?.[discriminator]?.enum?.[0]
      : undefined
    option.textContent = literal === undefined ? branch.text : String(literal)
    option.selected = literal === current
    select.append(option)
  }
  select.addEventListener('change', () => {
    const branch = prop.type.branches?.[Number(select.value)]
    if (branch)
      void setOverride(component.id, name, initialValue(branch, undefined))
  })
  const controlLabel = label('Union branch')
  controlLabel.append(select)
  return controlLabel
}

function generatorControl(
  component: PreviewComponent,
  name: string,
  prop: PropDefinition,
): HTMLElement {
  const wrapper = document.createElement('div')
  const select = document.createElement('select')
  select.setAttribute('aria-label', `${name} generator recipe`)
  const current =
    prop.generator?.$ref === 'generator' ? prop.generator.name : ''
  for (const recipe of [
    ['', 'Automatic recipe'],
    ['text', 'Text'],
    ['person', 'Person'],
    ['money', 'Money'],
    ['percentage', 'Percentage'],
    ['date', 'Date'],
    ['email', 'Email'],
    ['url', 'URL'],
    ['uuid', 'UUID'],
    ['emptyState', 'Empty-state message'],
    ['custom', 'Custom module…'],
  ]) {
    const option = document.createElement('option')
    option.value = recipe[0] as string
    option.textContent = recipe[1] as string
    option.selected =
      option.value === current ||
      Boolean(
        current && !recipes().includes(current) && option.value === 'custom',
      )
    select.append(option)
  }
  select.addEventListener(
    'change',
    () =>
      void mutate((documentValue) => {
        const target = componentById(documentValue, component.id).props[name]
        if (!target) return
        if (!select.value) delete target.generator
        else if (select.value === 'custom')
          target.generator = {
            $ref: 'generator',
            name: 'custom',
            module: {
              $ref: 'module',
              path: './preview-generators.js',
              export: 'generate',
            },
          }
        else target.generator = { $ref: 'generator', name: select.value }
      }),
  )
  const controlLabel = label('Generator recipe')
  controlLabel.append(select)
  wrapper.append(controlLabel)
  if (prop.generator?.$ref === 'generator' && prop.generator.module) {
    const textarea = document.createElement('textarea')
    textarea.value = JSON.stringify(prop.generator, null, 2)
    textarea.setAttribute('aria-label', `${name} custom generator descriptor`)
    textarea.addEventListener('change', () => {
      try {
        const parsed = JSON.parse(textarea.value) as PropDefinition['generator']
        void mutate((documentValue) => {
          const target = componentById(documentValue, component.id).props[name]
          if (target) target.generator = parsed
        })
      } catch (error) {
        diagnostics = [
          ...diagnostics,
          {
            severity: 'error',
            code: 'generator-json',
            path: `${component.id}.${name}.generator`,
            message: (error as Error).message,
          },
        ]
        valid = false
        dirty = true
        render()
      }
    })
    const moduleLabel = label('Custom generator descriptor')
    moduleLabel.append(textarea)
    wrapper.append(moduleLabel)
  }
  return wrapper
}

function validationControl(
  component: PreviewComponent,
  name: string,
  prop: PropDefinition,
): HTMLElement {
  const textarea = document.createElement('textarea')
  textarea.value = JSON.stringify(prop.validators ?? [], null, 2)
  textarea.setAttribute('aria-label', `${name} validation rules`)
  textarea.addEventListener('change', () => {
    try {
      const parsed = JSON.parse(textarea.value) as PropDefinition['validators']
      if (!Array.isArray(parsed))
        throw new Error('Validation rules must be an array.')
      void mutate((documentValue) => {
        const target = componentById(documentValue, component.id).props[name]
        if (!target) return
        if (parsed.length) target.validators = parsed
        else delete target.validators
      })
    } catch (error) {
      const path = `${component.id}.${name}.validators`
      fieldDrafts.set(path, textarea.value)
      diagnostics = [
        ...diagnostics.filter((item) => item.path !== path),
        {
          severity: 'error',
          code: 'validator-json',
          path,
          message: (error as Error).message,
        },
      ]
      valid = false
      dirty = true
      render()
    }
  })
  const controlLabel = label('Validation rules JSON')
  controlLabel.append(textarea)
  return controlLabel
}

async function setOverride(
  componentId: string,
  name: string,
  value: PreviewValue | undefined,
  remove = false,
) {
  await mutate((documentValue) => {
    const component = componentById(documentValue, componentId)
    const state = component.states.find(
      (item) => item.name === selectedStateName,
    )
    if (editStateScope() && state) {
      state.values ??= {}
      state.generated = false
      if (remove) delete state.values[name]
      else state.values[name] = clone(value) as PreviewValue
      return
    }
    const prop = component.props[name]
    if (!prop) return
    if (remove) delete prop.value
    else prop.value = clone(value) as PreviewValue
  })
}
async function regeneratePaths(paths: string[]) {
  if (!valid) return
  const result = await api<{
    document: PreviewDocument
    diagnostics: MockDiagnostic[]
  }>('/__preview/api/regenerate', { document: draft, paths })
  draft = result.document
  diagnostics = result.diagnostics
  dirty = true
  documentText = formatted(draft)
  await validateAndRender()
}

async function saveDocument() {
  if (!dirty || !valid || saving || externalPending) return
  saving = true
  renderStatus()
  try {
    const response = await api<{
      document: PreviewDocument
      etag: string
      changed: boolean
    }>(
      '/__preview/api/document',
      {
        document: draft,
        revision: saved.provenance.revision,
        etag,
      },
      'PUT',
    )
    adopt(response.document, response.etag)
  } catch (error) {
    elements.diagnostics.textContent = (error as Error).message
    await stageExternal()
  } finally {
    saving = false
    renderStatus()
  }
}
async function stageExternal() {
  const response = await fetchDocument()
  if (!dirty) {
    adopt(response.document, response.etag)
    return
  }
  externalPending = {
    document: response.document,
    etag: response.etag,
    revision: response.revision,
  }
  renderExternal()
  renderStatus()
}
async function mergeExternal() {
  if (!externalPending || documentTextInvalid || fieldDrafts.size) return
  const result = await api<{
    document: PreviewDocument
    conflicts: PreviewDocument['conflicts']
  }>('/__preview/api/merge-draft', { baseline: saved, draft })
  saved = clone(externalPending.document)
  etag = externalPending.etag
  draft = result.document
  externalPending = undefined
  dirty = true
  documentText = formatted(draft)
  await validateAndRender()
}
function reloadExternal() {
  if (!externalPending) return
  adopt(externalPending.document, externalPending.etag)
}

function renderJson() {
  if (document.activeElement !== elements.json)
    elements.json.value = documentText
  elements.jsonErrors.textContent = documentTextInvalid
    ? 'JSON is invalid. The last valid preview remains active.'
    : ''
}
async function applyJson() {
  try {
    const parsed = JSON.parse(elements.json.value) as PreviewDocument
    documentText = elements.json.value
    documentTextInvalid = false
    fieldDrafts.clear()
    draft = parsed
    dirty = true
    await validateAndRender()
  } catch (error) {
    documentText = elements.json.value
    documentTextInvalid = true
    dirty = true
    valid = false
    elements.jsonErrors.textContent = (error as Error).message
    renderStatus()
  }
}

function saveNamedState() {
  const name = elements.stateName.value.trim()
  const component = selectedComponent()
  if (!name || !component) return
  if (component.states.some((state) => state.name === name)) {
    elements.diagnostics.textContent = `State ${JSON.stringify(name)} already exists.`
    return
  }
  void mutate((documentValue) => {
    const target = componentById(documentValue, component.id)
    const sourceState = target.states.find(
      (state) => state.name === selectedStateName,
    )
    const values = Object.fromEntries(
      Object.entries(target.props).map(([propName, prop]) => [
        propName,
        clone(valueSource(prop, sourceState, propName).value) as PreviewValue,
      ]),
    )
    target.states.push({ name, values, generated: false })
    selectedStateName = name
    elements.stateName.value = ''
  })
}

function initialValue(type: TypeMetadata, current: unknown): PreviewValue {
  if (current !== undefined && !descriptor(current))
    return clone(current) as PreviewValue
  if (type.enum?.length) return type.enum[0] ?? null
  const branch = type.branches?.find(
    (item) => item.text !== 'undefined' && item.text !== 'null',
  )
  if (branch) return initialValue(branch, undefined)
  if (type.kind === 'boolean') return false
  if (type.kind === 'number') return 0
  if (type.kind === 'string') return ''
  if (type.kind === 'function') return { $ref: 'function', behavior: 'log' }
  if (type.kind === 'node')
    return { $ref: 'react-node', element: 'span', children: ['Preview'] }
  if (type.kind === 'array') return []
  if (type.kind === 'object')
    return Object.fromEntries(
      Object.entries(type.properties ?? {})
        .filter(([, child]) => child.required)
        .map(([name, child]) => [name, initialValue(child, undefined)]),
    ) as PreviewValue
  return { $ref: 'omit' }
}
function componentById(documentValue: PreviewDocument, id: string) {
  const component = documentValue.components.find((item) => item.id === id)
  if (!component) throw new Error(`Unknown component ${id}`)
  return component
}
function issuesFor(name: string) {
  const matching = diagnostics.filter(
    (item) =>
      item.path.includes(`.${name}`) ||
      item.path.includes(`[${JSON.stringify(name)}]`),
  )
  return matching.filter(
    (item, index) =>
      matching.findIndex(
        (candidate) =>
          candidate.code === item.code && candidate.message === item.message,
      ) === index,
  )
}
function descriptor(value: unknown): string | undefined {
  return object(value) && typeof value.$ref === 'string'
    ? value.$ref
    : undefined
}
function object(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function formatted(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`
}
function label(text: string) {
  const element = document.createElement('label')
  element.append(document.createTextNode(text))
  return element
}
function actionButton(text: string, action: () => void) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'secondary'
  button.textContent = text
  button.addEventListener('click', action)
  return button
}
function recipes() {
  return [
    'text',
    'person',
    'money',
    'percentage',
    'date',
    'email',
    'url',
    'uuid',
    'emptyState',
  ]
}

elements.state.addEventListener('change', () => {
  selectedStateName = elements.state.value
  render()
  reloadFrame()
})
elements.saveState.addEventListener('click', saveNamedState)
elements.save.addEventListener('click', () => void saveDocument())
elements.regenerate.addEventListener('click', () => {
  const component = selectedComponent()
  if (component)
    void regeneratePaths(
      Object.entries(component.props)
        .filter(([, prop]) => prop.value === undefined)
        .map(([name]) => `${component.id}.${name}`),
    )
})
elements.controlsTab.addEventListener('click', () => {
  activeTab = 'controls'
  render()
})
elements.jsonTab.addEventListener('click', () => {
  activeTab = 'json'
  documentText = formatted(draft)
  render()
})
elements.json.addEventListener('input', () => {
  documentText = elements.json.value
  documentTextInvalid = true
  dirty = true
  valid = false
  renderStatus()
  elements.jsonErrors.textContent =
    'Validate this draft before previewing or saving.'
})
elements.applyJson.addEventListener('click', () => void applyJson())
elements.components.addEventListener('keydown', (event) => {
  if (
    !(event instanceof KeyboardEvent) ||
    !['ArrowDown', 'ArrowUp'].includes(event.key)
  )
    return
  const buttons = [
    ...elements.components.querySelectorAll<HTMLButtonElement>('button'),
  ]
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (index < 0) return
  event.preventDefault()
  const offset = event.key === 'ArrowDown' ? 1 : -1
  buttons[(index + offset + buttons.length) % buttons.length]?.focus()
})
window.addEventListener('message', (event) => {
  if (
    event.origin !== location.origin ||
    event.source !== elements.frame.contentWindow
  )
    return
  const message = event.data as {
    channel?: string
    version?: number
    type?: string
    payload?: unknown
  }
  if (
    message?.channel !== CHANNEL ||
    message.version !== VERSION ||
    !['ready', 'error', 'event', 'reload-required'].includes(message.type ?? '')
  )
    return
  if (message.type === 'event') {
    const item = document.createElement('li')
    item.textContent = JSON.stringify(message.payload)
    elements.events.prepend(item)
    while (elements.events.children.length > 200)
      elements.events.lastElementChild?.remove()
  }
  if (message.type === 'error')
    elements.diagnostics.textContent = String(
      object(message.payload) ? message.payload.message : message.payload,
    )
  if (message.type === 'reload-required') reloadFrame()
})
if (import.meta.hot) {
  import.meta.hot.on('suzy:config', () => {
    if (!saving) void stageExternal()
  })
  import.meta.hot.on('suzy:diagnostic', (data) => {
    elements.diagnostics.textContent = data.message
  })
}

void loadInitial().catch((error) => {
  elements.diagnostics.textContent = (error as Error).message
})
