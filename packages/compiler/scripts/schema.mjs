import { writeFile } from 'node:fs/promises'
import { configSchema } from '../dist/core/config.js'

await writeFile(
  new URL('../suzy.schema.json', import.meta.url),
  `${JSON.stringify(configSchema, null, 2)}\n`,
)
