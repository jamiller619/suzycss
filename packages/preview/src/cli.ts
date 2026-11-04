#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { runCommand } from './command.js'
import { resolveOptions } from './config.js'
import { startPreviewServer } from './server.js'

async function main() {
  const args = process.argv.slice(2)
  if (args[0] !== 'serve') {
    console.log(await runCommand(args, process.cwd()))
    return
  }
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      root: { type: 'string' },
      input: { type: 'string' },
      output: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
    },
  })
  if (positionals.length)
    throw new Error(`Unexpected serve arguments: ${positionals.join(' ')}`)
  const port = Number(values.port ?? 3000)
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('--port must be an integer from 0 to 65535')
  const options = await resolveOptions({
    cwd: process.cwd(),
    config: values.config,
    root: values.root,
    input: values.input,
    output: values.output,
  })
  const server = await startPreviewServer(options, {
    port,
    host: values.host,
  })
  console.log(`Preview: ${server.url}`)
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await server.close()
    process.exitCode = 0
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}
main().catch((error: unknown) => {
  console.error(`suzy-preview: ${(error as Error).message}`)
  process.exitCode = 1
})
