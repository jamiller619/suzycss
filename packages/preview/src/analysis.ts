import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import * as ts from 'typescript'
import type { PreviewOptions } from './config.js'
import type {
  Diagnostic,
  JsonPrimitive,
  PreviewComponent,
  PreviewDocument,
  PreviewValue,
  PropDefinition,
  TypeMetadata,
} from './types.js'

const sourceExtensions = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
])
const ignoredParts = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
])
const MAX_DEPTH = 5
const MAX_PROPERTIES = 50

export async function analyzeProject(
  options: PreviewOptions,
): Promise<PreviewDocument> {
  const configPath = ts.findConfigFile(options.projectRoot, ts.sys.fileExists)
  let compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  }
  let rootNames: string[] = []
  const diagnostics: Diagnostic[] = []
  if (configPath) {
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile)
    if (loaded.error)
      diagnostics.push(tsDiagnostic(loaded.error, options.projectRoot))
    else {
      const parsed = ts.parseJsonConfigFileContent(
        loaded.config,
        ts.sys,
        dirname(configPath),
        undefined,
        configPath,
      )
      compilerOptions = parsed.options
      rootNames = parsed.fileNames
      diagnostics.push(
        ...parsed.errors.map((item) => tsDiagnostic(item, options.projectRoot)),
      )
    }
  }
  const inputFiles =
    options.inputKind === 'directory'
      ? ts.sys.readDirectory(
          options.input,
          [...sourceExtensions].map((extension) => `*${extension}`),
          ignoredGlobs(options),
          undefined,
        )
      : [options.input]
  rootNames = [...new Set([...rootNames, ...inputFiles])]
  const program = ts.createProgram({ rootNames, options: compilerOptions })
  const checker = program.getTypeChecker()
  const selected = selectSourceFiles(program, options, compilerOptions)
  const candidates: Array<{ component: PreviewComponent; importRank: string }> =
    []
  for (const sourceFile of selected) {
    const module = checker.getSymbolAtLocation(sourceFile)
    if (module) {
      const exports = checker
        .getExportsOfModule(module)
        .sort((a, b) => a.name.localeCompare(b.name))
      for (const exported of exports) {
        const component = reactComponent(exported, sourceFile, checker, options)
        if (component)
          candidates.push({
            component,
            importRank: `${relativePath(options.projectRoot, sourceFile.fileName)}#${exported.name}`,
          })
      }
    }
    candidates.push(
      ...webComponents(sourceFile, checker, options, diagnostics).map(
        (component) => ({ component, importRank: component.id }),
      ),
    )
  }
  const components = deduplicate(candidates)
  await applyCustomElementsManifest(
    components,
    options.projectRoot,
    diagnostics,
  )
  return {
    $schema: '../node_modules/@heysuzy/preview/preview.schema.json',
    schemaVersion: 1,
    project: {
      root: '.',
      entry: relativePath(options.projectRoot, options.input),
    },
    provenance: {
      generator: '@heysuzy/preview',
      generatorVersion: '0.1.0',
      generatedAt: new Date(0).toISOString(),
      revision: 1,
      sourceFingerprint: components.map((item) => item.id).join('|'),
    },
    components,
    diagnostics: diagnostics.sort(diagnosticOrder),
  }
}

function selectSourceFiles(
  program: ts.Program,
  options: PreviewOptions,
  compilerOptions: ts.CompilerOptions,
): ts.SourceFile[] {
  const eligible = (file: ts.SourceFile) =>
    !file.isDeclarationFile &&
    inside(options.projectRoot, file.fileName) &&
    !excluded(file.fileName, options)
  if (options.inputKind === 'directory')
    return program
      .getSourceFiles()
      .filter((file) => eligible(file) && inside(options.input, file.fileName))
      .sort(fileOrder)
  const input = program.getSourceFile(options.input)
  if (!input)
    throw new Error(`TypeScript could not load input ${options.input}`)
  if (options.inputKind === 'file') return [input]
  const found = new Map<string, ts.SourceFile>()
  const visit = (file: ts.SourceFile) => {
    if (found.has(file.fileName) || !eligible(file)) return
    found.set(file.fileName, file)
    for (const specifier of moduleSpecifiers(file)) {
      const resolved = ts.resolveModuleName(
        specifier,
        file.fileName,
        compilerOptions,
        ts.sys,
      ).resolvedModule?.resolvedFileName
      if (resolved) {
        const dependency =
          program.getSourceFile(resolved.replace(/\.d\.[cm]?ts$/, '.ts')) ??
          program.getSourceFile(resolved)
        if (dependency) visit(dependency)
      }
    }
  }
  visit(input)
  return [...found.values()].sort(fileOrder)
}

