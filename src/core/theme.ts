import type { Config, Mode, Tokens } from './config.js'
import { chooseForeground } from './contrast.js'
import { resolvePalette } from './palettes.js'
export interface Theme {
  config: Config
  modes: Record<Mode, Tokens>
}
export function createTheme(config: Config): Theme {
  const token = (name: string): string => `--${config.prefix}-${name}`
  const ref = (name: string): string => `var(${token(name)})`
  const modes: Theme['modes'] = { light: {}, dark: {} }
  for (const mode of ['light', 'dark'] as const) {
    const t: Tokens = {}
    const set = (name: string, value: string) => {
      t[token(name)] = value
    }
    for (const [role, palette] of Object.entries(config.colors)) {
      for (const alpha of [false, true]) {
        resolvePalette(palette, mode, alpha).forEach((value, i) => {
          set(`${role}-${alpha ? 'a' : ''}${i + 1}`, value)
        })
      }
    }
    ;[0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6].forEach((value, i) => {
      set(`space-${i}`, `${value}rem`)
    })
    for (const [role, family] of Object.entries(config.font.family)) {
      if (family) set(`font-${role}`, family)
    }
    ;['0.6875', '0.875', '1', '1.125', '1.25', '1.5', '2', '3'].forEach(
      (value, i) => {
        set(`font-size-${i + 1}`, `${value}rem`)
      },
    )
    for (const [key, value] of Object.entries({
      regular: '400',
      medium: '500',
      semibold: '600',
      bold: '700',
    })) {
      set(`font-weight-${key}`, value)
    }
    for (const [key, value] of Object.entries({
      tight: '1.15',
      normal: '1.5',
      relaxed: '1.75',
    })) {
      set(`line-height-${key}`, value)
    }
    const radii =
      config.radius === 'none'
        ? [0, 0, 0, 0]
        : config.radius === 'subtle'
          ? [0.125, 0.25, 0.375, 0.5]
          : [0.25, 0.5, 0.75, 1]
    radii.forEach((value, i) => {
      set(`radius-${i + 1}`, `${value}rem`)
    })
    set('radius-full', '9999px')
    set('corner-shape', config.squircle ? 'squircle' : 'round')
    set('shadow-1', `0 1px 3px ${ref('gray-a3')}`)
    set('shadow-2', `0 4px 16px ${ref('gray-a4')}`)
    set('shadow-3', `0 12px 40px ${ref('gray-a5')}`)
    set('duration-fast', '100ms')
    set('duration-normal', '180ms')
    set('duration-slow', '300ms')
    set('ease-standard', 'cubic-bezier(0.2, 0, 0, 1)')
    set('ease-enter', 'cubic-bezier(0, 0, 0.2, 1)')
    for (const [key, value] of Object.entries({
      base: '0',
      dropdown: '100',
      sticky: '200',
      overlay: '300',
      dialog: '400',
      toast: '500',
    })) {
      set(`z-${key}`, value)
    }
    const aliases: Record<string, string> = {
      bg: 'gray-1',
      surface: 'gray-2',
      'surface-raised': 'gray-1',
      'surface-hover': 'gray-3',
      'surface-active': 'gray-4',
      text: 'gray-12',
      'text-muted': 'gray-11',
      'text-subtle': 'gray-10',
      border: 'gray-6',
      'border-strong': 'gray-8',
      action: 'accent-9',
      'action-hover': 'accent-10',
      'action-active': 'accent-10',
      link: 'accent-11',
      'link-hover': 'accent-12',
      focus: 'accent-8',
      'selection-bg': 'accent-5',
      'selection-text': 'accent-12',
      'control-radius': config.radius === 'pill' ? 'radius-full' : 'radius-2',
      'panel-radius': 'radius-3',
      'dialog-radius': 'radius-4',
    }
    for (const status of ['warning', 'danger', 'success', 'info']) {
      aliases[`${status}-bg`] = `${status}-3`
      aliases[`${status}-text`] = `${status}-11`
      aliases[`${status}-border`] = `${status}-7`
    }
    for (const [name, target] of Object.entries(aliases)) {
      set(name, ref(target))
    }
    for (let level = 1; level <= 4; level++) {
      set(`surface-${level}`, ref(`gray-${level + 1}`))
    }
    set('overlay', mode === 'dark' ? '#000000b3' : '#00000066')
    const density = (
      {
        compact: ['2rem', 'space-2', 'space-1', 'space-3', 'space-5'],
        comfortable: ['2.5rem', 'space-3', 'space-2', 'space-5', 'space-6'],
        spacious: ['3rem', 'space-4', 'space-3', 'space-6', 'space-7'],
      } as const
    )[config.density]
    set('control-height', density[0])
    set('control-padding-x', ref(density[1]))
    set('control-gap', ref(density[2]))
    set('panel-padding', ref(density[3]))
    set('section-gap', ref(density[4]))
    // Apply overrides before choosing foreground, including primitive/action overrides.
    Object.assign(t, config.overrides.shared, config.overrides[mode])
    const dereference = (name: string, visited = new Set<string>()): string => {
      if (visited.has(name)) {
        return ''
      }
      visited.add(name)
      const value = t[name] ?? ''
      const target = /^var\((--[\w-]+)\)$/.exec(value)?.[1]
      return target ? dereference(target, visited) : value
    }
    if (
      !Object.hasOwn(config.overrides.shared, token('action-text')) &&
      !Object.hasOwn(config.overrides[mode], token('action-text'))
    ) {
      set(
        'action-text',
        chooseForeground(
          ['action', 'action-hover', 'action-active']
            .map(token)
            .map((n) => dereference(n)),
        ),
      )
    }
    modes[mode] = t
  }
  return { config, modes }
}
