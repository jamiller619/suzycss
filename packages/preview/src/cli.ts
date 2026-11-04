#!/usr/bin/env node
import { runCommand } from './command.js'

async function main() {
  console.log(await runCommand(process.argv.slice(2), process.cwd()))
}
main().catch((error: unknown) => {
  console.error(`suzy-preview: ${(error as Error).message}`)
  process.exitCode = 1
})