function moduleSpecifiers(file: ts.SourceFile): string[] {
  const values: string[] = []
  file.forEachChild((node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      values.push(node.moduleSpecifier.text)
  })
  return values
}

function reactComponent(
  exported: ts.Symbol,
  importFile: ts.SourceFile,
  checker: ts.TypeChecker,
  options: PreviewOptions,
): PreviewComponent | undefined {
  const exportName = exported.name
  let symbol =
    exported.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(exported)
      : exported
  let declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
  if (declaration && ts.isExportAssignment(declaration)) {
    const target = checker.getSymbolAtLocation(declaration.expression)
    if (target) {
      symbol =
        target.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(target)
          : target
      declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
    }
  }
  if (
    !declaration ||
    !inside(options.projectRoot, declaration.getSourceFile().fileName)
  )
    return
  let callable: ts.Node = declaration
  if (ts.isVariableDeclaration(declaration) && declaration.initializer)
    callable =
      unwrapMemo(declaration.initializer, checker) ?? declaration.initializer
  const signature = checker.getSignaturesOfType(
    checker.getTypeOfSymbolAtLocation(symbol, declaration),
    ts.SignatureKind.Call,
  )[0]
  if (!signature || !looksLikeReact(callable, signature, checker)) return
  const canonicalFile = declaration.getSourceFile()
  const canonicalName = symbol.name === 'default' ? 'default' : symbol.name
  const name =
    exportName === 'default' ? inferDefaultName(declaration) : exportName
  const props: Record<string, PropDefinition> = {}
  const parameter = signature.getParameters()[0]
  if (parameter) {
    const parameterNode = parameter.valueDeclaration ?? declaration
    const propType = checker.getTypeOfSymbolAtLocation(parameter, parameterNode)
    const defaults = destructuringDefaults(callable, checker)
    for (const prop of checker
      .getPropertiesOfType(propType)
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (props[prop.name]) continue
      const node =
        prop.valueDeclaration ?? prop.declarations?.[0] ?? parameterNode
      const type = checker.getTypeOfSymbolAtLocation(prop, node)
      const propDiagnostics: Diagnostic[] = []
      const metadata = describeType(
        type,
        checker,
        node,
        0,
        new Set(),
        propDiagnostics,
        options.projectRoot,
      )
      if (prop.name === 'children') metadata.kind = 'node'
      metadata.required = !(prop.flags & ts.SymbolFlags.Optional)
      const definition: PropDefinition = {
        type: metadata,
        generated: mockValue(metadata),
      }
      const defaultValue =
        defaults.get(prop.name) ??
        literalInitializer(
          (prop.valueDeclaration as ts.PropertyDeclaration | undefined)
            ?.initializer,
          checker,
        )
      if (defaultValue !== undefined) definition.default = defaultValue
      if (propDiagnostics.length) definition.diagnostics = propDiagnostics
      props[prop.name] = definition
    }
  }
  const path = relativePath(options.projectRoot, canonicalFile.fileName)
  return {
    id: `${path}#${canonicalName}`,
    name,
    framework: 'react',
    source: { path, export: canonicalName },
    import: {
      path: relativePath(options.projectRoot, importFile.fileName),
      export: exportName,
    },
    props,
    states: [{ name: 'default' }],
    diagnostics: jsDoc(symbol, checker)
      ? [
          {
            severity: 'info',
            code: 'source-context',
            message: jsDoc(symbol, checker) as string,
          },
        ]
      : undefined,
  }
}

