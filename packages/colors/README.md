# @suzycss/colors

Radix Colors as classless, system-aware CSS custom properties.

This package ships the regular color and alpha entry points from
`@radix-ui/colors`. Each file pairs its light and dark values with the CSS
`light-dark()` function, so the browser follows the user's color-scheme
preference without a class on `<html>` or `<body>`.

Separate `*-dark.css` and `*-dark-alpha.css` files are intentionally omitted;
both modes already exist in the corresponding regular file.

The package is CSS-only. It does not publish Radix's JavaScript bundles, type
declarations, image, or license file.

## Install

```sh
yarn add @suzycss/colors
```

## Use

```css
@import "@suzycss/colors/gray.css";

.card {
  background: var(--gray-2);
  color: var(--gray-12);
}
```

The stylesheet declares `color-scheme: light dark` on `:root`. An application
can override `color-scheme` on any subtree when it needs an explicit theme.

## Build

```sh
yarn workspace @suzycss/colors build
```

The TypeScript generator runs directly in Node and writes the complete publish
artifact to `dist/`. It discovers every CSS entry point and palette export from
the installed `@radix-ui/colors` package without a hardcoded list of palette
names or color values.
