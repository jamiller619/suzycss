// esbuild plugin. For each source file it rewrites every css`...` tag to a
// static object at build time, then routes the scoped CSS through a virtual
// module loaded as `css` — so esbuild bundles, orders, and minifies it exactly
// like a normal imported stylesheet and emits it next to your JS output.
//
// Requires `bundle: true` for the CSS to be emitted (same as CSS Modules).

import { readFile } from 'node:fs/promises'
import type { OnLoadArgs, Plugin } from 'esbuild'
import { type GenerateScopedName, transformSource } from './transform.js'

const NAMESPACE = 'inline-css-modules'

export interface InlineCssModulesOptions {
  /** Which files to scan. Default: /\.[cm]?[jt]sx?$/ */
  filter?: RegExp
  /** Customize scoped class names. Default: `${local}_${hash}`. */
  generateScopedName?: GenerateScopedName
  /** Also scan files under node_modules. Default: false. */
  includeNodeModules?: boolean
}

export function inlineCssModules(
  options: InlineCssModulesOptions = {},
): Plugin {
  const filter = options.filter ?? /\.[cm]?[jt]sx?$/
  const includeNodeModules = options.includeNodeModules ?? false
  const cssStore = new Map<string, string>()

  return {
    name: NAMESPACE,
    setup(build) {
      // namespace: "file" is required — without it this onLoad also matches
      // the virtual CSS module's path and tries to read it from disk.
      build.onLoad({ filter, namespace: 'file' }, async (args: OnLoadArgs) => {
        if (!includeNodeModules && args.path.includes('node_modules')) return

        const source = await readFile(args.path, 'utf8')
        if (!source.includes('css') || !source.includes('`')) return // fast bail, no parse needed

        const { code, css } = transformSource(source, {
          filename: args.path,
          generateScopedName: options.generateScopedName,
        })

        const loader = args.path.endsWith('tsx')
          ? 'tsx'
          : args.path.endsWith('ts') ||
              args.path.endsWith('mts') ||
              args.path.endsWith('cts')
            ? 'ts'
            : args.path.endsWith('jsx')
              ? 'jsx'
              : 'js'

        if (!css.trim()) return { contents: code, loader }

        const id = `${NAMESPACE}:${args.path}`
        cssStore.set(id, css)
        // Prepend a side-effect import of the file's scoped CSS.
        return { contents: `import ${JSON.stringify(id)};\n${code}`, loader }
      })

      build.onResolve({ filter: new RegExp(`^${NAMESPACE}:`) }, (args) => ({
        path: args.path,
        namespace: NAMESPACE,
      }))

      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => ({
        contents: cssStore.get(args.path) ?? '',
        loader: 'css',
      }))
    },
  }
}
