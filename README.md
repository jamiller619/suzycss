# Suzy

**Cascade FTW.**

From:
```json
{
  "density": "compact",
  "squircle": true,
  "colors": {
    "accent": "sky",
    "gray": "slate"
  }
}
```
to a complete CSS theme with tokens. Generated styles run on their own, with
no JavaScript or runtime dependency.

## Installing and using the CLI

### Quick start

Requires Node.js 22+.

Run Suzy as a one-time thing:

```sh
npx suzy init
npx suzy preview
```

`init` creates `suzy.config.json` and `src/styles/theme.css`. The config references the editor schema bundled with the installed Suzy package, normally at `./node_modules/suzy/suzy.schema.json`. Preview serves a local theme specimen at `http://127.0.0.1:3000` that updates as you edit the config.

Optionally, add Suzy as a development dependency to keep its version in your project's lockfile.

### Use

Import the generated stylesheet into your application's CSS entry point, or serve it and add a stylesheet link:

```html
<link rel="stylesheet" href="/styles/theme.css">
<button class="primary">Get started</button>
<label>Your name <input autocomplete="name" placeholder="Alex"></label>
```

Suzy includes design tokens, a lightweight reset, and native HTML styles inside `@layer suzy`. Buttons use gray by default; `class="primary"` applies the accent color. Unlayered application CSS takes precedence over Suzy's defaults.

| Command | Purpose |
| --- | --- |
| `npx suzy init --accent blue --radius pill` | Create a theme with named presets |
| `npx suzy build` | Generate CSS from the config |
| `npx suzy watch` | Rebuild CSS when the config changes |
| `npx suzy preview --port 3001` | Preview the theme on a custom port |
| `npx suzy check` | Check token references and text contrast |
| `npx suzy check --strict` | Fail on warnings as well as errors |
| `npx suzy --help` | Show commands and options |

If installed with Yarn, replace `npx suzy` with `yarn suzy`.

All commands accept `--config <path>`. Output paths are relative to the config file. Preview does not write CSS; use `build` or `watch` to update your application's stylesheet.

### Init style options

Choose your theme's styles when running `init`:

```sh
npx suzy init --accent teal --gray slate --radius pill --density compact
```

| Option | Available styles | Default |
| --- | --- | --- |
| `--accent <palette>` | Primary buttons, links, and accent colors; any palette below | `violet` |
| `--gray <palette>` | Neutral colors: `gray`, `mauve`, `slate`, `sage`, `olive`, `sand` | `slate` |
| `--warning <palette>` | Warning colors; any palette below | `amber` |
| `--danger <palette>` | Error and invalid-state colors; any palette below | `red` |
| `--success <palette>` | Success colors; any palette below | `green` |
| `--info <palette>` | Informational colors; any palette below | `blue` |
| `--radius <preset>` | `none` (square), `subtle` (slightly rounded), `rounded`, `pill` (fully rounded controls) | `rounded` |
| `--squircle` | Smooth corners with the selected radius preset | `false` |
| `--density <preset>` | `compact`, `comfortable`, `spacious`; adjusts control height and spacing | `comfortable` |

Available palettes for accent and status colors: `gray`, `mauve`, `slate`, `sage`, `olive`, `sand`, `tomato`, `red`, `ruby`, `crimson`, `pink`, `plum`, `purple`, `violet`, `iris`, `indigo`, `blue`, `cyan`, `teal`, `jade`, `green`, `grass`, `brown`, `bronze`, `gold`, `sky`, `mint`, `lime`, `yellow`, `amber`, `orange`.

`squircle: true` works with any radius preset and uses CSS `corner-shape`, falling back to ordinary rounded corners in browsers without support. `pill` rounds controls while keeping panels and dialogs at the `rounded` preset. Density changes spacing and control sizes; font sizes stay the same.

### Configure

`init` writes only accent and gray colors, plus any options you explicitly pass. Omitted settings use compiler defaults; even an empty `{}` is valid. For example:

```json
{
  "colors": { "accent": "blue", "gray": "slate" }
}
```

Font families are omitted by default so the browser uses the user’s preferred fonts. Set `font.family.body` or `font.family.mono` only to override them.

