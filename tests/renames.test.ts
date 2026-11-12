import { describe, expect, it, vi } from 'vitest'
import type { WorkflowTab, WorkspaceLayoutSnapshot } from '@valley/plugin-sdk/types'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { createStore } from '../src/store'
import type { SavedLayout } from '../src/repository'

const filePath = '.valley/plugins/data/workspace/workspaces.json'
const pdf = 'ETH/goodnotes/semester1/chemie/series/serie-8_chemie.pdf'

function snapshot(tabs: WorkflowTab[], right?: WorkflowTab[]): WorkspaceLayoutSnapshot {
  return {
    layout: { type: 'leaf', id: 'pane-1', tabs, activeTabId: tabs[0]?.id ?? null },
    activePaneId: 'pane-1',
    leftSidebarWidth: 260,
    leftSidebarVisible: true,
    ...(right ? { rightSidebarVisible: true, rightSidebarLayout: { type: 'leaf' as const, id: 'right-1', tabs: right, activeTabId: right[0].id } } : {})
  }
}

function layout(name: string, value: WorkspaceLayoutSnapshot): SavedLayout {
  return { name, group: '', snapshot: value, createdAt: 1, modifiedAt: 1 }
}

async function setup(layouts: SavedLayout[]) {
  const mock = createMockValleyApi({ manifest: { id: 'workspace' }, files: { [filePath]: JSON.stringify({ version: 1, layouts, groups: [] }) } })
  const store = createStore(mock.api)
  await store.ensureLoaded()
  const saved = async (): Promise<SavedLayout[]> => JSON.parse(await mock.api.data.files.readText('workspaces.json') ?? '{}').layouts
  const tabsOf = async (name: string, side: 'layout' | 'rightSidebarLayout' = 'layout') => {
    const node = (await saved()).find(entry => entry.name === name)!.snapshot[side]!
    return node.type === 'leaf' ? node.tabs : []
  }
  return { mock, store, saved, tabsOf }
}

