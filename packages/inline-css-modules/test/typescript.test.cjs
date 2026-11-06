const assert = require('node:assert/strict')
const { test } = require('node:test')
const ts = require('typescript')
const init = require('inline-css-modules/typescript')
const path = require('node:path')

function setup(text) {
  const filename = path.resolve('test/fixture.ts')
  let content = text.replace('|', '')
  let version = 0
  const host = {
    getScriptFileNames: () => [filename],
    getScriptVersion: () => String(version),
    getScriptSnapshot: (file) => {
      const source = file === filename ? content : ts.sys.readFile(file)
      return source === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(source)
    },
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => ({
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    }),
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
  }
  const service = ts.createLanguageService(host)
  const plugin = init({ typescript: ts }).create({ languageService: service })
  return {
    names: () =>
      plugin
        .getCompletionsAtPosition(filename, text.indexOf('|'), {})
        ?.entries.map((e) => e.name) ?? [],
    update(next) {
      text = next
      content = next.replace('|', '')
      version++
    },
    service,
    plugin,
    filename,
  }
}
const prelude = "import { css } from 'inline-css-modules';\n"

test('completes local classes from the matching block using shared scoping rules', () => {
  const fixture = setup(
    prelude +
      'const other = css`.wrong {}`; const styles = css`.page {} @media (width > 1px) { .title {} } :global(.external) {} .button { composes: page; }`; styles.|',
  )
  assert.deepEqual(fixture.names().sort(), ['button', 'page', 'title'])
})

test('refreshes suggestions after edits and supports partial names', () => {
  const fixture = setup(prelude + 'const styles = css`.page {}`; styles.p|')
  assert.ok(fixture.names().includes('page'))
  fixture.update(prelude + 'const styles = css`.title {}`; styles.|')
  assert.deepEqual(fixture.names(), ['title'])
})

test('uses symbols to distinguish shadowed variables', () => {
  const fixture = setup(
    prelude +
      'const styles = css`.outer {}`; function f() { const styles = css`.inner {}`; styles.| }',
  )
  assert.deepEqual(fixture.names(), ['inner'])
})

test('ignores unrelated tags and dynamic templates', () => {
  for (const source of [
    'function css(s: TemplateStringsArray): Record<string, string> { return {} }; const styles = css`.wrong {}`; styles.|',
    prelude + 'const styles = css`.wrong { color: ${"red"}; }`; styles.|',
    'import { css } from "another-package"; const styles = css`.wrong {}`; styles.|',
  ])
    assert.ok(!setup(source).names().includes('wrong'))
})

test('preserves explicit types and ordinary completions', () => {
  assert.deepEqual(
    setup(
      prelude + 'const styles = css<"explicit">`.other {}`; styles.|',
    ).names(),
    ['explicit'],
  )
  assert.deepEqual(setup('const object = { normal: 1 }; object.|').names(), [
    'normal',
  ])
})

test('handles incomplete CSS and safely falls back on transform errors', () => {
  assert.ok(
    setup(prelude + 'const styles = css`.page { color:`; styles.|')
      .names()
      .includes('page'),
  )
  assert.doesNotThrow(() =>
    setup(
      prelude +
        'const styles = css`.page { composes: foo from "x"; }`; styles.|',
    ).names(),
  )
})

test('forwards other language-service methods', () => {
  const fixture = setup('const value: number = "wrong"; // |')
  assert.deepEqual(
    fixture.plugin.getSemanticDiagnostics(fixture.filename),
    fixture.service.getSemanticDiagnostics(fixture.filename),
  )
})
