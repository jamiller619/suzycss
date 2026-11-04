import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { assertDocument, stableSerialize } from './document.js'
import { validateComponentState } from './mock.js'
import { type ReconciliationResult, reconcileDocuments } from './reconcile.js'
import type { MockDiagnostic, PreviewDocument } from './types.js'

export class StaleDocumentError extends Error {}
export class InvalidDiskDocumentError extends Error {}
export class ExternalWriteConflictError extends Error {}

export interface AtomicWriteHooks {
  afterTemporaryWrite?: (temporaryPath: string) => void | Promise<void>
  beforeRename?: (temporaryPath: string) => void | Promise<void>
}
export interface StoreReadResult {
  status: 'valid' | 'invalid' | 'conflicted' | 'missing'
  document?: PreviewDocument
  lastValid?: PreviewDocument
  etag?: string
  error?: Error
  diagnostics?: MockDiagnostic[]
}
export interface SaveResult {
  document: PreviewDocument
  etag: string
  changed: boolean
  externalWriteBoundary: string
}
export interface RegenerationResult extends SaveResult {
  reconciliation: ReconciliationResult
}

const boundary =
  'Writes are serialized inside this process and compare both revision and byte etag immediately before atomic rename. External editors do not share the lock; a write racing after that final comparison is detected by post-write verification when observable and is never reported as a merged save.'
let temporaryCounter = 0

export class DocumentStore {
  readonly dataPath: string
  readonly baselinesDir: string
  readonly projectRoot?: string
  private lastValid?: PreviewDocument
  private lastWrittenEtag?: string
  private queue: Promise<void> = Promise.resolve()

  constructor(options: {
    dataPath: string
    baselinesDir?: string
    projectRoot?: string
  }) {
    this.dataPath = options.dataPath
    this.baselinesDir =
      options.baselinesDir ?? join(dirname(options.dataPath), 'baselines')
    this.projectRoot = options.projectRoot
  }

  async read(): Promise<StoreReadResult> {
    try {
      const raw = await readFile(this.dataPath, 'utf8')
      const etag = digest(raw)
      let document: PreviewDocument
      try {
        document = JSON.parse(raw) as PreviewDocument
        assertDocument(document)
      } catch (error) {
        return {
          status: 'invalid',
          lastValid: this.lastValid,
          etag,
          error: error as Error,
        }
      }
      if (document.conflicts?.length) {
        return {
          status: 'conflicted',
          document,
          lastValid: this.lastValid,
          etag,
        }
      }
      const diagnostics = await validateDocumentSemantics(
        document,
        this.projectRoot,
      )
      if (diagnostics.length) {
        return {
          status: 'invalid',
          document,
          lastValid: this.lastValid,
          etag,
          diagnostics,
          error: new InvalidDiskDocumentError(
            `Document has ${diagnostics.length} value validation error(s).`,
          ),
        }
      }
      this.lastValid = structuredClone(document)
      return { status: 'valid', document, lastValid: document, etag }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { status: 'missing', lastValid: this.lastValid }
      throw error
    }
  }

  async saveEditable(
    proposed: PreviewDocument,
    expected: { revision: number; etag: string },
    hooks?: AtomicWriteHooks,
  ): Promise<SaveResult> {
    return this.exclusive(async () => {
      const disk = await this.requireValidDisk()
      if (
        disk.document.provenance.revision !== expected.revision ||
        disk.etag !== expected.etag
      )
        throw new StaleDocumentError(
          `Stale save: expected revision ${expected.revision} and etag ${expected.etag}, found revision ${disk.document.provenance.revision} and etag ${disk.etag}. Reload before saving.`,
        )
      assertDocument(proposed)
      const semantic = await validateDocumentSemantics(
        proposed,
        this.projectRoot,
      )
      if (semantic.length)
        throw new InvalidDiskDocumentError(
          `Proposed document is invalid:\n${semantic.map((item) => `  ${item.path}: ${item.message}`).join('\n')}`,
        )
      if (proposed.conflicts?.length)
        throw new InvalidDiskDocumentError(
          'Proposed document still contains reconciliation conflicts.',
        )
      if (sameIgnoringSaveRevision(proposed, disk.document))
        return {
          document: disk.document,
          etag: disk.etag,
          changed: false,
          externalWriteBoundary: boundary,
        }
      const document: PreviewDocument = {
        ...structuredClone(proposed),
        provenance: {
          ...proposed.provenance,
          baseline: disk.document.provenance.baseline,
          baseRevision: disk.document.provenance.revision,
          revision: disk.document.provenance.revision + 1,
        },
      }
      const raw = stableSerialize(document)
      await atomicReplace(this.dataPath, raw, disk.etag, hooks)
      const etag = await verifyWritten(this.dataPath, raw)
      this.lastWrittenEtag = etag
      this.lastValid = structuredClone(document)
      return {
        document,
        etag,
        changed: true,
        externalWriteBoundary: boundary,
      }
    })
  }

