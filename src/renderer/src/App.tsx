import React, { useEffect } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { GraphView } from './components/GraphView'
import { ListsView } from './components/ListsView'
import { BacklogView } from './components/BacklogView'
import { WarpsView } from './components/WarpsView'
import { ReviewsView } from './components/ReviewsView'
import { ActivityView } from './components/ActivityView'
import { SettingsView } from './components/SettingsView'
import { Inspector } from './components/Inspector'
import { QuickAdd } from './components/QuickAdd'
import { Palette } from './components/Palette'
import { Toasts } from './components/widgets'
import { inTextField, matches } from './lib/shortcuts'

export default function App(): React.JSX.Element {
  const booted = useStore((s) => s.booted)
  const view = useStore((s) => s.view)
  const selection = useStore((s) => s.selection)
  const quickAdd = useStore((s) => s.quickAdd)
  const palette = useStore((s) => s.palette)
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

  if (!booted) {
    return (
      <div className="boot">
        <span className="pulse">◈</span> waking the spec engine…
      </div>
    )
  }

  const showInspector = selection && (view === 'graph' || view === 'lists' || view === 'backlog' || view === 'warps')

  return (
    <div className="app">
      <Sidebar />
      <div className="content">
        {view === 'graph' && <GraphView />}
        {view === 'lists' && <ListsView />}
        {view === 'backlog' && <BacklogView />}
        {view === 'warps' && <WarpsView />}
        {view === 'reviews' && <ReviewsView />}
        {view === 'activity' && <ActivityView />}
        {view === 'settings' && <SettingsView />}
      </div>
      {showInspector && <Inspector />}
      {quickAdd.open && <QuickAdd />}
      {palette && <Palette />}
      <Toasts />
    </div>
  )
}
