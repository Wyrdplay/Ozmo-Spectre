import { EventEmitter } from 'events'
import type { OzmoEvent } from '@shared/types'

const emitter = new EventEmitter()
emitter.setMaxListeners(100)

export function emitEvent(type: string, projectId: string | undefined, data: unknown, actor?: string): void {
  const evt: OzmoEvent = { type, projectId, data, actor, at: Date.now() }
  emitter.emit('event', evt)
}

export function onEvent(listener: (evt: OzmoEvent) => void): () => void {
  emitter.on('event', listener)
  return () => emitter.off('event', listener)
}
