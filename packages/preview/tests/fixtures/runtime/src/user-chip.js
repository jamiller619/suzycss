export class UserChip extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `<button class="actual-web">Web one: ${this.displayName}</button>`
    this.querySelector('button').addEventListener('click', () => {
      const detail = { name: this.displayName }
      detail.self = detail
      this.dispatchEvent(new CustomEvent('select', { detail }))
    })
  }
}

customElements.define('user-chip', UserChip)
