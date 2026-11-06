// Bundler-agnostic core for build-time inline CSS Modules.
//
// `transformSource` takes the text of one .ts/.tsx/.js/.jsx file and:
//   1. finds every `css`...`` tagged-template literal,
//   2. scopes its class selectors (`.page` -> `.page_<hash>`),
//   3. replaces the literal in the source with a static object literal
//      (e.g. `{"page":"page_a1b2"}`) — so nothing survives at runtime,
//   4. returns the concatenated scoped CSS for the file.
//
// No third-party dependencies; native string handling only.

export interface ScopedNameParams {
  local: string
  filename: string
  hash: string
  css: string
}

export type GenerateScopedName = (params: ScopedNameParams) => string

export interface TransformOptions {
  filename: string
  /** Customize scoped class names. Default: `${local}_${hash}`. */
  generateScopedName?: GenerateScopedName | undefined
}

export interface TransformResult {
  /** Source with every css`...` replaced by a static object literal. */
  code: string
  /** Concatenated, scoped CSS for this file (one block per css`` tag). */
  css: string
  /** Every local -> scoped class name produced in this file. */
  classes: Record<string, string>
}

const defaultScopedName: GenerateScopedName = ({ local, hash }) =>
  `${local}_${hash}`

export function transformSource(
  source: string,
  options: TransformOptions,
): TransformResult {
  const generate = options.generateScopedName ?? defaultScopedName
  const tags = findCssTags(source, options.filename)
  if (tags.length === 0) return { code: source, css: '', classes: {} }

  let code = ''
  let cursor = 0
  let css = ''
  const classes: Record<string, string> = {}
  const emitted = new Set<string>()

  for (const tag of tags) {
    const hash = hashString(options.filename + '\u0000' + tag.body)
    const { cssText, classes: map } = scopeCss(tag.body, (local) =>
      generate({ local, filename: options.filename, hash, css: tag.body }),
    )

    code += source.slice(cursor, tag.start) + JSON.stringify(map)
    cursor = tag.end

    Object.assign(classes, map)
    if (!emitted.has(hash)) {
      emitted.add(hash)
      if (cssText.trim()) css += cssText + '\n'
    }
  }
  code += source.slice(cursor)

  return { code, css, classes }
}

/* ------------------------------------------------------------------ *
 * CSS scoping
 * ------------------------------------------------------------------ */

/**
 * Rewrite class selectors only where they appear in *selector position*
 * (the run of text immediately before a `{`). Declaration values, at-rule
 * preludes, strings, comments, and url(...) contents are left untouched,
 * which keeps `0.5rem`, `:hover`, `content: ".x"`, `@media (min-resolution:
 * 1.5dppx)` and data URLs safe.
 *
 * Supports the CSS Modules escape hatches:
 *   - `:global(.x)` / `:local(.x)`     function forms (recursive)
 *   - `.a :global .b`                  bare switches (until end of selector)
 *   - `:global { ... }`                block form (braces unwrapped)
 *   - `composes: a b`                  local composition, folded into the
 *                                      exported map (transitively, deduped);
 *                                      the declaration is stripped from the CSS.
 *     `composes: x from "..."` is rejected (no external file inline).
 */
