// The `css` tag you import in application code. It exists only for TypeScript
// types and editor syntax highlighting — the esbuild plugin replaces every
// css`...` call with a static object at build time, so this function body
// never actually runs in a correctly configured build.
//
// The styled-components / lit-html VS Code extensions highlight the CSS inside
// a `css` tag automatically, so the /*css*/ comment hint is optional.

export type Styles<K extends string = string> = Readonly<Record<K, string>>

/**
 * Define locally-scoped class names inline.
 *
 *   const styles = css`
 *     .page { display: flex; }
 *   `;
 *   element.className = styles.page; // "page_<hash>"
 *
 * For automatic editor completions, enable inline-css-modules/typescript.
 * For compile-time checking, pass the local names as a generic:
 *
 *   const styles = css<'page' | 'item'>`...`;
 */
export function css<K extends string = string>(
  _strings: TemplateStringsArray,
  ..._values: unknown[]
): Styles<K> {
  throw new Error(
    'inline-css-modules: a css`...` block reached runtime untransformed. ' +
      "Add inlineCssModules() to your esbuild plugins (and to your test runner's transform).",
  )
}