function unwrapMemo(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Node | undefined {
  if (!ts.isCallExpression(expression) || expression.arguments.length === 0)
    return
  const name = expression.expression.getText()
  if (name !== 'memo' && name !== 'React.memo') return
  const argument = expression.arguments[0]
  if (!argument) return
  const symbol = checker.getSymbolAtLocation(argument)
  return symbol?.valueDeclaration ?? argument
}

function looksLikeReact(
  node: ts.Node,
  signature: ts.Signature,
  checker: ts.TypeChecker,
): boolean {
  let jsx = false
  const visit = (child: ts.Node) => {
    if (
      ts.isJsxElement(child) ||
      ts.isJsxSelfClosingElement(child) ||
      ts.isJsxFragment(child)
    )
      jsx = true
    if (!jsx) child.forEachChild(visit)
  }
  node.forEachChild(visit)
  if (jsx) return true
  const returned = checker.typeToString(signature.getReturnType())
  return /(?:JSX\.Element|ReactElement|ReactNode)/.test(returned)
}

function webComponents(
  file: ts.SourceFile,
  checker: ts.TypeChecker,
  options: PreviewOptions,
  diagnostics: Diagnostic[],
): PreviewComponent[] {
  const registrations: Array<{
    tag: string
    declaration: ts.ClassDeclaration
    node: ts.CallExpression
  }> = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === 'customElements.define'
    ) {
      const tag = node.arguments[0]
      const constructorExpression = node.arguments[1]
      if (!tag || !ts.isStringLiteral(tag) || !constructorExpression)
        diagnostics.push({
          severity: 'warning',
          code: 'web-component-dynamic-registration',
          message: `Cannot statically resolve customElements.define at ${location(node, options.projectRoot)}. Add the component manually to preview.json.`,
          path: relativePath(options.projectRoot, file.fileName),
        })
      else {
        const symbol = checker.getSymbolAtLocation(constructorExpression)
        const declaration = symbol?.valueDeclaration
        if (
          declaration &&
          ts.isClassDeclaration(declaration) &&
          extendsHTMLElement(declaration)
        )
          registrations.push({ tag: tag.text, declaration, node })
        else
          diagnostics.push({
            severity: 'warning',
            code: 'web-component-unresolved-class',
            message: `Registration for <${tag.text}> does not resolve to a supported HTMLElement subclass. Add source/import metadata manually.`,
            path: relativePath(options.projectRoot, file.fileName),
          })
      }
    }
    node.forEachChild(visit)
  }
  file.forEachChild(visit)
  return registrations.map(({ tag, declaration }) => {
    const props: Record<string, PropDefinition> = {}
    const observed = observedAttributes(declaration, checker)
    for (const member of declaration.members) {
      if (
        !ts.isPropertyDeclaration(member) ||
        !member.name ||
        isPrivate(member) ||
        member.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
        )
      )
        continue
      const name = member.name.getText().replace(/^['"]|['"]$/g, '')
      const propDiagnostics: Diagnostic[] = []
      const metadata = describeType(
        checker.getTypeAtLocation(member),
        checker,
        member,
        0,
        new Set(),
        propDiagnostics,
        options.projectRoot,
      )
      metadata.required = !member.questionToken && !member.initializer
      const definition: PropDefinition = {
        type: metadata,
        generated: mockValue(metadata),
      }
      const value = literalInitializer(member.initializer, checker)
      if (value !== undefined) definition.default = value
      const attribute = observed.find(
        (item) => item === name || camel(item) === name,
      )
      if (attribute) definition.attribute = attribute
      if (propDiagnostics.length) definition.diagnostics = propDiagnostics
      props[name] = definition
    }
    for (const attribute of observed)
      if (!Object.values(props).some((prop) => prop.attribute === attribute))
        props[camel(attribute)] = {
          type: { text: 'string | null', kind: 'string', required: false },
          generated: 'example',
          attribute,
        }
    const path = relativePath(
      options.projectRoot,
      declaration.getSourceFile().fileName,
    )
    const exportName = declaration.name?.text ?? 'default'
    return {
      id: `${path}#${tag}`,
      name: declaration.name?.text ?? tag,
      framework: 'web-component' as const,
      source: { path, export: exportName, tagName: tag },
      import: {
        path: relativePath(options.projectRoot, file.fileName),
        export: exportName,
      },
      props,
      states: [{ name: 'default' }],
    }
  })
}

