class DynamicElement extends HTMLElement {}

const tagName = window.location.hash.slice(1) || 'dynamic-element'
customElements.define(tagName, DynamicElement)
