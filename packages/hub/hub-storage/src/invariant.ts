/** Package-owned invariant companion for DSH Hub storage. @module @k1412/dsh-hub-storage/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@k1412/dsh-hub-storage'

/** Cordis companion plugin name. */
export const name = 'hub-storage-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: SQLite constraints, legal command transitions, content
 * hashes, reference counts, and the append-only audit chain are enforced at every
 * storage mutation and exercised by the package test suite.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
