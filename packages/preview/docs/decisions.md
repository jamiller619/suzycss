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

Focused verification: `yarn workspace @heysuzy/preview test` and
`yarn workspace @heysuzy/preview check`.
