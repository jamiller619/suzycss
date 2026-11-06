declare namespace JSX {
  interface IntrinsicElements {
    [name: string]: Record<string, unknown>
  }
  type Element = unknown
}

declare module 'react' {
  export type ReactNode = unknown
  export function memo<T>(component: T): T
}

declare module 'react/jsx-runtime' {
  export const Fragment: unknown
  export function jsx(type: unknown, props: unknown): unknown
  export function jsxs(type: unknown, props: unknown): unknown
}
