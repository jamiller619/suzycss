# Token reference

Public tokens begin with `--suzy-` by default. Set `prefix` in your configuration to change this, for example `"prefix": "app"` generates `--app-bg`. The following tables omit that prefix. All tokens are emitted at every theme boundary. `var(...)` aliases remain aliases in generated CSS; the preview also displays their resolved values. Properties beginning with `--_suzy-` are private component aliases, not public theme tokens; do not override them.

## Semantic colors

| Token | Default source / role |
| --- | --- |
| `bg` | gray-1, page background |
| `surface` | gray-2, inset/card surface |
| `surface-raised` | gray-1, raised surface |
| `surface-1` … `surface-4` | gray-2 … gray-5, automatic web component nesting backgrounds |
| `surface-hover`, `surface-active` | gray-3, gray-4 |
| `text`, `text-muted`, `text-subtle` | gray-12, gray-11, gray-10 |
| `border`, `border-strong` | gray-6, gray-8 |
| `action`, `action-hover`, `action-active` | accent-9, accent-10, accent-10 |
| `action-text` | Black/white chosen for best worst-state contrast; overridable |
| `link`, `link-hover` | accent-11, accent-12 |
| `focus` | accent-8; apply to your focus outline |
| `selection-bg`, `selection-text` | accent-5, accent-12; apply to `::selection` |
| `overlay` | Black at 40% in light, 70% in dark |
| `{warning,danger,success,info}-bg` | Corresponding palette step 3 |
| `{warning,danger,success,info}-text` | Corresponding palette step 11 |
| `{warning,danger,success,info}-border` | Corresponding palette step 7 |

Hover and active intentionally share the solid step-10 action background. Applications may override active independently. Surface elevation is also conveyed by the shadow tokens. No component styles are emitted.

## Semantic dimensions

| Token | Role |
| --- | --- |
| `control-height` | Density-dependent minimum height |
| `control-padding-x` | Density-dependent horizontal padding |
| `control-gap` | Gap between inline controls/content |
| `control-radius` | radius-2, or radius-full for pill |
| `panel-radius` | radius-3 |
| `dialog-radius` | radius-4 |
| `panel-padding` | Density-dependent panel inset |
| `section-gap` | Density-dependent section spacing |

See the [preset tables](cli.md#presets) for exact dimensions. Controls retain the same type scale across densities.

## Primitives

| Family | Tokens / values |
| --- | --- |
| Color scales | `{gray,accent,warning,danger,success,info}-{1…12}` |
| Alpha scales | `{gray,accent,warning,danger,success,info}-a{1…12}` |
| Spacing | `space-0…9` = 0, .25, .5, .75, 1, 1.5, 2, 3, 4, 6rem |
| Families | `font-body`, `font-mono`; emitted only when explicitly configured or overridden |
| Type scale | `font-size-1…8` = .6875, .875, 1, 1.125, 1.25, 1.5, 2, 3rem (starts at 11px with a 16px root) |
| Weights | `font-weight-regular` 400, `medium` 500, `semibold` 600, `bold` 700 |
| Line heights | `line-height-tight` 1.15, `normal` 1.5, `relaxed` 1.75 |
| Corner shape | `corner-shape`: `squircle` when `squircle: true`, `round` otherwise |
| Radii | `radius-1…4` from the preset, `radius-full` 9999px |
| Shadows | `shadow-1` 0 1px 3px gray-a3; `shadow-2` 0 4px 16px gray-a4; `shadow-3` 0 12px 40px gray-a5 |
| Durations | `duration-fast` 100ms, `normal` 180ms, `slow` 300ms; zero for reduced motion |
| Easing | `ease-standard` cubic-bezier(.2,0,0,1); `ease-enter` cubic-bezier(0,0,.2,1) |
| Stacking | `z-base` 0, `z-dropdown` 100, `z-sticky` 200, `z-overlay` 300, `z-dialog` 400, `z-toast` 500 |

The z-index scale is a convention within an application's stacking contexts; it cannot override browser top-layer elements. Color and alpha scales come directly from named Radix light/dark palettes. Shadows reference local alpha colors.

## Contrast pairs

Every emitted mode checks the following at a normal-text threshold of 4.5:1:

- `text` against `bg`, `surface`, and `surface-raised`.
- `text-muted` and `text-subtle` against `bg`.
- `action-text` against `action`, `action-hover`, and `action-active`.
- `link` and `link-hover` against `bg`.
- `selection-text` against `selection-bg`.
- Each status `*-text` against its `*-bg`.

The check prints all 15 pairs per mode. FAIL is a warning; unsupported expressions are UNEVALUATED warnings, never PASS. Errors are reserved for malformed configuration and invalid token references/cycles. `--strict` fails on either errors or warnings. These checks describe specified token pairs, not all possible rendered applications.

For custom rounded elements, pair your radius token with `corner-shape: var(--suzy-corner-shape)` to follow the `squircle` setting.
