# Foundation handoff

- Keep analysis, document validation/merge, mock resolution, and rendering as
  separate modules. Rendering must start from `preview.json` and import the
  recorded component; it must not depend on analysis or synthesize lookalikes.
- `generated` and developer-owned `value` are separate fields. Preserve values,
  states, validators, wrappers, and `x-*` fields by stable component ID on regen.
- Runtime files are disposable only beneath `.preview/runtime`; the sibling
  `preview.json` is user-owned. Use revision-checked atomic writes for UI saves.
- React and Web Components are the only initial framework values. Emit document
  diagnostics for unsupported type syntax instead of serializing a general AST.
- Descriptor resolution must use an allowlisted built-in registry or explicit
  local module/export import. Never evaluate strings from JSON.
- Discovery uses TypeScript 6's stable compiler API (the repository's TypeScript
  7 native preview package does not expose the type checker). Automatic scope is
  the static import/export graph; explicit file and directory scopes stay local.
- CEM overrides matching member type text, description, and attribute mapping.
  Source remains authoritative for stable identity, imports, and literal defaults.
- Generated ancestry is stored as immutable content-addressed snapshots under
  `.preview/baselines`. Three-way comparison recognizes direct JSON edits without
  relying on UI ownership flags. Stable IDs/names are the only reconciliation
  keys; removed customized data is recoverable from `orphans`.
- Mock entropy is keyed by stable field path, never consumed from a shared stream.
  The registry is private behind documented recipes so the data implementation
  can change without changing the intermediate contract.
- Representative states vary one field at a time in a fixed priority order and
  validate the resulting complete state. Eight generated states is the default;
  developer states are outside that destructive cap.
- Validation covers only the resolved type subset and named rules documented in
  the README. Custom modules receive JSON/frozen context and failures are data
  diagnostics, not permission to silently select a different recipe.
- UI persistence must use `DocumentStore.read()` followed by `saveEditable()`
  with both revision and etag. Revision alone cannot detect an external editor
  that leaves provenance untouched. Conflicted or invalid disk content never
  replaces the store's last valid in-memory snapshot.
- Atomic replacement uses an adjacent temporary file and never cleans the output
  directory. The external-editor boundary is the last etag check before rename;
  detectable races and post-write mismatches are failures, not merged successes.
- The local runtime uses Vite custom-app middleware and virtual modules. It keeps
  component code in the project, preserves normal CSS/assets/dependency handling,
  and avoids mandatory generated entry files. `tsconfig` path aliases are added
  explicitly; project Vite plugins remain authoritative for richer resolution.
- The shell never mounts project components directly. A validated same-origin
  iframe protocol isolates navigation from import/render failures. The same
  iframe is re-created for custom-element source updates to obtain a new registry.
- Runtime mutation is intentionally narrow: same-origin + random token +
  revision/etag can update only the configured preview document. No route accepts
  an arbitrary path. Event logs are circular-safe and capped at 200 entries.
- The explorer is a compiled TypeScript client loaded by the virtual shell. It
  edits a cloned document and uses server validation, regeneration, merge, and
  revision-aware persistence APIs; the iframe consumes only the last valid draft.
- Nested data and advanced contract fields use validated JSON controls rather
  than an expanding collection of lossy special-purpose widgets. Arrays are
  labeled as complete dataset replacement, while union branches get a focused
  discriminator selector.
- A revision-scoped valid draft is cached in same-origin local storage so Vite's
  dependency-optimization reload cannot discard unsaved work. Initial document
  load replaces stale revisions; invalid text is retained only in live editor
  state and never becomes the rendered configuration.
- External disk events auto-adopt only into clean views. Dirty views stage the
  external revision and require merge or reload; Save is disabled until that
  decision is made. Vite dependency/build outputs are excluded from source
  analysis watches to avoid false external-change conflicts.

Focused verification: `yarn workspace @suzycss/preview test` and
`yarn workspace @suzycss/preview run check`.
