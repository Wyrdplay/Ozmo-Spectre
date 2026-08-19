import React, { useEffect, useRef, useState } from 'react'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { renderMarkdown, hydrateMarkdown, toggleTask } from '@/lib/markdown'
import { useStore } from '@/store'

const theme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: '#e6eaf2' },
    '.cm-content': { fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace", fontSize: '12.5px' },
    '.cm-line': { padding: '0 12px' },
    '.cm-selectionBackground': { backgroundColor: 'rgba(56,189,248,0.25) !important' },
    '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(56,189,248,0.25) !important' },
    '.cm-placeholder': { color: '#5b6478' }
  },
  { dark: true }
)

const mdHighlight = HighlightStyle.define([
  { tag: t.heading, color: '#38bdf8', fontWeight: '700' },
  { tag: t.strong, color: '#e6eaf2', fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic', color: '#c9d2e3' },
  { tag: t.link, color: '#c084fc' },
  { tag: t.url, color: '#8b94a7' },
  { tag: t.monospace, color: '#facc15' },
  { tag: t.quote, color: '#8b94a7' },
  { tag: t.list, color: '#8b94a7' },
  { tag: t.comment, color: '#5b6478' }
])

export function MarkdownEditor({ nodeId, value, onSave }: {
  nodeId: string
  value: string
  onSave: (content: string) => Promise<void>
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<'edit' | 'preview'>('preview')
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const dirtyRef = useRef(false)
  const valueRef = useRef(value)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  // checkbox toggles apply to a local copy immediately (no flicker) until the
  // saved content round-trips through the store and comes back as `value`
  const [localValue, setLocalValue] = useState<string | null>(null)
  const localValueRef = useRef<string | null>(null)
  const setLocal = (v: string | null): void => {
    localValueRef.current = v
    setLocalValue(v)
  }
  const savesInFlight = useRef(0)
  const lastRenderedRef = useRef<string | null>(null)

  const doSave = async (): Promise<void> => {
    const view = viewRef.current
    if (!view || !dirtyRef.current) return
    const content = view.state.doc.toString()
    try {
      await onSaveRef.current(content)
      valueRef.current = content
      dirtyRef.current = false
      setDirty(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 1600)
    } catch {
      /* toast handled by caller */
    }
  }
  const doSaveRef = useRef(doSave)
  doSaveRef.current = doSave

  // (re)create the editor when switching node or entering edit mode
  useEffect(() => {
    if (mode !== 'edit' || !hostRef.current) return
    const state = EditorState.create({
      doc: valueRef.current,
      extensions: [
        history(),
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              if (saveTimer.current) clearTimeout(saveTimer.current)
              doSaveRef.current()
              return true
            }
          },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap
        ]),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(mdHighlight),
        theme,
        placeholder('Write the spec in markdown…'),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            dirtyRef.current = true
            setDirty(true)
            if (saveTimer.current) clearTimeout(saveTimer.current)
            saveTimer.current = setTimeout(() => doSaveRef.current(), 1200)
          }
        })
      ]
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    view.focus()
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (dirtyRef.current) doSaveRef.current()
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, nodeId])

  // adopt external content updates when clean
  useEffect(() => {
    valueRef.current = value
    // clear the local checkbox-toggle copy once the save round-trips (value
    // catches up) or when a genuinely external edit arrives with nothing in flight
    if (localValueRef.current !== null && (value === localValueRef.current || savesInFlight.current === 0)) {
      setLocal(null)
    }
    const view = viewRef.current
    if (view && !dirtyRef.current && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
      dirtyRef.current = false
      setDirty(false)
    }
  }, [value])

  // reset mode when switching nodes
  useEffect(() => {
    setMode('preview')
    setDirty(false)
    dirtyRef.current = false
    setLocal(null)
    lastRenderedRef.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId])

  // render the preview into a real element (not dangerouslySetInnerHTML) so the
  // async hydrate pass (mermaid SVGs, code colors) can run over the same DOM.
  // Because this HTML is written outside React, the element it lands in must
  // never be reused by the editor branch — see the keys on the two hosts below.
  useEffect(() => {
    if (mode !== 'preview') {
      lastRenderedRef.current = null
      return
    }
    const el = previewRef.current
    if (!el) return
    const src = (localValue ?? value) || '_No spec yet. Hit **edit** and write one._'
    if (lastRenderedRef.current === src) return
    lastRenderedRef.current = src
    el.innerHTML = renderMarkdown(src)
    // this preview persists checkbox toggles, so its checkboxes are live
    el.querySelectorAll('input[type="checkbox"][data-task]').forEach((cb) => cb.removeAttribute('disabled'))
    void hydrateMarkdown(el)
  }, [mode, nodeId, value, localValue])

  const onToggleTask = (input: HTMLInputElement): void => {
    const attr = input.getAttribute('data-task')
    if (attr === null) return
    const base = localValueRef.current ?? valueRef.current
    const next = toggleTask(base, Number(attr))
    if (next === null) {
      input.checked = !input.checked // undo the native flip; source has no matching marker
      return
    }
    // the native click already flipped the box — the DOM now matches `next`,
    // so record it as rendered to skip a full (mermaid-rerendering) refresh
    lastRenderedRef.current = next
    valueRef.current = next // if the user opens edit mode before the refetch lands
    setLocal(next)
    savesInFlight.current++
    onSaveRef
      .current(next)
      .then(() => {
        setSaved(true)
        setTimeout(() => setSaved(false), 1600)
      })
      .catch(() => {
        // save failed (caller already toasted) — drop the local copy and re-render from the prop
        setLocal(null)
        lastRenderedRef.current = null
      })
      .finally(() => {
        savesInFlight.current--
      })
  }

  const onPreviewClick = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement
    if (target instanceof HTMLInputElement && target.type === 'checkbox') {
      onToggleTask(target)
      return
    }
    const a = target.closest('a')
    if (!a) return
    e.preventDefault()
    const fn = a.getAttribute('data-fn') ?? a.getAttribute('data-fnref')
    if (fn) {
      const sel = a.hasAttribute('data-fn') ? `[id="md-fn-${fn}"]` : `[id="md-fnref-${fn}"]`
      previewRef.current?.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      return
    }
    const wikilink = a.getAttribute('data-wikilink')
    if (wikilink) {
      const title = decodeURIComponent(wikilink).toLowerCase()
      const match = useStore.getState().graph.nodes.find((n) => n.title.toLowerCase() === title)
      if (match) {
        useStore.getState().selectNode(match.id)
        useStore.getState().setFocusNode(match.id)
      }
    } else if (a.href && /^https?:/.test(a.href)) {
      window.ozmo.openExternal(a.href)
    }
  }

  return (
    <div className="spec-editor">
      <div className="editor-bar">
        <button className={`btn sm ${mode === 'preview' ? '' : 'ghost'}`} onClick={() => setMode('preview')}>read</button>
        <button className={`btn sm ${mode === 'edit' ? '' : 'ghost'}`} onClick={() => setMode('edit')}>edit</button>
        <span className={`status ${dirty ? 'dirty' : ''}`}>
          {dirty ? 'unsaved · autosaves' : saved ? 'saved ✓' : 'ctrl+s to save'}
        </span>
      </div>
      {/* ONE of these, never both (faykarta: "displays the content twice").
          The keys are load-bearing: both branches are a <div> in the same slot,
          so without them React RECONCILES them into the SAME DOM node — it just
          swaps className and ref. The preview writes its HTML imperatively
          (el.innerHTML, outside React's tree), so that reused node arrived in
          edit mode still carrying the rendered spec, and CodeMirror then mounted
          its editor underneath it: the spec, twice, in one panel. Distinct keys
          force a real unmount/mount, so the editor host is always empty. */}
      {mode === 'edit'
        ? <div key="edit" className="cm-host" ref={hostRef} />
        : <div key="preview" className="md" ref={previewRef} onClick={onPreviewClick} />}
    </div>
  )
}
