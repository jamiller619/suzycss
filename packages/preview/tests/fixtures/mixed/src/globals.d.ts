declare namespace JSX {
  interface IntrinsicElements {
    [name: string]: Record<string, unknown>
  }
  type Element = unknown
}
declare function memo<T>(component: T): T
