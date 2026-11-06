import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import {
  createTheme,
  renderCss,
  resolveConfig,
  resolveToken,
} from '../dist/core/compiler.js'
import { startPreview } from '../dist/preview/server.js'

const rgb = (hex) =>
  `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`

test('surfaces follow nesting, theme scopes, moves, and detached roots', async (t) => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SUZY_CHROMIUM_EXECUTABLE,
  })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const theme = createTheme(resolveConfig({ prefix: 'app' }))
  await page.route('http://suzy.test/**', async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1)
    await route.fulfill({
      contentType: 'text/javascript',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: await readFile(
        new URL(`../../components/dist/${name}`, import.meta.url),
        'utf8',
      ),
    })
  })
  await page.setContent(`<style>${renderCss(theme)}</style>
    <style>suzy-surface { padding: 16px; }</style>
    <suzy-surface id="outer">Base
      <div id="wrapper"><suzy-surface id="inner">Nested
        <suzy-surface id="third">Third
          <suzy-surface id="fourth">Fourth
            <suzy-surface id="fifth">Capped</suzy-surface>
          </suzy-surface>
        </suzy-surface>
      </suzy-surface></div>
      <suzy-surface id="sibling">Sibling</suzy-surface>
      <div data-suzy-theme="dark"><suzy-surface id="dark">Dark nested theme</suzy-surface></div>
    </suzy-surface>
    <suzy-surface id="detached">Detached</suzy-surface>`)
  await page.addScriptTag({ type: 'module', url: 'http://suzy.test/index.js' })
  const assertSurface = async (id, level, mode) => {
    assert.equal(
      await page
        .locator(`#${id}`)
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      rgb(resolveToken(theme.modes[mode], `--app-surface-${level}`)),
      `${id}: surface ${level}, ${mode}`,
    )
  }
  for (const mode of ['light', 'dark']) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.suzyTheme = mode
    }, mode)
    for (const [id, level] of [
      ['outer', 1],
      ['inner', 2],
      ['third', 3],
      ['fourth', 4],
      ['fifth', 4],
      ['sibling', 2],
      ['detached', 1],
    ]) {
      await assertSurface(id, level, mode)
    }
    await assertSurface('dark', 2, 'dark')
    await mkdir('test-results', { recursive: true })
    await page.screenshot({ path: `test-results/surfaces-${mode}.png` })
  }
  await page.evaluate(() =>
    document.body.append(document.querySelector('#wrapper')),
  )
  await assertSurface('inner', 1, 'dark')
  await assertSurface('third', 2, 'dark')
  await page.evaluate(() =>
    document
      .querySelector('#detached')
      .append(document.querySelector('#wrapper')),
  )
  await assertSurface('inner', 2, 'dark')
  await assertSurface('third', 3, 'dark')
  await page.evaluate(() => {
    const host = document.createElement('div')
    document.querySelector('#outer').append(host)
    host.attachShadow({ mode: 'open' }).innerHTML =
      '<suzy-surface id="shadow">Shadow child</suzy-surface>'
  })
  await assertSurface('shadow', 2, 'dark')
  await page.locator('#outer').evaluate((el) => {
    el.hidden = true
  })
  assert.equal(await page.locator('#outer').isVisible(), false)
  await page.addStyleTag({ content: '#detached { background: rgb(1, 2, 3); }' })
  assert.equal(
    await page
      .locator('#detached')
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgb(1, 2, 3)',
  )
})

