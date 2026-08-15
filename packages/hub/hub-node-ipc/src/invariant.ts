/** Package-owned invariant companion for Hub node IPC. @module @k1412/dsh-hub-node-ipc/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { createHubIpcProof, generateHubIpcSecret } from './index.ts'

const PACKAGE_NAME = '@k1412/dsh-hub-node-ipc'
export const name = 'hub-node-ipc-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = (_ctx: Context, fail: InvariantFailure) => {
  const proof = createHubIpcProof(
    generateHubIpcSecret(), 'AAAAAAAAAAAAAAAA', 'default-runtime', 'BBBBBBBBBBBBBBBB', '1.0.0',
  )
  if (proof.length !== 43) fail('Hub IPC HMAC invariant failed')
}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
