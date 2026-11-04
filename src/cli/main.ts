#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  createTheme,
  renderCss,
  resolveConfig,
  validateTheme,
} from '../core/compiler.js'
import { startPreview } from '../preview/server.js'
import { build, watchConfig, writeAtomic } from './files.js'

const help = `suzy — Cascade FTW.

Usage: suzy <init|build|watch|preview|check> [options]

  init     Create suzy.config.json and initial CSS
  build    Compile CSS (unchanged output is not rewritten)
  watch    Build now and rebuild on configuration changes
  preview  Serve a live local theme specimen
  check    Check references and report text contrast pairs

Options:
  --config <path>       Configuration file (default: ./suzy.config.json)
  --force               Replace configuration during init
  --strict              Fail check on warnings as well as errors
  --port <number>        Preview port (default: 3000; 0 chooses a free port)
  --help, -h            Show help
  --version, -v         Show version

Init options:
  --name <name>         Theme name
  --accent <palette>    Named Radix palette (default: violet)
  --gray <palette>      gray, mauve, slate, sage, olive, sand
  --warning <palette>  --danger <palette>  --success <palette>  --info <palette>
  --radius <preset>     none, subtle, rounded, pill
  --squircle            Use squircle corners with the selected radius
  --density <preset>    compact, comfortable, spacious
  --prefix <name>       Token prefix (default: suzy)
  --output <path>       CSS path for init, build, or watch; relative to config

Example: suzy init --accent blue --radius pill
         suzy preview
`
const report = (error: unknown) =>
  console.error(`suzy: ${(error as Error).message}`)
async function main() {
  const { values: parsedValues, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      force: { type: 'boolean' },
      strict: { type: 'boolean' },
      squircle: { type: 'boolean' },
      ...Object.fromEntries(
        [
          'config',
          'name',
          'prefix',
          'accent',
          'gray',
          'warning',
          'danger',
          'success',
          'info',
          'radius',
          'density',
          'output',
          'port',
        ].map((k) => [k, { type: 'string' as const }]),
      ),
    },
  })
  const values = parsedValues as Record<string, string | boolean | undefined>
  if (values.version) {
    console.log(
      (
        JSON.parse(
          await readFile(
            new URL('../../package.json', import.meta.url),
            'utf8',
          ),
        ) as { version: string }
      ).version,
    )
    return
  }
  if (values.help || positionals.length === 0) {
    console.log(help)
    return
  }
  const command = positionals[0]
  if (
    positionals.length !== 1 ||
    command === undefined ||
    !['init', 'build', 'watch', 'preview', 'check'].includes(command)
  ) {
    throw new Error(
      `Unknown command: ${positionals.join(' ')}. Run suzy --help.`,
    )
  }
  const initOptions = [
    'force',
    'name',
    'prefix',
    'accent',
    'gray',
    'warning',
    'danger',
    'success',
    'info',
    'radius',
    'squircle',
    'density',
  ]
  for (const key of Object.keys(values)) {
    if (
      (initOptions.includes(key) && command !== 'init') ||
      (key === 'output' && !['init', 'build', 'watch'].includes(command)) ||
      (key === 'strict' && command !== 'check') ||
      (key === 'port' && command !== 'preview')
    ) {
      throw new Error(`--${key} is not supported by ${command}`)
    }
  }
  const configPath = resolve(String(values.config ?? 'suzy.config.json'))
  if (command === 'init') {
    const colors = Object.fromEntries(
      ['accent', 'gray', 'warning', 'danger', 'success', 'info']
        .filter((k) => values[k] !== undefined)
        .map((k) => [k, values[k]]),
    )
    const options = Object.fromEntries(
      ['name', 'prefix', 'radius', 'squircle', 'density', 'output']
        .filter((k) => values[k] !== undefined)
        .map((k) => [k, values[k]]),
    )
    const config = resolveConfig({ ...options, colors })
    const outputPath = resolve(dirname(configPath), config.output)
    const schemaPath = fileURLToPath(
      new URL('../../suzy.schema.json', import.meta.url),
    )
    const relativeSchemaPath = relative(dirname(configPath), schemaPath)
    // Reference the bundled schema instead of copying it into the project.
    const schemaReference = isAbsolute(relativeSchemaPath)
      ? pathToFileURL(schemaPath).href
      : `./${relativeSchemaPath.split(sep).map(encodeURIComponent).join('/')}`
    if (new Set([configPath, schemaPath, outputPath]).size !== 3) {
      throw new Error(
        'Configuration, schema, and CSS output must have different paths',
      )
    }
    const theme = createTheme(config)
    await mkdir(dirname(configPath), { recursive: true })
    try {
      await writeFile(
        configPath,
        `${JSON.stringify(
          {
            $schema: schemaReference,
            ...options,
            colors: {
              accent: config.colors.accent,
              gray: config.colors.gray,
              ...colors,
            },
          },
          null,
          2,
        )}\n`,
        { flag: values.force ? 'w' : 'wx' },
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(
          `${configPath} already exists. Use --force to replace it.`,
        )
      }
      throw error
    }
    await writeAtomic(outputPath, renderCss(theme))
    console.log(
      `Created ${configPath}\nCreated ${outputPath}\n\nUse: body { background: var(--${config.prefix}-bg); color: var(--${config.prefix}-text); }\nRun suzy preview to explore your theme.`,
    )
    return
  }
  if (command === 'build') {
    const result = await build(configPath, values.output as string | undefined)
    console.log(
      `${result.changed ? 'Wrote' : 'Unchanged'} ${result.outputPath}`,
    )
    return
  }
  if (command === 'check') {
    // Load independently so all reference errors are printed alongside contrast diagnostics.
    const theme = createTheme(
      resolveConfig(JSON.parse(await readFile(configPath, 'utf8'))),
    )
    const diagnostics = validateTheme(theme)
    for (const d of diagnostics) {
      console.log(`${d.severity.toUpperCase()} [${d.mode}] ${d.message}`)
    }
    const errors = diagnostics.filter((d) => d.severity === 'error').length
    const warnings = diagnostics.filter((d) => d.severity === 'warning').length
    console.log(
      `${errors} errors, ${warnings} warnings. Token checks do not guarantee application accessibility.`,
    )
    if (errors || (values.strict && warnings)) {
      process.exitCode = 1
    }
    return
  }
  let stop: () => Promise<void>
  if (command === 'preview') {
    const port = Number(values.port ?? 3000)
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error('--port must be an integer from 0 to 65535')
    }
    const server = await startPreview(configPath, port)
    console.log(`Preview: ${server.url}`)
    stop = server.close
  } else {
    const rebuild = async () => {
      try {
        const r = await build(configPath, values.output as string | undefined)
        console.log(`${r.changed ? 'Wrote' : 'Unchanged'} ${r.outputPath}`)
      } catch (error) {
        report(error)
      }
    }
    stop = watchConfig(configPath, rebuild, report)
    await rebuild()
    console.log(`Watching ${configPath}`)
  }
  let closing = false
  const shutdown = () => {
    if (closing) {
      return
    }
    closing = true
    void stop().catch(report)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
main().catch((error) => {
  report(error)
  process.exitCode = 1
})
