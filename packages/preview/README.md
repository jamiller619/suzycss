# @suzycss/preview

Local React and Web Component explorer without story files. The executable is
`suzy-preview` (the npm scope does not determine its name).

```sh
npm install --save-dev @suzycss/preview
npx suzy-preview
```

Zero-option startup finds the project, discovers its entry, creates
`.preview/preview.json` when absent, and starts the explorer at
`http://127.0.0.1:3000`. Other useful commands are:

```sh
suzy-preview generate --input src/index.ts --output .preview
suzy-preview --config preview.config.json --port 4173
suzy-preview --validate .preview/preview.json
suzy-preview serve --port 3000 # explicit alias for the default command
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
An explicit input may be a file or directory. A JSON config supports `root`,
`input`, and `output`. Config paths resolve from the config file; CLI paths
resolve from the invocation directory. Precedence is CLI, then config, then the
documented default. `generate` analyzes/reconciles and exits; `--dry-run` does
the same without writing.

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

The practical consumer projects under [`examples/consumers`](examples/consumers)
contain the supported React and Web Component patterns. Keep the generated
`$schema` property for editor completion. Schema version 1 is the only accepted
version in this release.

When developing this package in the Suzy monorepo, run `yarn preview` from the
repository root. It rebuilds and watches the package while serving the React
consumer fixture. Pass server flags through directly, such as
`yarn preview --port 4173`.

The server and explorer consume an existing validated document without running
discovery. Analysis remains a separate source-change workflow.

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

Running `suzy-preview` writes analysis through reconciliation and an atomic,
revision-checked save. `--dry-run` only reports results.

## Deterministic mocks and validation

Mock values are derived from `seed + component ID + state/field path + attempt`.
Changing traversal order cannot change another field. Name tokenization handles
camelCase, acronym boundaries, snake_case, and kebab-case. The built-in recipe
registry currently recognizes text, people, money/balances, percentages and
utilization, ISO dates, email, HTTP(S) URLs, UUIDs, and empty-state messages.
Type literals and allowed-value rules are applied before semantic names, so a
plausible string never violates a literal restriction. No AI or network service
is involved. Applications may register another in-process recipe through the
public mock API.

Supported rules are `required`, `min`, `max`, `minLength`, `maxLength`,
`pattern`, `allowed` (`options.values`), and `format` (`options.value`). Formats
are deliberately limited to `date`, `date-time`, `email`, `url`, and `uuid`.
Generation retries at most 20 times. Contradictions and exhausted retries become
field-path diagnostics; they never loop or label an invalid value valid. The
same validator functions are intended for generation and editor saves and check
the resolved preview type model—not arbitrary TypeScript runtime behavior.

`generator` descriptors select a registered recipe or a local module/export.
Custom generators receive a frozen context with a stable numeric seed, path,
component, prop, type, default, and JSON options. They must return JSON and are
responsible for using the supplied seed deterministically. Referenced custom
validators return `true`/`undefined` or an error string. Missing exports,
exceptions, non-JSON output, and rejected values become diagnostics. Explicit
extensions do not silently fall back to another generator.

Generated states are marked with `generated: true`. The default cap is eight:
baseline first, then one-field legal union branches, boolean poles, alternate
literals, and optional omission in stable prop order. This avoids a Cartesian
product. Developer states are never removed even when they exceed the generated
cap, and every complete state is validated after normal precedence is applied.
`value` remains pinned during full or selective regeneration. Selection uses
stable `<component-id>.<prop>` paths. Nested literal overrides use JSON Pointer;
objects may be patched, while datasets/arrays are replaced as a whole.

## Reconciliation and persistence

Every active document points through `provenance.baseline` to an immutable,
SHA-256-addressed generated snapshot under `.preview/baselines`. Regeneration
performs a three-way merge of that exact baseline, the current editable JSON,
and new analysis. A current field equal to the baseline is untouched generated
data and advances; a current field different from the baseline is a manual JSON
customization whether or not a UI ownership control was used. Deleting a custom
field resets it when the baseline also omitted it. `null` and `$ref: "omit"`
remain explicit values.

Objects merge by field, while arrays and scalar values are atomic. Props merge
by exact prop name, components by stable ID, and states by exact state name.
There is deliberately no fuzzy rename matching. Customized removed props and
components are copied into top-level `orphans`; incompatible simultaneous edits
are retained as the editable value and recorded in `conflicts`. A custom value
that no longer matches a changed type is preserved for review rather than
coerced. Generated metadata continues to update around compatible values,
validators, recipes, extensions, wrappers, and named states.

`DocumentStore` serializes operations inside one process. UI saves must provide
both the revision and byte etag returned by `read()`; either mismatch rejects the
save as stale, including direct editor changes that did not bump the revision.
Writes use a same-directory temporary file, file sync, two pre-rename etag
checks, atomic rename where supported, directory sync where supported, and
post-write byte verification. An interrupted write leaves the prior file and
removes only its own temporary file. Content-addressed baselines are written
first, so interruption can leave only a harmless unreferenced baseline.

External editors do not participate in the in-process lock. The defined boundary
is the final etag comparison immediately before rename. A detectable racing edit
or failed post-write verification is returned as a conflict, never as a safely
merged success. Callers should ignore watch events whose content hash matches
`DocumentStore.isOwnWrite()` to avoid write loops.

Malformed, structurally invalid, semantically invalid, and conflicted files stay
on disk for correction. `read()` returns the last valid in-memory document when
available but never writes that snapshot over the user's file. A proposed UI
document is structurally and semantically validated before it can become active.

## Local preview server

`suzy-preview serve` starts a loopback Vite development server. Vite is used
because this workspace already integrates with it and it provides the project
module graph, dependency transforms, CSS/assets, source maps, user Vite config,
and HMR without generating per-component source files. Preview entrypoints are
virtual modules; `.preview/runtime` remains reserved for disposable future build
artifacts. An existing valid `preview.json` starts rendering directly without
rerunning analysis. If no document exists, the server performs initial analysis,
mock generation, and persistence.

The server uses the target project as Vite's root, loads its Vite configuration,
and adds literal/wildcard `baseUrl`/`paths` mappings from `tsconfig.json`.
React 19 JSX uses the automatic transform. Project imports continue to resolve
styles, preprocessors installed by the project, static assets, and dependencies
through Vite. This is a documented subset rather than a promise to emulate every
compiler plugin or nonstandard resolver.

The explorer shell and selected component run in separate same-origin iframe
documents. Messages require the exact iframe window, origin, channel, protocol
version, and known message type. A React error boundary and the iframe boundary
keep import/render failures out of shell navigation. The frame imports the real
recorded module/export and resolves function, React-node, omission, and module
descriptors. Runtime `providers`, a shared `wrapper`, component wrappers, and
state wrappers compose around the actual component. Runtime `styles` are loaded
as Vite modules.

Web Components import their registration module and instantiate the recorded
tag. Inferred `attribute` metadata and explicit `runtime.webComponents`
property/attribute mappings control assignment; only configured event names are
observed. Mount cleanup removes listeners and instances. Source changes reload
the isolated frame so the new document has a fresh custom-element registry;
state-preserving custom-element HMR is intentionally not claimed.

Vite watches loaded dependencies and its module graph. A project-tree fallback
watches source/config/style files when dynamically imported edges cannot
propagate HMR. React updates use Vite HMR where possible and otherwise reload the
frame; styles and direct valid document edits reload the frame. Source changes
also schedule bounded analysis/reconciliation. Invalid direct JSON edits produce
shell diagnostics while the last valid document stays active, and correction
recovers without restarting the server.

Callback and configured custom-event invocations are posted through the protocol
into a 200-entry shell log. Payload serialization bounds depth, breadth, and
string length and labels circular/non-serializable values. The only mutation
route writes the configured document through `DocumentStore`; it requires the
same HTTP origin, a random session token, JSON content type, revision, and etag.
There is no arbitrary filesystem-write endpoint. Closing the server stops Vite,
the fallback watchers, timers, iframe mounts, and event listeners.

## Explorer interface

The shell provides keyboard-operable component navigation, automatic and named
state selection, an isolated live preview, prop controls, whole-document JSON
editing, validation feedback, selective regeneration, explicit Save, and a
bounded callback/event log. Controls are selected from resolved metadata:
checkboxes for booleans, selects for literals and union discriminators, native
text/number inputs, and JSON editors for nested objects, complete array dataset
replacement, descriptors, module references, validators, and unsupported
advanced metadata. Descriptor objects remain visibly structured data; they are
never presented as executable strings.

Each value source is explicit: generated/default, saved override, omission,
null, or a concrete override. Changes validate through the same contract used by
generation. A valid draft updates the iframe immediately; invalid field or JSON
text stays in its editor while the last valid preview remains mounted. Valid
drafts are retained across Vite reloads for the current document revision.
Regeneration skips pinned values, can target one field, and does not alter
unrelated fields. Reset removes the selected override and returns precedence to
generated/default data.

Save sends the revision and byte etag originally read. Direct disk changes
refresh a clean explorer; when a draft is dirty, the shell retains it and shows
explicit **Merge external changes** and **Reload from disk** choices. Merge uses
the persistence three-way reconciliation and keeps conflicts in the document
for review. Save remains disabled for invalid drafts or unresolved external
changes, so a stale browser cannot silently overwrite an editor write.

## Extensions, wrappers, and manual escape hatches

A custom generator and validator are ordinary trusted local exports referenced
without executable JSON strings:

```json
{
  "generator": {
    "$ref": "generator",
    "name": "fixture-balance",
    "module": {
      "$ref": "module",
      "path": "preview-extensions.mjs",
      "export": "balanceGenerator"
    }
  },
  "validators": [
    {
      "$ref": "validator",
      "module": {
        "$ref": "module",
        "path": "preview-extensions.mjs",
        "export": "nonNegative"
      }
    }
  ]
}
```

Module paths are project-relative. Generator output must be JSON-serializable;
validators return `true`/`undefined` or an error string. Exceptions, missing
exports, and invalid output become diagnostics. These modules are trusted local
project code and are loaded only for their declared role.

Add project-wide styles and providers/wrappers in the document:

```json
{
  "runtime": {
    "styles": ["src/preview.css"],
    "providers": [
      { "$ref": "module", "path": "src/PreviewProvider.tsx", "export": "PreviewProvider" }
    ],
    "wrapper": { "$ref": "module", "path": "src/Frame.tsx", "export": "Frame" }
  }
}
```

Component and state `wrapper` references are also supported. For Web Components,
`runtime.webComponents[component-id]` is the escape hatch for property names,
attribute mappings, and event names that static analysis cannot establish.
Dynamic registrations and decorator/reflection/event semantics are never guessed.

## Two correction workflows

After `suzy-preview generate`, correct generated data directly in JSON by adding
developer-owned `value` next to `generated`:

```json
"outstandingBalance": {
  "type": { "text": "number", "kind": "number", "required": true },
  "generated": 4821.17,
  "value": 1250
}
```

Save `.preview/preview.json`; the running explorer validates and reloads it.
Future regeneration updates `generated` but preserves `value`. Delete `value` to
reset to generated data. Use `{ "$ref": "omit" }` for explicit omission; JSON
`null` remains a real null.

To make the same correction in the page, open `BillingCard`, choose **Override
value** for `outstandingBalance`, enter `1250`, and press **Save**. The preview
updates as soon as the draft validates; Save writes the same `value` field using
the revision-aware persistence API. Use **Save state** first when the correction
should belong to a named state instead of the component baseline.

## Supported environments and boundaries

- Node.js 22.12 or newer, ESM packages, TypeScript/JavaScript source, and Vite 7.
- React 18.2 or 19 with `react` and `react-dom` installed in the consumer.
  Exported function/arrow components, default functions, and common `memo`
  wrappers are supported. Class components, arbitrary higher-order wrappers,
  runtime export factories, and complete React/DOM type expansion are not.
- Web Components require a statically resolvable `customElements.define()` and
  an `HTMLElement` subclass. Typed public fields and literal
  `observedAttributes` are supported; matching Custom Elements Manifest member
  metadata takes precedence for descriptions/types/mappings. Dynamic tags,
  arbitrary decorators, reflection, and event contracts require manual config.
- Vite handles normal aliases, CSS, static assets, dependencies, and the
  documented `tsconfig` mappings. Framework-specific compiler plugins,
  nonstandard resolvers, SSR-only modules, and every possible Vite plugin are
  outside the verified contract.
- Custom-element source updates reload the isolated preview document to obtain a
  fresh registry. Custom-element state-preserving HMR is not supported.

## Troubleshooting

- **No entry or ambiguous entry:** pass `--input <file-or-directory>` or set
  `input` in `preview.config.json`; the error lists considered candidates.
- **Invalid JSON or field validation:** the file remains untouched and the last
  valid preview stays active. Correct the path shown in diagnostics and save.
- **Stale save/external edit:** choose merge to reconcile the browser draft with
  disk, or reload to discard the draft. The UI never silently overwrites it.
- **Unsupported component/type:** use the structured editor to add a component,
  value, descriptor, mapping, or local generator manually. Diagnostics are the
  support boundary, not a promise of universal inference.
- **Render/import error:** inspect the isolated frame diagnostic and project Vite
  output. Navigation remains usable; fixing the source/config recovers without
  replacing the editable document.
