// Vite plugin. Runs as a `pre` transform so it sees source (with TS types)
// before Vite strips them, rewrites every css`...` tag to a static object,
// and routes the scoped CSS through a `\0virtual:...lang.css` module so it
// flows through Vite's own CSS pipeline — PostCSS, HMR in dev, extraction and
// minification in build — exactly like an imported stylesheet.

import type { Plugin } from 'vite'
import { type GenerateScopedName, transformSource } from './transform.js'

export interface InlineCssModulesViteOptions {
  /** Which modules to scan. Default: /\.[cm]?[jt]sx?$/ */
  include?: RegExp
  /** Modules to skip. Default: /node_modules/ */
  exclude?: RegExp
  /** Customize scoped class names. Default: `${local}_${hash}`. */
  generateScopedName?: GenerateScopedName
}

const PREFIX = 'virtual:inline-css-modules/'

/** Stable, collision-free hash of a string (FNV-1a, base36). */
function hash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

export function inlineCssModules(
  options: InlineCssModulesViteOptions = {},
): Plugin {
  const include = options.include ?? /\.[cm]?[jt]sx?$/
  const exclude = options.exclude ?? /node_modules/

  // resolved virtual id ("\0virtual:...lang.css") -> css text
  const cssByVirtual = new Map<string, string>()
  // source file path -> its current virtual id (for HMR cleanup)
  const virtualByFile = new Map<string, string>()

  return {
    name: 'inline-css-modules',
    enforce: 'pre',

    resolveId(source) {
      if (source.startsWith(PREFIX)) return '\0' + source
      return null
    },

    load(id) {
      const css = cssByVirtual.get(id)
      return css == null ? null : css
    },

    transform(code, id) {
      const path = id.split('?')[0] ?? id
      if (id.includes(PREFIX)) return null // our own virtual CSS module
      if (!include.test(path) || exclude.test(path)) return null
      if (!code.includes('css') || !code.includes('`')) return null

      const result = transformSource(code, {
        filename: path,
        generateScopedName: options.generateScopedName,
      })
      if (!result.css.trim()) return { code: result.code, map: null }

      // Content-hashed virtual id so edits produce a new module (correct HMR).
      const virtualSpecifier = `${PREFIX}${hash(path)}-${hash(result.css)}.css`
      const resolved = '\0' + virtualSpecifier

      const previous = virtualByFile.get(path)
      if (previous && previous !== resolved) cssByVirtual.delete(previous)
      cssByVirtual.set(resolved, result.css)
      virtualByFile.set(path, resolved)

      return {
        code: `import ${JSON.stringify(virtualSpecifier)};\n${result.code}`,
        map: null,
      }
    },
  }
}
