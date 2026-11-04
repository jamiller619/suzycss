# @heysuzy/preview

Foundation for a local React and Web Component explorer. The executable is
`suzy-preview` (the npm scope does not determine its name).

```sh
yarn workspace @heysuzy/preview build
suzy-preview --input src/index.ts --output .preview
suzy-preview --config preview.config.json
suzy-preview --validate .preview/preview.json
```

With no flags, the project root is the nearest directory containing
`package.json`, input is discovered, and output is `<project-root>/.preview`.
The editable document is `.preview/preview.json`; disposable bundler/runtime
assets belong under `.preview/runtime`. Nothing recursively cleans the output
directory.

Input discovery takes the first unambiguous existing source file from:
`package.json#source`, root `exports` conditions `source`, `import`, then
`default`, `module`, `main`, then `src/index.tsx`, `.ts`, `.jsx`, `.js`.
Only literal JS/TS source mappings are read; config or package code is never
evaluated. Ambiguous or missing input reports candidates and asks for `--input`.
An explicit input may be a file or directory.

## Intermediate document contract

Schema v1 is documented by [`preview.schema.json`](preview.schema.json), with
small React and Web Component examples in [`examples`](examples). Components
have stable source/export-derived IDs. Source analysis writes `type`,
`generated`, source/import references, and diagnostics. Developers own `value`,
generator and validator selection, wrappers, named states, and `x-*` extension
fields. Regeneration matches by component ID and prop name, refreshes generated
metadata, and preserves those developer fields. Removed components/props do not
silently migrate to another identity.

At a prop path, `value` wins over `generated`, which wins over `default`.
Missing `value` means “use the generated choice”; JSON `null` is an actual null;
`{"$ref":"omit"}` explicitly omits the prop. State values override component
values by prop name. Object values replace at their addressed prop/state path;
arrays replace as a whole (no index merge). Resetting to generated means delete
`value` or the state override. Paths in diagnostics use JSONPath-like notation.

Objects containing `$ref` are reserved descriptors, not ordinary object props.
Built-ins cover functions, React nodes, omission, and generators. Custom
generators, validators, and wrappers use `{ "$ref": "module", "path": "...",
"export": "..." }` references (paths are project-relative); the future renderer
imports the module and named export, and validates its expected role. No code
strings are evaluated.

Writers must compare `provenance.revision` with the revision they read before an
atomic save. A mismatch is a conflict and must abort/reload, never last-write-win.
`baseRevision` records the regenerated ancestor. Unknown `x-*` fields survive.
Unknown future schema versions fail validation and are never rewritten. Other
unknown fields are rejected so misspellings are visible.

Current scope is the configuration/discovery/document foundation. It does not
yet bundle modules, resolve descriptors, or render; those stages can consume an
existing validated document without running discovery.

## Static discovery scope

Analysis loads the project's `tsconfig.json` through the TypeScript 6 compiler
API, so aliases, re-exports, imported prop types, and project compiler options
participate in type checking. Explicit files inspect their supported exports;
directories scan eligible JS/TS source files; automatic entries follow static
imports and exports reachable from the entry. `node_modules`, `.preview`, and
common `dist`, `build`, and `coverage` trees are excluded. Modules are parsed and
type-checked but never executed.

React support covers exported function/arrow components, default exports, and
common `memo`/`React.memo` calls when JSX or a supported React return type is
visible. Props include callbacks, children, destructuring defaults, nested
objects/arrays, literal unions, and whole discriminated-union branches. Expansion
is capped at five levels and 50 properties; circular, bounded generic, and
unresolved shapes produce diagnostics rather than recursively expanding React or
DOM internals.

Web Component support requires a statically named `customElements.define()` and
an `HTMLElement` subclass. Public typed fields and literal
`observedAttributes` are included, with kebab/camel property mappings recorded.
Dynamic registrations, arbitrary decorators, reflection behavior, and event
contracts are not guessed; diagnostics direct developers to add or edit a
component in `preview.json`. If `custom-elements.json` exists, matching CEM member
types, descriptions, and attribute mappings override source inference; source
identity, imports, and defaults remain authoritative.

Running `suzy-preview` writes analysis through an atomic, revision-checked save.
`--dry-run` only reports results. Until full reconciliation is implemented, a
document containing developer values, non-default states, chosen generators or
validators, wrappers, or `x-*` extensions is refused rather than destructively
rewritten.
