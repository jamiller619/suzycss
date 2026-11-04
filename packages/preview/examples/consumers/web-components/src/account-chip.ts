import './account-chip.css'

export class AccountChip extends HTMLElement {
  static observedAttributes = ['display-name', 'active']

  displayName = 'Ada Lovelace'
  active = false
  account = { id: 'account-1', plan: 'pro' as const }

  connectedCallback() {
    this.render()
  }

  attributeChangedCallback() {
    this.render()
  }

  private render() {
    this.innerHTML = `<button class="account-chip" type="button">${this.displayName}${this.active ? ' · active' : ''}</button>`
    this.querySelector('button')?.addEventListener('click', () => {
      this.dispatchEvent(
        new CustomEvent('account-select', {
          detail: { account: this.account },
          bubbles: true,
        }),
      )
    })
  }
}

customElements.define('account-chip', AccountChip)
