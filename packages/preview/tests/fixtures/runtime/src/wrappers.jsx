export function Provider({ children }) {
  return <section data-provider="active">{children}</section>
}

export function SharedWrapper({ children }) {
  return <div data-shared-wrapper="active">{children}</div>
}

export function ComponentWrapper({ children }) {
  return <div data-component-wrapper="active">{children}</div>
}
