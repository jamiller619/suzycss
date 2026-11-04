import { readFileSync } from 'node:fs'
import type { Mode, Theme } from '../core/compiler.js'
import {
  createTheme,
  renderCss,
  resolveConfig,
  resolveToken,
} from '../core/compiler.js'

const logoSvg = readFileSync(new URL('./logo.svg', import.meta.url), 'utf8')
const pageTemplate = readFileSync(
  new URL('./page.html', import.meta.url),
  'utf8',
)
const specimenTemplate = readFileSync(
  new URL('./specimen.html', import.meta.url),
  'utf8',
)

const componentsTemplate = readFileSync(
  new URL('./components.html', import.meta.url),
  'utf8',
)
const surfaceTemplate = readFileSync(
  new URL('./surface.html', import.meta.url),
  'utf8',
)

// Replace only template markers, never markers inside inserted theme values.
function fillTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined)
      throw new Error(`Missing preview template value: ${key}`)
    return String(value)
  })
}

export const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] ?? c,
  )

function specimen(mode: Mode, prefix: string): string {
  return fillTemplate(specimenTemplate.replaceAll('--suzy-', `--${prefix}-`), {
    mode: mode,
    statuses: ['success', 'info', 'warning', 'danger']
      .map(
        (s) =>
          `<p class="status ${s}"><strong>${s}</strong> · ${{ success: 'Changes saved.', info: 'A new version is available.', warning: 'Review before continuing.', danger: 'Something needs your attention.' }[s]}</p>`,
      )
      .join(''),
  })
}
export function renderPreview(
  theme: Theme,
  revision: number,
  components = false,
): string {
  const modes = Object.keys(theme.modes) as Mode[]
  const { config } = theme
  const presetCss: string[] = []
  const presets = (
    kind: 'density' | 'radius' | 'squircle',
    values: (string | boolean)[],
  ) =>
    values
      .map((value) => {
        const variant = createTheme(resolveConfig({ ...config, [kind]: value }))
        // Compile each preset through the same IR; redeclare aliases at the sample boundary.
        for (const mode of modes) {
          const variantTokens = variant.modes[mode]
          if (!variantTokens) {
            throw new Error(`Missing ${mode} mode in preset theme.`)
          }
          presetCss.push(
            `[data-preset="${kind}-${value}"][data-suzy-theme="${mode}"] {${Object.entries(
              variantTokens,
            )
              .map(([key, val]) => `${key}:${val};`)
              .join('')}}`,
          )
        }
        return `<div class="preset" data-preset="${kind}-${value}" data-suzy-theme="${modes[0]}"><span>${value}</span><div class="card"><button class="primary">Make it yours</button></div></div>`
      })
      .join('')
  const density = presets('density', ['compact', 'comfortable', 'spacious'])
  const radius = presets('radius', ['none', 'subtle', 'rounded', 'pill'])
  const squircle = presets('squircle', [false, true])
  const tokens = Object.entries(theme.modes)
    .map(
      ([mode, modeTokens]) =>
        `<details class="token-group" ${mode === modes[0] ? 'open' : ''}><summary>${mode} tokens</summary><div class="table-wrap"><table><thead><tr><th>Token</th><th>Definition</th><th>Resolved</th></tr></thead><tbody>${Object.entries(
          modeTokens,
        )
          .sort(([a], [b]) => a.localeCompare(b))
          .map(
            ([name, value]) =>
              `<tr><th scope="row"><code>${escapeHtml(name)}</code></th><td><code>${escapeHtml(value)}</code></td><td><code>${escapeHtml(resolveToken(modeTokens, name) ?? 'Unevaluated expression')}</code></td></tr>`,
          )
          .join('')}</tbody></table></div></details>`,
    )
    .join('')
  return fillTemplate(
    pageTemplate.replaceAll('--suzy-', `--${config.prefix}-`),
    {
      componentsSection: components
        ? fillTemplate(componentsTemplate, {
            componentSpecimens: modes
              .map((mode) =>
                fillTemplate(
                  surfaceTemplate.replaceAll('--suzy-', `--${config.prefix}-`),
                  { mode },
                ),
              )
              .join(''),
          })
        : '',
      componentsScript: components
        ? '<script type="module" src="/components/index.js"></script>'
        : '',
      themeName: escapeHtml(config.name),
      themeCss: renderCss(theme),
      presetCss: presetCss.join('\n'),
      modeCount: modes.length,
      statusCss: ['success', 'info', 'warning', 'danger']
        .map(
          (s) =>
            `.${s} { color: var(--${config.prefix}-${s}-text); background: var(--${config.prefix}-${s}-bg); border-color: var(--${config.prefix}-${s}-border); }`,
        )
        .join('\n'),
      logo: logoSvg,
      appearanceOptions: modes
        .map((m) => `<option value="${m}">${m}</option>`)
        .join(''),
      accent: config.colors.accent,
      gray: config.colors.gray,
      densityName: config.density,
      radiusName: `${config.radius}${config.squircle ? ' + squircle' : ''}`,
      specimens: modes.map((mode) => specimen(mode, config.prefix)).join(''),
      palettes: modes
        .map(
          (mode) =>
            `<div class="palette" data-suzy-theme="${mode}"><h3>${mode}</h3>${Object.keys(
              config.colors,
            )
              .map(
                (role) =>
                  `<p>${role}</p><div class="swatches">${Array.from({ length: 12 }, (_, i) => `<div><div class="swatch" style="background:var(--${config.prefix}-${role}-${i + 1})" title="--${config.prefix}-${role}-${i + 1}"></div><div class="swatch-label">${i + 1}</div></div>`).join('')}</div>`,
              )
              .join('')}</div>`,
        )
        .join(''),
      typography: [8, 7, 6, 5, 4, 3, 2, 1]
        .map(
          (i) =>
            `<p class="type-sample" style="font-size:var(--${config.prefix}-font-size-${i})">The details make the difference. <code>/${i}</code></p>`,
        )
        .join(''),
      densityPresets: density,
      radiusPresets: radius,
      squirclePresets: squircle,
      tokens: tokens,
      revision: revision,
    },
  )
}