describe('saved layouts follow in-app renames and moves', () => {
  it('rewrites every saved layout when a parent folder is renamed', async () => {
    const { mock, store, tabsOf } = await setup([
      layout('chemie', snapshot([
        { id: 't1', folderPath: pdf, viewState: { pdfPage: 3 }, recentTargets: [{ kind: 'file', folderPath: 'ETH/goodnotes/semester1/chemie/notes.md' }, { kind: 'plugin', pluginId: 'graphView' }], historyIndex: 1 },
        { id: 't2', folderPath: 'ETH/goodnotes/semester10/other.md' },
        { id: 't3', folderPath: 'ETH/goodnotes/semester1', kind: 'file' },
        { id: 't4', folderPath: '', kind: 'plugin', pluginId: 'calendar' }
      ], [{ id: 'r1', folderPath: pdf }])),
      layout('ai-society', snapshot([{ id: 't5', folderPath: 'ETH/goodnotes/semester1/chemie/notes.md' }]))
    ])
    mock.emitFileRenamed('ETH/goodnotes/semester1', 'ETH/goodnotes/semester-1')
    await vi.waitFor(async () => expect((await tabsOf('ai-society'))[0].folderPath).toBe('ETH/goodnotes/semester-1/chemie/notes.md'))
    const tabs = await tabsOf('chemie')
    expect(tabs.map(tab => tab.folderPath)).toEqual(['ETH/goodnotes/semester-1/chemie/series/serie-8_chemie.pdf', 'ETH/goodnotes/semester10/other.md', 'ETH/goodnotes/semester-1', ''])
    expect(tabs[0].viewState).toEqual({ pdfPage: 3 })
    expect(tabs[0].recentTargets).toEqual([{ kind: 'file', folderPath: 'ETH/goodnotes/semester-1/chemie/notes.md' }, { kind: 'plugin', pluginId: 'graphView' }])
    expect(tabs[3]).toEqual({ id: 't4', folderPath: '', kind: 'plugin', pluginId: 'calendar' })
    expect((await tabsOf('chemie', 'rightSidebarLayout'))[0].folderPath).toBe('ETH/goodnotes/semester-1/chemie/series/serie-8_chemie.pdf')
    const live = store.find('chemie')!.snapshot.layout
    expect(live.type === 'leaf' && live.tabs.map(tab => tab.folderPath)).toEqual(tabs.map(tab => tab.folderPath))
    store.dispose()
  })

  it('opens the new path when a layout is loaded after its file moved', async () => {
    const { mock, store } = await setup([layout('chemie', snapshot([{ id: 't1', folderPath: pdf }]))])
    const apply = vi.spyOn(mock.api.workspace, 'applyLayout')
    mock.emitFileRenamed(pdf, 'ETH/archive/serie-8_chemie.pdf')
    await vi.waitFor(() => expect(store.find('chemie')!.snapshot.layout).toMatchObject({ tabs: [{ folderPath: 'ETH/archive/serie-8_chemie.pdf' }] }))
    await store.loadByName('chemie')
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ layout: expect.objectContaining({ tabs: [expect.objectContaining({ folderPath: 'ETH/archive/serie-8_chemie.pdf' })] }) }))
    store.dispose()
  })

  it('drops the viewer position only when a rename changes the file type', async () => {
    const { mock, store, tabsOf } = await setup([layout('notes', snapshot([
      { id: 't1', folderPath: 'Notes/a.md', viewState: { editorScrollTop: 40 } },
      { id: 't2', folderPath: 'Notes/b.txt', viewState: { editorScrollTop: 80 } }
    ]))])
    mock.emitFileRenamed('Notes/a.md', 'Notes/alpha.md')
    mock.emitFileRenamed('Notes/b.txt', 'Notes/b.md')
    await vi.waitFor(async () => expect((await tabsOf('notes')).map(tab => tab.folderPath)).toEqual(['Notes/alpha.md', 'Notes/b.md']))
    const tabs = await tabsOf('notes')
    expect(tabs[0].viewState).toEqual({ editorScrollTop: 40 })
    expect(tabs[1]).not.toHaveProperty('viewState')
    store.dispose()
  })

  it('keeps plugin and Properties tabs and moves their per-file outline folds', async () => {
    const { mock, store, tabsOf } = await setup([layout('chemie', snapshot([
      { id: 't1', folderPath: pdf, pinned: true },
      { id: 't2', folderPath: '', kind: 'plugin', pluginId: 'graphView', pluginInstanceId: 'g1', pluginTitle: 'Graph' }
    ], [{ id: 'r1', folderPath: '', kind: 'properties', viewState: { propsSegment: 'outline', outlineFolds: { 'ETH/goodnotes/semester1/chemie/notes.md': ['intro'], 'Other/x.md': ['a'] } } }]))])
    mock.emitFileRenamed('ETH/goodnotes/semester1', 'ETH/goodnotes/semester-1')
    await vi.waitFor(async () => expect((await tabsOf('chemie'))[0].folderPath).toBe('ETH/goodnotes/semester-1/chemie/series/serie-8_chemie.pdf'))
    const [file, plugin] = await tabsOf('chemie')
    expect(file.pinned).toBe(true)
    expect(plugin).toEqual({ id: 't2', folderPath: '', kind: 'plugin', pluginId: 'graphView', pluginInstanceId: 'g1', pluginTitle: 'Graph' })
    expect((await tabsOf('chemie', 'rightSidebarLayout'))[0]).toEqual({ id: 'r1', folderPath: '', kind: 'properties', viewState: { propsSegment: 'outline', outlineFolds: { 'ETH/goodnotes/semester-1/chemie/notes.md': ['intro'], 'Other/x.md': ['a'] } } })
    store.dispose()
  })

  it('writes nothing when no saved layout references the renamed path', async () => {
    const { mock, store } = await setup([layout('notes', snapshot([{ id: 't1', folderPath: 'Notes/a.md' }]))])
    const writes = vi.spyOn(mock.api.data.files, 'writeTextGuarded')
    mock.emitFileRenamed('Other/a.md', 'Other/b.md')
    await store.ensureLoaded()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(writes).not.toHaveBeenCalled()
    store.dispose()
  })

  it('adopts a file another window already moved and saves normally afterwards', async () => {
    const { mock, store, tabsOf } = await setup([layout('chemie', snapshot([{ id: 't1', folderPath: pdf }]))])
    const current = await mock.api.data.files.readTextBaseline('workspaces.json')
    const other = JSON.parse(current!.content)
    other.layouts[0].snapshot.layout.tabs[0].folderPath = 'ETH/goodnotes/semester-1/chemie/series/serie-8_chemie.pdf'
    await mock.api.data.files.writeTextGuarded('workspaces.json', JSON.stringify(other, null, 2) + '\n', current!.baseline)
    const writes = vi.spyOn(mock.api.data.files, 'writeTextGuarded')
    mock.emitFileRenamed('ETH/goodnotes/semester1', 'ETH/goodnotes/semester-1')
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(1))
    await store.drainFollows()
    expect((await tabsOf('chemie'))[0].folderPath).toBe('ETH/goodnotes/semester-1/chemie/series/serie-8_chemie.pdf')
    await expect(store.createGroup('Ferns')).resolves.toBe('Ferns')
    expect(JSON.parse(await mock.api.data.files.readText('workspaces.json') ?? '{}').groups).toEqual(['Ferns'])
    store.dispose()
  })

  it('never overwrites a change from another window that this window has not seen', async () => {
    const { mock, store, saved } = await setup([layout('chemie', snapshot([{ id: 't1', folderPath: pdf }]))])
    const current = await mock.api.data.files.readTextBaseline('workspaces.json')
    const other = JSON.parse(current!.content)
    other.layouts.push(layout('physik', snapshot([{ id: 'p1', folderPath: 'ETH/physik/blatt-3.pdf' }])))
    await mock.api.data.files.writeTextGuarded('workspaces.json', JSON.stringify(other, null, 2) + '\n', current!.baseline)
    mock.emitFileRenamed('ETH/goodnotes/semester1', 'ETH/goodnotes/semester-1')
    await store.drainFollows()
    expect((await saved()).map(entry => entry.name)).toEqual(['chemie', 'physik'])
    await expect(store.createGroup('Ferns')).rejects.toThrow('another window')
    expect((await saved()).map(entry => entry.name)).toEqual(['chemie', 'physik'])
    store.dispose()
  })

  it('applies a chain of renames that reuses a path once across two windows', async () => {
    const plan = 'Notes/plan.md', old = 'Notes/plan-old.md', draft = 'Notes/draft.md'
    const records = [layout('desk', snapshot([{ id: 'a', folderPath: plan }, { id: 'b', folderPath: draft }]))]
    const first = await setup(records)
    const second = createMockValleyApi({ manifest: { id: 'workspace' } })
    for (const method of ['readText', 'readTextBaseline', 'writeTextGuarded'] as const) {
      vi.spyOn(second.api.data.files, method).mockImplementation(((...args: unknown[]) => (first.mock.api.data.files[method] as (...input: unknown[]) => unknown)(...args)) as never)
    }
    const other = createStore(second.api)
    await other.ensureLoaded()
    first.mock.emitFileRenamed(plan, old)
    await first.store.drainFollows()
    first.mock.emitFileRenamed(draft, plan)
    await first.store.drainFollows()
    second.emitFileRenamed(plan, old)
    second.emitFileRenamed(draft, plan)
    await other.drainFollows()
    expect((await first.tabsOf('desk')).map(tab => [tab.id, tab.folderPath])).toEqual([['a', old], ['b', plan]])
    expect(other.find('desk')!.snapshot.layout).toMatchObject({ tabs: [{ id: 'a', folderPath: old }, { id: 'b', folderPath: plan }] })
    await expect(other.createGroup('Ferns')).resolves.toBe('Ferns')
    expect((await first.tabsOf('desk')).map(tab => tab.folderPath)).toEqual([old, plan])
    other.dispose()
    first.store.dispose()
  })

  it('leaves the file to the window that wrote first when both follow the same rename', async () => {
    const { mock, store, tabsOf } = await setup([layout('chemie', snapshot([{ id: 't1', folderPath: pdf }])), layout('ai-society', snapshot([{ id: 't2', folderPath: 'Other/x.md' }]))])
    const write = mock.api.data.files.writeTextGuarded
    const writes = vi.spyOn(mock.api.data.files, 'writeTextGuarded').mockImplementationOnce(async (file, content, expected) => {
      const moved = JSON.parse(content)
      await write(file, JSON.stringify(moved, null, 2) + '\n', expected)
      return write(file, content, expected)
    })
    mock.emitFileRenamed('ETH/goodnotes/semester1', 'ETH/goodnotes/semester-1')
    await store.drainFollows()
    expect(writes).toHaveBeenCalledTimes(1)
    expect((await tabsOf('chemie'))[0].folderPath).toBe('ETH/goodnotes/semester-1/chemie/series/serie-8_chemie.pdf')
    await expect(store.renameByName('ai-society', 'ai society')).resolves.toBeTruthy()
    store.dispose()
  })

  it('follows into split panes and nested right-sidebar splits, changing only path values', async () => {
    const leaf = (id: string, tabs: WorkflowTab[]) => ({ type: 'leaf' as const, id, tabs, activeTabId: tabs[0]?.id ?? null })
    const value: WorkspaceLayoutSnapshot = {
      layout: { type: 'split', id: 's1', direction: 'row', sizes: [0.5, 0.5], children: [leaf('p1', [{ id: 't1', folderPath: pdf, pinned: true }]), { type: 'split', id: 's2', direction: 'column', sizes: [0.5, 0.5], children: [leaf('p2', [{ id: 't2', folderPath: 'ETH/goodnotes/semester1/chemie/notes.md', scrollTop: 120 }]), leaf('p3', [{ id: 't3', folderPath: '', kind: 'plugin', pluginId: 'calendar' }])] }] },
      activePaneId: 'p2', leftSidebarWidth: 260, leftSidebarVisible: true, rightSidebarVisible: true,
      rightSidebarLayout: { type: 'split', id: 'r0', direction: 'column', sizes: [0.4, 0.6], children: [leaf('r1', [{ id: 'r1t', folderPath: 'ETH/goodnotes/semester1/chemie/notes.md' }]), leaf('r2', [{ id: 'r2t', folderPath: '', kind: 'properties' }])] }
    }
    const { mock, store } = await setup([layout('chemie', value)])
    await store.setActive('chemie', false)
    const before = await mock.api.data.files.readText('workspaces.json')
    mock.emitFileRenamed('ETH/goodnotes/semester1', 'ETH/goodnotes/semester-1')
    await store.drainFollows()
    const after = await mock.api.data.files.readText('workspaces.json')
    expect(JSON.parse(after!)).toStrictEqual(JSON.parse(before!.replaceAll('ETH/goodnotes/semester1/', 'ETH/goodnotes/semester-1/')))
    expect(store.active).toBe('chemie')
    store.dispose()
  })

  it('tries again after a write error so the moved paths reach the file', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { mock, store, tabsOf } = await setup([layout('chemie', snapshot([{ id: 't1', folderPath: pdf }]))])
      vi.spyOn(mock.api.data.files, 'writeTextGuarded').mockResolvedValueOnce({ ok: false, reason: 'error' })
      mock.emitFileRenamed('ETH/goodnotes/semester1', 'ETH/goodnotes/semester-1')
      await store.drainFollows()
      expect((await tabsOf('chemie'))[0].folderPath).toBe(pdf)
      await vi.advanceTimersByTimeAsync(2100)
      await store.drainFollows()
      expect((await tabsOf('chemie'))[0].folderPath).toBe('ETH/goodnotes/semester-1/chemie/series/serie-8_chemie.pdf')
      store.dispose()
    } finally { vi.useRealTimers() }
  })

  it('moves its own layouts in the file even when another window changed it unseen, and stays refused for saves', async () => {
    const { mock, store, saved } = await setup([layout('chemie', snapshot([{ id: 't1', folderPath: pdf }])), layout('notes', snapshot([{ id: 'n1', folderPath: 'ETH/goodnotes/semester1/chemie/notes.md' }]))])
    const current = await mock.api.data.files.readTextBaseline('workspaces.json')
    const other = JSON.parse(current!.content)
    other.layouts.push(layout('physik', snapshot([{ id: 'p1', folderPath: 'ETH/physik/blatt-3.pdf' }])))
    other.layouts[1].snapshot.layout.tabs.push({ id: 'n2', folderPath: 'Other/x.md' })
    await mock.api.data.files.writeTextGuarded('workspaces.json', JSON.stringify(other, null, 2) + '\n', current!.baseline)
    mock.emitFileRenamed('ETH/goodnotes/semester1', 'ETH/goodnotes/semester-1')
    await store.drainFollows()
    const disk = await saved()
    expect(disk.map(entry => entry.name)).toEqual(['chemie', 'notes', 'physik'])
    expect(disk[0].snapshot.layout).toMatchObject({ tabs: [{ folderPath: 'ETH/goodnotes/semester-1/chemie/series/serie-8_chemie.pdf' }] })
    expect(disk[1].snapshot.layout).toMatchObject({ tabs: [{ folderPath: 'ETH/goodnotes/semester1/chemie/notes.md' }, { folderPath: 'Other/x.md' }] })
    await expect(store.createGroup('Ferns')).rejects.toThrow('another window')
    store.dispose()
  })

  it('does not replay a path-reusing chain that arrived while it was still reading the file', async () => {
    const plan = 'Notes/plan.md', old = 'Notes/plan-old.md', draft = 'Notes/draft.md'
    const first = await setup([layout('desk', snapshot([{ id: 'a', folderPath: plan }, { id: 'b', folderPath: draft }]))])
    const second = createMockValleyApi({ manifest: { id: 'workspace' } })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let reads = 0
    for (const method of ['readText', 'readTextBaseline', 'writeTextGuarded'] as const) {
      vi.spyOn(second.api.data.files, method).mockImplementation((async (...args: unknown[]) => {
        if (method === 'readTextBaseline' && reads++ === 0) await held
        return (first.mock.api.data.files[method] as (...input: unknown[]) => unknown)(...args)
      }) as never)
    }
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const other = createStore(second.api)
    const loading = other.ensureLoaded()
    second.emitFileRenamed(plan, old)
    second.emitFileRenamed(draft, plan)
    first.mock.emitFileRenamed(plan, old)
    first.mock.emitFileRenamed(draft, plan)
    await first.store.drainFollows()
    release()
    await loading
    await other.drainFollows()
    expect((await first.tabsOf('desk')).map(tab => [tab.id, tab.folderPath])).toEqual([['a', old], ['b', plan]])
    expect(warned).toHaveBeenCalledOnce()
    warned.mockRestore()
    other.dispose()
    first.store.dispose()
  })

  it('applies renames that arrived during its first read when none reuses a moved path', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' }, files: { [filePath]: JSON.stringify({ version: 1, layouts: [layout('chemie', snapshot([{ id: 't1', folderPath: pdf }, { id: 't2', folderPath: 'Docs/a.md' }]))], groups: [] }) } })
    const store = createStore(mock.api)
    mock.emitFileRenamed('ETH/goodnotes/semester1', 'ETH/goodnotes/semester-1')
    mock.emitFileRenamed('Docs/a.md', 'Archive/a.md')
    await store.ensureLoaded()
    await store.drainFollows()
    const tabs = JSON.parse(await mock.api.data.files.readText('workspaces.json') ?? '{}').layouts[0].snapshot.layout.tabs
    expect(tabs.map((tab: WorkflowTab) => tab.folderPath)).toEqual(['ETH/goodnotes/semester-1/chemie/series/serie-8_chemie.pdf', 'Archive/a.md'])
    store.dispose()
  })

  it('writes nothing for a follow that was still queued when the store was disposed', async () => {
    const { mock, store, saved } = await setup([layout('chemie', snapshot([{ id: 't1', folderPath: pdf }]))])
    const write = mock.api.data.files.writeTextGuarded
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const writes = vi.spyOn(mock.api.data.files, 'writeTextGuarded').mockImplementationOnce(async (...args) => { await held; return write(...args) })
    const blocked = store.createGroup('Ferns')
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(1))
    mock.emitFileRenamed('ETH/goodnotes/semester1', 'ETH/goodnotes/semester-1')
    store.dispose()
    release()
    await blocked
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(writes).toHaveBeenCalledTimes(1)
    expect((await saved())[0].snapshot.layout).toMatchObject({ tabs: [{ folderPath: pdf }] })
  })

  it('stops after three write errors and keeps no retry after dispose', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { mock, store } = await setup([layout('chemie', snapshot([{ id: 't1', folderPath: pdf }]))])
      const writes = vi.spyOn(mock.api.data.files, 'writeTextGuarded').mockResolvedValue({ ok: false, reason: 'error' })
      mock.emitFileRenamed('ETH/goodnotes/semester1', 'ETH/goodnotes/semester-1')
      await store.drainFollows()
      await vi.advanceTimersByTimeAsync(2100)
      await store.drainFollows()
      await vi.advanceTimersByTimeAsync(2100)
      await store.drainFollows()
      expect(writes).toHaveBeenCalledTimes(3)
      expect(logged).toHaveBeenCalledWith('Workspace could not save saved layouts after a rename')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(writes).toHaveBeenCalledTimes(3)
      writes.mockClear()
      mock.emitFileRenamed('ETH/goodnotes/semester-1', 'ETH/goodnotes/semester-2')
      await store.drainFollows()
      expect(writes).toHaveBeenCalledTimes(1)
      store.dispose()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(writes).toHaveBeenCalledTimes(1)
    } finally { logged.mockRestore(); vi.useRealTimers() }
  })

  it('stops following renames after the store is disposed', async () => {
    const { mock, store, saved } = await setup([layout('chemie', snapshot([{ id: 't1', folderPath: pdf }]))])
    store.dispose()
    mock.emitFileRenamed('ETH/goodnotes/semester1', 'ETH/goodnotes/semester-1')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await saved())[0].snapshot.layout).toMatchObject({ tabs: [{ folderPath: pdf }] })
  })
})