test('computed CSS: OS, explicit root, alternating nested scopes, local aliases, reduced motion', async (t) => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SUZY_CHROMIUM_EXECUTABLE,
  })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const theme = createTheme(
    resolveConfig({
      overrides: {
        shared: {
          '--suzy-local': 'var(--suzy-accent-9)',
          '--suzy-spacing': 'var(--suzy-control-padding-x)',
        },
        dark: { '--suzy-space-3': '2rem', '--suzy-dark-only': '3px' },
      },
    }),
  )
  const html = (css) =>
    `<style>${css}</style><style>.sample { background:var(--suzy-bg); color:var(--suzy-text); border:1px solid var(--suzy-local); padding-left:var(--suzy-spacing); margin-left:var(--suzy-dark-only, 0px); transition-property:opacity; transition-duration:var(--suzy-duration-normal); }</style><div id="root" class="sample">root</div><div id="dark" class="sample" data-suzy-theme="dark"><div id="light-in-dark" class="sample" data-suzy-theme="light"><div id="dark-in-light" class="sample" data-suzy-theme="dark">nested</div></div></div><div id="light" class="sample" data-suzy-theme="light"><div id="dark-in-light-2" class="sample" data-suzy-theme="dark"><div id="light-in-dark-2" class="sample" data-suzy-theme="light">nested</div></div></div>`
  const computed = (id) =>
    page.locator(`#${id}`).evaluate((el) => {
      const s = getComputedStyle(el)
      return {
        bg: s.backgroundColor,
        text: s.color,
        border: s.borderTopColor,
        scheme: s.colorScheme,
        duration: s.transitionDuration,
        padding: s.paddingLeft,
        margin: s.marginLeft,
      }
    })
  const assertMode = async (id, mode) => {
    const s = await computed(id),
      tokens = theme.modes[mode]
    assert.equal(s.bg, rgb(resolveToken(tokens, '--suzy-bg')), `${id} bg`)
    assert.equal(s.text, rgb(resolveToken(tokens, '--suzy-text')), `${id} text`)
    assert.equal(
      s.border,
      rgb(resolveToken(tokens, '--suzy-local')),
      `${id} local alias`,
    )
    assert.equal(s.scheme, mode)
    assert.equal(s.padding, mode === 'dark' ? '32px' : '12px')
    assert.equal(s.margin, mode === 'dark' ? '3px' : '0px')
  }
  await page.setContent(html(renderCss(theme)))
  for (const os of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: os })
    for (const root of [null, 'light', 'dark']) {
      await page.evaluate((mode) => {
        if (mode) document.documentElement.dataset.suzyTheme = mode
        else document.documentElement.removeAttribute('data-suzy-theme')
      }, root)
      await assertMode('root', root ?? os)
      for (const id of ['dark', 'dark-in-light', 'dark-in-light-2'])
        await assertMode(id, 'dark')
      for (const id of ['light', 'light-in-dark', 'light-in-dark-2'])
        await assertMode(id, 'light')
    }
  }
  await page.evaluate(() =>
    document.documentElement.removeAttribute('data-suzy-theme'),
  )
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  for (const id of ['root', 'dark', 'light', 'dark-in-light', 'light-in-dark'])
    assert.equal((await computed(id)).duration, '0s')
})

test('preview browser: switching, dialogs, live reload/error recovery, responsive layout, no remote assets', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'suzy-browser-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const config = join(dir, 'suzy.config.json')
  await writeFile(config, JSON.stringify({ prefix: 'app' }))
  const server = await startPreview(config, 0)
  t.after(server.close)
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SUZY_CHROMIUM_EXECUTABLE,
  })
  t.after(() => browser.close())
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  })
  const errors = [],
    remote = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('request', (r) => {
    if (!r.url().startsWith(server.url)) remote.push(r.url())
  })
  await page.goto(server.url)
  await page.selectOption('#appearance', 'dark')
  assert.equal(
    await page.locator('html').getAttribute('data-suzy-theme'),
    'dark',
  )
  await page.locator('[data-dialog="light"]').click()
  assert.equal(
    await page.locator('#dialog-light').evaluate((el) => el.open),
    true,
  )
  await page.locator('#dialog-light button').click()
  assert.equal(
    await page.locator('#dialog-light').evaluate((el) => el.open),
    false,
  )
  await page.evaluate(() => window.scrollTo(0, 0))
  await mkdir('test-results', { recursive: true })
  await page.screenshot({
    path: 'test-results/preview-desktop.png',
    fullPage: true,
  })
  await page.screenshot({ path: 'test-results/preview-desktop-viewport.png' })
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 })
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `page overflow at ${width}`,
    )
    const overflowing = await page
      .locator('button, input, select, textarea, fieldset, h1, h2, .card')
      .evaluateAll((els) =>
        els
          .filter((el) => {
            const box = el.getBoundingClientRect()
            return box.width && (box.right > innerWidth + 1 || box.left < -1)
          })
          .map((el) => el.outerHTML.slice(0, 100)),
      )
    assert.deepEqual(overflowing, [], `elements outside viewport at ${width}`)
  }
  await page.setViewportSize({ width: 375, height: 900 })
  await page.screenshot({
    path: 'test-results/preview-mobile.png',
    fullPage: true,
  })
  await page.screenshot({ path: 'test-results/preview-mobile-viewport.png' })
  await writeFile(config, '{bad')
  await page.waitForFunction(() =>
    document
      .querySelector('#connection')
      .textContent.includes('Configuration error'),
  )
  await writeFile(config, JSON.stringify({ name: 'Live browser update' }))
  await page.waitForFunction(() =>
    document.title.includes('Live browser update'),
  )
  assert.equal(
    await page.locator('html').getAttribute('data-suzy-theme'),
    'dark',
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(remote, [])
})

