# Suzy

@heysuzy, or Suzy, is a monorepo for several CSS packages:
- [`@heysuzy/compiler`](packages/compiler) — the Suzy CLI and theme compiler.
- [`@heysuzy/components`](packages/components) — Suzy web components.
- [`@heysuzy/preview`](packages/preview) — Suzy component
  isolation framework.
- [`@heysuzy/inline-css-modules`](packages/inline-css-modules) — zero-runtime
  CSS Modules written inline in JavaScript and TypeScript files.

Package-specific documentation lives with its package. See the
[`@heysuzy/compiler` README](packages/compiler/README.md) for installation, usage, and
development instructions.

## Development

```sh
yarn install --frozen-lockfile
yarn build
yarn test
```

To work on the component explorer UI, run `yarn preview`. It builds the preview
package, watches its TypeScript sources, and serves the realistic React example
at `http://127.0.0.1:3000`. Extra CLI options pass through, for example
`yarn preview --port 4173`.
