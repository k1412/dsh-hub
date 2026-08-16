/** Package-owned invariant companion. @module @k1412/dsh-hub-client-ui/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@k1412/dsh-hub-client-ui'

/** Cordis companion plugin name. */
export const name = 'hub-client-ui-invariant'
/** Service required before package ownership is reserved. */
export const inject = ['invariants']
/** Browser settings do not own node-side runtime state. */
const install: InvariantInstaller = () => {}
/** Register package ownership with the invariant service. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
