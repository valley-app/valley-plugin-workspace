import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'
import type { TextFileWithBaseline } from '@valley/plugin-sdk/types'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { register } from '../src/index'
import { React } from '../src/runtime'
import { useWorkspaceSurface } from '../src/surfaces'
import { createStore } from '../src/store'
import { WorkspaceRepository, type SavedLayout } from '../src/repository'
import config from '../config.json'

const filePath = '.valley/plugins/data/workspace/workspaces.json'
const contents = (layouts: SavedLayout[] = [], groups: string[] = []) => JSON.stringify({ version: 1, layouts, groups })
const read = async (mock: ReturnType<typeof createMockValleyApi>) => JSON.parse(await mock.api.data.files.readText('workspaces.json') ?? contents())

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail })
  return { promise, resolve, reject }
}

function setup() {
  const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
  const query = vi.spyOn(mock.api.data.files, 'readTextBaseline')
  return { mock, query, store: createStore(mock.api) }
}

describe('workspace package', () => {
  it('registers through its injected API without declaring SQL datasets', () => {
    const mock = createMockValleyApi()
    const dispose = register(mock.api)
    expect(mock.commands.length).toBeGreaterThan(0)
    expect(config).not.toHaveProperty('datasets')
    dispose()
  })
})

it('awaits queued user changes before unload and retains a failed change for retry', async () => {
  const { mock, store } = setup()
  const write = mock.api.data.files.writeTextGuarded
  const blocked = deferred<void>()
  const writes = vi.spyOn(mock.api.data.files, 'writeTextGuarded').mockImplementationOnce(async (...args) => { await blocked.promise; return write(...args) })
  const first = store.createGroup('Ferns')
  await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(1))
  let completed = false
  const unload = mock.runBeforeUnload().then(() => { completed = true })
  await Promise.resolve()
  expect(completed).toBe(false)
  blocked.resolve()
  await first
  await unload
  expect((await read(mock)).groups).toEqual(['Ferns'])
  writes.mockRejectedValueOnce(new Error('Disk unavailable'))
  await expect(store.createGroup('Moss')).rejects.toThrow('Disk unavailable')
  await expect(mock.runBeforeUnload()).rejects.toThrow('Disk unavailable')
  expect(store.declaredGroups).toContain('Moss')
  await store.renameGroup('Moss', 'Mosses')
  await expect(mock.runBeforeUnload()).resolves.toBeUndefined()
  expect((await read(mock)).groups).toEqual(['Ferns', 'Mosses'])
  store.dispose()
})

it('releases mounted and provider subscriptions after the owning session is revoked', () => {
  const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
  const dispose = register(mock.api)
  function Subject(): null {
    useWorkspaceSurface('left_sidebar')
    return null
  }
  const mounted = render(React.createElement(Subject))
  const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension
  const unsubscribe = surface.subscribe(vi.fn())
  const state = mock.api.runtime.getOrCreate('workspace.surfaces', () => ({ listeners: new Set() }))
  expect(state.listeners.size).toBe(2)
  dispose()
  const runtime = vi.spyOn(mock.api.runtime, 'getOrCreate').mockImplementation(() => {
    throw new Error('Plugin session is no longer active')
  })
  try {
    unsubscribe()
    mounted.unmount()
    expect(state.listeners.size).toBe(0)
    expect(runtime).not.toHaveBeenCalled()
  } finally {
    runtime.mockRestore()
    mounted.unmount()
  }
})

