import type { OzmoEvent } from '@shared/types'

/**
 * THE HOST SEAM.
 *
 * The renderer is one codebase with two hosts: inside Electron, where the core
 * is the process next door, and inside a browser, where it is a Spectre across
 * the network. Everything that differs between those two lives here and only
 * here — a component that reaches past this seam is the failure the design
 * exists to prevent, because it is the thing that quietly makes the two clients
 * two codebases.
 *
 * `call` and `subscribe` are the whole transport. Everything else on this
 * interface is a HOST CAPABILITY: an affordance that is about the machine
 * rather than the board — a native file dialog, a folder on disk, restarting
 * the process. Those do not port; they are absent. Which is the point of `can`.
 *
 * ## `can` is a promise about the UI, not a guard on the call
 *
 * The web host still implements every method, and they refuse honestly. But a
 * button that explains why it does nothing is worse than a button that is not
 * drawn: a viewer in a browser is not a desktop user who has lost something,
 * they are a viewer of a board, and reveal-in-folder was never theirs to lose.
 * So components ASK `can` and omit the affordance. `HostUnavailable` is the
 * backstop for the case someone forgets, and it says which host they are on.
 */
export interface RpcResult {
  ok: boolean
  data?: unknown
  /** `data` carries ApiError.data — the gate's offender lists, a 409's connection */
  error?: { message: string; status: number; data?: unknown }
}

/** What this host can do beyond talking to the core. */
export interface HostCapabilities {
  /** a native directory picker, choosing a path on the machine the core runs on */
  pickFolder: boolean
  /** put a generated document on the viewer's own machine */
  saveToDisk: boolean
  /**
   * write a generated document into the CORE's vault. Separate from
   * `saveToDisk` because they are different destinations that happen to share
   * one IPC handler: one is the viewer's disk, the other is the server's.
   */
  saveToVault: boolean
  /** show a path in the OS file manager */
  revealFile: boolean
  /** hand a node to Obsidian via its URL scheme */
  openInObsidian: boolean
  /** restart the process hosting the core */
  relaunch: boolean
  /**
   * edit settings that configure the HOST MACHINE — the vault path, the API
   * port, the skill target roots. Distinct from settings that describe the
   * BOARD, which every client may edit.
   */
  configureHost: boolean
}

export interface Host {
  readonly kind: 'electron' | 'web'
  /** A human-readable name for where the core is, for the UI to say out loud. */
  readonly coreLabel: string
  readonly can: HostCapabilities

  call(method: string, payload?: unknown): Promise<RpcResult>
  /**
   * Every mutation, live. The callback fires for events from any project — the
   * store filters, exactly as it does under IPC.
   *
   * `onStatus` reports the health of the link itself. Under Electron it is
   * always connected and fires once; over a network it is a real signal, and a
   * client that hides it is a client showing a stale board with confidence.
   */
  subscribe(cb: (evt: OzmoEvent) => void, onStatus?: (s: LinkStatus) => void): () => void

  pickFolder(): Promise<string | null>
  saveDocument(arg: { markdown: string; filename: string; toVault?: boolean }): Promise<{ ok: boolean; path?: string; canceled?: boolean }>
  revealFile(path: string): Promise<void>
  openInObsidian(nodeId: string): Promise<void>
  openExternal(url: string): Promise<void>
  relaunch(): Promise<void>
}

/**
 * `resync` is the one that matters and the one a naive client omits: the link
 * came back but the gap could not be replayed, so what is on screen is not
 * known to be current. It is not an error — nothing failed — and it must not be
 * silent either. The store answers it by refetching the graph.
 */
export type LinkStatus =
  | { state: 'connected' }
  | { state: 'reconnecting'; attempt: number }
  | { state: 'offline'; reason: string }
  | { state: 'resync'; since: number }

export class HostUnavailable extends Error {
  constructor(what: string, kind: string) {
    super(`"${what}" is not available in the ${kind} client — it addresses the machine the core runs on, not the board.`)
    this.name = 'HostUnavailable'
  }
}

let current: Host | null = null

export function setHost(h: Host): void {
  current = h
}

export function host(): Host {
  if (!current) throw new Error('host not installed — the entry point must call setHost() before rendering')
  return current
}
