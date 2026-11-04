import type { Mode, Tokens } from './config.js'
import { contrastRatio, parseColor } from './contrast.js'
import type { Theme } from './theme.js'
export interface Diagnostic {
  severity: 'error' | 'warning' | 'info'
  code: 'reference' | 'cycle' | 'contrast' | 'unevaluated'
  mode: Mode
  message: string
  pair?: readonly [string, string]
  ratio?: number
  pass?: boolean
}
export const contrastPairs = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text', 'surface-raised'],
  ['text-muted', 'bg'],
  ['text-subtle', 'bg'],
  ['action-text', 'action'],
  ['action-text', 'action-hover'],
  ['action-text', 'action-active'],
  ['link', 'bg'],
  ['link-hover', 'bg'],
  ['selection-text', 'selection-bg'],
  ...['warning', 'danger', 'success', 'info'].map((s) => [
    `${s}-text`,
    `${s}-bg`,
  ]),
] as readonly (readonly string[])[]
export function resolveToken(
  tokens: Tokens,
  name: string,
  visited = new Set<string>(),
): string | undefined {
  if (visited.has(name) || !Object.hasOwn(tokens, name)) {
    return undefined
  }
  const token = tokens[name]
  if (token === undefined) {
    return undefined
  }
  const next = new Set(visited).add(name)
  let unresolved = false
  const value = token.replace(
    /var\(\s*(--[\w-]+)\s*\)/g,
    (_, target: string) => {
      const resolved = resolveToken(tokens, target, next)
      if (resolved === undefined) {
        unresolved = true
        return ''
      }
      return resolved
    },
  )
  return unresolved || /\bvar\s*\(/.test(value) ? undefined : value
}
export function validateTheme(theme: Theme): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  for (const [modeName, tokens] of Object.entries(theme.modes)) {
    const mode = modeName as Mode
    const done = new Set<string>()
    const visit = (name: string, path: string[]) => {
      if (path.includes(name)) {
        diagnostics.push({
          severity: 'error',
          code: 'cycle',
          mode,
          message: `Circular reference: ${[...path, name].join(' → ')}`,
        })
        return
      }
      const token = tokens[name]
      if (!Object.hasOwn(tokens, name) || token === undefined) {
        diagnostics.push({
          severity: 'error',
          code: 'reference',
          mode,
          message: `Unresolved reference ${name} in ${path.at(-1)}`,
        })
        return
      }
      if (done.has(name)) {
        return
      }
      // Inspect references even inside fallbacks and unsupported expressions.
      for (const match of token.matchAll(/\bvar\(\s*(--[\w-]+)/g)) {
        const target = match[1]
        if (target !== undefined) {
          visit(target, [...path, name])
        }
      }
      done.add(name)
    }
    for (const name of Object.keys(tokens).sort()) {
      visit(name, [])
    }
    for (const [fg, bg] of contrastPairs) {
      const pair = [
        `--${theme.config.prefix}-${fg}`,
        `--${theme.config.prefix}-${bg}`,
      ] as const
      const foreground = parseColor(resolveToken(tokens, pair[0]) ?? '')
      const background = parseColor(resolveToken(tokens, pair[1]) ?? '')
      if (!foreground || !background) {
        diagnostics.push({
          severity: 'warning',
          code: 'unevaluated',
          mode,
          pair,
          message: `${pair.join(' / ')}: UNEVALUATED (unsupported color expression, transparency, or unresolved reference)`,
        })
      } else {
        const ratio = contrastRatio(foreground, background),
          pass = ratio >= 4.5
        diagnostics.push({
          severity: pass ? 'info' : 'warning',
          code: 'contrast',
          mode,
          pair,
          ratio,
          pass,
          message: `${pair.join(' / ')}: ${ratio.toFixed(2)}:1 ${pass ? 'PASS' : 'FAIL'} (4.5:1 normal text)`,
        })
      }
    }
  }
  return diagnostics
}