  async regenerate(
    generated: PreviewDocument,
    hooks?: AtomicWriteHooks,
  ): Promise<RegenerationResult> {
    return this.exclusive(async () => {
      assertDocument(generated)
      const generatedSemantic = await validateDocumentSemantics(
        generated,
        this.projectRoot,
      )
      if (generatedSemantic.length)
        throw new InvalidDiskDocumentError(
          `New generated baseline is invalid:\n${generatedSemantic.map((item) => `  ${item.path}: ${item.message}`).join('\n')}`,
        )
      const baselineRaw = stableSerialize(generated)
      const fingerprint = digest(baselineRaw)
      const baselinePath = join(this.baselinesDir, `${fingerprint}.json`)
      const disk = await this.readStructuralDisk()
      if (
        disk.status === 'valid' &&
        disk.document.provenance.baseline?.fingerprint === fingerprint
      ) {
        const semantic = await validateDocumentSemantics(
          disk.document,
          this.projectRoot,
        )
        if (semantic.length)
          throw new InvalidDiskDocumentError(
            'The editable document is invalid. It was left untouched for correction.',
          )
        const reconciliation: ReconciliationResult = {
          document: disk.document,
          conflicts: disk.document.conflicts ?? [],
          orphans: disk.document.orphans ?? [],
        }
        return {
          document: disk.document,
          reconciliation,
          etag: disk.etag,
          changed: false,
          externalWriteBoundary: boundary,
        }
      }
      await writeImmutableBaseline(baselinePath, baselineRaw)
      if (disk.status === 'missing') {
        const document = withBaseline(generated, fingerprint)
        const raw = stableSerialize(document)
        await atomicReplace(this.dataPath, raw, undefined, hooks)
        const etag = await verifyWritten(this.dataPath, raw)
        this.lastWrittenEtag = etag
        this.lastValid = structuredClone(document)
        const reconciliation = { document, conflicts: [], orphans: [] }
        return {
          document,
          reconciliation,
          etag,
          changed: true,
          externalWriteBoundary: boundary,
        }
      }
      if (disk.status === 'invalid')
        throw new InvalidDiskDocumentError(
          'The editable document is malformed or structurally invalid. It was left untouched for correction.',
        )
      const reference = disk.document.provenance.baseline
      if (!reference)
        throw new InvalidDiskDocumentError(
          'The editable document has no generated baseline reference. Automatic reconciliation is unsafe; preserve or migrate it manually.',
        )
      const oldBaseline = await this.loadBaseline(reference.fingerprint)
      const reconciliation = await reconcileDocuments(
        oldBaseline,
        disk.document,
        generated,
        this.projectRoot,
      )
      const mergedSemantic = await validateDocumentSemantics(
        reconciliation.document,
        this.projectRoot,
      )
      for (const item of mergedSemantic) {
        if (
          reconciliation.conflicts.some(
            (existing) => existing.path === item.path,
          )
        )
          continue
        const review = {
          path: item.path,
          code: 'reconciled-state-invalid',
          message: `The preserved complete state requires review: ${item.message}`,
        }
        reconciliation.conflicts.push(review)
        reconciliation.document.conflicts = [
          ...(reconciliation.document.conflicts ?? []),
          review,
        ]
        reconciliation.document.diagnostics.push({
          severity: 'warning',
          code: review.code,
          message: review.message,
          path: review.path,
        })
      }
      const document = withBaseline(reconciliation.document, fingerprint)
      const raw = stableSerialize(document)
      await atomicReplace(this.dataPath, raw, disk.etag, hooks)
      const etag = await verifyWritten(this.dataPath, raw)
      this.lastWrittenEtag = etag
      if (!reconciliation.conflicts.length)
        this.lastValid = structuredClone(document)
      return {
        document,
        reconciliation: { ...reconciliation, document },
        etag,
        changed: true,
        externalWriteBoundary: boundary,
      }
    })
  }

  isOwnWrite(rawOrEtag: string): boolean {
    const etag = /^[a-f0-9]{64}$/.test(rawOrEtag)
      ? rawOrEtag
      : digest(rawOrEtag)
    return etag === this.lastWrittenEtag
  }

  getLastValid(): PreviewDocument | undefined {
    return this.lastValid ? structuredClone(this.lastValid) : undefined
  }

