import { hostname, homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createRuntimeSurface, type RuntimeContext } from './runtime.ts'
import { readConnectionConfig, startNodeConnector } from './connector.ts'

export { NodeSurface } from './surface.ts'
export { NativeMux } from './stream.ts'
export { createRuntimeSurface } from './runtime.ts'
export { startNodeConnector, readConnectionConfig } from './connector.ts'
export type { NodeConnectionConfig, NodeMetadata, ConnectorStatus } from './connector.ts'

export const name = 'gateway-node'
export const inject = ['connection', 'clientModules', 'typertGateway']
export interface Config { connectionFile?: string; runtimeId?: string; name?: string }
export const Config = z.object({
  connectionFile: z.string().default(join(homedir(), '.dsh-gateway', 'connection.json')),
  runtimeId: z.string().default('default'), name: z.string().default(hostname()),
})

/** Activate inside the existing DSH Runtime; no Web listener or Runtime is created. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const connection = await readConnectionConfig(config.connectionFile ?? join(homedir(), '.dsh-gateway', 'connection.json'))
  const { surface, dshVersion } = await createRuntimeSurface(ctx as unknown as RuntimeContext)
  const ready = ctx.get('appReady') as { onReady(listener: () => void): () => void } | undefined
  ctx.effect(() => {
    let connector: ReturnType<typeof startNodeConnector> | undefined
    const start = () => {
      connector = startNodeConnector({ config: connection, surface,
        metadata: { name: config.name ?? connection.name, runtimeId: config.runtimeId ?? 'default', dshVersion, protocol: 1 },
        onStatus: (status) => { ctx.logger.info(`Gateway ${status.state}: ${status.message}`) },
      })
    }
    const cancelReady = ready?.onReady(start)
    if (!ready) start()
    return async () => { cancelReady?.(); await connector?.close() }
  }, 'gateway-node: paired outbound tunnel')
}
