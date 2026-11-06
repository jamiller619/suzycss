import { randomBytes } from 'node:crypto'
import { type Dirent, type FSWatcher, watch as watchDirectory } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import {
  type Alias,
  createServer as createViteServer,
  type Plugin,
  type ViteDevServer,
} from 'vite'
import { analyzeProject } from './analysis.js'
import type { PreviewOptions } from './config.js'
import { assertDocument } from './document.js'
import { generateDocumentMocks } from './mock.js'
import { DocumentStore, validateDocumentSemantics } from './persistence.js'
import { reconcileDocuments } from './reconcile.js'
import type { PreviewDocument } from './types.js'

export interface PreviewServer {
  url: string
  close: () => Promise<void>
  store: DocumentStore
}
export interface PreviewServerOptions {
  port?: number
  host?: string
}

const runtimeId = 'virtual:suzy-preview-runtime'
const resolvedRuntimeId = `\0${runtimeId}`
const shellId = 'virtual:suzy-preview-shell'
const resolvedShellId = `\0${shellId}`
const sourcePattern = /\.[cm]?[jt]sx?$/

export async function startPreviewServer(
  options: PreviewOptions,
  serverOptions: PreviewServerOptions = {},
): Promise<PreviewServer> {
  const token = randomBytes(24).toString('hex')
  const packageRuntime = dirname(fileURLToPath(import.meta.url))
  const host = serverOptions.host ?? '127.0.0.1'
  const port =
    serverOptions.port === 0
      ? await availablePort(host)
      : (serverOptions.port ?? 3000)
  const store = new DocumentStore({
    dataPath: options.data,
    baselinesDir: options.baselines,
    projectRoot: options.projectRoot,
  })
  let activeDocument = await initialDocument(options, store)
  let vite: ViteDevServer
  let analysisTimer: NodeJS.Timeout | undefined
  let analysisRunning = false
  let analysisQueued = false
  let closed = false
  let runtimeVersion = 0
  const fileTimers = new Map<string, NodeJS.Timeout>()

  const updateRuntime = () => {
    runtimeVersion++
    const module = vite.moduleGraph.getModuleById(resolvedRuntimeId)
    if (module) vite.moduleGraph.invalidateModule(module)
  }
  const broadcast = (event: string, data: unknown) =>
    vite.ws.send({ type: 'custom', event, data })
  const activateDiskDocument = async () => {
    const result = await store.read()
    if (result.status === 'valid' && result.document) {
      activeDocument = result.document
      updateRuntime()
      broadcast('suzy:config', {
        revision: activeDocument.provenance.revision,
      })
      return
    }
    broadcast('suzy:diagnostic', {
      message:
        result.error?.message ??
        `Preview document is ${result.status}; the last valid document remains active.`,
    })
  }
  const analyze = async () => {
    if (analysisRunning) {
      analysisQueued = true
      return
    }
    analysisRunning = true
    try {
      const analyzed = await analyzeProject(options)
      const mocked = await generateDocumentMocks(analyzed, {
        projectRoot: options.projectRoot,
      })
      mocked.document.diagnostics.push(...mocked.diagnostics)
      const result = await store.regenerate(mocked.document)
      if (result.reconciliation.conflicts.length) {
        broadcast('suzy:diagnostic', {
          message: `Source reconciliation produced ${result.reconciliation.conflicts.length} conflict(s). The last valid document remains active.`,
        })
      } else {
        activeDocument = result.document
        updateRuntime()
        broadcast('suzy:config', {
          revision: activeDocument.provenance.revision,
        })
      }
    } catch (error) {
      broadcast('suzy:diagnostic', { message: (error as Error).message })
    } finally {
      analysisRunning = false
      if (analysisQueued) {
        analysisQueued = false
        void analyze()
      }
    }
  }
  const scheduleAnalysis = () => {
    if (analysisTimer) clearTimeout(analysisTimer)
    analysisTimer = setTimeout(() => void analyze(), 100)
  }

  const plugin: Plugin = {
    name: 'heysuzy-preview-runtime',
    resolveId(id) {
      if (id === runtimeId) return resolvedRuntimeId
      if (id === shellId) return resolvedShellId
    },
    load(id) {
      if (id === resolvedRuntimeId)
        return runtimeModule(
          activeDocument,
          options.projectRoot,
          runtimeVersion,
        )
      if (id === resolvedShellId) return shellModule(token, packageRuntime)
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://preview.local')
        if (request.method === 'GET' && url.pathname === '/') {
          sendHtml(response, shellHtml())
          return
        }
        if (request.method === 'GET' && url.pathname === '/__preview/frame') {
          sendHtml(response, frameHtml())
          return
        }
        if (
          request.method === 'GET' &&
          url.pathname === '/__preview/api/document'
        ) {
          const disk = await store.read()
          sendJson(response, 200, {
            document: activeDocument,
            etag: disk.etag,
            revision: activeDocument.provenance.revision,
            diskStatus: disk.status,
          })
          return
        }
        if (
          request.method === 'POST' &&
          url.pathname === '/__preview/api/validate'
        ) {
          if (!validMutationRequest(request, token)) {
            sendJson(response, 403, {
              error: 'Forbidden validation origin or token.',
            })
            return
          }
          try {
            const body = (await readJsonBody(request, 2_000_000)) as {
              document: PreviewDocument
            }
            assertDocument(body.document)
            const diagnostics = await validateDocumentSemantics(
              body.document,
              options.projectRoot,
            )
            sendJson(response, 200, {
              valid: diagnostics.length === 0,
              diagnostics,
            })
          } catch (error) {
            sendJson(response, 200, {
              valid: false,
              diagnostics: [
                {
                  severity: 'error',
                  code: 'document-invalid',
                  path: '$',
                  message: (error as Error).message,
                },
              ],
            })
          }
          return
        }
        if (
          request.method === 'POST' &&
          url.pathname === '/__preview/api/regenerate'
        ) {
          if (!validMutationRequest(request, token)) {
            sendJson(response, 403, {
              error: 'Forbidden regeneration origin or token.',
            })
            return
          }
          try {
            const body = (await readJsonBody(request, 2_000_000)) as {
              document: PreviewDocument
              paths?: string[]
            }
            assertDocument(body.document)
            const result = await generateDocumentMocks(body.document, {
              projectRoot: options.projectRoot,
              paths: body.paths,
            })
            sendJson(response, 200, result)
          } catch (error) {
            sendJson(response, 400, { error: (error as Error).message })
          }
          return
        }
        if (
          request.method === 'POST' &&
          url.pathname === '/__preview/api/merge-draft'
        ) {
          if (!validMutationRequest(request, token)) {
            sendJson(response, 403, {
              error: 'Forbidden merge origin or token.',
            })
            return
          }
          try {
            const body = (await readJsonBody(request, 4_000_000)) as {
              baseline: PreviewDocument
              draft: PreviewDocument
            }
            assertDocument(body.baseline)
            assertDocument(body.draft)
            const result = await reconcileDocuments(
              body.baseline,
              body.draft,
              activeDocument,
              options.projectRoot,
            )
            sendJson(response, 200, result)
          } catch (error) {
            sendJson(response, 400, { error: (error as Error).message })
          }
          return
        }
        if (
          request.method === 'PUT' &&
          url.pathname === '/__preview/api/document'
        ) {
          if (!validMutationRequest(request, token)) {
            sendJson(response, 403, {
              error: 'Forbidden mutation origin or token.',
            })
            return
          }
          try {
            const body = (await readJsonBody(request, 2_000_000)) as {
              document: PreviewDocument
              revision: number
              etag: string
            }
            const saved = await store.saveEditable(body.document, {
              revision: body.revision,
              etag: body.etag,
            })
            activeDocument = saved.document
            updateRuntime()
            broadcast('suzy:config', {
              revision: activeDocument.provenance.revision,
            })
            sendJson(response, 200, {
              document: saved.document,
              etag: saved.etag,
              changed: saved.changed,
              externalWriteBoundary: saved.externalWriteBoundary,
            })
          } catch (error) {
            sendJson(response, 409, { error: (error as Error).message })
          }
          return
        }
        next()
      })
    },
  }

  vite = await createViteServer({
    root: options.projectRoot,
    appType: 'custom',
    plugins: [plugin],
    esbuild: { jsx: 'automatic' },
    resolve: { alias: await tsconfigAliases(options.projectRoot) },
    server: {
      host: serverOptions.host ?? '127.0.0.1',
      port,
      strictPort: false,
      fs: {
        allow: [options.projectRoot, dirname(options.data), packageRuntime],
      },
    },
  })
  const watch = async (file: string) => {
    if (closed) return
    if (resolve(file) === resolve(options.data)) {
      try {
        const raw = await readFile(options.data, 'utf8')
        if (store.isOwnWrite(raw)) return
      } catch {
        // The read path below reports deletion or malformed content.
      }
      await activateDiskDocument()
      return
    }
    if (!inside(options.projectRoot, file) || inside(options.output, file))
      return
    const projectPath = relative(options.projectRoot, file).split(sep).join('/')
    if (/(^|\/)(?:node_modules|dist|build|coverage)(?:\/|$)/.test(projectPath))
      return
    if (/\.(?:css|scss|sass|less|styl|stylus)$/.test(file)) {
      updateRuntime()
      broadcast('suzy:config', {
        revision: activeDocument.provenance.revision,
        reason: 'style-change',
      })
      return
    }
    if (sourcePattern.test(file)) {
      vite.moduleGraph.onFileChange(file)
      if (webComponentFile(activeDocument, options.projectRoot, file))
        broadcast('suzy:web-reload', {
          file: relative(options.projectRoot, file),
        })
      else
        broadcast('suzy:config', {
          revision: activeDocument.provenance.revision,
          reason: 'source-change',
        })
    }
    if (
      sourcePattern.test(file) ||
      ['tsconfig.json', 'package.json'].includes(projectPath)
    )
      scheduleAnalysis()
  }
  vite.watcher.on('change', watch)
  vite.watcher.on('add', watch)
  vite.watcher.on('unlink', watch)
  await vite.listen()
  const fallbackWatcher = await watchProjectTree(
    options.projectRoot,
    options.output,
    options.data,
    (file) => {
      const previous = fileTimers.get(file)
      if (previous) clearTimeout(previous)
      fileTimers.set(
        file,
        setTimeout(() => {
          fileTimers.delete(file)
          void watch(file)
        }, 50),
      )
    },
  )
  const address = vite.httpServer?.address()
  const listeningPort =
    typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://${host}:${listeningPort}`,
    store,
    close: async () => {
      closed = true
      if (analysisTimer) clearTimeout(analysisTimer)
      for (const timer of fileTimers.values()) clearTimeout(timer)
      fallbackWatcher.close()
      vite.watcher.off('change', watch)
      vite.watcher.off('add', watch)
      vite.watcher.off('unlink', watch)
      await vite.close()
    },
  }
}

