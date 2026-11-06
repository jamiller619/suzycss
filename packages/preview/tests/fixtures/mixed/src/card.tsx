import type { Circular, Variant } from '@models/card'

export interface CardProps {
  /** Content shown inside the card. */
  children?: string
  variant: Variant
  tree?: Circular
  onSelect?: (id: string) => void
}

/** A representative React card. */
export const Card = memo(function Card({
  children = 'Hello',
  variant,
  tree,
  onSelect,
}: CardProps) {
  void tree
  void onSelect
  return <article data-kind={variant.kind}>{children}</article>
})

export default function DefaultBadge({
  tone = 'info',
}: {
  tone?: 'info' | 'warning'
}) {
  return <span>{tone}</span>
}
