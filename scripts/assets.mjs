import { copyFile, mkdir } from 'node:fs/promises'

await mkdir(new URL('../dist/core/', import.meta.url), { recursive: true })
await copyFile(
  new URL('../src/core/base.css', import.meta.url),
  new URL('../dist/core/base.css', import.meta.url),
)
await mkdir(new URL('../dist/preview/', import.meta.url), { recursive: true })
await copyFile(
  new URL('../assets/logo.svg', import.meta.url),
  new URL('../dist/preview/logo.svg', import.meta.url),
)
for (const file of [
  'page.html',
  'specimen.html',
  'components.html',
  'surface.html',
]) {
  await copyFile(
    new URL(`../src/preview/${file}`, import.meta.url),
    new URL(`../dist/preview/${file}`, import.meta.url),
  )
}
