/**
 * The bundle entry for `smoke-accounts.mjs`.
 *
 * It exists so the test drives the SHIPPED modules rather than a paraphrase of
 * them: esbuild follows these two imports into `src/main`, and what the suite
 * exercises is the same `account-local.ts` and `db.ts` the app runs.
 */
export { openDb, closeDb } from '../../src/main/db'
export { localAccounts } from '../../src/main/account-local'
