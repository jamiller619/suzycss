import { SuzySurface } from './surface.js'

export { SuzySurface }

if (!customElements.get('suzy-surface')) {
  customElements.define('suzy-surface', SuzySurface)
}