describe('workspace refresh ownership', () => {
  it('shares initial consumers and publishes only the latest requested file revision', async () => {
    const { mock, query, store } = setup()
    const firstRead = deferred<TextFileWithBaseline | null>()
    query.mockImplementationOnce(() => firstRead.promise)
    const published: string[][] = []
    store.subscribe(() => published.push([...store.declaredGroups]))
    const first = store.ensureLoaded()
    expect(store.ensureLoaded()).toBe(first)
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    await mock.api.data.files.writeTextGuarded('workspaces.json', contents([], ['Ferns', 'Mosses']), null)
    for (let n = 0; n < 20; n++) void store.refresh()
    firstRead.resolve(null)
    await first
    expect(query).toHaveBeenCalledTimes(2)
    expect(published).toEqual([['Ferns', 'Mosses']])
    store.dispose()
  })

  it('allows a failed initial read to be retried', async () => {
    const { query, store } = setup()
    query.mockRejectedValueOnce(new Error('File unavailable'))
    await expect(store.ensureLoaded()).rejects.toThrow('File unavailable')
    await expect(store.ensureLoaded()).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledTimes(2)
    store.dispose()
  })

  it('ignores a stale failed read when a newer revision was requested', async () => {
    const { mock, query, store } = setup()
    const firstRead = deferred<TextFileWithBaseline | null>()
    query.mockImplementationOnce(() => firstRead.promise)
    const pending = store.ensureLoaded()
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    await mock.api.data.files.writeTextGuarded('workspaces.json', contents([], ['Ferns']), null)
    void store.refresh()
    firstRead.reject(new Error('Stale read failed'))
    await pending
    expect(store.declaredGroups).toEqual(['Ferns'])
    store.dispose()
  })

  it('does not publish a late read after disposal', async () => {
    const { query, store } = setup()
    const held = deferred<TextFileWithBaseline | null>()
    query.mockImplementationOnce(() => held.promise)
    const listener = vi.fn()
    store.subscribe(listener)
    const pending = store.ensureLoaded()
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    void store.refresh()
    store.dispose()
    held.resolve({ content: contents([], ['Late']), baseline: null })
    await pending
    expect(store.declaredGroups).toEqual([])
    expect(listener).not.toHaveBeenCalled()
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('preserves a local write when an older refresh completes', async () => {
    const { mock, query, store } = setup()
    await store.ensureLoaded()
    const held = deferred<TextFileWithBaseline | null>()
    query.mockImplementationOnce(() => held.promise)
    const refresh = store.refresh()
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))
    await store.createGroup('Ferns')
    held.resolve(null)
    await refresh
    expect(store.declaredGroups).toEqual(['Ferns'])
    expect((await read(mock)).groups).toEqual(['Ferns'])
    await store.createGroup('Mosses')
    expect((await read(mock)).groups).toEqual(['Ferns', 'Mosses'])
    store.dispose()
  })

  it('captures each queued write before later edits and drains all writes', async () => {
    const { mock, store } = setup()
    const blocked = deferred<void>()
    const write = mock.api.data.files.writeTextGuarded
    const writes = vi.spyOn(mock.api.data.files, 'writeTextGuarded').mockImplementationOnce(async (...args) => { await blocked.promise; return write(...args) })
    const first = store.createGroup('Ferns')
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(1))
    const second = store.createGroup('Mosses')
    blocked.resolve()
    await Promise.all([first, second])
    expect(writes.mock.calls.map(([, content]) => JSON.parse(content).groups)).toEqual([['Ferns'], ['Ferns', 'Mosses']])
    expect((await read(mock)).groups).toEqual(['Ferns', 'Mosses'])
    await expect(mock.runBeforeUnload()).resolves.toBeUndefined()
    store.dispose()
  })

  it('refreshes only for the workspace data file and removes its watcher on dispose', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    let changed!: (path: string) => void
    const off = vi.fn()
    vi.spyOn(mock.api.data.files, 'onChanged').mockImplementation(listener => { changed = listener; return off })
    const store = createStore(mock.api)
    await store.ensureLoaded()
    const refresh = vi.spyOn(store, 'refresh')
    changed('unrelated.json')
    expect(refresh).not.toHaveBeenCalled()
    await mock.api.data.files.writeTextGuarded('workspaces.json', contents([], ['Mosses']), null)
    changed('workspaces.json')
    await vi.waitFor(() => expect(store.declaredGroups).toEqual(['Mosses']))
    store.dispose()
    expect(off).toHaveBeenCalledOnce()
  })

  it('reuses name and group projections until a layout or group changes', async () => {
    const { mock, store } = setup()
    const readName = vi.fn((index: number) => `Layout ${index}`)
    store.layouts = Array.from({ length: 500 }, (_, index) => ({
      get name() { return readName(index) }, group: 'Ferns', snapshot: mock.api.workspace.captureLayout(), createdAt: 1, modifiedAt: 1
    }))
    store.declaredGroups = ['Empty']
    const groups = store.groups()
    expect(readName).toHaveBeenCalledTimes(500)
    for (let index = 0; index < 100; index++) {
      expect(store.find(` layout ${index} `)).toBe(store.layouts[index])
      expect(store.groups()).toBe(groups)
      expect(store.hasGroup(' FERNS ')).toBe(true)
      expect(store.groupNames()).toEqual(['Empty', 'Ferns'])
    }
    expect(readName).toHaveBeenCalledTimes(500)
    store.layouts = [store.layouts[0]]
    expect(store.find('Layout 499')).toBeUndefined()
    expect(store.groups()).not.toBe(groups)
    expect(store.groups().find(group => group.group === 'Ferns')?.layouts).toHaveLength(1)
    store.declaredGroups = ['Canopy']
    expect(store.hasGroup('Empty')).toBe(false)
    expect(store.groupNames()).toEqual(['Canopy', 'Ferns'])
    store.dispose()
  })

})

