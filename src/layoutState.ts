import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { LeafPane, WorkspaceLayoutSnapshot, WorkspaceNode, ValleyPluginManifest } from '@valley/plugin-sdk/types'

const ICON_RAIL_SETTING = 'saveIconRail'
const FOOTER_RAIL_SETTING = 'saveFooterRail'
const RIGHT_SIDEBAR_SETTING = 'saveRightSidebarState'

/**
 * The optional parts a layout can carry beside the always-saved pane tree and
 * left sidebar. Each saved layout owns its own choice; the settings only seed
 * the choice for a new layout.
 */
export type LayoutScope = 'rightSidebar' | 'iconRail' | 'footer'
export type LayoutScopes = Record<LayoutScope, boolean>
export const LAYOUT_SCOPES: readonly LayoutScope[] = ['rightSidebar', 'iconRail', 'footer']

const SCOPE_FIELDS = {
  rightSidebar: ['rightSidebarVisible', 'rightSidebarLayout'],
  iconRail: ['railVisible', 'panelOrder', 'hiddenPanelIds'],
  footer: ['footerVisible', 'footerLayout']
} as const satisfies Record<LayoutScope, readonly (keyof WorkspaceLayoutSnapshot)[]>

/** Which optional parts a saved snapshot carries, read from the fields present. */
export function scopesOf(snapshot: WorkspaceLayoutSnapshot): LayoutScopes {
  const has = (scope: LayoutScope): boolean => SCOPE_FIELDS[scope].some((key) => snapshot[key] != null)
  return { rightSidebar: has('rightSidebar'), iconRail: has('iconRail'), footer: has('footer') }
}

/** Keep only the always-saved fields plus the parts `scopes` selects. */
export function projectSnapshot(raw: WorkspaceLayoutSnapshot, scopes: LayoutScopes): WorkspaceLayoutSnapshot {
  const snapshot = storedSnapshot(raw)
  const projected: WorkspaceLayoutSnapshot = {
    layout: snapshot.layout,
    activePaneId: snapshot.activePaneId,
    leftSidebarWidth: snapshot.leftSidebarWidth,
    ...(snapshot.rightSidebarWidth != null ? { rightSidebarWidth: snapshot.rightSidebarWidth } : {}),
    leftSidebarVisible: snapshot.leftSidebarVisible,
    ...(snapshot.activePanel ? { activePanel: snapshot.activePanel } : {})
  }
  for (const scope of LAYOUT_SCOPES) {
    if (!scopes[scope]) continue
    for (const key of SCOPE_FIELDS[scope]) if (snapshot[key] != null) Object.assign(projected, { [key]: snapshot[key] })
  }
  return projected
}

/** Pane and tab counts of the main workspace, for the layout lists. */
export function layoutCounts(snapshot: WorkspaceLayoutSnapshot): { panes: number; tabs: number } {
  const leaves = (node: WorkspaceNode): LeafPane[] => node.type === 'leaf' ? [node] : node.children.flatMap(leaves)
  const panes = snapshot.layout ? leaves(snapshot.layout) : []
  return { panes: panes.length, tabs: panes.reduce((total, pane) => total + pane.tabs.length, 0) }
}

/**
 * A key for "has the live arrangement diverged from what's saved" comparisons —
 * includes the complete captured snapshot, including the focused pane and active
 * tab. Switching to another open tab therefore makes the current layout different
 * until the saved layout is restored or saved again.
 */
export function structuralSnapshotKey(snapshot: WorkspaceLayoutSnapshot): string {
  try {
    return JSON.stringify(stableValue(storedSnapshot(snapshot)))
  } catch {
    return ''
  }
}

// Reading position inside a tab (scroll offset, media time, per-tab history)
// changes while the user reads; it never makes the arrangement itself unsaved.
const TRANSIENT_TAB_FIELDS = new Set(['scrollTop', 'viewState', 'recentTargets', 'historyIndex'])

function arrangementOnly(node: WorkspaceNode | undefined): WorkspaceNode | undefined {
  if (!node) return node
  if (node.type === 'split') return { ...node, children: node.children.map((child) => arrangementOnly(child) as WorkspaceNode) }
  return {
    ...node,
    tabs: node.tabs.map((tab) => Object.fromEntries(Object.entries(tab).filter(([key]) => !TRANSIENT_TAB_FIELDS.has(key))) as typeof tab)
  }
}

function arrangementKey(snapshot: WorkspaceLayoutSnapshot): string {
  return structuralSnapshotKey({
    ...snapshot,
    layout: arrangementOnly(snapshot.layout) as WorkspaceNode,
    ...(snapshot.rightSidebarLayout ? { rightSidebarLayout: arrangementOnly(snapshot.rightSidebarLayout) as WorkspaceLayoutSnapshot['rightSidebarLayout'] } : {})
  })
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)])
  )
}

