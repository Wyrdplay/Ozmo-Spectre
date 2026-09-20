/**
 * The bundle entry for `smoke-accounts.mjs`.
 *
 * It exists so the test drives the SHIPPED modules rather than a paraphrase of
 * them: esbuild follows these two imports into `src/main`, and what the suite
 * exercises is the same `account-local.ts` and `db.ts` the app runs.
 */
export { openDb, closeDb } from '../../src/main/db'
export { localAccounts } from '../../src/main/account-local'
// The gate is only as good as its classification table, so the test holds the
// registry against it. Importing the registry pulls in the whole service layer,
// which is the point: if that no longer loads headless, the suite says so here
// rather than in production.
export { registry, capabilityTable, roleAllows } from '../../src/main/registry'
// Who may hand out which role. The gate enforces it row-by-row and the People
// card draws its dropdown from it, so a change to the rule is a change here.
export { rolesGrantableBy } from '../../src/shared/types'
