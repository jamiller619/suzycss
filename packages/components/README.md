# Suzy web components

Optional browser components for a Suzy-generated theme. This package is installed separately from `suzy`.

```js
import '@heysuzy/components'
```

Load your generated theme stylesheet, then use:

```html
<suzy-surface>
  Base surface
  <suzy-surface>Nested surface</suzy-surface>
</suzy-surface>
```

Backgrounds follow nesting, capped at four colors. Detached surfaces start at the base color. Theme colors and custom token prefixes work automatically. Use ordinary CSS for spacing, borders, and radii.

The `suzy preview` command detects this package in the project containing its config and displays a dedicated Web components section. Restart preview after installation or removal.

Build from the repository root with `yarn build`; pack separately with `yarn --cwd packages/components pack`.
