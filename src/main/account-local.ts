import crypto from 'crypto'
import * as db from './db'
import { emitEvent } from './events'
import { nameKey, normaliseDisplayName, type Account, type AccountProvider, type IssuedSession } from './account'
import { newId, type AccountRole, type AccountState } from '@shared/types'

/**
 * Accounts in the board's own database.
 *
 * The provider Atlas will replace, and the one a single-machine Spectre should
 * keep. Nothing here reaches outside the process, which is the point: a board
 * on one desk must not acquire a service dependency to let its owner in.
 */

interface Row {
  id: string
  display_name: string
  display_name_key: string
  state: string
  role: string
  is_owner: number
  created_at: number
  decided_at: number | null
  decided_by: string | null
  note: string | null
}

const map = (r: Row): Account => ({
  id: r.id,
  displayName: r.display_name,
  state: r.state as AccountState,
  role: (r.role as AccountRole) ?? 'viewer',
  isOwner: r.is_owner === 1,
  createdAt: r.created_at,
  decidedAt: r.decided_at ?? undefined,
  decidedBy: r.decided_by ?? undefined,
  note: r.note ?? undefined
})

const rowById = (id: string): Row | undefined => db.get<Row>('SELECT * FROM accounts WHERE id = ?', [id])
const rowByKey = (key: string): Row | undefined => db.get<Row>('SELECT * FROM accounts WHERE display_name_key = ?', [key])

/**
 * 32 bytes from the CSPRNG. Not a JWT and not signed: it is a random string
 * looked up in a table, so revoking it is a DELETE and there is no key to leak,
 * rotate or get wrong. The lookup reads the account's state fresh, so approval
 * and revocation both take effect on the next request.
 */
const newToken = (): string => crypto.randomBytes(32).toString('base64url')

/**
 * The owner row, claiming it if the board has none.
 *
 * Shared by the two callers that are allowed to name an owner without asking
 * anyone: the desktop renderer (which is demonstrably at the machine) and the
 * host operator who started a container. Both are the same claim, so they are
 * the same code — a second implementation of "who owns this board" is how the
 * two would come to disagree.
 */