Set `prefix` to customize public token names (default: `"suzy"`):

```json
{
  "prefix": "app",
  "overrides": {
    "shared": { "--app-panel-padding": "var(--app-space-6)" }
  }
}
```

This generates names such as `--app-bg` and `--app-gray-2`. Use the configured prefix in your CSS and overrides. Prefixes start with a lowercase letter and contain lowercase letters, digits, and hyphen-separated segments. You can also initialize with `npx suzy init --prefix app`. Native styles, the preview, and web components use the prefix automatically; element names and `data-suzy-theme` stay unchanged.

Suzy always generates both light and dark themes and follows the OS preference. Set `data-suzy-theme="light"` or `data-suzy-theme="dark"` on `<html>` or a nested element to choose explicitly.

See the [CLI and configuration reference](docs/cli.md) for options, presets, overrides, and diagnostics, or the [token reference](docs/tokens.md) to use tokens in your own CSS. Contrast checks cover token pairs, not your application's overall accessibility.

## Web components

Components are a separate, optional package. Install `@suzy/components` alongside Suzy, then import it in your browser entry point alongside the generated theme stylesheet:

```js
import '@suzy/components'
```

```html
<suzy-surface>
  Base surface
  <div>
    <suzy-surface>Nested surface</suzy-surface>
  </div>
</suzy-surface>
```

The preview displays a dedicated **Web components** section when `@suzy/components` is installed in the project containing your config. Otherwise the section and component scripts are omitted. Restart the preview after installing or removing the package.

`<suzy-surface>` derives its background from its nearest enclosing surface, even through ordinary wrappers. Siblings share a color. A detached surface starts again at the base color; moving a surface updates its subtree automatically. There is no level override and `z-index` does not affect the color.

The four surface colors use `--suzy-surface-1` through `--suzy-surface-4` (gray steps 2–5). Deeper nesting keeps the fourth color. Theme changes update colors through CSS, including nested light/dark themes. Customize these tokens with theme overrides.

Surfaces are block containers with no default padding, border, radius, or interactive role. Style them with ordinary CSS. Content remains in the light DOM, so native controls keep the generated theme styles. Components require JavaScript in the browser; the compiler entry point and generated native styles remain independent.

## Working in this repo

### Setup and development

Use the Node version in `.nvmrc` and Yarn Classic 1.22.

```sh
nvm use
yarn install --frozen-lockfile
yarn dev
```

`yarn dev` builds both packages, watches TypeScript, and starts the preview on port 3000. Use `yarn dev --port 3001` to change the port.

To run the built CLI directly or link it onto your PATH:

```sh
yarn build
node dist/cli/main.js --help
yarn link
suzy --help
```

### Verification

```sh
yarn typecheck
yarn check                  # Biome checks
yarn test                   # Core and CLI tests
yarn playwright install chromium
yarn test:browser           # Browser styles and preview tests
yarn test:package           # Install and run a packed copy outside this repo
```

Browser tests save screenshots to ignored `test-results/`. Set `SUZY_CHROMIUM_EXECUTABLE` to use an installed compatible Chromium. The package smoke test requires registry access or a populated Yarn cache.

The optional component package lives in `packages/components` and is linked as a development dependency in this repo. It is not included in the published `suzy` package.

### Packaging

```sh
yarn pack --filename /tmp/suzy-0.1.0.tgz
yarn --cwd packages/components pack --filename /tmp/suzy-components-0.1.0.tgz
```

Packing runs the build automatically. The build also regenerates the schema and executable permissions. Commit `yarn.lock` and `suzy.schema.json` when changing dependencies or the schema.

### Compiler API

The CLI, preview, and diagnostics share a pure TypeScript compiler with no filesystem or process access:

```ts
import { resolveConfig, createTheme, validateTheme, renderCss } from 'suzy';

const config = resolveConfig({ colors: { accent: 'blue' } });
const theme = createTheme(config);
const diagnostics = validateTheme(theme);
const css = renderCss(theme);
```

The package includes type declarations and exports its schema as `suzy/schema` and `configSchema`.
