import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import { startPreviewServer } from '../dist/server.js'

async function fixture(t) {
  const parent = resolve('../../test-results')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(`${parent}/preview-runtime-`)
  await cp(resolve('tests/fixtures/runtime'), root, { recursive: true })
  const output = resolve(root, '.preview')
  await mkdir(output)
  const data = resolve(output, 'preview.json')
  await writeFile(data, `${JSON.stringify(documentFixture(), null, 2)}\n`)
  const options = {
    projectRoot: root,
    input: resolve(root, 'src/index.js'),
    inputKind: 'automatic',
    output,
    data,
    runtime: resolve(output, 'runtime'),
    baselines: resolve(output, 'baselines'),
  }
  const server = await startPreviewServer(options, { port: 0 })
  t.after(async () => {
    await server.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, data, server }
}

function documentFixture() {
  return {
    schemaVersion: 1,
    project: { root: '.', entry: 'src/index.js' },
    provenance: {
      generator: '@heysuzy/preview',
      generatorVersion: '0.1.0',
      generatedAt: '1970-01-01T00:00:00.000Z',
      revision: 1,
    },
    runtime: {
      styles: ['src/shared.css'],
      providers: [
        { $ref: 'module', path: 'src/wrappers.jsx', export: 'Provider' },
      ],
      wrapper: {
        $ref: 'module',
        path: 'src/wrappers.jsx',
        export: 'SharedWrapper',
      },
      webComponents: {
        'src/user-chip.js#user-chip': {
          properties: ['displayName'],
          attributes: { active: 'active' },
          events: ['select'],
        },
      },
    },
    components: [
      {
        id: 'src/card.jsx#Card',
        name: 'Card',
        framework: 'react',
        source: { path: 'src/card.jsx', export: 'Card' },
        import: { path: 'src/card.jsx', export: 'Card' },
        wrapper: {
          $ref: 'module',
          path: 'src/wrappers.jsx',
          export: 'ComponentWrapper',
        },
        props: {
          children: {
            type: { text: 'ReactNode', kind: 'node', required: true },
            generated: {
              $ref: 'react-node',
              element: 'strong',
              children: ['Configured child'],
            },
          },
          onPress: {
            type: { text: '() => void', kind: 'function', required: true },
            generated: { $ref: 'function', behavior: 'log' },
          },
          fail: {
            type: { text: 'boolean', kind: 'boolean', required: false },
            generated: false,
          },
          audience: {
            type: {
              text: 'PersonAudience | TeamAudience',
              kind: 'object',
              required: true,
              discriminator: 'kind',
              branches: [
                {
                  text: 'PersonAudience',
                  kind: 'object',
                  properties: {
                    kind: {
                      text: "'person'",
                      kind: 'string',
                      required: true,
                      enum: ['person'],
                    },
                    profile: {
                      text: 'Profile',
                      kind: 'object',
                      required: true,
                      properties: {
                        address: {
                          text: 'Address',
                          kind: 'object',
                          required: true,
                          properties: {
                            city: {
                              text: 'string',
                              kind: 'string',
                              required: true,
                            },
                          },
                        },
                      },
                    },
                  },
                },
                {
                  text: 'TeamAudience',
                  kind: 'object',
                  properties: {
                    kind: {
                      text: "'team'",
                      kind: 'string',
                      required: true,
                      enum: ['team'],
                    },
                    members: {
                      text: 'string[]',
                      kind: 'array',
                      required: true,
                      items: { text: 'string', kind: 'string', required: true },
                    },
                  },
                },
              ],
            },
            generated: {
              kind: 'person',
              profile: { address: { city: 'Boston' } },
            },
          },
        },
        states: [
          { name: 'default', generated: true },
          { name: 'failing', values: { fail: true } },
        ],
      },
      {
        id: 'src/user-chip.js#user-chip',
        name: 'UserChip',
        framework: 'web-component',
        source: {
          path: 'src/user-chip.js',
          export: 'UserChip',
          tagName: 'user-chip',
        },
        import: { path: 'src/user-chip.js', export: 'UserChip' },
        props: {
          displayName: {
            type: { text: 'string', kind: 'string', required: true },
            generated: 'Ada',
          },
          active: {
            type: { text: 'boolean', kind: 'boolean', required: false },
            attribute: 'active',
            generated: true,
          },
        },
        states: [{ name: 'default', generated: true }],
      },
    ],
    diagnostics: [],
  }
}

test('server renders both actual frameworks and recovers across edits/failures', {
  timeout: 45_000,
}, async (t) => {
  const { root, data, server } = await fixture(t)
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  page.setDefaultTimeout(10_000)
  if (process.env.DEBUG_PREVIEW_TEST) {
    page.on('console', (message) => console.error('browser:', message.text()))
    page.on('pageerror', (error) => console.error('pageerror:', error))
  }
  await page.goto(server.url)
  await page.getByRole('button', { name: 'Card', exact: true }).click()
  const frame = page.frameLocator('#preview-frame')
  const react = frame.locator('#actual-react')
  await assert.doesNotReject(() => react.waitFor())
  assert.equal(await react.getAttribute('data-message'), 'alias-resolved')
  await assert.doesNotReject(() =>
    frame.locator('[data-provider="active"]').waitFor(),
  )
  await assert.doesNotReject(() =>
    frame.locator('[data-shared-wrapper="active"]').waitFor(),
  )
  await assert.doesNotReject(() =>
    frame.locator('[data-component-wrapper="active"]').waitFor(),
  )
  assert.match(await react.textContent(), /Configured child/)
  assert.ok(
    await frame.locator('img').evaluate((image) => image.naturalWidth > 0),
  )
  await react.click()
  await assert.doesNotReject(() =>
    page.locator('#events li').first().waitFor({ state: 'attached' }),
  )
  assert.match(
    await page.locator('#events li').first().textContent(),
    /onPress/,
  )

  const color = await react.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )
  assert.equal(color, 'rgb(10, 20, 30)')
  await writeFile(
    resolve(root, 'src/shared.css'),
    '.actual-react { background: rgb(30, 40, 50); }\n',
  )
  await page.waitForFunction(() => {
    const element = document
      .querySelector('#preview-frame')
      ?.contentDocument?.querySelector('#actual-react')
    return (
      element && getComputedStyle(element).backgroundColor === 'rgb(30, 40, 50)'
    )
  })

  const edited = JSON.parse(await readFile(data, 'utf8'))
  edited.components[0].props.children.value = 'Direct config edit'
  await writeFile(data, `${JSON.stringify(edited, null, 2)}\n`)
  await frame
    .locator('.content')
    .filter({ hasText: 'Direct config edit' })
    .waitFor()
  await writeFile(data, '{ invalid json')
  await page
    .locator('#diagnostics')
    .filter({ hasText: /Expected|Unexpected|JSON/ })
    .waitFor()
  assert.match(
    await frame.locator('.content').textContent(),
    /Direct config edit/,
  )
  edited.components[0].props.children.value = 'Recovered config'
  await writeFile(data, `${JSON.stringify(edited, null, 2)}\n`)
  await frame
    .locator('.content')
    .filter({ hasText: 'Recovered config' })
    .waitFor()

  const cardPath = resolve(root, 'src/card.jsx')
  await writeFile(
    cardPath,
    (await readFile(cardPath, 'utf8')).replace('Version one', 'Version two'),
  )
  await frame.locator('.version').filter({ hasText: 'Version two' }).waitFor()

  await page.getByRole('button', { name: 'UserChip', exact: true }).click()
  await frame
    .locator('.actual-web')
    .filter({ hasText: 'Web one: Ada' })
    .waitFor()
  assert.equal(await frame.locator('user-chip').getAttribute('active'), '')
  await frame.locator('.actual-web').click()
  await page.locator('#events li').first().waitFor({ state: 'attached' })
  assert.match(
    await page.locator('#events li').first().textContent(),
    /\[Circular\]/,
  )

  const webPath = resolve(root, 'src/user-chip.js')
  await writeFile(
    webPath,
    (await readFile(webPath, 'utf8')).replace('Web one', 'Web two'),
  )
  await frame
    .locator('.actual-web')
    .filter({ hasText: 'Web two: Ada' })
    .waitFor()

  await page.evaluate(() => {
    const iframe = document.querySelector('#preview-frame')
    iframe.src =
      '/__preview/frame?component=src%2Fcard.jsx%23Card&state=failing&reload=failure'
  })
  await frame
    .locator('.preview-error')
    .filter({ hasText: 'Intentional component failure' })
    .waitFor()
  assert.equal(await page.locator('#components button').count(), 2)
  await page.getByRole('button', { name: 'UserChip', exact: true }).click()
  await frame.locator('.actual-web').waitFor()

  const forbidden = await fetch(`${server.url}/__preview/api/document`, {
    method: 'PUT',
    headers: {
      origin: 'https://unrelated.example',
      'content-type': 'application/json',
    },
    body: '{}',
  })
  assert.equal(forbidden.status, 403)
})

