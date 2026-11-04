const contextEvent = 'suzy-surface-context'
const maximumLevel = 4

/** A themed surface whose level follows its nearest enclosing surface. */
export class SuzySurface extends HTMLElement {
  #parent: SuzySurface | null = null
  #children = new Set<SuzySurface>()
  #level = 1
  #style: HTMLStyleElement

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    this.#style = document.createElement('style')
    root.append(this.#style, document.createElement('slot'))
    this.addEventListener(contextEvent, (event) => {
      const request = event as CustomEvent<{ surface: SuzySurface }>
      if (request.detail.surface === this) return
      request.stopPropagation()
      const child = request.detail.surface
      child.#parent = this
      this.#children.add(child)
    })
  }

  connectedCallback() {
    // Wait for enclosing custom elements to upgrade before requesting context.
    queueMicrotask(() => {
      if (!this.isConnected) return
      if (this.#parent) this.#parent.#children.delete(this)
      this.#parent = null
      this.dispatchEvent(
        new CustomEvent(contextEvent, {
          bubbles: true,
          composed: true,
          detail: { surface: this },
        }),
      )
      this.#update()
    })
  }

  disconnectedCallback() {
    if (this.#parent) this.#parent.#children.delete(this)
    this.#parent = null
  }

  #update() {
    this.#level = Math.min(
      maximumLevel,
      (this.#parent ? this.#parent.#level : 0) + 1,
    )
    this.#style.textContent = `
      :host {
        display: block;
        background-color: var(--_suzy-surface-${this.#level});
        color: var(--_suzy-text);
      }
      :host([hidden]) { display: none; }
    `
    for (const child of this.#children) child.#update()
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'suzy-surface': SuzySurface
  }
}