/** Keep only recognized fields while preserving optional legacy/new scopes. */
export function storedSnapshot(raw: WorkspaceLayoutSnapshot): WorkspaceLayoutSnapshot {
  return {
    layout: raw.layout,
    activePaneId: raw.activePaneId,
    leftSidebarWidth: raw.leftSidebarWidth,
    leftSidebarVisible: raw.leftSidebarVisible,
    ...(typeof raw.activePanel === 'string' ? { activePanel: raw.activePanel } : {}),
    ...(typeof raw.rightSidebarWidth === 'number' ? { rightSidebarWidth: raw.rightSidebarWidth } : {}),
    ...(typeof raw.rightSidebarVisible === 'boolean' ? { rightSidebarVisible: raw.rightSidebarVisible } : {}),
    ...(raw.rightSidebarLayout ? { rightSidebarLayout: raw.rightSidebarLayout } : {}),
    ...(typeof raw.railVisible === 'boolean' ? { railVisible: raw.railVisible } : {}),
    ...(Array.isArray(raw.panelOrder) ? { panelOrder: raw.panelOrder.filter((id): id is string => typeof id === 'string') } : {}),
    ...(Array.isArray(raw.hiddenPanelIds)
      ? { hiddenPanelIds: raw.hiddenPanelIds.filter((id): id is string => typeof id === 'string') }
      : {}),
    ...(typeof raw.footerVisible === 'boolean' ? { footerVisible: raw.footerVisible } : {}),
    ...(raw.footerLayout ? { footerLayout: raw.footerLayout } : {})
  }
}

export function availableSnapshot(snapshot: WorkspaceLayoutSnapshot, manifests: readonly ValleyPluginManifest[]): { snapshot: WorkspaceLayoutSnapshot; missing: string[] } {
  const installed = new Map(manifests.map(manifest => [manifest.id, manifest]))
  const missing = new Set<string>()
  const has = (id: string, surface: 'left_sidebar' | 'right_sidebar' | 'footer' | 'main_workspace'): boolean => {
    const manifest = installed.get(id)
    if (manifest?.uiSlots?.[surface]) return true
    missing.add(id)
    return false
  }
  const panels = new Set(['files', 'search', 'bookmarks', 'dataHub'])
  const panel = (id: string): boolean => panels.has(id) || has(id, 'left_sidebar')
  const tree = (node: WorkspaceNode, surface: 'main_workspace' | 'right_sidebar'): WorkspaceNode => {
    if (node.type === 'split') return { ...node, children: node.children.map(child => tree(child, surface)) }
    const tabs = node.tabs.filter(tab => tab.kind !== 'plugin' || !!tab.pluginId && has(tab.pluginId, surface))
    return { ...node, tabs, activeTabId: tabs.some(tab => tab.id === node.activeTabId) ? node.activeTabId : tabs[0]?.id ?? null }
  }
  const next = storedSnapshot(snapshot)
  next.layout = tree(next.layout, 'main_workspace')
  if (next.rightSidebarLayout) next.rightSidebarLayout = tree(next.rightSidebarLayout, 'right_sidebar')
  if (next.activePanel && !panel(next.activePanel)) next.activePanel = 'files'
  if (next.panelOrder) next.panelOrder = next.panelOrder.filter(panel)
  if (next.hiddenPanelIds) next.hiddenPanelIds = next.hiddenPanelIds.filter(panel)
  if (next.footerLayout) {
    const footer = (id: string): boolean => !id.startsWith('plugin:') || has(id.slice(7), 'footer')
    next.footerLayout = { left: next.footerLayout.left.filter(footer), right: next.footerLayout.right.filter(footer), hidden: next.footerLayout.hidden.filter(footer) }
  }
  return { snapshot: next, missing: [...missing].sort() }
}

export class WorkspaceLayoutState {
  constructor(private readonly api: ValleyPluginApi) {}

  defaultScopes(): LayoutScopes {
    const settings = this.api.settings.get()
    return {
      rightSidebar: settings[RIGHT_SIDEBAR_SETTING] === true,
      iconRail: settings[ICON_RAIL_SETTING] === true,
      footer: settings[FOOTER_RAIL_SETTING] === true
    }
  }

  capture(scopes: LayoutScopes = this.defaultScopes()): WorkspaceLayoutSnapshot {
    return projectSnapshot(this.api.workspace.captureLayout(), scopes)
  }

  captureForSave(scopes: LayoutScopes): WorkspaceLayoutSnapshot {
    return this.capture(scopes)
  }

  withLivePart(snapshot: WorkspaceLayoutSnapshot, scope: LayoutScope): WorkspaceLayoutSnapshot {
    const live = this.capture({ rightSidebar: false, iconRail: false, footer: false, [scope]: true })
    const next: WorkspaceLayoutSnapshot = { ...snapshot }
    for (const key of SCOPE_FIELDS[scope]) if (live[key] != null) Object.assign(next, { [key]: live[key] })
    return next
  }

  isCurrent(snapshot: WorkspaceLayoutSnapshot): boolean {
    const scopes = scopesOf(snapshot)
    const live = this.capture(scopes)
    return arrangementKey(live) === arrangementKey({ ...live, ...projectSnapshot(snapshot, scopes) })
  }

  applySnapshot(snapshot: WorkspaceLayoutSnapshot): void {
    this.api.workspace.applyLayout(projectSnapshot(snapshot, scopesOf(snapshot)))
  }
}
