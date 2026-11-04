# Suzy

Suzy is a Yarn workspaces monorepo.

## Packages

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
