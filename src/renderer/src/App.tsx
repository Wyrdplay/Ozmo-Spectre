import React, { useEffect } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { GraphView } from './components/GraphView'
import { ListsView } from './components/ListsView'
import { BacklogView } from './components/BacklogView'
import { WarpsView } from './components/WarpsView'
import { ReviewsView } from './components/ReviewsView'
import { AgenticView } from './components/AgenticView'
import { ActivityView } from './components/ActivityView'
import { SettingsView } from './components/SettingsView'
import { Inspector } from './components/Inspector'
import { QuickAdd } from './components/QuickAdd'
import { Palette } from './components/Palette'
import { ExportDialog } from './components/ExportDialog'
import { Toasts } from './components/widgets'
import { Onboarding } from './components/Onboarding'
import { WorkspaceChooser } from './components/WorkspaceChooser'
import { LoadingScreen } from './components/LoadingScreen'
import { LockBanner } from './components/BoardLock'
import { inTextField, matches } from './lib/shortcuts'

export default function App(): React.JSX.Element {
  const booted = useStore((s) => s.booted)
  const session = useStore((s) => s.session)
  const workspaceGate = useStore((s) => s.workspaceGate)
  const switching = useStore((s) => s.switching)
  const workspaces = useStore((s) => s.workspaces)
  const view = useStore((s) => s.view)
  const selection = useStore((s) => s.selection)
  const quickAdd = useStore((s) => s.quickAdd)
  const palette = useStore((s) => s.palette)
  const exportScope = useStore((s) => s.exportScope)
  const setExportScope = useStore((s) => s.setExportScope)
  const setPalette = useStore((s) => s.setPalette)
  const showQuickAdd = useStore((s) => s.showQuickAdd)

  useEffect(() => {
    // chords come from the shortcut table (lib/shortcuts) — the same rows the
    // canvas '?' panel renders, so a binding is declared exactly once
    const onKey = (e: KeyboardEvent): void => {
      if (matches('palette', e)) {
        e.preventDefault()
        setPalette(true)
      } else if (matches('quick-add', e) && !inTextField(e)) {
        e.preventDefault()
        showQuickAdd()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPalette, showQuickAdd])

  // Opening a board can be a network round trip now, so the wait says what it is
  // waiting for and eventually offers a way out of it. The chooser wins over the
  // loading screen: a human who has asked to change workspace should not be made
  // to watch the one that is failing.
  const openingWs = workspaces?.workspaces.find((w) => w.id === workspaces.activeId)
  if (!workspaceGate && (switching || !booted)) {
    return (
      <LoadingScreen
        title={switching ? `Opening ${switching}…` : 'waking the spec engine…'}
        detail={openingWs?.url ?? openingWs?.vaultPath}
      />
    )
  }

  // WHERE COMES BEFORE WHO. The chooser sits in front of the door, because the
  // door is a different door per server — there is no identity to ask about
  // until the board is chosen.
  if (workspaceGate) {
    return (
      <>
        <WorkspaceChooser />
        <Toasts />
      </>
    )
  }

  // THE DOOR COMES BEFORE THE APP. Not a redirect and not an overlay: an
  // unapproved viewer has no board to render behind this, because the server
  // never sent one.
  if (!session || session.state !== 'approved') {
    return (
      <>
        <Onboarding />
        <Toasts />
      </>
    )
  }

  const showInspector = selection && (view === 'graph' || view === 'lists' || view === 'backlog' || view === 'warps')

  return (
    // A closed board reads normally, so without this the app would look entirely
    // ordinary and only fail on the first attempt to change something. The state
    // is announced rather than discovered.
    <div className={session.readOnly ? 'app locked' : 'app'}>
      {session.readOnly && <LockBanner lock={session.readOnly} />}
      <Sidebar />
      <div className="content">
        {view === 'graph' && <GraphView />}
        {view === 'lists' && <ListsView />}
        {view === 'backlog' && <BacklogView />}
        {view === 'warps' && <WarpsView />}
        {view === 'reviews' && <ReviewsView />}
        {view === 'agentic' && <AgenticView />}
        {view === 'activity' && <ActivityView />}
        {view === 'settings' && <SettingsView />}
      </div>
      {showInspector && <Inspector />}
      {quickAdd.open && <QuickAdd />}
      {palette && <Palette />}
      {exportScope && <ExportDialog initialScope={exportScope} onClose={() => setExportScope(null)} />}
      <Toasts />
    </div>
  )
}