async function watchProjectTree(
  root: string,
  output: string,
  dataPath: string,
  onChange: (file: string) => void,
): Promise<{ close: () => void }> {
  const watchers = new Map<string, FSWatcher>()
  let closed = false
  const ignored = new Set(['node_modules', '.git', 'dist', 'build', 'coverage'])
  const add = async (directory: string): Promise<void> => {
    if (closed || watchers.has(directory) || inside(output, directory)) return
    let entries: Dirent<string>[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    const watcher = watchDirectory(directory, (event, name) => {
      if (!name) return
      const file = resolve(directory, name.toString())
      onChange(file)
      if (event === 'rename') void add(file)
    })
    watcher.on('error', () => watcher.close())
    watchers.set(directory, watcher)
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !ignored.has(entry.name) &&
            !inside(output, resolve(directory, entry.name)),
        )
        .map((entry) => add(resolve(directory, entry.name))),
    )
  }
  await add(root)
  const dataDirectory = dirname(dataPath)
  if (!watchers.has(dataDirectory)) {
    const dataWatcher = watchDirectory(dataDirectory, (_event, name) => {
      if (!name) return
      const file = resolve(dataDirectory, name.toString())
      if (file === resolve(dataPath)) onChange(file)
    })
    dataWatcher.on('error', () => dataWatcher.close())
    watchers.set(dataDirectory, dataWatcher)
  }
  return {
    close: () => {
      closed = true
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    },
  }
}

