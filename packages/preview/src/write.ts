import { dirname } from 'node:path'
import { DocumentStore } from './persistence.js'
import type { PreviewComponent, PreviewDocument } from './types.js'

export async function writeAnalysis(
  path: string,
  generated: PreviewDocument,
  options: { baselinesDir?: string; projectRoot?: string } = {},
): Promise<PreviewDocument> {
  const store = new DocumentStore({
    dataPath: path,
    baselinesDir: options.baselinesDir ?? `${dirname(path)}/baselines`,
    projectRoot: options.projectRoot,
  })
  return (await store.regenerate(generated)).document
}

export function hasDeveloperEdits(document: PreviewDocument): boolean {
  if (extensionKeys(document).length) return true
  return document.components.some(componentEdited)
}

function componentEdited(component: PreviewComponent): boolean {
  if (component.wrapper || extensionKeys(component).length) return true
  if (
    component.states.some((state) => state.generated !== true) &&
    (component.states.length !== 1 || component.states[0]?.name !== 'default')
  )
    return true
  if (
    component.states.some(
      (state) =>
        (state.values && state.generated !== true) ||
        state.wrapper ||
        extensionKeys(state).length,
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