test('generated CSS alone styles native controls, preserves behavior, and allows application overrides', async (t) => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SUZY_CHROMIUM_EXECUTABLE,
  })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const density of ['compact', 'comfortable', 'spacious']) {
    const theme = createTheme(resolveConfig({ density, radius: 'subtle' }))
    await page.setContent(
      `<style>${renderCss(theme)}</style><button id="action">Continue</button><input id="text" placeholder="Name"><input id="check" type="checkbox"><input type="hidden" id="hidden"><button hidden id="hidden-button">Hidden</button><button disabled id="disabled">Disabled</button><textarea>Notes</textarea><select><option>One</option></select><dialog>Closed</dialog><details><summary>More</summary>Content</details>`,
    )
    for (const mode of ['light', 'dark']) {
      await page.evaluate(
        (mode) => (document.documentElement.dataset.suzyTheme = mode),
        mode,
      )
      const styles = await page.evaluate(() => {
        const button = getComputedStyle(document.querySelector('#action'))
        const input = getComputedStyle(document.querySelector('#text'))
        return {
          margin: getComputedStyle(document.body).margin,
          bg: button.backgroundColor,
          height: button.minHeight,
          radius: button.borderRadius,
          inputBg: input.backgroundColor,
          box: input.boxSizing,
          checkHeight: document.querySelector('#check').getBoundingClientRect()
            .height,
        }
      })
      assert.equal(styles.margin, '0px')
      assert.equal(
        styles.bg,
        rgb(resolveToken(theme.modes[mode], '--suzy-gray-3')),
      )
      assert.equal(
        styles.inputBg,
        rgb(resolveToken(theme.modes[mode], '--suzy-surface-raised')),
      )
      assert.equal(
        styles.height,
        { compact: '32px', comfortable: '40px', spacious: '48px' }[density],
      )
      assert.equal(styles.radius, '4px')
      assert.equal(styles.box, 'border-box')
      assert.ok(styles.checkHeight < 24, 'checkbox retains native dimensions')
    }
    assert.equal(await page.locator('#hidden').isVisible(), false)
    assert.equal(await page.locator('#hidden-button').isVisible(), false)
    assert.equal(await page.locator('dialog').isVisible(), false)
    assert.equal(await page.locator('#disabled').isDisabled(), true)
    await page.locator('#check').check()
    assert.equal(await page.locator('#check').isChecked(), true)
    await page.locator('summary').click()
    assert.equal(await page.locator('details').getAttribute('open'), '')
    await page.keyboard.press('Tab')
    await page.locator('#action').focus()
    assert.equal(
      await page
        .locator('#action')
        .evaluate((el) => getComputedStyle(el).outlineStyle),
      'solid',
    )
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert.equal(
      await page
        .locator('#action')
        .evaluate((el) => getComputedStyle(el).transitionDuration),
      '0s',
    )
    await page.addStyleTag({
      content: 'button { background: rgb(1, 2, 3); border-radius: 0; }',
    })
    assert.equal(
      await page
        .locator('#action')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      'rgb(1, 2, 3)',
    )
  }
})

test('default and primary buttons retain their colors through interaction in both themes', async (t) => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SUZY_CHROMIUM_EXECUTABLE,
  })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const theme = createTheme(resolveConfig({}))
  for (const mode of ['light', 'dark']) {
    for (const primary of [false, true]) {
      for (const type of ['button', 'submit', 'reset', null]) {
        const attributes = `id="target" class="${primary ? 'primary' : ''}"`
        await page.setContent(
          `<style>${renderCss(theme)}</style>${type ? `<input type="${type}" ${attributes} value="Action">` : `<button ${attributes}>Action</button>`}`,
        )
        await page.evaluate(
          (mode) => (document.documentElement.dataset.suzyTheme = mode),
          mode,
        )
        const target = page.locator('#target')
        const assertColor = async (token) => {
          assert.equal(
            await target.evaluate((el) => getComputedStyle(el).backgroundColor),
            rgb(resolveToken(theme.modes[mode], token)),
            `${mode} ${primary ? 'primary' : 'default'} ${type ?? 'button element'} ${token}`,
          )
        }
        await page.mouse.move(1000, 700)
        await assertColor(primary ? '--suzy-action' : '--suzy-gray-3')
        assert.equal(
          await target.evaluate((el) => getComputedStyle(el).color),
          rgb(
            resolveToken(
              theme.modes[mode],
              primary ? '--suzy-action-text' : '--suzy-text',
            ),
          ),
        )
        await target.hover()
        await assertColor(primary ? '--suzy-action-hover' : '--suzy-gray-4')
        await page.mouse.down()
        await assertColor(primary ? '--suzy-action-active' : '--suzy-gray-5')
        await page.mouse.up()
        await target.evaluate((el) => {
          el.disabled = true
        })
        await assertColor(primary ? '--suzy-action' : '--suzy-gray-3')
      }
    }
  }
})