describe('workspace JSON persistence', () => {
  function fixture() {
    const seed = createMockValleyApi()
    const layouts: SavedLayout[] = [{ name: 'Canopy', group: 'Ferns', snapshot: seed.api.workspace.captureLayout(), createdAt: 1, modifiedAt: 1 }]
    const mock = createMockValleyApi({ manifest: { id: 'workspace' }, files: { [filePath]: contents(layouts, ['Ferns', 'Empty']) } })
    const writes = vi.spyOn(mock.api.data.files, 'writeTextGuarded')
    const dataset = vi.spyOn(mock.api.data, 'dataset')
    const notify = vi.fn()
    return { mock, layouts, writes, dataset, notify, repository: new WorkspaceRepository(mock.api, notify) }
  }

  it('round-trips layouts, pane trees, widths, timestamps and empty groups in one JSON file', async () => {
    const { mock, layouts, repository, dataset, writes } = fixture()
    await repository.read()
    const updated = { ...layouts[0], name: 'Forest', snapshot: { ...layouts[0].snapshot, leftSidebarWidth: 310, rightSidebarWidth: 380 } }
    await repository.save([updated], ['Ferns', 'Empty'])
    expect(await read(mock)).toEqual({ version: 1, layouts: [updated], groups: ['Ferns', 'Empty'] })
    expect(await new WorkspaceRepository(mock.api, vi.fn()).read()).toEqual(await read(mock))
    expect(writes).toHaveBeenCalledOnce()
    expect(dataset).not.toHaveBeenCalled()
  })

  it('skips unchanged saves regardless of object key order', async () => {
    const { layouts, repository, writes } = fixture()
    await repository.save(layouts.map(layout => ({ ...layout, snapshot: Object.fromEntries(Object.entries(layout.snapshot).reverse()) as SavedLayout['snapshot'] })), ['Ferns', 'Empty'])
    expect(writes).not.toHaveBeenCalled()
  })

  it('refuses to overwrite a concurrently changed file', async () => {
    const { mock, layouts, repository } = fixture()
    await repository.read()
    const external = await mock.api.data.files.readTextBaseline('workspaces.json')
    const replacement = contents(layouts, ['External'])
    await mock.api.data.files.writeTextGuarded('workspaces.json', replacement, external!.baseline)
    await expect(repository.save([], [])).rejects.toThrow('another window')
    await expect(repository.drain()).rejects.toThrow('another window')
    expect(await mock.api.data.files.readText('workspaces.json')).toBe(replacement)
  })

  it.each(['{bad json', '{"version":2,"layouts":[],"groups":[]}', '{"version":1,"layouts":[{}],"groups":[]}'])('preserves an invalid file instead of overwriting it: %s', async content => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' }, files: { [filePath]: content } })
    const repository = new WorkspaceRepository(mock.api, vi.fn())
    await expect(repository.save([], [])).rejects.toThrow()
    expect(await mock.api.data.files.readText('workspaces.json')).toBe(content)
  })

  it('rejects duplicate layout or group names before changing the file', async () => {
    const { mock, layouts, repository, writes } = fixture()
    await expect(repository.save([...layouts, layouts[0]], [])).rejects.toThrow('Duplicate Workspace record name')
    await expect(repository.save(layouts, ['Ferns', 'Ferns'])).rejects.toThrow('Duplicate Workspace record name')
    expect(writes).not.toHaveBeenCalled()
    expect((await read(mock)).groups).toEqual(['Ferns', 'Empty'])
  })

  it('reports a failed write without claiming that another window changed the file', async () => {
    const { mock, layouts, repository, writes } = fixture()
    writes.mockResolvedValueOnce({ ok: false, reason: 'error' })
    await expect(repository.save([], [])).rejects.toThrow('Unable to save workspaces.json')
    expect((await read(mock)).layouts).toEqual(layouts)
  })

  it('keeps the prior durable file on a failed write and permits a later retry', async () => {
    const { mock, layouts, repository, writes, notify } = fixture()
    writes.mockRejectedValueOnce(new Error('Disk unavailable'))
    await expect(repository.save([], [])).rejects.toThrow('Disk unavailable')
    await expect(repository.drain()).rejects.toThrow('Disk unavailable')
    expect((await read(mock)).layouts).toEqual(layouts)
    expect(notify).not.toHaveBeenCalled()
    await repository.save([], [])
    await repository.drain()
    expect(await read(mock)).toEqual({ version: 1, layouts: [], groups: [] })
  })
})