function describeType(
  type: ts.Type,
  checker: ts.TypeChecker,
  node: ts.Node,
  depth: number,
  stack: Set<ts.Type>,
  diagnostics: Diagnostic[],
  root: string,
): TypeMetadata {
  const text = checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation)
  const metadata: TypeMetadata = {
    text,
    kind: kindOf(type, checker),
    source: sourceLocation(node, root),
  }
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
    diagnostics.push({
      severity: 'warning',
      code: 'type-unresolved',
      message: `Type ${text} could not be expanded safely; configure a value or generator manually.`,
    })
  const description = type.symbol ? jsDoc(type.symbol, checker) : undefined
  if (description) metadata.description = description
  if (depth >= MAX_DEPTH) {
    diagnostics.push({
      severity: 'warning',
      code: 'type-depth-limit',
      message: `Stopped expanding ${text} at depth ${MAX_DEPTH}.`,
    })
    return metadata
  }
  if (stack.has(type)) {
    diagnostics.push({
      severity: 'warning',
      code: 'type-circular',
      message: `Circular type ${text} was not expanded recursively.`,
    })
    return metadata
  }
  if (type.isUnion()) {
    const literals = type.types
      .map(literalType)
      .filter((value): value is JsonPrimitive => value !== undefined)
    if (literals.length === type.types.length) metadata.enum = literals
    else {
      const next = new Set(stack).add(type)
      metadata.branches = type.types.map((branch) =>
        describeType(branch, checker, node, depth + 1, next, diagnostics, root),
      )
      metadata.discriminator = discriminator(type.types, checker)
    }
    return metadata
  }
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const item = checker.getTypeArguments(type as ts.TypeReference)[0]
    if (item)
      metadata.items = describeType(
        item,
        checker,
        node,
        depth + 1,
        new Set(stack).add(type),
        diagnostics,
        root,
      )
    return metadata
  }
  if (metadata.kind === 'object') {
    if (
      type.aliasTypeArguments?.length ||
      (type as ts.TypeReference).typeArguments?.length
    )
      diagnostics.push({
        severity: 'info',
        code: 'type-generic-bounded',
        message: `Expanded instantiated generic ${text} only to the configured limits.`,
      })
    const properties = checker.getPropertiesOfType(type)
    if (properties.length > MAX_PROPERTIES)
      diagnostics.push({
        severity: 'warning',
        code: 'type-property-limit',
        message: `${text} has ${properties.length} properties; only ${MAX_PROPERTIES} were expanded.`,
      })
    metadata.properties = {}
    const next = new Set(stack).add(type)
    for (const property of properties
      .slice(0, MAX_PROPERTIES)
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const declaration =
        property.valueDeclaration ?? property.declarations?.[0] ?? node
      const child = describeType(
        checker.getTypeOfSymbolAtLocation(property, declaration),
        checker,
        declaration,
        depth + 1,
        next,
        diagnostics,
        root,
      )
      child.required = !(property.flags & ts.SymbolFlags.Optional)
      metadata.properties[property.name] = child
    }
  }
  return metadata
}

function kindOf(type: ts.Type, checker: ts.TypeChecker): TypeMetadata['kind'] {
  if (type.getCallSignatures().length) return 'function'
  if (
    type.isUnion() &&
    type.types.some((branch) => branch.getCallSignatures().length)
  )
    return 'function'
  if (checker.isArrayType(type) || checker.isTupleType(type)) return 'array'
  if (type.flags & ts.TypeFlags.StringLike) return 'string'
  if (type.flags & ts.TypeFlags.NumberLike) return 'number'
  if (type.flags & ts.TypeFlags.BooleanLike) return 'boolean'
  if (type.flags & ts.TypeFlags.Object) return 'object'
  return 'unknown'
}

function mockValue(type: TypeMetadata): PreviewValue {
  if (type.enum?.length) return type.enum[0] ?? null
  if (type.kind === 'function') return { $ref: 'function', behavior: 'log' }
  if (type.kind === 'node')
    return { $ref: 'react-node', element: 'span', children: ['Preview'] }
  if (type.branches?.length)
    return mockValue(
      type.branches.find((branch) => branch.kind === 'object') ??
        (type.branches[0] as TypeMetadata),
    )
  if (type.kind === 'string')
    return /ReactNode|children/i.test(type.text)
      ? { $ref: 'react-node', element: 'span', children: ['Preview'] }
      : 'example'
  if (type.kind === 'number') return 1
  if (type.kind === 'boolean') return false
  if (type.kind === 'array') return []
  if (type.kind === 'object' && type.properties)
    return Object.fromEntries(
      Object.entries(type.properties)
        .filter(([, value]) => value.required)
        .map(([name, value]) => [name, mockValue(value) as never]),
    )
  return { $ref: 'omit' }
}

