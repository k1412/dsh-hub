/** Package-owned invariant companion for the Hub Node Agent. @module @k1412/dsh-hub-node-agent/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@k1412/dsh-hub-node-agent'
export const name = 'hub-node-agent-invariant'
export const inject = ['invariants']
/** No runtime invariant: this out-of-process supervisor has direct lifecycle tests. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
