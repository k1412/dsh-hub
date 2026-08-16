/** Package-owned invariant companion for Hub capability contracts. @module @k1412/dsh-hub-capabilities/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { hubCapabilityContracts } from './index.ts'

const PACKAGE_NAME = '@k1412/dsh-hub-capabilities'

/** Cordis companion plugin name. */
export const name = 'hub-capabilities-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Verify unique capability names at invariant activation. */
const install: InvariantInstaller = (_ctx: Context, fail: InvariantFailure) => {
  const names = hubCapabilityContracts.map(contract => contract.descriptor.name)
  if (new Set(names).size !== names.length) fail('duplicate Hub capability contract')
}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
