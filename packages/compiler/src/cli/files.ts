import { randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import {
  createTheme,
  renderCss,
  resolveConfig,
  validateTheme,
} from '../core/compiler.js'

export async function loadTheme(configPath: string, output?: string) {
  let input: unknown
  try {
    input = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read ${configPath}: ${(error as Error).message}`)
  }
  const config = resolveConfig(input)
  const outputPath = resolve(dirname(configPath), output ?? config.output)
  if (outputPath === resolve(configPath)) {
    throw new Error('config.output must not overwrite the configuration file')
  }
  const theme = createTheme(config)
  const diagnostics = validateTheme(theme)
  const errors = diagnostics.filter((d) => d.severity === 'error')
  if (errors.length) {
    throw new Error(errors.map((d) => `${d.mode}: ${d.message}`).join('\n'))
  }
  return { config, theme, diagnostics, css: renderCss(theme), outputPath }
}
export async function writeAtomic(
  path: string,
  content: string,
): Promise<boolean> {
  try {
    if ((await readFile(path, 'utf8')) === content) {
      return false
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return true
}
export async function build(configPath: string, output?: string) {
  const result = await loadTheme(configPath, output)
  const changed = await writeAtomic(result.outputPath, result.css)
  return { ...result, changed }
}
/** Watch the directory, not its replaceable inode. Serialize rebuilds and debounce saves. */
export function watchConfig(
  path: string,
  onChange: () => Promise<void>,
  onError: (error: Error) => void,
): () => Promise<void> {
  let timer: NodeJS.Timeout | undefined
  let running = Promise.resolve()
  let closed = false
  const watcher = watch(dirname(path), (_event, file) => {
    if (file !== null && file.toString() !== basename(path)) {
      return
    }
    clearTimeout(timer)
    timer = setTimeout(() => {
      running = running
        .then(async () => {
          if (!closed) {
            await onChange()
          }
        })
        .catch(onError)
    }, 100)
  })
  watcher.on('error', onError)
  return async () => {
    closed = true
    clearTimeout(timer)
    watcher.close()
    await running
  }
}
