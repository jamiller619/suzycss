export interface Address {
  city: string
  lines?: string[]
}

export type Audience =
  | { kind: 'person'; assignee: string; address: Address }
  | { kind: 'team'; teamName: string; members: string[] }

export interface Milestone {
  title: string
  complete?: boolean
}

export interface BillingCardProps {
  outstandingBalance: number
  renewalDate: string
  utilization?: number
  audience: Audience
  milestones: Milestone[]
  emptyStateMessage?: string
  compact?: boolean
  onAssign?: (assignee: string) => void
  children?: unknown
}
