import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { analyzeProject } from './analysis.js'
import { resolveOptions } from './config.js'
import { assertDocument } from './document.js'
import { writeAnalysis } from './write.js'

export const help = `suzy-preview — local component previews without story files

Usage: suzy-preview [options]

  --config <path>    JSON configuration path
  --root <path>      Project root (default: nearest package.json)
  --input <path>     Source entry file or directory
  --output <path>    Output directory (default: <project-root>/.preview)
  --validate <path>  Validate an intermediate preview document
  --dry-run          Analyze without writing preview.json
  --help, -h         Show help

CLI paths are relative to the invocation directory. Config values are relative
to the config file. Precedence: CLI > config > default.`

export async function runCommand(args: string[], cwd: string): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      config: { type: 'string' },
      root: { type: 'string' },
      input: { type: 'string' },
      output: { type: 'string' },
      validate: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  })
  if (values.help) return help
  if (positionals.length)
    throw new Error(`Unexpected arguments: ${positionals.join(' ')}`)
  if (values.validate) {
    const path = resolve(cwd, values.validate)
    assertDocument(JSON.parse(await readFile(path, 'utf8')) as unknown)
    return `Valid ${path}`
  }
  const options = await resolveOptions({
    cwd,
    root: values.root,
    config: values.config,
    input: values.input,
    output: values.output,
  })
  const generated = await analyzeProject(options)
  if (!values['dry-run']) await writeAnalysis(options.data, generated)
  return `Project: ${options.projectRoot}\nInput: ${relative(options.projectRoot, options.input) || '.'}\nData: ${options.data}\nRuntime: ${options.runtime}\nComponents: ${generated.components.length}${values['dry-run'] ? ' (not written)' : ''}`
}
