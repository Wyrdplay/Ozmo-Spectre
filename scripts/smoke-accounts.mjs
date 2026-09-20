/* The onboarding decisions, against the SHIPPED account provider.
 *
 *   npm run smoke:accounts
 *
 * smoke-client.mjs exercises the gate over HTTP, which reaches everything a
 * network client can do — and deliberately not the owner's verbs, because
 * approving and rejecting are at-the-machine only. Those are the decisions with
 * teeth, so they are tested here instead of left to a screenshot: this bundles
 * the real account-local.ts over the real db.ts and drives it directly, exactly
 * as db-parity.mjs does.
 *
 * Runs headless under Electron's Node against a scratch database. It cannot
 * touch a running Spectre or a real vault.
 */
import { reexecUnderElectron, ROOT } from './lib/electron-node.mjs'
reexecUnderElectron(import.meta.url)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let failures = 0
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name} ${extra}`)
  }
}

/** Did this throw, and did the message say why? */
const refuses = (fn, pattern) => {
  try {
    fn()
    return false
  } catch (e) {
    return pattern.test(String(e?.message ?? e))
  }
}

// --- bundle the real modules, so this tests shipped code and not a paraphrase
const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'ozmo-accounts')
fs.mkdirSync(BUILD_DIR, { recursive: true })
const bundle = path.join(BUILD_DIR, 'accounts.bundle.cjs')

await esbuild.build({
  entryPoints: [path.join(ROOT, 'scripts', 'lib', 'accounts-entry.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  alias: { '@shared': path.join(ROOT, 'src', 'shared') },
  logLevel: 'warning'
})

const mod = require(bundle)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ozmo-accounts-'))
const dbFile = path.join(scratch, 'spec.db')

console.log(`smoke-accounts → ${dbFile}`)
await mod.openDb(dbFile)
const acc = mod.localAccounts()

// --- the first name through the door owns the board ------------------------
{
  const first = acc.request('Faykarta', 'test')
  ok('a board with no owner gives the first name the board',
    first.account.isOwner === true && first.account.state === 'approved', JSON.stringify(first.account))
  ok('and it issues a session', typeof first.token === 'string' && first.token.length > 20)
}

// --- everyone after waits ---------------------------------------------------
let riley
{
  riley = acc.request('Riley Vance', 'test')
  ok('the second name is pending, not approved', riley.account.state === 'pending', JSON.stringify(riley.account))
  ok('a pending person still gets a token to hold', typeof riley.token === 'string')
  ok('the token resolves to the pending account',
    acc.resolve(riley.token)?.state === 'pending')
}

// --- the owner is not claimable over the wire --------------------------------
{
  ok('claiming the owner name is refused, and says where it can be used',
    refuses(() => acc.request('Faykarta', 'test'), /owner of this board.*machine it runs on/i))
  ok('and refused case-insensitively — "sam" must not become "Sam"',
    refuses(() => acc.request('faykarta', 'test'), /owner of this board/i))
}

// --- one name, one account --------------------------------------------------
{
  const again = acc.request('riley vance', 'test')
  ok('a second claim of the same name RESUMES it rather than minting a rival',
    again.account.id === riley.account.id, `${again.account.id} vs ${riley.account.id}`)
  ok('the newest capitalisation is kept — it is their name',
    again.account.displayName === 'riley vance', again.account.displayName)
  ok('and both tokens work: asking again did not lock them out of the tab they had open',
    !!acc.resolve(riley.token) && !!acc.resolve(again.token))
}

// --- approval ----------------------------------------------------------------
{
  const after = acc.approve(riley.account.id, 'Faykarta')
  ok('approve flips the state and records who decided',
    after.state === 'approved' && after.decidedBy === 'Faykarta' && typeof after.decidedAt === 'number',
    JSON.stringify(after))
  ok('an existing token sees the new state WITHOUT signing in again',
    acc.resolve(riley.token)?.state === 'approved')
}

// --- rejection ---------------------------------------------------------------
{
  const mallory = acc.request('Mallory', 'test')
  const after = acc.reject(mallory.account.id, 'Faykarta', 'not on this project')
  ok('reject records the state, the decider and the note',
    after.state === 'rejected' && after.note === 'not on this project', JSON.stringify(after))
  // A rejection that leaves a live session is a rejection that takes effect
  // whenever they next happen to reload, which is not a decision.
  ok('rejection revokes their sessions immediately', acc.resolve(mallory.token) === undefined)
  ok('the row SURVIVES — a rejection that left no trace is a name asked for again unnoticed',
    acc.list().some((a) => a.displayName === 'Mallory' && a.state === 'rejected'))
  ok('and asking again resumes the rejected row rather than laundering it into a fresh request',
    acc.request('Mallory', 'test').account.state === 'rejected')
}

// --- the owner cannot be rejected off their own board -------------------------
{
  const owner = acc.list().find((a) => a.isOwner)
  ok('the owner cannot be rejected', refuses(() => acc.reject(owner.id, 'Riley Vance'), /owner cannot be rejected/i))
}

// --- sign out -----------------------------------------------------------------
{
  const s = acc.request('Temp Person', 'test')
  acc.revoke(s.token)
  ok('a revoked token resolves to nobody', acc.resolve(s.token) === undefined)
  ok('but the account remains, still pending', acc.list().some((a) => a.displayName === 'Temp Person'))
}

// --- display names are validated, not sanitised --------------------------------
{
  ok('a one-character name is refused', refuses(() => acc.request('x', 'test'), /at least 2/))
  ok('a 41-character name is refused', refuses(() => acc.request('x'.repeat(41), 'test'), /at most 40/))
  ok('markdown- and path-hostile characters are refused',
    refuses(() => acc.request('Bad[Name]', 'test'), /cannot contain/))
  ok('a control character is refused',
    refuses(() => acc.request(`Bad${String.fromCharCode(7)}Name`, 'test'), /control characters/))
  ok('surrounding and doubled whitespace is normalised, not rejected',
    acc.request('  Ada   Lovelace  ', 'test').account.displayName === 'Ada Lovelace')
}

// --- the owner claim is idempotent ---------------------------------------------
{
  const a = acc.ownerAtTheMachine('Someone Else')
  ok('ownerAtTheMachine returns the EXISTING owner rather than minting a second',
    a.displayName === 'Faykarta' && acc.list().filter((x) => x.isOwner).length === 1,
    JSON.stringify(acc.list().filter((x) => x.isOwner)))
}


// --- roles ------------------------------------------------------------------
{
  const acc2 = mod.localAccounts()
  const riley = acc2.list().find((a) => a.displayName === 'riley vance')

  ok('approval makes a VIEWER, not an editor — promoting is a second decision',
    riley?.role === 'viewer', JSON.stringify({ role: riley?.role }))
  ok('the owner holds the owner role', acc2.list().find((a) => a.isOwner)?.role === 'owner')

  const promoted = acc2.setRole(riley.id, 'editor', 'Faykarta')
  ok('setRole promotes to editor', promoted.role === 'editor', JSON.stringify(promoted))
  // The role must be read FRESH on every call, not baked into the token when it
  // was issued — otherwise a promotion or a demotion only lands when the person
  // next signs in, which is not a decision taking effect.
  const held = acc2.request('Held Token Person', 'test')
  acc2.approve(held.account.id, 'Faykarta')
  ok('a held token sees viewer immediately after approval', acc2.resolve(held.token)?.role === 'viewer')
  acc2.setRole(held.account.id, 'editor', 'Faykarta')
  ok('and sees editor the moment the role changes, with no new sign-in',
    acc2.resolve(held.token)?.role === 'editor', JSON.stringify(acc2.resolve(held.token)))
  acc2.setRole(held.account.id, 'viewer', 'Faykarta')
  ok('and sees a DEMOTION just as immediately — the dangerous direction',
    acc2.resolve(held.token)?.role === 'viewer', JSON.stringify(acc2.resolve(held.token)))
  ok('setRole demotes back to viewer', acc2.setRole(riley.id, 'viewer', 'Faykarta').role === 'viewer')

  // The whole reason owner is a role and not a grant.
  ok('owner cannot be GRANTED — it is claimed at the machine',
    refuses(() => acc2.setRole(riley.id, 'owner', 'Faykarta'), /claimed at the machine, never granted/i))
  const owner = acc2.list().find((a) => a.isOwner)
  ok('and the owner row cannot be re-roled out of its own board',
    refuses(() => acc2.setRole(owner.id, 'viewer', 'Faykarta'), /cannot be changed/i))
}

// --- the capability table ----------------------------------------------------
/* The gate is only as good as this table. Two properties matter:
   every method is classified (or editors silently lose verbs), and the roles
   grant what they claim (or the labels lie). */
{
  const reg = Object.keys(mod.registry)
  const classified = Object.keys(mod.capabilityTable)
  const missing = reg.filter((m) => !classified.includes(m))
  const stale = classified.filter((m) => !reg.includes(m))

  ok('every registry method is classified — an unclassified verb is owner-only at runtime, which locks out editors',
    missing.length === 0, missing.join(', '))
  ok('the table names no method that no longer exists', stale.length === 0, stale.join(', '))

  // Default deny, checked rather than assumed.
  ok('an unknown method is refused to an editor — default deny', mod.roleAllows('editor', 'not.a.real.method') === false)
  ok('...and to a viewer', mod.roleAllows('viewer', 'not.a.real.method') === false)

  ok('a viewer may read the board', mod.roleAllows('viewer', 'graph.get') && mod.roleAllows('viewer', 'nodes.get'))
  ok('a viewer may comment', mod.roleAllows('viewer', 'nodes.annotate') && mod.roleAllows('viewer', 'edges.annotate'))
  ok('a viewer may NOT change what the board says',
    !mod.roleAllows('viewer', 'nodes.update') && !mod.roleAllows('viewer', 'nodes.setContent') &&
    !mod.roleAllows('viewer', 'edges.create') && !mod.roleAllows('viewer', 'nodes.create'))
  ok('an editor may write but may NOT decide who is on the board',
    mod.roleAllows('editor', 'nodes.update') && !mod.roleAllows('editor', 'accounts.approve') &&
    !mod.roleAllows('editor', 'accounts.setRole'))
  // settings.update is a WRITE (it carries the board's flag rules and styling);
  // the machine-facing FIELDS inside it are refused in the handler. Target
  // management is machine-facing outright.
  ok('an editor may edit board settings', mod.roleAllows('editor', 'settings.update'))
  ok('an editor may NOT change the filesystem roots the installer writes into',
    !mod.roleAllows('editor', 'skills.addTarget') && !mod.roleAllows('editor', 'skills.removeTarget'))
  ok('the owner may do everything the registry offers',
    reg.every((m) => mod.roleAllows('owner', m)), reg.filter((m) => !mod.roleAllows('owner', m)).join(', '))

  // Nothing that writes the filesystem outside the vault may be a viewer's.
  // An admin runs the GUEST LIST, not the machine. These two lists are the whole
  // difference between the roles, so they are asserted separately rather than as
  // one bag of "privileged".
  const machineOnly = ['skills.addTarget', 'skills.removeTarget', 'skills.setTargetEnabled',
    'board.lock', 'board.unlock']
  ok('machine-facing verbs are the owner alone — not an admin, not an editor, not a viewer',
    machineOnly.every((m) => mod.roleAllows('owner', m) &&
      !mod.roleAllows('admin', m) && !mod.roleAllows('editor', m) && !mod.roleAllows('viewer', m)),
    machineOnly.filter((m) => mod.roleAllows('admin', m) || mod.roleAllows('editor', m)).join(', '))

  const membership = ['accounts.list', 'accounts.approve', 'accounts.reject', 'accounts.setRole']
  ok('membership is the owner and admins, and nobody below',
    membership.every((m) => mod.roleAllows('owner', m) && mod.roleAllows('admin', m) &&
      !mod.roleAllows('editor', m) && !mod.roleAllows('viewer', m)),
    membership.filter((m) => !mod.roleAllows('admin', m) || mod.roleAllows('editor', m)).join(', '))

  ok('an admin may also change what the board says', mod.roleAllows('admin', 'nodes.update'))
  ok('an admin may NOT reconfigure the machine', !mod.roleAllows('admin', 'skills.addTarget'))
  ok('an admin may NOT close the board', !mod.roleAllows('admin', 'board.lock'))

  // The rule the gate enforces row-by-row, asserted on the table that feeds it.
  ok('the owner may grant admin', mod.rolesGrantableBy('owner').includes('admin'))
  ok('an admin may NOT grant admin — one borrowed name must not become the guest list',
    !mod.rolesGrantableBy('admin').includes('admin'))
  ok('an admin may grant viewer and editor',
    mod.rolesGrantableBy('admin').includes('viewer') && mod.rolesGrantableBy('admin').includes('editor'))
  ok('nobody grants owner',
    !mod.rolesGrantableBy('owner').includes('owner') && !mod.rolesGrantableBy('admin').includes('owner'))
}

mod.closeDb?.()
try {
  fs.rmSync(scratch, { recursive: true, force: true })
} catch {
  /* windows may hold the file a moment longer; the temp dir is disposable */
}

console.log(failures === 0 ? '\nall account checks passed ✓' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
