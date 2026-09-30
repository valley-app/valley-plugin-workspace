import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { FileBaseline, WorkspaceLayoutSnapshot } from '@valley/plugin-sdk/types'
import { storedSnapshot } from './layoutState'

export interface SavedLayout {
  name: string
  /** Optional group label; empty string means ungrouped. */
  group: string
  snapshot: WorkspaceLayoutSnapshot
  createdAt: number
  modifiedAt: number
}

export const WORKSPACES_FILE = 'workspaces.json'

export interface WorkspaceDocument {
  version: 1
  layouts: SavedLayout[]
  groups: string[]
}

function parseDocument(content: string | null): WorkspaceDocument {
  if (content === null) return { version: 1, layouts: [], groups: [] }
  const document = JSON.parse(content)
  if (!document || document.version !== 1 || !Array.isArray(document.layouts) || !Array.isArray(document.groups)
    || document.groups.some((group: unknown) => typeof group !== 'string')
    || document.layouts.some((layout: unknown) => !layout || typeof layout !== 'object' || !normalizeLayout(layout as Record<string, unknown>))) {
    throw new Error('Invalid workspace file. Restore a valid workspaces.json before saving.')
  }
  return document
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key)
    && sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}

export class WorkspaceRepository {
  pending: Promise<void> = Promise.resolve()
  failure: { reason: unknown } | null = null
  private baseline: FileBaseline | null = null
  private document: WorkspaceDocument | null = null
  private revision = 0

  constructor(private readonly api: ValleyPluginApi, private readonly notify: () => void) {}

  async drain(): Promise<void> {
    let pending: Promise<void>
    do { pending = this.pending; await pending } while (pending !== this.pending)
    if (this.failure) throw this.failure.reason
  }

  async read(): Promise<WorkspaceDocument> {
    const revision = ++this.revision
    const file = await this.api.data.files.readTextBaseline(WORKSPACES_FILE)
    const document = parseDocument(file?.content ?? null)
    if (revision === this.revision) {
      this.baseline = file?.baseline ?? null
      this.document = document
    }
    return document
  }

  save(layouts: SavedLayout[], groups: string[]): Promise<void> {
    let captured: WorkspaceDocument | { error: unknown }
    try {
      captured = JSON.parse(JSON.stringify({ version: 1, layouts: layouts.map(layout => ({ ...layout, snapshot: storedSnapshot(layout.snapshot) })), groups }))
    } catch (error) { captured = { error } }
    return this.enqueue(async () => {
      if ('error' in captured) throw captured.error
      for (const names of [captured.layouts.map(layout => layout.name), captured.groups]) {
        if (new Set(names).size !== names.length) throw new Error('Duplicate Workspace record name')
      }
      if (!this.document) await this.read()
      if (!sameValue(this.document, captured)) {
        this.revision++
        const result = await this.api.data.files.writeTextGuarded(WORKSPACES_FILE, JSON.stringify(captured, null, 2) + '\n', this.baseline)
        if (!result.ok) throw new Error(result.reason === 'conflict'
          ? 'Workspaces changed in another window. Reload the plugin before saving again.'
          : 'Unable to save workspaces.json. Try saving again.')
        this.baseline = result.baseline
        this.document = captured
      }
      this.notify()
    })
  }

  reject(error: unknown): Promise<void> { return this.enqueue(async () => { throw error }) }

  private enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.pending.then(run, run)
    this.pending = next.then(
      () => { this.failure = null },
      (reason) => { this.failure = { reason } }
    )
    return next
  }
}

/** Keep the first spelling of each group name, drop blanks and case-twins. */
export function dedupeGroups(names: string[]): string[] {
  const seen = new Set<string>()
  return names.filter((name) => {
    const key = name.toLowerCase()
    if (!name || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function normalizeLayout(record: Record<string, unknown>): SavedLayout | null {
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const snapshot = record.snapshot
  if (!name || !snapshot || typeof snapshot !== 'object') return null
  const now = Date.now()
  return {
    name,
    group: typeof record.group === 'string' ? record.group : '',
    snapshot: storedSnapshot(snapshot as WorkspaceLayoutSnapshot),
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : now,
    modifiedAt: typeof record.modifiedAt === 'number' ? record.modifiedAt : now
  }
}
