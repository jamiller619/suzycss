import type { BillingCardProps } from '@models/billing'
import './billing-card.css'

export function BillingCard({
  outstandingBalance,
  renewalDate,
  utilization = 0.5,
  audience,
  milestones,
  emptyStateMessage = 'No milestones yet',
  compact = false,
  onAssign,
  children,
}: BillingCardProps) {
  const assignee =
    audience.kind === 'person' ? audience.assignee : audience.teamName
  return (
    <article className="billing-card" data-compact={compact}>
      <header>{children ?? assignee}</header>
      <p>Outstanding: {outstandingBalance}</p>
      <p>Renews: {renewalDate}</p>
      <p>Utilization: {Math.round(utilization * 100)}%</p>
      <button type="button" onClick={() => onAssign?.(assignee)}>
        Assign {assignee}
      </button>
      <ul>
        {milestones.length ? (
          milestones.map((milestone) => (
            <li key={milestone.title}>{milestone.title}</li>
          ))
        ) : (
          <li>{emptyStateMessage}</li>
        )}
      </ul>
    </article>
  )
}
