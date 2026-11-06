export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue }
export type ModuleReference = { $ref: 'module'; path: string; export: string }
export type ValueDescriptor =
  | { $ref: 'function'; behavior: 'noop' | 'log' | 'reject' | 'resolve' }
  | {
      $ref: 'react-node'
      element: string
      props?: Record<string, JsonValue>
      children?: JsonValue[]
    }
  | {
      $ref: 'generator'
      name: string
      options?: Record<string, JsonValue>
      module?: ModuleReference
    }
  | ModuleReference
  | { $ref: 'omit' }
export type PreviewValue = JsonValue | ValueDescriptor
export interface Diagnostic {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
  path?: string
}
export interface TypeMetadata {
  text: string
  kind?:
    | 'string'
    | 'number'
    | 'boolean'
    | 'object'
    | 'array'
    | 'function'
    | 'node'
    | 'unknown'
  required?: boolean
  enum?: JsonPrimitive[]
  description?: string
  properties?: Record<string, TypeMetadata>
  items?: TypeMetadata
  branches?: TypeMetadata[]
  discriminator?: string
  source?: { path: string; line: number }
}
export interface PropDefinition {
  type: TypeMetadata
  attribute?: string
  default?: PreviewValue
  generated?: PreviewValue
  value?: PreviewValue
  generator?: ValueDescriptor
  validators?: Array<{
    $ref: 'validator'
    name?: string
    module?: ModuleReference
    options?: Record<string, JsonValue>
  }>
  diagnostics?: Diagnostic[]
  [extension: `x-${string}`]: JsonValue | undefined
}
export interface ComponentState {
  name: string
  generated?: boolean
  description?: string
  values?: Record<string, PreviewValue>
  wrapper?: ModuleReference
  diagnostics?: Diagnostic[]
  [extension: `x-${string}`]: JsonValue | undefined
}
export interface PreviewComponent {
  id: string
  name: string
  framework: 'react' | 'web-component'
  source: { path: string; export: string; tagName?: string }
  import: { path: string; export: string }
  props: Record<string, PropDefinition>
  states: ComponentState[]
  wrapper?: ModuleReference
  diagnostics?: Diagnostic[]
  [extension: `x-${string}`]: JsonValue | undefined
}
export interface PreviewDocument {
  $schema?: string
  schemaVersion: 1
  project: { root: string; entry: string }
  provenance: {
    generator: string
    generatorVersion: string
    generatedAt: string
    revision: number
    baseRevision?: number
    sourceFingerprint?: string
    baseline?: { fingerprint: string; path: string }
  }
  components: PreviewComponent[]
  diagnostics: Diagnostic[]
  runtime?: RuntimeConfiguration
  conflicts?: ReconciliationConflict[]
  orphans?: OrphanedCustomization[]
  [extension: `x-${string}`]: JsonValue | undefined
}
export interface RuntimeConfiguration {
  styles?: string[]
  wrapper?: ModuleReference
  providers?: ModuleReference[]
  webComponents?: Record<
    string,
    {
      properties?: string[]
      attributes?: Record<string, string>
      events?: string[]
    }
  >
}
export interface ReconciliationConflict {
  path: string
  code: string
  message: string
  baseline?: JsonValue
  current?: JsonValue
  generated?: JsonValue
}
export interface OrphanedCustomization {
  path: string
  reason: 'component-removed' | 'prop-removed' | 'state-removed'
  value: JsonValue
  sourceRevision: number
}
export interface ValidationIssue {
  path: string
  message: string
}

export interface MockDiagnostic extends Diagnostic {
  path: string
}
export interface MockGenerationOptions {
  seed?: string | number
  componentIds?: string[]
  paths?: string[]
  projectRoot?: string
  stateCap?: number
  retryCap?: number
}
