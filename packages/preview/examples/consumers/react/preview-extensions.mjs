export function balanceGenerator(context) {
  return 100 + (context.seed % 90000) / 100
}

export function nonNegative(value) {
  return typeof value === 'number' && value >= 0
    ? true
    : 'Balance must be zero or greater.'
}
