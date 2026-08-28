import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { useStore } from './store'
import { setHost, type Host } from './host'
import './styles.css'

/**
 * Everything both clients do, which is everything except choosing a host.
 *
 * The two entry points beside this file are three lines each, deliberately: the
 * moment one of them grows a second difference, the thin client has started
 * becoming a second codebase, and the diff will say so.
 */
export function boot(host: Host): void {
  setHost(host)

  const store = useStore.getState()
  store.boot()
  host.subscribe(
    (evt) => useStore.getState().handleEvent(evt as never),
    (status) => useStore.getState().setLink(status)
  )

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