function claimOwner(displayName: string): Row {
  const existing = db.get<Row>('SELECT * FROM accounts WHERE is_owner = 1')
  if (existing) return existing

  const name = normaliseDisplayName(displayName || 'Owner')
  const key = nameKey(name)
  const taken = rowByKey(key)
  if (taken) {
    db.run('UPDATE accounts SET is_owner = 1, role = ?, state = ?, decided_at = ?, decided_by = ? WHERE id = ?',
      ['owner', 'approved', Date.now(), 'first run', taken.id])
    return rowById(taken.id)!
  }
  const id = newId('ac')
  db.run(
    `INSERT INTO accounts (id, display_name, display_name_key, state, role, is_owner, created_at, decided_at, decided_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, name, key, 'approved', 'owner', 1, Date.now(), Date.now(), 'first run']
  )
  const row = rowById(id)!
  emitEvent('account.claimed', undefined, map(row), name)
  return row
}

export function localAccounts(): AccountProvider {
  return {
    name: 'local',
    label: 'this machine',

    list(): Account[] {
      return db.all<Row>('SELECT * FROM accounts ORDER BY created_at DESC').map(map)
    },

    get(id: string): Account | undefined {
      const r = rowById(id)
      return r ? map(r) : undefined
    },

    request(displayName: string, client: string): IssuedSession {
      const name = normaliseDisplayName(displayName)
      const key = nameKey(name)

      let row = rowByKey(key)

      /**
       * THE OWNER IS NOT CLAIMABLE OVER THE WIRE.
       *
       * An allowlist has a known property: anyone who knows an approved name
       * can type it. For an ordinary member that is the cost of not having
       * authentication yet, and it is written down. For the OWNER it is not a
       * cost, it is the end of the gate — claiming that one name would grant
       * the right to approve accounts, starting with your own, and every other
       * refusal in this file would be decoration.
       *
       * So the owner account is served at the machine and nowhere else. The
       * person who owns the board decides who joins it while sitting at the
       * machine that holds it. That stops being a limitation when a person is
       * authenticated rather than asserted; until then it is the difference
       * between a gate and a suggestion.
       */
      if (row?.is_owner === 1) {
        throw new Error(`"${row.display_name}" is the owner of this board and can only be used at the machine it runs on. Choose another name.`)
      }

      if (!row) {
        // A board with no owner yet has nobody who could approve anyone, so the
        // first name through the door claims it. Everyone after waits.
        const ownerExists = !!db.get<{ n: number }>('SELECT COUNT(*) AS n FROM accounts WHERE is_owner = 1')?.n
        const id = newId('ac')
        const state: AccountState = ownerExists ? 'pending' : 'approved'
        db.run(
          `INSERT INTO accounts (id, display_name, display_name_key, state, role, is_owner, created_at, decided_at, decided_by)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          // The first name claims the board and is the owner. Everyone after is
          // a VIEWER the moment they are approved — promoting is a separate,
          // deliberate act, so the careless path is the safe one.
          [id, name, key, state, ownerExists ? 'viewer' : 'owner', ownerExists ? 0 : 1,
           Date.now(), ownerExists ? null : Date.now(), ownerExists ? null : 'first run']
        )
        row = rowById(id)!
        emitEvent(state === 'pending' ? 'account.requested' : 'account.claimed', undefined, map(row), name)
      } else if (row.display_name !== name) {
        // Same name, different capitalisation. Keep what they typed most
        // recently — it is their name — without minting a second account.
        db.run('UPDATE accounts SET display_name = ? WHERE id = ?', [name, row.id])
        row = rowById(row.id)!
      }

      const token = newToken()
      db.run('INSERT INTO sessions (token, account_id, created_at, last_seen_at, client) VALUES (?,?,?,?,?)',
        [token, row.id, Date.now(), Date.now(), client])
      return { account: map(row), token }
    },

    approve(id: string, by: string): Account {
      const row = rowById(id)
      if (!row) throw new Error(`no account ${id}`)
      db.run('UPDATE accounts SET state = ?, decided_at = ?, decided_by = ?, note = NULL WHERE id = ?',
        ['approved', Date.now(), by, id])
      const after = map(rowById(id)!)
      emitEvent('account.approved', undefined, after, by)
      return after
    },

    reject(id: string, by: string, note?: string): Account {
      const row = rowById(id)
      if (!row) throw new Error(`no account ${id}`)
      if (row.is_owner === 1) throw new Error('the owner cannot be rejected')
      db.run('UPDATE accounts SET state = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ?',
        ['rejected', Date.now(), by, note ?? null, id])
      // Their sessions go with the decision. Leaving them would let a rejected
      // person keep reading until they happened to reload.
      db.run('DELETE FROM sessions WHERE account_id = ?', [id])
      const after = map(rowById(id)!)
      emitEvent('account.rejected', undefined, after, by)
      return after
    },

    setRole(id: string, role: AccountRole, by: string): Account {
      const row = rowById(id)
      if (!row) throw new Error(`no account ${id}`)
      if (row.is_owner === 1) throw new Error('the board owner has every capability by definition; their role cannot be changed')
      if (role === 'owner') {
        throw new Error('owner is claimed at the machine, never granted — approving is the privilege that lets someone let themselves in, and a display name is asserted rather than proved')
      }
      db.run('UPDATE accounts SET role = ? WHERE id = ?', [role, id])
      const after = map(rowById(id)!)
      emitEvent('account.role', undefined, after, by)
      return after
    },

    resolve(token: string): Account | undefined {
      if (!token) return undefined
      const s = db.get<{ account_id: string }>('SELECT account_id FROM sessions WHERE token = ?', [token])
      if (!s) return undefined
      const r = rowById(s.account_id)
      if (!r) return undefined
      // last_seen is written on a coarse grain deliberately: a write per request
      // would make every read a write, on a database whose whole point is that
      // writes are the expensive thing.
      db.run('UPDATE sessions SET last_seen_at = ? WHERE token = ? AND last_seen_at < ?',
        [Date.now(), token, Date.now() - 60_000])
      return map(r)
    },

    revoke(token: string): void {
      db.run('DELETE FROM sessions WHERE token = ?', [token])
    },

    ownerAtTheMachine(displayName: string): Account {
      return map(claimOwner(displayName))
    },

    recoverOwnerSession(displayName: string, client: string): IssuedSession {
      const row = claimOwner(displayName)

      // Pointing the board at a DIFFERENT name is not recovery, it is a transfer
      // of ownership — and doing that silently because an environment variable
      // disagreed with the database is how a board gets lost to a typo. The
      // existing owner wins, loudly.
      if (displayName) {
        const want = nameKey(normaliseDisplayName(displayName))
        if (want !== row.display_name_key) {
          throw new Error(
            `this board is owned by "${row.display_name}", not "${normaliseDisplayName(displayName)}". ` +
              'Recovery issues a session for the owner it already has; it does not transfer ownership.'
          )
        }
      }

      // Every existing session goes. Recovery means the old one is gone or out
      // of the owner's hands, and both of those say the same thing about whether
      // it should keep working.
      const had = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?', [row.id])?.n ?? 0
      db.run('DELETE FROM sessions WHERE account_id = ?', [row.id])

      const token = newToken()
      db.run('INSERT INTO sessions (token, account_id, created_at, last_seen_at, client) VALUES (?,?,?,?,?)',
        [token, row.id, Date.now(), Date.now(), client])
      console.log(`[ozmo] owner recovery: issued a session for "${row.display_name}", revoked ${had}`)
      return { account: map(row), token }
    }
  }
}