async function availablePort(host: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => (error ? reject(error) : resolvePort(port)))
    })
  })
}

async function initialDocument(
  options: PreviewOptions,
  store: DocumentStore,
): Promise<PreviewDocument> {
  const disk = await store.read()
  if (disk.status === 'valid' && disk.document) return disk.document
  if (disk.status !== 'missing')
    throw new Error(
      `Cannot start preview with ${disk.status} ${options.data}: ${disk.error?.message ?? 'correct the document first'}`,
    )
  const analyzed = await analyzeProject(options)
  const mocked = await generateDocumentMocks(analyzed, {
    projectRoot: options.projectRoot,
  })
  mocked.document.diagnostics.push(...mocked.diagnostics)
  return (await store.regenerate(mocked.document)).document
}

async function tsconfigAliases(root: string): Promise<Alias[]> {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists)
  if (!configPath) return []
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile)
  if (loaded.error) return []
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  )
  const base = resolve(dirname(configPath), parsed.options.baseUrl ?? '.')
  const aliases: Alias[] = []
  for (const [pattern, targets] of Object.entries(parsed.options.paths ?? {})) {
    const target = targets[0]
    if (!target) continue
    if (!pattern.includes('*'))
      aliases.push({ find: pattern, replacement: resolve(base, target) })
    else {
      const escaped = pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('(.*)')
      aliases.push({
        find: new RegExp(`^${escaped}$`),
        replacement: resolve(base, target.replace('*', '$1')),
      })
    }
  }
  return aliases
}

