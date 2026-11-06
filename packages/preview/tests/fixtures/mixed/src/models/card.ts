export interface Address {
  city: string
  lines?: string[]
}
export type Variant =
  | { kind: 'person'; name: string; address: Address }
  | { kind: 'team'; title: string; members: string[] }
export interface Circular {
  label: string
  next?: Circular
}
