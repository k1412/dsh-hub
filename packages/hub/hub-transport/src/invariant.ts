/** Package-owned invariant companion for reliable Hub transport. @module @k1412/dsh-hub-transport/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@k1412/dsh-hub-transport'

/** Cordis companion plugin name. */
export const name = 'hub-transport-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the SQLite journal transactionally enforces sequence
 * allocation, contiguous acceptance, recovery state, and quota bounds.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