function scopeCss(
  source: string,
  nameFor: (local: string) => string,
): { cssText: string; classes: Record<string, string> } {
  const scoped: Record<string, string> = {} // local -> single scoped class name
  const compositions: Array<{ owner: string; name: string }> = []

  const scopeName = (local: string): string => {
    const existing = scoped[local]
    if (existing) return existing
    const s = nameFor(local)
    scoped[local] = s
    return s
  }

  // Read a balanced parenthesized group; text[k] must be "(".
  const readParen = (
    text: string,
    k: number,
  ): { inner: string; end: number } => {
    let depth = 0
    let j = k
    for (; j < text.length; j++) {
      const ch = text[j]
      if (ch === "'" || ch === '"') {
        const q = ch
        j++
        while (j < text.length && text[j] !== q) {
          if (text[j] === '\\') j++
          j++
        }
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) {
          j++
          break
        }
      }
    }
    return { inner: text.slice(k + 1, j - 1), end: j }
  }

  // Scope class selectors in one selector fragment. `globalStart` is the mode
  // at the fragment's start (also the value a comma resets to). Handles the
  // :global(...) / :local(...) function forms (recursively) and the bare
  // :global / :local switches.
  const scopeFragment = (text: string, globalStart: boolean): string => {
    let res = ''
    let i = 0
    let global = globalStart
    while (i < text.length) {
      const c = text[i]

      if (c === '"' || c === "'") {
        const quote = c
        res += c
        i++
        while (i < text.length) {
          res += text[i]
          if (text[i] === '\\') {
            res += text[i + 1] ?? ''
            i += 2
            continue
          }
          if (text[i] === quote) {
            i++
            break
          }
          i++
        }
        continue
      }

      if (/^:global\(/i.test(text.slice(i))) {
        const { inner, end } = readParen(text, i + 7)
        res += scopeFragment(inner, true) // contents pass through unscoped
        i = end
        continue
      }
      if (/^:local\(/i.test(text.slice(i))) {
        const { inner, end } = readParen(text, i + 6)
        res += scopeFragment(inner, false) // contents scoped
        i = end
        continue
      }
      if (/^:global\b/i.test(text.slice(i)) && text[i + 7] !== '(') {
        global = true // switch the rest of this selector to global
        i += 7
        continue
      }
      if (/^:local\b/i.test(text.slice(i)) && text[i + 6] !== '(') {
        global = false
        i += 6
        continue
      }

      if (c === ',') {
        global = globalStart // each selector in the list starts fresh
        res += ','
        i++
        continue
      }

      if (c === '.') {
        const m = /^\.(-?[_a-zA-Z][\w-]*)/.exec(text.slice(i))
        const name = m?.[1]
        if (m && name != null) {
          res += '.' + (global ? name : scopeName(name))
          i += m[0].length
          continue
        }
      }

      res += c
      i++
    }
    return res
  }

  // The single local class a rule owns, for `composes` (null otherwise).
  const singleLocal = (
    trimmedPrelude: string,
    inheritedGlobal: boolean,
  ): string | null => {
    if (inheritedGlobal) return null
    const m = /^\.(-?[_a-zA-Z][\w-]*)$/.exec(trimmedPrelude)
    return m?.[1] ?? null
  }

  const isComposes = (seg: string) => /^\s*composes\s*:/i.test(seg)

  const handleComposes = (seg: string, owner: string | null): void => {
    const value = seg.replace(/^\s*composes\s*:/i, '').trim()
    if (/\bfrom\b/i.test(value)) {
      throw new Error(
        'inline-css-modules: `composes: ... from "..."` is not supported — inline ' +
          'blocks have no external file to compose from. Compose only local classes ' +
          'from the same css`` block.',
      )
    }
    if (!owner) {
      throw new Error(
        'inline-css-modules: `composes` is only allowed in a rule with a single ' +
          'class selector, e.g. `.button { composes: base }`.',
      )
    }
    for (const name of value.split(/\s+/).filter(Boolean)) {
      scopeName(name) // register so it gets a consistent scoped name
      compositions.push({ owner, name })
    }
  }

  interface Frame {
    drop: boolean // a :global {} / :local {} block whose braces are unwrapped
    global: boolean // are class selectors in this block global?
    owner: string | null // the local class this block composes into
  }
  const stack: Frame[] = []
  const curGlobal = () => stack.at(-1)?.global ?? false

  let out = ''
  let seg = ''
  let i = 0

  while (i < source.length) {
    const c = source[i]

    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }

    if (c === '"' || c === "'") {
      const quote = c
      seg += c
      i++
      while (i < source.length) {
        seg += source[i]
        if (source[i] === '\\') {
          seg += source[i + 1] ?? ''
          i += 2
          continue
        }
        if (source[i] === quote) {
          i++
          break
        }
        i++
      }
      continue
    }

    if (/^url\(/i.test(source.slice(i, i + 4))) {
      seg += source.slice(i, i + 4)
      i += 4
      while (i < source.length && source[i] !== ')') {
        const ch = source[i]
        if (ch === '"' || ch === "'") {
          const q = ch
          seg += ch
          i++
          while (i < source.length) {
            seg += source[i]
            if (source[i] === '\\') {
              seg += source[i + 1] ?? ''
              i += 2
              continue
            }
            if (source[i] === q) {
              i++
              break
            }
            i++
          }
          continue
        }
        seg += ch
        i++
      }
      if (i < source.length) {
        seg += ')'
        i++
      }
      continue
    }

    if (c === '{') {
      const trimmed = seg.trim()
      const inherited = curGlobal()
      // :global { ... } / :local { ... } block form — unwrap (drop the braces).
      if (/^:global$/i.test(trimmed) || /^:local$/i.test(trimmed)) {
        stack.push({
          drop: true,
          global: /^:global$/i.test(trimmed),
          owner: null,
        })
        seg = ''
        i++
        continue
      }
      out += scopeFragment(seg, inherited) + '{'
      stack.push({
        drop: false,
        global: inherited,
        owner: singleLocal(trimmed, inherited),
      })
      seg = ''
      i++
      continue
    }

    if (c === ';') {
      const top = stack.at(-1)
      if (top && isComposes(seg)) {
        handleComposes(seg, top.owner)
      } else {
        out += seg + ';'
      }
      seg = ''
      i++
      continue
    }

    if (c === '}') {
      const frame = stack.pop()
      if (frame && seg.trim() && isComposes(seg)) {
        handleComposes(seg, frame.owner)
        seg = ''
      }
      if (frame && frame.drop) {
        out += seg // trailing whitespace only; the brace is dropped
      } else {
        out += seg + '}'
      }
      seg = ''
      i++
      continue
    }

    seg += c
    i++
  }

  out += seg

  // Resolve composition transitively into exported class strings.
  const composeMap = new Map<string, string[]>()
  for (const { owner, name } of compositions) {
    const list = composeMap.get(owner) ?? []
    list.push(name)
    composeMap.set(owner, list)
  }
  const resolve = (local: string, seen: Set<string>): string[] => {
    if (seen.has(local)) return []
    seen.add(local)
    const acc: string[] = []
    for (const n of composeMap.get(local) ?? []) acc.push(...resolve(n, seen))
    if (scoped[local]) acc.push(scoped[local]) // own class last (most specific)
    return acc
  }
  const classes: Record<string, string> = {}
  for (const local of Object.keys(scoped)) {
    classes[local] = [...new Set(resolve(local, new Set()))].join(' ')
  }

  return { cssText: out, classes }
}

/* ------------------------------------------------------------------ *
 * JS/TS scanning — locate css`...` tagged templates
 * ------------------------------------------------------------------ */

interface CssTag {
  start: number // index of the `css` identifier
  end: number // index just past the closing backtick
  body: string // raw CSS between the backticks
}

/**
 * Dependency-free scanner that finds `css`...`` tagged templates while
 * correctly skipping JS strings, line/block comments, regex literals
 * (heuristic), and other (non-css) template literals including their
 * nested ${ ... } expressions.
 *
 * Known limitation: regex-literal detection is heuristic. A regex literal
 * containing an unbalanced quote in expression position is the only realistic
 * way to confuse it — vanishingly rare in code that also uses css``.
 */
function findCssTags(src: string, filename: string): CssTag[] {
  const tags: CssTag[] = []
  const n = src.length
  let i = 0

  const isIdentStart = (ch: string | undefined) =>
    (!!ch && ch >= 'a' && ch <= 'z') ||
    (!!ch && ch >= 'A' && ch <= 'Z') ||
    ch === '_' ||
    ch === '$'
  const isIdentChar = (ch: string | undefined) =>
    isIdentStart(ch) || (!!ch && ch >= '0' && ch <= '9')
  const regexAllowed = (prev: string) =>
    prev === '' || '([{,;:=!&|?+-*/%^~<>'.includes(prev)

  function scanTemplate(collect: boolean): string {
    i++ // past opening backtick
    let body = ''
    while (i < n) {
      const c = src[i]
      if (c === '\\') {
        if (collect) body += src.slice(i, i + 2)
        i += 2
        continue
      }
      if (c === '`') {
        i++
        return body
      }
      if (c === '$' && src[i + 1] === '{') {
        if (collect) {
          throw new Error(
            `inline-css-modules: the css\`...\` block in ${filename} must be ` +
              `static CSS (found a \${} interpolation). Move dynamic values to ` +
              `CSS custom properties set at runtime instead.`,
          )
        }
        i += 2
        scanExpr(true) // consume the balanced ${ ... }
        continue
      }
      if (collect) body += c
      i++
    }
    return body // unterminated; best effort
  }

  // Consume a balanced TS type-argument list starting at `<`. Returns the
  // index just past the matching `>`, or -1 if it can't be balanced. Handles
  // nesting, object-type `;` separators, arrow (`=>`) function types, strings,
  // and comments.
  function scanTypeArgs(from: number): number {
    let j = from
    let angle = 0 // < > depth
    let brace = 0 // { } ( ) [ ] depth
    while (j < n) {
      const c = src[j]
      if (c === '/' && src[j + 1] === '/') {
        j += 2
        while (j < n && src[j] !== '\n') j++
        continue
      }
      if (c === '/' && src[j + 1] === '*') {
        j += 2
        while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++
        j = Math.min(j + 2, n)
        continue
      }
      if (c === '"' || c === "'") {
        j = skipQuoted(src, j)
        continue
      }
      if (c === '=' && src[j + 1] === '>') {
        j += 2 // arrow in a function type — not an angle bracket
        continue
      }
      if (c === '`') return -1
      if (c === ';' && brace === 0) return -1 // ';' outside braces => not type args
      if (c === '{' || c === '(' || c === '[') {
        brace++
        j++
        continue
      }
      if (c === '}' || c === ')' || c === ']') {
        brace--
        j++
        continue
      }
      if (c === '<') {
        angle++
        j++
        continue
      }
      if (c === '>') {
        angle--
        j++
        if (angle === 0 && brace === 0) return j
        continue
      }
      j++
      if (j - from > 4000) return -1 // runaway guard
    }
    return -1
  }

  function nextSignificant(from: number): number {
    let j = from
    while (j < n) {
      const c = src[j]
      if (
        c === ' ' ||
        c === '\t' ||
        c === '\n' ||
        c === '\r' ||
        c === '\f' ||
        c === '\v'
      ) {
        j++
        continue
      }
      if (c === '/' && src[j + 1] === '/') {
        j += 2
        while (j < n && src[j] !== '\n') j++
        continue
      }
      if (c === '/' && src[j + 1] === '*') {
        j += 2
        while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++
        j = Math.min(j + 2, n)
        continue
      }
      return j
    }
    return n
  }

  function scanExpr(stopAtBrace: boolean): void {
    let depth = 0
    let prevSig = ''
    let lastIdent: string | null = null
    let lastIdentStart = -1
    let lastIdentDotted = false

    while (i < n) {
      const c = src[i] ?? ''

      // Whitespace and comments preserve lastIdent so `css \`...\`` and
      // `css /*x*/\`...\`` are still recognized as tags.
      if (
        c === ' ' ||
        c === '\t' ||
        c === '\n' ||
        c === '\r' ||
        c === '\f' ||
        c === '\v'
      ) {
        i++
        continue
      }
      if (c === '/' && src[i + 1] === '/') {
        i += 2
        while (i < n && src[i] !== '\n') i++
        continue
      }
      if (c === '/' && src[i + 1] === '*') {
        i += 2
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
        i = Math.min(i + 2, n)
        continue
      }

      if (c === '"' || c === "'") {
        i = skipQuoted(src, i)
        prevSig = c
        lastIdent = null
        continue
      }

      if (c === '/' && regexAllowed(prevSig)) {
        const j = skipRegex(src, i)
        if (j > i) {
          i = j
          prevSig = '/'
          lastIdent = null
          continue
        }
      }

      if (c === '`') {
        const isCss = lastIdent === 'css' && !lastIdentDotted
        const tagStart = isCss ? lastIdentStart : i
        const body = scanTemplate(isCss) // advances i past closing backtick
        if (isCss) tags.push({ start: tagStart, end: i, body })
        prevSig = '`'
        lastIdent = null
        continue
      }

      // Typed form: css<...>`...`. Consume the TS type-argument list so the
      // backtick is still recognized as a css tag (keeping lastIdent intact).
      if (c === '<' && lastIdent === 'css' && !lastIdentDotted) {
        const afterArgs = scanTypeArgs(i)
        if (afterArgs > i) {
          const k = nextSignificant(afterArgs)
          if (k < n && src[k] === '`') {
            i = afterArgs // skip <...>; lastIdent / lastIdentStart preserved
            continue
          }
        }
        // Not a typed tag — fall through and treat `<` as a normal operator.
      }

      if (isIdentStart(c)) {
        const start = i
        i++
        while (i < n && isIdentChar(src[i])) i++
        lastIdent = src.slice(start, i)
        lastIdentStart = start
        lastIdentDotted = prevSig === '.'
        prevSig = src[i - 1] ?? ''
        continue
      }

      if (c >= '0' && c <= '9') {
        i++
        while (i < n && /[0-9a-fA-FxXeE._]/.test(src[i] ?? '')) i++
        prevSig = '0'
        lastIdent = null
        continue
      }

      if (stopAtBrace) {
        if (c === '{') {
          depth++
          i++
          prevSig = '{'
          lastIdent = null
          continue
        }
        if (c === '}') {
          if (depth === 0) {
            i++
            return
          }
          depth--
          i++
          prevSig = '}'
          lastIdent = null
          continue
        }
      }

      // Any other operator/punctuation. A `.` keeps lastIdent so the *next*
      // identifier is correctly flagged as member access (e.g. `obj.css`).
      prevSig = c
      if (c !== '.') lastIdent = null
      i++
    }
  }

  scanExpr(false)
  return tags
}

function skipQuoted(src: string, i: number): number {
  const q = src[i]
  const n = src.length
  i++
  while (i < n) {
    if (src[i] === '\\') {
      i += 2
      continue
    }
    if (src[i] === q) return i + 1
    i++
  }
  return i
}

function skipRegex(src: string, start: number): number {
  const n = src.length
  let j = start + 1
  let inClass = false
  let closed = false
  while (j < n) {
    const c = src[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '\n') return start // regex literals can't span lines
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) {
      j++
      closed = true
      break
    }
    j++
  }
  if (!closed) return start // not a regex after all
  while (j < n && /[a-z]/i.test(src[j] ?? '')) j++ // flags
  return j
}

/** FNV-1a 32-bit, base36. Filename-seeded so identical class names in different files don't collide. */
function hashString(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}