function runtimeModule(
  document: PreviewDocument,
  root: string,
  version: number,
): string {
  const styles = (document.runtime?.styles ?? [])
    .map(
      (path) =>
        `import ${JSON.stringify(`${moduleUrl(root, path)}?suzy=${version}`)}`,
    )
    .join('\n')
  const reactMount = document.components.some(
    (component) => component.framework === 'react',
  )
    ? `async function mountReact(component, state, config) {
  const [{ default: React }, { createRoot }] = await Promise.all([import('react'), import('react-dom/client')])
  const module = await import(/* @vite-ignore */ pathUrl(component.import.path))
  const Component = module[component.import.export]
  if (!Component) throw new Error('Missing component export ' + component.import.export)
  const props = await resolvedProps(component, state, React)
  const references = [...(config.runtime?.providers ?? []), config.runtime?.wrapper, component.wrapper, state?.wrapper].filter(Boolean)
  const wrappers = await Promise.all(references.map(imported))
  let child = React.createElement(Component, props)
  for (let index = wrappers.length - 1; index >= 0; index--) child = React.createElement(wrappers[index], null, child)
  class Boundary extends React.Component {
    constructor(props) { super(props); this.state = { error: null } }
    static getDerivedStateFromError(error) { return { error } }
    componentDidCatch(error) { post('error', { message: error.message, stack: error.stack, componentId: component.id }) }
    render() { return this.state.error ? React.createElement('pre', { className: 'preview-error' }, this.state.error.message) : this.props.children }
  }
  const reactRoot = createRoot(rootNode)
  reactRoot.render(React.createElement(Boundary, null, child))
  cleanup = () => reactRoot.unmount()
}`
    : `async function mountReact() { throw new Error('React is not configured in this preview document') }`
  return `${styles}
const CHANNEL = 'heysuzy-preview'
const VERSION = 1
const PROJECT_ROOT = ${JSON.stringify(root.split(sep).join('/'))}
let cleanup = () => {}
const rootNode = document.querySelector('#root')

function safe(value, depth = 0, seen = new WeakSet()) {
  if (depth > 5) return '[Max depth]'
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return typeof value === 'string' && value.length > 2000 ? value.slice(0, 2000) + '…' : value
  if (typeof value === 'bigint') return String(value) + 'n'
  if (typeof value === 'function') return '[Function]'
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (value instanceof Event) return { type: value.type, detail: safe(value.detail, depth + 1, seen), target: value.target?.tagName }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => safe(item, depth + 1, seen))
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, safe(item, depth + 1, seen)]))
}
function post(type, payload) {
  parent.postMessage({ channel: CHANNEL, version: VERSION, type, payload: safe(payload) }, location.origin)
}
function pathUrl(path) {
  if (path.startsWith('http:') || path.startsWith('https:') || path.startsWith('/')) return path
  return '/@fs/' + PROJECT_ROOT + '/' + (path.startsWith('./') ? path.slice(2) : path)
}
async function imported(reference) {
  const module = await import(/* @vite-ignore */ pathUrl(reference.path))
  const value = module[reference.export]
  if (value === undefined) throw new Error('Missing export ' + reference.export + ' from ' + reference.path)
  return value
}
async function resolveValue(value, React, path) {
  if (Array.isArray(value)) return Promise.all(value.map((item, index) => resolveValue(item, React, path + '[' + index + ']')))
  if (!value || typeof value !== 'object' || !value.$ref) {
    if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await resolveValue(item, React, path + '.' + key)])))
    return value
  }
  if (value.$ref === 'omit') return OMIT
  if (value.$ref === 'function') return (...args) => post('event', { name: path, args })
  if (value.$ref === 'module') return imported(value)
  if (value.$ref === 'react-node') {
    const props = await resolveValue(value.props ?? {}, React, path + '.props')
    const children = await Promise.all((value.children ?? []).map((item, index) => resolveValue(item, React, path + '.children[' + index + ']')))
    return React.createElement(value.element, props, ...children)
  }
  throw new Error('Unresolved descriptor ' + value.$ref + ' at ' + path)
}
const OMIT = Symbol('omit')
function selectedValues(component, state) {
  return Object.fromEntries(Object.entries(component.props).flatMap(([name, prop]) => {
    const value = state?.values?.[name] ?? prop.value ?? prop.generated ?? prop.default ?? { $ref: 'omit' }
    return [[name, value]]
  }))
}
async function resolvedProps(component, state, React) {
  const entries = []
  for (const [name, value] of Object.entries(selectedValues(component, state))) {
    const resolved = await resolveValue(value, React, component.id + '.' + name)
    if (resolved !== OMIT) entries.push([name, resolved])
  }
  return Object.fromEntries(entries)
}
${reactMount}
async function mountWeb(component, state, config) {
  await import(/* @vite-ignore */ pathUrl(component.import.path))
  const tag = component.source.tagName
  if (!tag || !customElements.get(tag)) throw new Error('Custom element <' + tag + '> was not registered by ' + component.import.path)
  const element = document.createElement(tag)
  const props = await resolvedProps(component, state, null)
  const mapping = config.runtime?.webComponents?.[component.id] ?? {}
  for (const [name, value] of Object.entries(props)) {
    const definition = component.props[name] ?? {}
    const attribute = mapping.attributes?.[name] ?? definition.attribute
    if (mapping.properties?.includes(name) || !attribute) element[name] = value
    else if (typeof value === 'boolean') { if (value) element.setAttribute(attribute, ''); else element.removeAttribute(attribute) }
    else if (value === null || value === undefined) element.removeAttribute(attribute)
    else element.setAttribute(attribute, String(value))
  }
  const listeners = (mapping.events ?? []).map((name) => {
    const listener = (event) => post('event', { name, componentId: component.id, event })
    element.addEventListener(name, listener)
    return [name, listener]
  })
  rootNode.replaceChildren(element)
  cleanup = () => { for (const [name, listener] of listeners) element.removeEventListener(name, listener); element.remove() }
}
async function start() {
  const response = await fetch('/__preview/api/document', { cache: 'no-store' })
  if (!response.ok) throw new Error('Could not load preview document')
  const body = await response.json()
  let config = body.document
  const sessionDraft = localStorage.getItem('heysuzy-preview-valid-draft')
  if (sessionDraft) {
    try { config = JSON.parse(sessionDraft) } catch { localStorage.removeItem('heysuzy-preview-valid-draft') }
  }
  const query = new URLSearchParams(location.search)
  const component = config.components.find((item) => item.id === query.get('component')) ?? config.components[0]
  if (!component) throw new Error('No component selected')
  const state = component.states.find((item) => item.name === query.get('state')) ?? component.states[0]
  if (component.framework === 'react') await mountReact(component, state, config)
  else await mountWeb(component, state, config)
  post('ready', { componentId: component.id, state: state?.name })
}
window.addEventListener('beforeunload', () => cleanup(), { once: true })
if (import.meta.hot) {
  import.meta.hot.on('suzy:web-reload', () => post('reload-required', { reason: 'custom-element-source-change' }))
  import.meta.hot.dispose(() => cleanup())
}
start().catch((error) => {
  rootNode.textContent = ''
  const pre = document.createElement('pre')
  pre.className = 'preview-error'
  pre.textContent = error.stack ?? error.message
  rootNode.append(pre)
  post('error', { message: error.message, stack: error.stack })
})
`
}

