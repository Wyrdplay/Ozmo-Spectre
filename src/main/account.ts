import type { Account, AccountRole, AccountState } from '@shared/types'

/**
 * THE ACCOUNT SEAM.
 *
 * Who is allowed on this board is not the board's business to decide, and the
 * decision has already been made about where it belongs: **Atlas services on
 * the local machine manage the account.** Atlas has no account concept today —
 * it distributes builds — so this is the shape that capability will take,
 * written now and implemented locally, exactly as the storage seam was written
 * before the native driver was trusted.
 *
 * The local provider is not a stub. It is the whole feature, backed by the
 * board's own database, and it is what a single-machine Spectre should keep
 * using even after Atlas exists. The Atlas provider is a second implementation
 * of the same verbs — the seam is what makes it a swap rather than a rewrite.
 *
 * ## What this is, said honestly
 *
 * An approved display name is an **allowlist**, not authentication. It stops
 * the unknown and the accidental. It does not stop anyone who knows an approved
 * name from typing it, and holding a session token proves only that someone
 * once claimed that name on this machine.
 *
 * The security boundary today is the loopback bind and the Origin check in
 * `server.ts`, not this. That is a defensible position for a tool on one desk;
 * it stops being one the moment the API binds wider, and the two MUST move
 * together. `A person is authenticated, not asserted` is the node that closes
 * this gap, and it is not closed by this file.
 */

export type { Account, AccountRole, AccountState }

export interface IssuedSession {
  account: Account
  /** The bearer token. Returned exactly once, at request time. */
  token: string
}

export interface AccountProvider {
  readonly name: 'local' | 'atlas'
  /** Where accounts live, for the UI to say out loud. */
  readonly label: string

  /** Every account, newest request first. Owner-only at the call site. */
  list(): Account[]
  get(id: string): Account | undefined

  /**
   * Onboard. Returns a session token even while the account is pending — the
   * person needs something to hold while they wait, or being approved would
   * require them to type their name again and hope.
   *
   * Claiming a name that already exists RESUMES it rather than creating a
   * second: a rejected person who tries again is the same person, and a second
   * row would launder the rejection into a fresh pending request.
   */
  request(displayName: string, client: string): IssuedSession

  approve(id: string, by: string): Account
  reject(id: string, by: string, note?: string): Account

  /**
   * Change what someone may do. Refuses `owner` and refuses to touch the owner
   * row: owner is claimed at the machine, never granted.
   */
  setRole(id: string, role: AccountRole, by: string): Account

  /** The account a bearer token names, or undefined. Reads state FRESH. */
  resolve(token: string): Account | undefined
  revoke(token: string): void

  /**
   * The account for whoever is physically at the machine running the core.
   *
   * They have the database and the vault on their own disk. Gating them behind
   * a screen they could bypass with a text editor is theatre, and the standing
   * requirement is that existing single-user boards keep working without anyone
   * logging in. On a fresh board this CLAIMS the owner from the display name in
   * settings; afterwards it returns that owner.
   */
  ownerAtTheMachine(displayName: string): Account

  /**
   * A session for the owner, minted for whoever holds the HOST.
   *
   * `ownerAtTheMachine` answers "who is the owner" for a caller the process can
   * see is local. A container has no such caller — headless never sets
   * atTheMachine — and `request()` refuses the owner's name over the wire by
   * design. Between them, a containerised board's owner is claimed exactly once,
   * in the call that mints their first session, and is unreachable forever after
   * that session is lost. This is the way back, and it is deliberately not
   * reachable through the API: only a process started by the person holding the
   * host may call it.
   *
   * Every existing session for the owner is revoked first. Recovery is for the
   * case where the old one is gone or out of the owner's hands, and both readings
   * say the same thing about whether it should keep working.
   */
  recoverOwnerSession(displayName: string, client: string): IssuedSession
}

let provider: AccountProvider | null = null

export function setAccountProvider(p: AccountProvider): void {
  provider = p
}

export function accounts(): AccountProvider {
  if (!provider) throw new Error('account provider not installed')
  return provider
}

/** Characters a display name may not contain, spelled out rather than escaped. */
const FORBIDDEN = new Set(['<', '>', '[', ']', '{', '}', '|', '\\', '/', '"', '`'])

/**
 * Display names are the attribution in every note, comment and activity row,
 * so they are validated rather than sanitised: a silently-corrected name
 * attributes work to somebody who does not exist.
 *
 * Checked by code point rather than by regex because the set that matters most
 * — the control characters — cannot be written as literals in source without
 * becoming invisible to the next person reading it.
 */
export function normaliseDisplayName(raw: unknown): string {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ')
  if (name.length < 2) throw new Error('a display name needs at least 2 characters')
  if (name.length > 40) throw new Error('a display name is at most 40 characters')

  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) {
      throw new Error('a display name cannot contain control characters')
    }
    if (FORBIDDEN.has(ch)) {
      throw new Error(`a display name cannot contain ${[...FORBIDDEN].join(' ')}`)
    }
  }
  return name
}

export const nameKey = (name: string): string => name.toLowerCase()
