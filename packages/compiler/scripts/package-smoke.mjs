import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'suzy-package-'))
const run = (command, args, cwd = dir) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
try {
  const tar = join(dir, 'suzy.tgz')
  const componentsTar = join(dir, 'components.tgz')
  run('yarn', ['pack', '--filename', tar], process.cwd())
  assert.doesNotMatch(
    run('tar', ['-tzf', tar]),
    /dist\/components|packages\/components/,
  )
  run(
    'yarn',
    ['pack', '--filename', componentsTar],
    join(process.cwd(), '../components'),
  )
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'suzy-consumer-test',
      private: true,
      type: 'module',
      dependencies: { '@suzycss/compiler': `file:${tar}` },
    }),
  )
  run('yarn', [
    'install',
    '--cache-folder',
    join(dir, 'cache'),
    '--production',
    '--ignore-scripts',
    '--non-interactive',
  ])
  const bin = join(dir, 'node_modules/.bin/suzy')
  const { version } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )
  assert.equal(run(bin, ['--version']).trim(), version)
  run(bin, ['init'])
  const config = JSON.parse(
    await readFile(join(dir, 'suzy.config.json'), 'utf8'),
  )
  assert.equal(
    config.$schema,
    './node_modules/%40suzy/compiler/suzy.schema.json',
  )
  assert.ok(
    JSON.parse(
      await readFile(join(dir, decodeURIComponent(config.$schema)), 'utf8'),
    ).properties.colors,
  )
  await assert.rejects(stat(join(dir, 'suzy.schema.json')), { code: 'ENOENT' })
  run(bin, ['build'])
  assert.match(
    await readFile(join(dir, 'src/styles/theme.css'), 'utf8'),
    /@layer suzy/,
  )
  run(process.execPath, [
    '--input-type=module',
    '-e',
    "import {resolveConfig,createTheme,renderCss} from '@suzycss/compiler'; import schema from '@suzycss/compiler/schema' with {type:'json'}; if (!schema.properties.version || !renderCss(createTheme(resolveConfig())).includes('--suzy-bg')) throw Error('Bad exports');",
  ])
  const checkPreview = (installed) =>
    run(process.execPath, [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { resolve } from 'node:path';
      import { createRequire } from 'node:module';
      if (${installed}) createRequire(resolve('package.json')).resolve('@suzycss/components/preview');
      import { startPreview } from './node_modules/@suzycss/compiler/dist/preview/server.js';
      const server = await startPreview(resolve('suzy.config.json'), 0);
      try {
        const html = await (await fetch(server.url)).text();
        assert.equal(html.includes('id="components"'), ${installed});
        assert.equal((await fetch(server.url + '/components/index.js')).status, ${installed ? 200 : 404});
        if (${installed}) assert.equal((await fetch(server.url + '/components/surface.js')).status, 200);
      } finally { await server.close(); }
    `,
    ])
  checkPreview(false)
  run('yarn', [
    'add',
    `@suzycss/components@file:${componentsTar}`,
    '--cache-folder',
    join(dir, 'cache'),
    '--ignore-scripts',
    '--non-interactive',
  ])
  checkPreview(true)
  console.log(
    'Package smoke passed: isolated production install, executable, init/build, library exports, schema, separate component package, preview with and without components.',
  )
} finally {
  await rm(dir, { recursive: true, force: true })
}
