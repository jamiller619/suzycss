import { spawn } from 'node:child_process'

const children = new Set()
let stopping = false

function stop(code = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of children) child.kill('SIGTERM')
}

function start(args) {
  const child = spawn(process.execPath, args, { stdio: 'inherit' })
  children.add(child)
  child.once('error', (error) => {
    console.error(error.message)
    stop(1)
  })
  child.once('exit', (code) => {
    children.delete(child)
    stop(code ?? 1)
  })
}

process.once('SIGINT', () => stop())
process.once('SIGTERM', () => stop())

start(['node_modules/typescript/bin/tsc', '--watch', '--preserveWatchOutput'])
start([
  'node_modules/typescript/bin/tsc',
  '-p',
  'packages/components/tsconfig.json',
  '--watch',
  '--preserveWatchOutput',
])
start([
  '--watch',
  '--watch-preserve-output',
  'dist/cli/main.js',
  'preview',
  ...process.argv.slice(2),
])
