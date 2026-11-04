export function ticketGenerator(context) {
  return `TICKET-${String(context.seed).slice(-4)}`
}

export function startsWithTicket(value) {
  return typeof value === 'string' && value.startsWith('TICKET-')
    ? true
    : 'Value must start with TICKET-.'
}
