import type ts from 'typescript'
import { transformSource } from './transform.js'

/** Editor-only class-name completions for inline CSS Modules. */
function init({
  typescript,
}: {
  typescript: typeof ts
}): ts.server.PluginModule {
  return {
    create(info) {
      const service = info.languageService
      const proxy = Object.create(null) as ts.LanguageService
      for (const key of Object.keys(service) as Array<
        keyof ts.LanguageService
      >) {
        const method = service[key] as (...args: unknown[]) => unknown
        ;(proxy as unknown as Record<string, unknown>)[key] = (
          ...args: unknown[]
        ) => method.apply(service, args)
      }

      proxy.getCompletionsAtPosition = (
        filename,
        position,
        options,
        formattingSettings,
      ) => {
        const original = service.getCompletionsAtPosition(
          filename,
          position,
          options,
          formattingSettings,
        )
        const program = service.getProgram()
        const source = program?.getSourceFile(filename)
        if (!program || !source) return original

        let access: ts.PropertyAccessExpression | undefined
        function visit(node: ts.Node): void {
          if (position < node.getFullStart() || position > node.end) return
          if (
            typescript.isPropertyAccessExpression(node) &&
            position >= node.name.getStart(source)
          ) {
            access = node
          }
          typescript.forEachChild(node, visit)
        }
        visit(source)
        if (!access) return original

        const checker = program.getTypeChecker()
        const symbol = checker.getSymbolAtLocation(access.expression)
        const declaration = symbol?.valueDeclaration
        if (!declaration || !typescript.isVariableDeclaration(declaration))
          return original
        const initializer = declaration.initializer
        if (!initializer || !typescript.isTaggedTemplateExpression(initializer))
          return original
        if (
          !typescript.isIdentifier(initializer.tag) ||
          initializer.tag.text !== 'css'
        )
          return original
        if (!typescript.isNoSubstitutionTemplateLiteral(initializer.template))
          return original
        // Leave explicitly typed blocks to TypeScript's normal completion behavior.
        if (initializer.typeArguments?.length || declaration.type)
          return original

        const tagSymbol = checker.getSymbolAtLocation(initializer.tag)
        const imported = tagSymbol?.declarations?.find(
          typescript.isImportSpecifier,
        )
        if (
          !imported ||
          (imported.propertyName ?? imported.name).text !== 'css'
        )
          return original
        const importDeclaration = imported.parent.parent.parent
        if (
          !typescript.isImportDeclaration(importDeclaration) ||
          !typescript.isStringLiteral(importDeclaration.moduleSpecifier) ||
          importDeclaration.moduleSpecifier.text !== 'inline-css-modules'
        )
          return original

        try {
          const body = initializer.template.getText().slice(1, -1)
          const { classes } = transformSource('css`' + body + '`', { filename })
          const entries = [...(original?.entries ?? [])]
          const existing = new Set(entries.map((entry) => entry.name))
          for (const name of Object.keys(classes)) {
            if (existing.has(name) || !/^[$A-Z_a-z][$\w]*$/.test(name)) continue
            entries.push({
              name,
              kind: typescript.ScriptElementKind.memberVariableElement,
              kindModifiers: 'readonly',
              sortText: '0',
            })
          }
          return {
            ...original,
            isGlobalCompletion: false,
            isMemberCompletion: true,
            isNewIdentifierLocation: false,
            entries,
          }
        } catch {
          // Incomplete CSS while typing must not interrupt the language service.
          return original
        }
      }
      return proxy
    },
  }
}

export = init
