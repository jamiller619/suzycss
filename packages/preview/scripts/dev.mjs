import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = resolve(packageRoot, 'examples/consumers/react')
const children = new Set()
let stopping = false

function stop(code = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of children) child.kill('SIGTERM')
}

function start(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', ...options })
  children.add(child)
  child.once('error', (error) => {
    console.error(error.message)
    stop(1)
  })
  child.once('exit', (code, signal) => {
    children.delete(child)
    if (!stopping && signal !== 'SIGTERM') stop(code ?? 1)
  })
}

process.once('SIGINT', () => stop())
process.once('SIGTERM', () => stop())

start(
  process.execPath,
  [
    resolve(packageRoot, '../../node_modules/typescript/bin/tsc'),
    '--watch',
    '--preserveWatchOutput',
  ],
  { cwd: packageRoot },
)

start(
  process.execPath,
  [
    '--watch',
    '--watch-preserve-output',
    resolve(packageRoot, 'dist/cli.js'),
    '--config',
    'preview.config.json',
    ...process.argv.slice(2),
  ],
  { cwd: projectRoot },
)
