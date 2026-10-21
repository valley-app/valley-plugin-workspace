/**
 * The Workspace plugin's data layer for named layouts.
 *
 * A `WorkspaceStore` owns the saved-layout list in `workspaces.json` and the
 * active-layout name (the `ACTIVE` badge, persisted via `api.settings`). It is
 * anchored in session-scoped `api.runtime`, so a mid-session hot reload replaces
 * rather than strands the in-memory list. The panel subscribes; commands mutate through the
 * same primitives, so both surfaces stay in sync.
 *
 * Groups come from two places and `groups()` merges them: every layout's `group`
 * field and the explicit groups in `workspaces.json`. That is what lets
 * an empty group exist before a layout is saved into it.
 */
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { WorkspaceLayoutSnapshot } from '@valley/plugin-sdk/types'
import { WorkspaceLayoutState, availableSnapshot, projectSnapshot, scopesOf, structuralSnapshotKey, type LayoutScope, type LayoutScopes } from './layoutState'
import { WorkspaceRepository, WORKSPACES_FILE, dedupeGroups, normalizeLayout, type SavedLayout } from './repository'
export type { SavedLayout } from './repository'
export { structuralSnapshotKey, layoutCounts, scopesOf, LAYOUT_SCOPES, type LayoutScope, type LayoutScopes } from './layoutState'
import { api as runtimeApi, initRuntime } from './runtime'
import { uiText } from './localization'

/** What one group rename moved, so its inverse restores the exact prior strings. */
export interface GroupRenameReceipt {
  to: string
  layouts: { name: string; group: string }[]
  declared: string | null
}

/** What one group delete removed, so its inverse restores the exact prior strings and position. */
export interface GroupDeleteReceipt {
  group: string
  layouts: { name: string; group: string }[]
  declared: { spelling: string; index: number } | null
}

/** A refusal raised before anything changed, so the bus can report a known no-effect outcome. */
export function notApplied(message: string, code: string): Error {
  return Object.assign(new Error(message), { code, outcome: 'not-applied' as const })
}

const STORE_KEY = 'workspace.store'
const ACTIVE_SETTING = 'active'
export class WorkspaceStore {
  layouts: SavedLayout[] = []
  /** Groups created on their own; they stay listed while they hold no layout. */
  declaredGroups: string[] = []
  active: string | null = null
  private loadRevision = 0
  private loaded = false
  private disposed = false
  private refreshRevision = 0
  private refreshPromise: Promise<void> | null = null
  private readonly repository: WorkspaceRepository
  private readonly listeners = new Set<() => void>()
  private readonly cleanups: (() => void)[] = []
  private readonly layoutState: WorkspaceLayoutState
  private projection: {
    layouts: SavedLayout[]
    declaredGroups: string[]
    byName: Map<string, SavedLayout>
    groups: { group: string; layouts: SavedLayout[] }[]
    groupNames: string[]
    groupKeys: Set<string>
  } | null = null

  constructor(private readonly api: ValleyPluginApi) {
    this.layoutState = new WorkspaceLayoutState(api)
    this.repository = new WorkspaceRepository(api, () => this.notify())
    this.cleanups.push(api.runtime.onBeforeUnload(() => this.repository.drain()))
    this.cleanups.push(api.settings.subscribe(() => this.notify()))
    const refresh = (): void => { if (this.loaded || this.refreshPromise) void this.refresh() }
    this.cleanups.push(api.data.files.onChanged(path => { if (path === WORKSPACES_FILE) refresh() }))
  }

  dispose(): void {
    this.disposed = true
    this.loadRevision++
    this.api.workspace.applyLayout(null)
    this.cleanups.splice(0).forEach((off) => off())
    this.listeners.clear()
  }

  /** Load the persisted list + active name once (idempotent). */
  ensureLoaded(): Promise<void> {
    if (this.loaded || this.disposed) return Promise.resolve()
    return this.refreshPromise ?? this.refresh()
  }