test('preview shows components only when installed in the consumer project', async (t) => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SUZY_CHROMIUM_EXECUTABLE,
  })
  t.after(() => browser.close())
  for (const installed of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'suzy-optional-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    await writeFile(
      join(dir, 'suzy.config.json'),
      JSON.stringify({ prefix: 'app' }),
    )
    if (installed) {
      await mkdir(join(dir, 'node_modules/@suzy'), { recursive: true })
      await symlink(
        resolve('../components'),
        join(dir, 'node_modules/@suzycss/components'),
        'dir',
      )
    }
    const server = await startPreview(join(dir, 'suzy.config.json'), 0)
    t.after(server.close)
    const page = await browser.newPage({
      viewport: { width: 1200, height: 900 },
    })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.url)
    assert.equal(await page.locator('#components').count(), installed ? 1 : 0)
    assert.equal(
      (await page.request.get(`${server.url}/components/index.js`)).status(),
      installed ? 200 : 404,
    )
    assert.equal(
      await page.locator('.dual').first().locator('suzy-surface').count(),
      0,
    )
    if (installed) {
      await page.waitForFunction(() => customElements.get('suzy-surface'))
      const theme = createTheme(resolveConfig({ prefix: 'app' }))
      for (const mode of ['light', 'dark']) {
        const surface = page.locator(
          `#components [data-suzy-theme="${mode}"] > suzy-surface`,
        )
        assert.equal(
          await surface.evaluate((el) => getComputedStyle(el).backgroundColor),
          rgb(resolveToken(theme.modes[mode], '--app-surface-1')),
        )
      }
      await mkdir('test-results', { recursive: true })
      await page
        .locator('#components')
        .screenshot({ path: 'test-results/components-section.png' })
      await page.setViewportSize({ width: 375, height: 900 })
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      )
    }
    assert.deepEqual(errors, [])
    await page.close()
  }
})

test('squircle corners render on controls and containers while radios stay round', async (t) => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SUZY_CHROMIUM_EXECUTABLE,
  })
  t.after(() => browser.close())
  const page = await browser.newPage()
  for (const squircle of [true, false]) {
    const theme = createTheme(
      resolveConfig({ radius: 'subtle', squircle, prefix: 'app' }),
    )
    await page.setContent(`<style>${renderCss(theme)}</style>
      <button>Continue</button><input type="text"><textarea>Notes</textarea>
      <select><option>One</option></select><input type="checkbox" checked>
      <input type="radio" checked><input type="file">
      <fieldset><legend>Options</legend>Fieldset</fieldset><dialog open>Details</dialog>`)
    assert.equal(
      await page.evaluate(() => CSS.supports('corner-shape', 'squircle')),
      true,
    )
    const shape = squircle ? 'superellipse(2)' : 'superellipse(1)'
    for (const selector of [
      'button',
      'input[type="text"]',
      'textarea',
      'select',
      'input[type="checkbox"]',
      'fieldset',
      'dialog',
    ]) {
      assert.equal(
        await page
          .locator(selector)
          .evaluate((el) => getComputedStyle(el).cornerShape),
        shape,
        `${squircle} ${selector}`,
      )
    }
    assert.equal(
      await page
        .locator('input[type="file"]')
        .evaluate(
          (el) => getComputedStyle(el, '::file-selector-button').cornerShape,
        ),
      shape,
    )
    assert.equal(
      await page
        .locator('input[type="radio"]')
        .evaluate((el) => getComputedStyle(el).cornerShape),
      'superellipse(1)',
    )
    assert.equal(
      await page
        .locator('button')
        .evaluate((el) => getComputedStyle(el).borderTopLeftRadius),
      '4px',
    )
    if (squircle) {
      await mkdir('test-results', { recursive: true })
      await page.screenshot({ path: 'test-results/squircle.png' })
    }
  }
})
