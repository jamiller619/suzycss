import { message } from '@ui/message'
import logo from './logo.svg'
import './component.css'

export function Card({ children, onPress, fail = false, audience }) {
  if (fail) throw new Error('Intentional component failure')
  return (
    <button
      type="button"
      id="actual-react"
      className="actual-react"
      data-message={message}
      onClick={onPress}
    >
      <img src={logo} alt="fixture" />
      <span className="version">Version one</span>
      <span className="content">{children}</span>
      <span className="audience">
        {audience.kind === 'person'
          ? `${audience.kind}: ${audience.profile.address.city}`
          : `${audience.kind}: ${audience.members.join(', ')}`}
      </span>
    </button>
  )
}
