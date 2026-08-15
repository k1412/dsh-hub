/** Package-owned invariant companion for Hub Connector. @module @k1412/dsh-hub-connector/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@k1412/dsh-hub-connector'

/** Cordis companion plugin name. */
export const name = 'hub-connector-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the Connector's live contract is its required
 * `apiProxy` injection, while repository runtime-closure gates enforce its
 * forbidden Web dependencies.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
