import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { useStore } from './store'
import './styles.css'

const store = useStore.getState()
store.boot()
window.ozmo.onEvent((evt) => useStore.getState().handleEvent(evt as never))

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
