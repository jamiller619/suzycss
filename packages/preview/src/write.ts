import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  assertDocument,
  mergeRegeneration,
  stableSerialize,
} from './document.js'
import type { PreviewComponent, PreviewDocument } from './types.js'

export async function writeAnalysis(
  path: string,
  generated: PreviewDocument,
): Promise<PreviewDocument> {
  let current: PreviewDocument | undefined
  try {
    current = JSON.parse(await readFile(path, 'utf8')) as PreviewDocument
    assertDocument(current)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (current && hasDeveloperEdits(current))
    throw new Error(
      `${path} contains developer-owned values, states, validators, wrappers, generators, or extensions. Analysis refused to rewrite it until full reconciliation is available. Move it aside or reset those fields to generated values.`,
    )
  const document = current ? mergeRegeneration(current, generated) : generated
  const revisionRead = current?.provenance.revision
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, stableSerialize(document), { flag: 'wx' })
  try {
    if (current) {
      const latest = JSON.parse(await readFile(path, 'utf8')) as PreviewDocument
      assertDocument(latest)
      if (latest.provenance.revision !== revisionRead)
        throw new Error(
          `Revision conflict for ${path}: read ${revisionRead}, found ${latest.provenance.revision}. Reload before saving.`,
        )
    }
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  return document
}

export function hasDeveloperEdits(document: PreviewDocument): boolean {
  if (extensionKeys(document).length) return true
  return document.components.some(componentEdited)
}

function componentEdited(component: PreviewComponent): boolean {
  if (component.wrapper || extensionKeys(component).length) return true
  if (component.states.length !== 1 || component.states[0]?.name !== 'default')
    return true
  if (
    component.states.some(
      (state) => state.values || state.wrapper || extensionKeys(state).length,
    )
  )
    return true
  return Object.values(component.props).some(
    (prop) =>
      prop.value !== undefined ||
      prop.generator !== undefined ||
      prop.validators !== undefined ||
      extensionKeys(prop).length,
  )
}
function extensionKeys(value: object) {
  return Object.keys(value).filter((key) => key.startsWith('x-'))
}
