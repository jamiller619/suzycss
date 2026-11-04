export class UserChip extends HTMLElement {
  static get observedAttributes() {
    return ['display-name', 'active']
  }
  /** Visible user name. */
  displayName = 'Ada'
  active?: boolean
  private internal = 1
  get internalValue() {
    return this.internal
  }
}
customElements.define('user-chip', UserChip)

class DynamicThing extends HTMLElement {}
const dynamicTag = 'dynamic-thing'
customElements.define(dynamicTag, DynamicThing)