  /** Re-read the list from disk (e.g. another window mutated it). */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.refreshRevision++
    if (this.refreshPromise) return this.refreshPromise
    const pending = this.readLatest().finally(() => {
      if (this.refreshPromise === pending) this.refreshPromise = null
    })
    this.refreshPromise = pending
    void pending.catch(() => {})
    return pending
  }

  private async readLatest(): Promise<void> {
    while (!this.disposed) {
      const writes = this.repository.pending
      await writes
      if (this.disposed || this.repository.failure) return
      if (writes !== this.repository.pending) continue
      const revision = this.refreshRevision
      const result = await this.repository.read().then(
        value => ({ value }),
        error => ({ error })
      )
      if (this.disposed) return
      if (revision !== this.refreshRevision || writes !== this.repository.pending) continue
      if ('error' in result) throw result.error
      this.layouts = result.value.layouts
        .map((r) => normalizeLayout(r as unknown as Record<string, unknown>))
        .filter((l): l is SavedLayout => l !== null)
        .sort((a, b) => a.name.localeCompare(b.name))
      this.declaredGroups = dedupeGroups(result.value.groups.map(name => name.trim()))
      const priorActive = this.active
      const settingActive = this.api.settings.get()[ACTIVE_SETTING]
      this.active = typeof settingActive === 'string' && this.find(settingActive) ? settingActive : null
      const firstLoad = !this.loaded
      this.loaded = true
      if (firstLoad && this.active) {
        const loadRevision = this.loadRevision + 1
        if (!await this.loadByName(this.active, { keepLiveMain: true }) && loadRevision === this.loadRevision) await this.setActive(null)
      }
      else if (!this.active && (priorActive || settingActive)) await this.setActive(null)
      else if (firstLoad && !this.active) this.api.workspace.applyLayout(null)
      this.notify()
      if (revision === this.refreshRevision) return
    }
  }

  private indexed() {
    if (this.projection?.layouts === this.layouts && this.projection.declaredGroups === this.declaredGroups) return this.projection
    const byName = new Map<string, SavedLayout>()
    for (const layout of this.layouts) {
      const key = layout.name.toLowerCase()
      if (!byName.has(key)) byName.set(key, layout)
    }
    const byGroup = new Map<string, SavedLayout[]>()
    const labels = new Map<string, string>()
    const bucket = (raw: string): string => {
      const key = raw.toLowerCase()
      if (!byGroup.has(key)) {
        byGroup.set(key, [])
        labels.set(key, raw)
      }
      return key
    }
    for (const declared of this.declaredGroups) if (declared) bucket(declared)
    for (const l of this.layouts) byGroup.get(bucket(l.group.trim()))?.push(l)
    const groups = [...byGroup.entries()]
      .map(([key, layouts]) => ({ group: labels.get(key) ?? key, layouts }))
      .sort((a, b) => (a.group === '' ? 1 : b.group === '' ? -1 : a.group.localeCompare(b.group)))
    const groupNames = groups.map(group => group.group).filter(group => group !== '')
    return this.projection = {
      layouts: this.layouts, declaredGroups: this.declaredGroups, byName, groups, groupNames,
      groupKeys: new Set(groupNames.map(group => group.toLowerCase()))
    }
  }

  find(name: string): SavedLayout | undefined { return this.indexed().byName.get(name.trim().toLowerCase()) }

  groups(): { group: string; layouts: SavedLayout[] }[] { return this.indexed().groups }

  groupNames(): string[] { return this.indexed().groupNames }

  hasGroup(name: string): boolean {
    const key = name.trim().toLowerCase()
    return key !== '' && this.indexed().groupKeys.has(key)
  }

  /**
   * Create a group with no layouts in it — the panel's "New group". Throws on a
   * blank name or one that is already taken; returns the trimmed name.
   */
  async createGroup(name: string): Promise<string> {
    const next = name.trim()
    if (!next) throw notApplied('A group name is required.', 'INVALID_INPUT')
    if (this.hasGroup(next)) throw notApplied(`A group named "${next}" already exists.`, 'GROUP_EXISTS')
    this.declaredGroups = [...this.declaredGroups, next]
    await this.persist()
    return next
  }

  /**
   * Drop a group: its declaration goes and every layout in it falls back to
   * ungrouped. Returns a receipt of exactly what changed, for `revertGroupDelete`.
   */
  async deleteGroup(name: string): Promise<GroupDeleteReceipt> {
    const key = name.trim().toLowerCase()
    if (!key) throw notApplied('A group name is required.', 'INVALID_INPUT')
    if (!this.hasGroup(key)) throw notApplied(`No group named "${name.trim()}".`, 'NOT_FOUND')
    const index = this.declaredGroups.findIndex((g) => g.trim().toLowerCase() === key)
    const receipt: GroupDeleteReceipt = {
      group: this.groups().find((g) => g.group.toLowerCase() === key)?.group ?? name.trim(),
      layouts: this.layouts.filter((l) => l.group.trim().toLowerCase() === key).map((l) => ({ name: l.name, group: l.group })),
      declared: index === -1 ? null : { spelling: this.declaredGroups[index], index }
    }
    this.declaredGroups = this.declaredGroups.filter((g) => g.trim().toLowerCase() !== key)
    this.layouts = this.layouts.map((l) => (l.group.trim().toLowerCase() === key ? { ...l, group: '' } : l))
    await this.persist()
    return receipt
  }

  /**
   * Undo one `deleteGroup` in a single persist: the declaration returns at its
   * prior position (only if there was one), and every layout it ungrouped that is
   * still ungrouped gets its exact prior group string back. Refuses (before any
   * change) if a group of that name exists again, or if nothing is left to restore.
   */
  async revertGroupDelete(receipt: GroupDeleteReceipt): Promise<void> {
    if (this.hasGroup(receipt.group)) throw notApplied(`A group named "${receipt.group.trim()}" already exists.`, 'GROUP_EXISTS')
    const prior = new Map(receipt.layouts.map((l) => [l.name.toLowerCase(), l.group]))
    let restored = 0
    const layouts = this.layouts.map((l) => {
      const group = prior.get(l.name.toLowerCase())
      if (group === undefined || l.group.trim() !== '') return l
      restored++
      return { ...l, group }
    })
    if (restored === 0 && receipt.declared === null) {
      throw notApplied(`Nothing from group "${receipt.group.trim()}" is left to restore.`, 'NOT_FOUND')
    }
    if (receipt.declared !== null) {
      const declaredGroups = [...this.declaredGroups]
      declaredGroups.splice(Math.min(receipt.declared.index, declaredGroups.length), 0, receipt.declared.spelling)
      this.declaredGroups = declaredGroups
    }
    this.layouts = layouts
    await this.persist()
  }

  /**
   * Undo one `createGroup`: drop exactly the declaration it added and nothing
   * else, so layouts saved into the group since keep their membership. Refuses
   * (before any change) if that declaration is no longer there.
   */
  async revertGroupCreate(name: string): Promise<void> {
    const index = this.declaredGroups.indexOf(name)
    if (index === -1) throw notApplied(`Group "${name}" is no longer declared.`, 'NOT_FOUND')
    this.declaredGroups = this.declaredGroups.filter((_, i) => i !== index)
    await this.persist()
  }

  capture(scopes?: LayoutScopes): WorkspaceLayoutSnapshot { return this.layoutState.capture(scopes) }
  captureForSave(scopes: LayoutScopes, _prior?: WorkspaceLayoutSnapshot): WorkspaceLayoutSnapshot { return this.layoutState.captureForSave(scopes) }
  defaultScopes(): LayoutScopes { return this.layoutState.defaultScopes() }
  isCurrent(snapshot: WorkspaceLayoutSnapshot): boolean { return this.layoutState.isCurrent(snapshot) }
  applySnapshot(snapshot: WorkspaceLayoutSnapshot): void { this.layoutState.applySnapshot(snapshot) }

  /**
   * Capture the live arrangement and save it under `name`, then make it active.
   * Replacing an existing layout keeps its group and its saved parts unless the
   * caller names new ones; a new layout starts from the settings' defaults.
   */
  async saveCurrent(name: string, group?: string, scopes?: LayoutScopes): Promise<SavedLayout> {
    const prior = this.find(name)
    const now = Date.now()
    const chosen = scopes ?? (prior ? scopesOf(prior.snapshot) : this.defaultScopes())
    const layout: SavedLayout = {
      name,
      group: group?.trim() || prior?.group || '',
      snapshot: this.captureForSave(chosen, prior?.snapshot),
      createdAt: prior?.createdAt ?? now,
      modifiedAt: now
    }
    await this.upsert(layout)
    await this.setActive(name)
    return layout
  }

  /** Copy a layout under the first free "<name> copy" name; the copy stays inactive. */
  async duplicate(name: string, copyLabel: (base: string, n: number) => string): Promise<SavedLayout> {
    const source = this.find(name)
    if (!source) throw new Error(`No saved layout named "${name}".`)
    let n = 1
    let next = copyLabel(source.name, n)
    while (this.find(next)) next = copyLabel(source.name, ++n)
    const now = Date.now()
    const copy: SavedLayout = { ...source, name: next, createdAt: now, modifiedAt: now }
    await this.upsert(copy)
    return copy
  }

  /**
   * Add or drop one optional part of a saved layout. Adding captures that part
   * from the live workspace; dropping removes it, so loading the layout uses
   * the default settings for that part.
   */
  async setScope(name: string, scope: LayoutScope, included: boolean): Promise<SavedLayout> {
    const prior = this.find(name)
    if (!prior) throw new Error(`No saved layout named "${name}".`)
    const kept = projectSnapshot(prior.snapshot, { ...scopesOf(prior.snapshot), [scope]: included })
    const snapshot = included ? this.layoutState.withLivePart(kept, scope) : kept
    const next: SavedLayout = { ...prior, snapshot, modifiedAt: Date.now() }
    await this.upsert(next)
    return next
  }

  /** Re-capture any saved layout from the live workspace, keeping its parts and group. */
  replaceWithCurrent(name: string): Promise<SavedLayout> {
    const target = this.find(name)
    if (!target) return Promise.reject(new Error(`No saved layout named "${name}".`))
    return this.saveCurrent(target.name, target.group)
  }

  /**
   * Restore a saved layout into the live workspace (the panel's Load). The
   * startup restore of the active layout keeps the main panes and tabs that the
   * host already restored from its session and applies only the layout's chrome.
   */
  async loadByName(name: string, options: { keepLiveMain?: boolean } = {}): Promise<SavedLayout | null> {
    const target = this.find(name)
    if (!target) throw new Error(`No saved layout named "${name}".`)
    const revision = ++this.loadRevision
    const checked = availableSnapshot(target.snapshot, await this.api.workspace.listPlugins())
    if (this.disposed || revision !== this.loadRevision) return null
    let layout = target
    if (checked.missing.length) {
      const choice = await this.api.ui.confirm({
        title: uiText('workspace.missing.title'),
        message: uiText('workspace.missing.message', { plugins: checked.missing.join(', ') }),
        actions: [{ label: uiText('workspace.missing.continue'), value: 'continue', variant: 'primary' }]
      })
      const current = this.find(name)
      if (choice !== 'continue' || this.disposed || revision !== this.loadRevision || !current || structuralSnapshotKey(current.snapshot) !== structuralSnapshotKey(target.snapshot)) return null
      layout = { ...target, snapshot: checked.snapshot, modifiedAt: Date.now() }
      await this.upsert(layout)
    }
    if (this.disposed || revision !== this.loadRevision) return null
    if (options.keepLiveMain) {
      const live = this.capture()
      this.applySnapshot({ ...layout.snapshot, layout: live.layout, activePaneId: live.activePaneId })
    } else this.applySnapshot(layout.snapshot)
    await this.setActive(layout.name, false)
    return layout
  }


  /** Insert or replace a layout by name, then persist + notify. */
  async upsert(layout: SavedLayout): Promise<void> {
    let owned: SavedLayout
    try { owned = JSON.parse(JSON.stringify(layout)) }
    catch (error) { return this.repository.reject(error) }
    const next = this.layouts.filter((l) => l.name.toLowerCase() !== owned.name.toLowerCase())
    next.push(owned)
    next.sort((a, b) => a.name.localeCompare(b.name))
    this.layouts = next
    await this.persist()
  }

  /** Remove a layout by name (no-op if absent), then persist + notify. */
  async deleteByName(name: string): Promise<void> {
    const key = name.trim().toLowerCase()
    this.layouts = this.layouts.filter((l) => l.name.toLowerCase() !== key)
    if (this.active && this.active.toLowerCase() === key) await this.setActive(null)
    await this.persist()
  }

  /**
   * Rename a saved layout, preserving its group/createdAt/snapshot and moving the
   * `ACTIVE` pointer if it pointed at the old name. Throws if `oldName` is absent
   * or `newName` collides with a *different* existing layout. Returns the prior
   * entry so a caller can register a revert.
   */
  async renameByName(oldName: string, newName: string): Promise<SavedLayout> {
    const prior = this.find(oldName)
    if (!prior) throw notApplied(`No saved layout named "${oldName}".`, 'NOT_FOUND')
    const next = newName.trim()
    if (!next) throw notApplied('A new name is required.', 'INVALID_INPUT')
    const clash = this.find(next)
    if (clash && clash.name.toLowerCase() !== prior.name.toLowerCase()) {
      throw notApplied(`A layout named "${next}" already exists.`, 'LAYOUT_EXISTS')
    }
    const renamed: SavedLayout = { ...prior, name: next, modifiedAt: Date.now() }
    const wasActive = this.active != null && this.active.toLowerCase() === prior.name.toLowerCase()
    this.layouts = this.layouts
      .filter((l) => l.name.toLowerCase() !== prior.name.toLowerCase())
      .concat(renamed)
      .sort((a, b) => a.name.localeCompare(b.name))
    if (wasActive) await this.setActive(next, false)
    await this.persist()
    return prior
  }

  /** Move a saved layout into (or out of, with `''`) a group — the ⋯ menu's "Add to Group". */
  async setGroup(name: string, group: string): Promise<void> {
    const key = name.trim().toLowerCase()
    const idx = this.layouts.findIndex((l) => l.name.toLowerCase() === key)
    if (idx === -1) throw new Error(`No saved layout named "${name}".`)
    this.layouts = this.layouts.map((layout, index) => index === idx ? { ...layout, group: group.trim() } : layout)
    await this.persist()
  }

  /**
   * Rename a group, moving every layout currently in `oldGroup` to `newGroup`
   * in one batch (a single persist/notify, unlike calling `setGroup` per layout)
   * and carrying the declaration across so an empty group can be renamed too.
   * A case-only rename re-spells every layout and the declaration in place.
   * No-op (null) if nothing would change; throws (before any change) if
   * `newGroup` is blank or already names a *different* group — renaming onto an
   * existing group would merge the two in a way no inverse can separate again.
   * Returns a receipt of exactly what moved, for `revertGroupRename`.
   */
  async renameGroup(oldGroup: string, newGroup: string): Promise<GroupRenameReceipt | null> {
    const from = oldGroup.trim().toLowerCase()
    const to = newGroup.trim()
    if (!to) throw notApplied('A new group name is required.', 'INVALID_INPUT')
    // A case-only rename re-spells the group in place: the new name is the same group.
    const respell = from === to.toLowerCase()
    if (!respell && this.hasGroup(to)) throw notApplied(`A group named "${to}" already exists.`, 'GROUP_EXISTS')
    const receipt: GroupRenameReceipt = { to, layouts: [], declared: null }
    this.layouts = this.layouts.map((l) => {
      if (l.group.trim().toLowerCase() !== from || l.group === to) return l
      receipt.layouts.push({ name: l.name, group: l.group })
      return { ...l, group: to }
    })
    const declared = this.declaredGroups.find((g) => g.trim().toLowerCase() === from)
    if (declared !== undefined && declared !== to) {
      receipt.declared = declared
      this.declaredGroups = dedupeGroups(this.declaredGroups.map((g) => (g.trim().toLowerCase() === from ? to : g)))
    }
    if (receipt.layouts.length === 0 && receipt.declared === null) return null
    await this.persist()
    return receipt
  }

  /**
   * Undo one `renameGroup`: every layout it moved that is still in the new group
   * gets its exact prior group string back, and the declaration returns to its
   * prior spelling in place. Refuses (before any change) if the old name has
   * since been taken by another group, since restoring would merge into it, or
   * if nothing it renamed is left in the new group.
   */
  async revertGroupRename(receipt: GroupRenameReceipt): Promise<void> {
    const toKey = receipt.to.toLowerCase()
    const original = (receipt.declared ?? receipt.layouts[0]?.group ?? '').trim()
    if (original && original.toLowerCase() !== toKey && this.hasGroup(original)) {
      throw notApplied(`A group named "${original}" already exists.`, 'GROUP_EXISTS')
    }
    const prior = new Map(receipt.layouts.map((l) => [l.name.toLowerCase(), l.group]))
    let changed = false
    this.layouts = this.layouts.map((l) => {
      const group = prior.get(l.name.toLowerCase())
      if (group === undefined || l.group.trim().toLowerCase() !== toKey) return l
      changed = true
      return { ...l, group }
    })
    const declared = receipt.declared
    if (declared !== null && this.declaredGroups.some((g) => g.trim().toLowerCase() === toKey)) {
      this.declaredGroups = this.declaredGroups.map((g) => (g.trim().toLowerCase() === toKey ? declared : g))
      changed = true
    }
    if (!changed) throw notApplied(`Nothing renamed to "${receipt.to}" is left to restore.`, 'NOT_FOUND')
    await this.persist()
  }

  async setActive(name: string | null, apply = true): Promise<void> {
    const layout = name ? this.find(name) : undefined
    this.loadRevision++
    if (apply) {
      if (layout) this.applySnapshot(layout.snapshot)
      else this.api.workspace.applyLayout(null)
    }
    this.active = layout?.name ?? null
    await this.api.settings.set(ACTIVE_SETTING, this.active ?? '')
    this.notify()
  }

  private persist(): Promise<void> { return this.repository.save(this.layouts, this.declaredGroups) }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(): void {
    if (this.disposed) return
    this.listeners.forEach((l) => l())
  }
}

/**
 * Replace the one session-scoped store with a fresh instance for the given
 * `api`. Called from `register()` on every (re)load — a hot reload drops the
 * previous instance rather than stranding open views on it.
 */
export function createStore(api: ValleyPluginApi): WorkspaceStore {
  initRuntime(api)
  const holder = api.runtime.getOrCreate<{ current: WorkspaceStore | null }>(STORE_KEY, () => ({ current: null }))
  holder.current?.dispose()
  const store = new WorkspaceStore(api)
  holder.current = store
  return store
}

/** The live store, or null before `register()` has run. */
export function getStore(): WorkspaceStore | null {
  return runtimeApi.runtime.getOrCreate<{ current: WorkspaceStore | null }>(STORE_KEY, () => ({ current: null })).current
}