function shellModule(token: string, packageRuntime: string): string {
  const client = moduleUrl(packageRuntime, 'explorer-client.js')
  return `globalThis.__SUZY_PREVIEW_TOKEN__ = ${JSON.stringify(token)}; import(${JSON.stringify(client)});`
}

function shellHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Suzy Preview</title><style>
:root{font:14px/1.4 system-ui,sans-serif;color:#18181b;background:#fff;--border:#d4d4d8;--muted:#71717a;--soft:#f4f4f5;--danger:#b42318;--accent:#4338ca}*{box-sizing:border-box}body{margin:0;min-height:100vh}button,input,select,textarea{font:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.app{display:grid;grid-template-columns:15rem minmax(20rem,1fr) 22rem;min-height:100vh}.sidebar,.editor{padding:1rem;overflow:auto}.sidebar{border-right:1px solid var(--border)}.editor{border-left:1px solid var(--border);max-height:100vh}.brand{font-size:1rem;margin:0 0 1rem}.component-button{display:flex;width:100%;border:0;background:transparent;padding:.5rem;border-radius:.25rem;text-align:left;justify-content:space-between}.component-button:hover,.component-button[aria-current=true]{background:var(--soft)}.framework{font-size:.75rem;color:var(--muted)}main{display:grid;grid-template-rows:auto auto minmax(18rem,1fr) auto;gap:.75rem;padding:1rem;min-width:0}.toolbar,.editor-toolbar,.row,.actions{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}.toolbar{justify-content:space-between}.status{font-size:.8rem;color:var(--muted)}.status.dirty{color:#9a3412}.status.saved{color:#166534}.banner,#diagnostics{padding:.6rem;border-radius:.25rem;background:#fff7ed;color:#9a3412;white-space:pre-wrap}.banner[hidden],#diagnostics:empty{display:none}.preview-wrap{min-height:20rem}iframe{border:1px solid var(--border);width:100%;height:100%;min-height:20rem;background:white}.tabs{display:flex;border-bottom:1px solid var(--border);margin-bottom:1rem}.tab{border:0;background:transparent;padding:.5rem .75rem}.tab[aria-selected=true]{border-bottom:2px solid var(--accent);font-weight:600}.prop-card{border-bottom:1px solid var(--border);padding:.75rem 0}.prop-head{display:flex;justify-content:space-between;gap:.5rem}.prop-name{font-weight:600}.badge{font-size:.7rem;border:1px solid var(--border);border-radius:1rem;padding:.1rem .4rem;color:var(--muted)}label{display:block;font-size:.8rem;color:#3f3f46;margin-top:.5rem}input,select,textarea{width:100%;border:1px solid var(--border);border-radius:.25rem;padding:.4rem;background:#fff;color:inherit}input[type=checkbox]{width:auto}textarea{min-height:6rem;font:12px/1.4 ui-monospace,monospace;resize:vertical}.field-error{color:var(--danger);font-size:.78rem;margin:.25rem 0}.secondary{border:1px solid var(--border);background:#fff;border-radius:.25rem;padding:.35rem .55rem}.primary{border:1px solid #3730a3;background:var(--accent);color:#fff;border-radius:.25rem;padding:.4rem .7rem}.danger{color:var(--danger)}button:disabled{cursor:not-allowed;opacity:.5}.json-editor{min-height:55vh}.event-log{max-height:10rem;overflow:auto;font:12px ui-monospace;margin:0;padding-left:1.5rem}.empty{color:var(--muted);font-style:italic}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:1000px){.app{grid-template-columns:13rem 1fr}.editor{grid-column:1/-1;border-left:0;border-top:1px solid var(--border);max-height:none}}@media(max-width:650px){.app{display:block}.sidebar{border-right:0;border-bottom:1px solid var(--border)}main{min-height:70vh}.editor{border-left:0}}
</style></head><body><div class="app"><aside class="sidebar"><h1 class="brand">Suzy Preview</h1><nav id="components" aria-label="Components"></nav></aside><main><div id="external-banner" class="banner" hidden></div><div class="toolbar"><div class="row"><label for="state-select" class="sr-only">Preview state</label><select id="state-select" aria-label="Preview state"></select><input id="new-state-name" aria-label="New state name" placeholder="New state name"><button id="save-state" class="secondary" type="button">Save state</button></div><div class="actions"><span id="save-status" class="status saved">Saved</span><button id="regenerate-component" class="secondary" type="button">Regenerate unpinned</button><button id="save-document" class="primary" type="button">Save</button></div></div><div id="diagnostics" role="status" aria-live="polite"></div><div class="preview-wrap"><iframe id="preview-frame" title="Component preview" sandbox="allow-scripts allow-same-origin"></iframe></div><details><summary>Callbacks and events</summary><ol id="events" class="event-log"></ol></details></main><aside class="editor"><div class="tabs" role="tablist"><button id="controls-tab" class="tab" role="tab" aria-selected="true" type="button">Controls</button><button id="json-tab" class="tab" role="tab" aria-selected="false" type="button">JSON</button></div><section id="controls-panel" role="tabpanel"><div id="props"></div></section><section id="json-panel" role="tabpanel" hidden><label for="json-editor">Intermediate document</label><textarea id="json-editor" class="json-editor" spellcheck="false"></textarea><div id="json-errors" class="field-error"></div><div class="actions"><button id="apply-json" class="secondary" type="button">Validate and apply</button></div></section></aside></div><script type="module" src="/@id/${shellId}"></script></body></html>`
}
function frameHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>html,body,#root{min-height:100%;margin:0}.preview-error{color:#b42318;white-space:pre-wrap;padding:1rem}</style></head><body><div id="root"></div><script type="module" src="/@id/${runtimeId}"></script></body></html>`
}
function moduleUrl(root: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(root, path)
  return `/@fs/${absolute.split(sep).join('/')}`
}
function webComponentFile(
  document: PreviewDocument,
  root: string,
  file: string,
): boolean {
  return document.components.some(
    (component) =>
      component.framework === 'web-component' &&
      [component.source.path, component.import.path].some(
        (path) => resolve(root, path) === resolve(file),
      ),
  )
}
function validMutationRequest(
  request: import('node:http').IncomingMessage,
  token: string,
): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    return (
      new URL(origin).host === host &&
      request.headers['x-suzy-token'] === token &&
      request.headers['content-type']?.startsWith('application/json') === true
    )
  } catch {
    return false
  }
}
async function readJsonBody(
  request: import('node:http').IncomingMessage,
  limit: number,
): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error(`Request body exceeds ${limit} bytes.`)
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
function sendHtml(response: import('node:http').ServerResponse, body: string) {
  response.statusCode = 200
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(body)
}
function sendJson(
  response: import('node:http').ServerResponse,
  status: number,
  value: unknown,
) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(value))
}
function inside(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child))
  return value === '' || (!value.startsWith('..') && !value.startsWith(sep))
}