function destructuringDefaults(
  node: ts.Node,
  checker: ts.TypeChecker,
): Map<string, PreviewValue> {
  const defaults = new Map<string, PreviewValue>()
  const parameter = ts.isFunctionLike(node) ? node.parameters[0] : undefined
  if (parameter && ts.isObjectBindingPattern(parameter.name))
    for (const element of parameter.name.elements) {
      const value = literalInitializer(element.initializer, checker)
      if (value !== undefined)
        defaults.set(
          element.propertyName?.getText() ?? element.name.getText(),
          value,
        )
    }
  return defaults
}

function literalInitializer(
  node: ts.Expression | undefined,
  checker: ts.TypeChecker,
): PreviewValue | undefined {
  if (!node) return
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand))
    return node.operator === ts.SyntaxKind.MinusToken
      ? -Number(node.operand.text)
      : Number(node.operand.text)
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.map((item) =>
      ts.isExpression(item) ? literalInitializer(item, checker) : undefined,
    )
    if (values.every((item) => item !== undefined))
      return values as PreviewValue[]
  }
  if (ts.isObjectLiteralExpression(node)) {
    const entries: Array<[string, PreviewValue]> = []
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return
      const value = literalInitializer(property.initializer, checker)
      if (value === undefined) return
      entries.push([property.name.getText().replace(/^['"]|['"]$/g, ''), value])
    }
    return Object.fromEntries(entries)
  }
  const constant = checker.getConstantValue(node as ts.AccessExpression)
  return typeof constant === 'string' || typeof constant === 'number'
    ? constant
    : undefined
}

function observedAttributes(
  declaration: ts.ClassDeclaration,
  checker: ts.TypeChecker,
): string[] {
  for (const member of declaration.members)
    if (
      ts.isGetAccessorDeclaration(member) &&
      member.name.getText() === 'observedAttributes' &&
      member.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
      ) &&
      member.body
    ) {
      const returned = member.body.statements.find(
        ts.isReturnStatement,
      )?.expression
      const value = returned ? literalInitializer(returned, checker) : undefined
      if (
        Array.isArray(value) &&
        value.every((item) => typeof item === 'string')
      )
        return value
    }
  return []
}

async function applyCustomElementsManifest(
  components: PreviewComponent[],
  root: string,
  diagnostics: Diagnostic[],
) {
  try {
    const manifest = JSON.parse(
      await readFile(join(root, 'custom-elements.json'), 'utf8'),
    ) as {
      modules?: Array<{
        declarations?: Array<{
          tagName?: string
          name?: string
          description?: string
          members?: Array<{
            kind?: string
            name?: string
            attribute?: string
            type?: { text?: string }
            description?: string
            default?: string
          }>
        }>
      }>
    }
    for (const declaration of manifest.modules?.flatMap(
      (module) => module.declarations ?? [],
    ) ?? []) {
      const component = components.find(
        (item) =>
          item.framework === 'web-component' &&
          (item.source.tagName === declaration.tagName ||
            item.name === declaration.name),
      )
      if (!component) continue
      for (const member of declaration.members ?? []) {
        if (!member.name) continue
        const existing: PropDefinition = component.props[member.name] ?? {
          type: { text: member.type?.text ?? 'unknown', kind: 'unknown' },
          generated: { $ref: 'omit' },
        }
        if (member.type?.text) existing.type.text = member.type.text
        if (member.description) existing.type.description = member.description
        if (member.attribute) existing.attribute = member.attribute
        component.props[member.name] = existing
      }
      component.diagnostics = [
        ...(component.diagnostics ?? []),
        {
          severity: 'info',
          code: 'custom-elements-manifest',
          message:
            'Custom Elements Manifest metadata overrides matching source type descriptions and attribute mappings.',
        },
      ]
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      diagnostics.push({
        severity: 'warning',
        code: 'custom-elements-manifest-invalid',
        message: `Could not read custom-elements.json: ${(error as Error).message}`,
      })
  }
}

function deduplicate(
  candidates: Array<{ component: PreviewComponent; importRank: string }>,
): PreviewComponent[] {
  const byId = new Map<
    string,
    { component: PreviewComponent; importRank: string }
  >()
  for (const candidate of candidates.sort((a, b) =>
    a.importRank.localeCompare(b.importRank),
  ))
    if (!byId.has(candidate.component.id))
      byId.set(candidate.component.id, candidate)
  return [...byId.values()]
    .map(({ component }) => component)
    .sort((a, b) => a.id.localeCompare(b.id))
}
function extendsHTMLElement(declaration: ts.ClassDeclaration) {
  return (
    declaration.heritageClauses?.some(
      (clause) =>
        clause.token === ts.SyntaxKind.ExtendsKeyword &&
        clause.types.some((type) =>
          /(?:^|\.)HTMLElement$/.test(type.expression.getText()),
        ),
    ) ?? false
  )
}
function isPrivate(member: ts.PropertyDeclaration) {
  return (
    ts
      .getModifiers(member)
      ?.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.PrivateKeyword ||
          modifier.kind === ts.SyntaxKind.ProtectedKeyword,
      ) ?? false
  )
}
function discriminator(
  types: ts.Type[],
  checker: ts.TypeChecker,
): string | undefined {
  const names = types.map(
    (type) =>
      new Set(
        checker
          .getPropertiesOfType(type)
          .filter((property) => {
            const declaration =
              property.valueDeclaration ?? property.declarations?.[0]
            return (
              declaration &&
              checker
                .getTypeOfSymbolAtLocation(property, declaration)
                .isLiteral()
            )
          })
          .map((property) => property.name),
      ),
  )
  return names[0]
    ? [...names[0]].find((name) => names.every((set) => set.has(name)))
    : undefined
}
function literalType(type: ts.Type): JsonPrimitive | undefined {
  if (type.flags & ts.TypeFlags.StringLiteral)
    return (type as ts.StringLiteralType).value
  if (type.flags & ts.TypeFlags.NumberLiteral)
    return (type as ts.NumberLiteralType).value
  if (type.flags & ts.TypeFlags.BooleanLiteral)
    return (
      (type as ts.Type & { intrinsicName?: string }).intrinsicName === 'true'
    )
  if (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return null
}
function inferDefaultName(declaration: ts.Declaration) {
  return (ts.isFunctionDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isVariableDeclaration(declaration)) &&
    declaration.name &&
    ts.isIdentifier(declaration.name)
    ? declaration.name.text
    : 'DefaultComponent'
}
function jsDoc(symbol: ts.Symbol, checker: ts.TypeChecker) {
  return (
    ts.displayPartsToString(symbol.getDocumentationComment(checker)) ||
    undefined
  )
}
function sourceLocation(node: ts.Node, root: string) {
  const file = node.getSourceFile()
  return {
    path: relativePath(root, file.fileName),
    line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
  }
}
function location(node: ts.Node, root: string) {
  const source = sourceLocation(node, root)
  return `${source.path}:${source.line}`
}
function relativePath(root: string, path: string) {
  return relative(root, path).split(sep).join('/')
}
function inside(parent: string, child: string) {
  const value = relative(resolve(parent), resolve(child))
  return (
    value === '' || (!value.startsWith('..') && !value.startsWith(`${sep}..`))
  )
}
function excluded(path: string, options: PreviewOptions) {
  if (inside(options.output, path)) return true
  return relative(options.projectRoot, path)
    .split(sep)
    .some((part) => ignoredParts.has(part))
}
function ignoredGlobs(options: PreviewOptions) {
  return [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/coverage/**',
    `${relativePath(options.input, options.output)}/**`,
  ]
}
function fileOrder(a: ts.SourceFile, b: ts.SourceFile) {
  return a.fileName.localeCompare(b.fileName)
}
function diagnosticOrder(a: Diagnostic, b: Diagnostic) {
  return `${a.path ?? ''}:${a.code}:${a.message}`.localeCompare(
    `${b.path ?? ''}:${b.code}:${b.message}`,
  )
}
function tsDiagnostic(item: ts.Diagnostic, root: string): Diagnostic {
  return {
    severity:
      item.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
    code: `typescript-${item.code}`,
    message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
    path: item.file ? relativePath(root, item.file.fileName) : undefined,
  }
}
function camel(value: string) {
  return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}
