import { access, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export interface PreviewOptions {
  projectRoot: string
  input: string
  output: string
  data: string
  runtime: string
  configPath?: string
}
interface FileConfig {
  root?: string
  input?: string
  output?: string
}
const exists = async (path: string) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function findProjectRoot(start: string): Promise<string> {
  let cursor = resolve(start)
  for (;;) {
    if (await exists(join(cursor, 'package.json'))) return cursor
    const parent = dirname(cursor)
    if (parent === cursor)
      throw new Error(
        `Cannot find package.json from ${start}; pass --root <project-directory>`,
      )
    cursor = parent
  }
}
export async function resolveOptions(cli: {
  cwd: string
  root?: string
  config?: string
  input?: string
  output?: string
}): Promise<PreviewOptions> {
  const invocation = resolve(cli.cwd)
  const configPath = cli.config ? resolve(invocation, cli.config) : undefined
  let file: FileConfig = {}
  if (configPath)
    file = JSON.parse(await readFile(configPath, 'utf8')) as FileConfig
  const configBase = configPath ? dirname(configPath) : invocation
  const projectRoot = resolve(
    cli.root
      ? resolve(invocation, cli.root)
      : file.root
        ? resolve(configBase, file.root)
        : await findProjectRoot(invocation),
  )
  const input = cli.input
    ? resolve(invocation, cli.input)
    : file.input
      ? resolve(configBase, file.input)
      : await discoverEntry(projectRoot)
  const output = cli.output
    ? resolve(invocation, cli.output)
    : file.output
      ? resolve(configBase, file.output)
      : join(projectRoot, '.preview')
  return {
    projectRoot,
    input,
    output,
    data: join(output, 'preview.json'),
    runtime: join(output, 'runtime'),
    configPath,
  }
}
export async function discoverEntry(root: string): Promise<string> {
  const pkg = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ) as Record<string, unknown>
  const groups: Array<[string, string[]]> = [
    ['package source', strings(pkg.source)],
    ['exports source/import/default', exportStrings(pkg.exports)],
    ['module', strings(pkg.module)],
    ['main', strings(pkg.main)],
    [
      'conventional source entry',
      ['src/index.tsx', 'src/index.ts', 'src/index.jsx', 'src/index.js'],
    ],
  ]
  const considered: string[] = []
  for (const [label, mappings] of groups) {
    const candidates = [
      ...new Set(
        mappings.filter(supportedMapping).map((item) => resolve(root, item)),
      ),
    ]
    considered.push(...candidates)
    const found: string[] = []
    for (const candidate of candidates)
      if ((await exists(candidate)) && (await stat(candidate)).isFile())
        found.push(candidate)
    if (found.length === 1) return found[0] as string
    if (found.length > 1)
      throw new Error(
        `Ambiguous ${label}:\n${found.map((item) => `  ${relative(root, item)}`).join('\n')}\nPass --input <file-or-directory>.`,
      )
  }
  throw new Error(
    `No supported project entry found. Candidates checked:\n${considered.map((item) => `  ${relative(root, item)}`).join('\n')}\nPass --input <file-or-directory>.`,
  )
}
const strings = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : []
function exportStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const record = value as Record<string, unknown>
  const selected = ['source', 'import', 'default'].flatMap((key) =>
    strings(record[key]),
  )
  return selected.length
    ? selected
    : Object.keys(record)
        .sort()
        .flatMap((key) => (key === '.' ? exportStrings(record[key]) : []))
}
const supportedMapping = (value: string) =>
  /\.(?:[cm]?[jt]sx?)$/.test(value) &&
  !value.includes('*') &&
  !isAbsolute(value)