test('explorer edits, validates, persists, and resolves external changes', {
  timeout: 45_000,
}, async (t) => {
  const { data, server } = await fixture(t)
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  page.setDefaultTimeout(10_000)
  await page.goto(server.url)

  const card = page.getByRole('button', { name: 'Card', exact: true })
  await card.waitFor()
  await card.focus()
  await page.keyboard.press('ArrowDown')
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute('aria-label'),
    ),
    'UserChip',
  )
  await page.keyboard.press('ArrowUp')

  await page.getByLabel('audience value source').selectOption('override')
  await page.getByLabel('audience union branch').selectOption({ label: 'team' })
  const frame = page.frameLocator('#preview-frame')
  const audience = page.getByLabel('audience structured value')
  await audience.fill(
    JSON.stringify({ kind: 'team', members: ['Mira'] }, null, 2),
  )
  await audience.blur()
  await frame.locator('.audience').filter({ hasText: 'team: Mira' }).waitFor()
  await page.locator('#save-status').filter({ hasText: 'Unsaved' }).waitFor()

  await audience.fill('{')
  await audience.blur()
  await page
    .locator('#save-status')
    .filter({ hasText: 'Invalid draft' })
    .waitFor()
  assert.equal(await audience.inputValue(), '{')
  assert.match(await frame.locator('.audience').textContent(), /team: Mira/)
  await audience.fill(
    JSON.stringify({ kind: 'team', members: ['Mira', 'Sam'] }, null, 2),
  )
  await audience.blur()
  await frame.locator('.audience').filter({ hasText: 'Mira, Sam' }).waitFor()

  await page.getByLabel('children value source').selectOption('override')
  const childValue = page.getByLabel(/children (descriptor|structured) value/)
  await childValue.fill(JSON.stringify('short'))
  await childValue.blur()
  const rules = page.getByLabel('children validation rules')
  await rules.fill(
    JSON.stringify(
      [{ $ref: 'validator', name: 'minLength', options: { value: 10 } }],
      null,
      2,
    ),
  )
  await rules.blur()
  await page
    .locator('[data-prop="children"] .field-error')
    .filter({ hasText: /length/i })
    .waitFor()
  assert.match(await frame.locator('.content').textContent(), /short/)
  const corrected = page.getByLabel(/children (descriptor|structured) value/)
  await corrected.fill(JSON.stringify('long enough child'))
  await corrected.blur()
  await frame
    .locator('.content')
    .filter({ hasText: 'long enough child' })
    .waitFor()

  await page
    .locator('[data-prop="onPress"]')
    .getByRole('button', { name: 'Regenerate field' })
    .click()
  assert.match(await frame.locator('.audience').textContent(), /Mira, Sam/)

  await page.locator('#new-state-name').fill('custom team')
  await page.getByRole('button', { name: 'Save state' }).click()
  await page
    .locator('#state-select')
    .selectOption({ label: 'custom team · named' })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.locator('#save-status').filter({ hasText: 'Saved' }).waitFor()
  await page.reload()
  await page
    .locator('#state-select')
    .selectOption({ label: 'custom team · named' })
  await frame.locator('.audience').filter({ hasText: 'Mira, Sam' }).waitFor()

  await page
    .getByLabel('audience structured value')
    .fill(JSON.stringify({ kind: 'team', members: ['Local draft'] }, null, 2))
  await page.getByLabel('audience structured value').blur()
  const external = JSON.parse(await readFile(data, 'utf8'))
  external.components[1].props.displayName.value = 'External editor'
  await writeFile(data, `${JSON.stringify(external, null, 2)}\n`)
  await page
    .locator('#external-banner')
    .filter({ hasText: 'changed outside' })
    .waitFor()
  assert.match(
    await page.getByLabel('audience structured value').inputValue(),
    /Local draft/,
  )
  await page.getByRole('button', { name: 'Merge external changes' }).click()
  await page.locator('#external-banner').waitFor({ state: 'hidden' })
  assert.match(
    await page.getByLabel('audience structured value').inputValue(),
    /Local draft/,
  )
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.locator('#save-status').filter({ hasText: 'Saved' }).waitFor()

  const persisted = JSON.parse(await readFile(data, 'utf8'))
  assert.equal(
    persisted.components[1].props.displayName.value,
    'External editor',
  )
  assert.ok(
    persisted.components[0].states.some(
      (state) => state.name === 'custom team',
    ),
  )
})