  private async loadBaseline(fingerprint: string): Promise<PreviewDocument> {
    if (!/^[a-f0-9]{64}$/.test(fingerprint))
      throw new InvalidDiskDocumentError('Invalid baseline fingerprint.')
    const path = join(this.baselinesDir, `${fingerprint}.json`)
    if (!inside(this.baselinesDir, path))
      throw new InvalidDiskDocumentError('Baseline path escapes its directory.')
    const raw = await readFile(path, 'utf8')
    if (digest(raw) !== fingerprint)
      throw new InvalidDiskDocumentError(
        `Generated baseline ${fingerprint} failed its content hash check.`,
      )
    const document = JSON.parse(raw) as PreviewDocument
    assertDocument(document)
    return document
  }

  private async requireValidDisk(): Promise<{
    document: PreviewDocument
    etag: string
  }> {
    const disk = await this.readStructuralDisk()
    if (disk.status !== 'valid')
      throw new InvalidDiskDocumentError(
        'The editable document is missing, malformed, or structurally invalid.',
      )
    const semantic = await validateDocumentSemantics(
      disk.document,
      this.projectRoot,
    )
    if (semantic.length || disk.document.conflicts?.length)
      throw new InvalidDiskDocumentError(
        'The editable document is invalid or conflicted and was left untouched.',
      )
    return disk
  }

  private async readStructuralDisk(): Promise<
    | { status: 'missing' }
    | { status: 'invalid'; error: Error; etag: string }
    | { status: 'valid'; document: PreviewDocument; etag: string }
  > {
    try {
      const raw = await readFile(this.dataPath, 'utf8')
      const etag = digest(raw)
      try {
        const document = JSON.parse(raw) as PreviewDocument
        assertDocument(document)
        return { status: 'valid', document, etag }
      } catch (error) {
        return { status: 'invalid', error: error as Error, etag }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { status: 'missing' }
      throw error
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue
    let release: () => void = () => undefined
    this.queue = new Promise<void>((resolveQueue) => {
      release = resolveQueue
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

export async function atomicReplace(
  path: string,
  content: string,
  expectedEtag?: string,
  hooks: AtomicWriteHooks = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${temporaryCounter++}`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await hooks.afterTemporaryWrite?.(temporary)
    const actualEtag = await diskEtag(path)
    if (actualEtag !== expectedEtag)
      throw new ExternalWriteConflictError(
        `File changed before atomic replacement: expected ${expectedEtag ?? 'no file'}, found ${actualEtag ?? 'no file'}.`,
      )
    await hooks.beforeRename?.(temporary)
    const finalEtag = await diskEtag(path)
    if (finalEtag !== expectedEtag)
      throw new ExternalWriteConflictError(
        `File changed immediately before atomic replacement: expected ${expectedEtag ?? 'no file'}, found ${finalEtag ?? 'no file'}.`,
      )
    await rename(temporary, path)
    try {
      const directory = await open(dirname(path), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch {
      // Some platforms do not support syncing directory handles; rename remains atomic.
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function writeImmutableBaseline(path: string, content: string) {
  try {
    const existing = await readFile(path, 'utf8')
    if (existing !== content)
      throw new InvalidDiskDocumentError(
        `Content-addressed baseline collision at ${path}.`,
      )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await atomicReplace(path, content, undefined)
  }
}
export async function validateDocumentSemantics(
  document: PreviewDocument,
  projectRoot?: string,
): Promise<MockDiagnostic[]> {
  const diagnostics: MockDiagnostic[] = []
  for (const component of document.components)
    for (const state of component.states)
      diagnostics.push(
        ...(await validateComponentState(component, state, projectRoot)),
      )
  return diagnostics.filter((item) => item.severity === 'error')
}
function withBaseline(
  document: PreviewDocument,
  fingerprint: string,
): PreviewDocument {
  return {
    ...structuredClone(document),
    provenance: {
      ...document.provenance,
      baseline: {
        fingerprint,
        path: `baselines/${fingerprint}.json`,
      },
    },
  }
}
async function verifyWritten(path: string, expected: string): Promise<string> {
  const actual = await readFile(path, 'utf8')
  if (actual !== expected)
    throw new ExternalWriteConflictError(
      'The file changed before post-write verification; the save is not reported as successful.',
    )
  return digest(actual)
}
async function diskEtag(path: string): Promise<string | undefined> {
  try {
    await stat(path)
    return digest(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
function sameIgnoringSaveRevision(
  left: PreviewDocument,
  right: PreviewDocument,
): boolean {
  const normalize = (document: PreviewDocument) => ({
    ...document,
    provenance: {
      ...document.provenance,
      revision: 0,
      baseRevision: 0,
    },
  })
  return stableSerialize(normalize(left)) === stableSerialize(normalize(right))
}
function inside(parent: string, child: string): boolean {
  const value = relative(parent, child)
  return value === '' || (!value.startsWith('..') && !value.startsWith(sep))
}
