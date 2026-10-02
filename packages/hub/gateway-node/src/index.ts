import { ControlRPC } from '@k1412/dsh-gateway-transport'
import { createManagement, type Manager } from './management.ts'
import { createDelegation, type DelegationContext } from './delegation.ts'
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
export interface Config { connectionFile?: string; runtimeId?: string; name?: string; control?: boolean; delegationWorkspace?: string; trustedPackages?: string[]; updateExecutor?: string; installation?: 'npm' | 'docker' | 'external' }
export const Config = z.object({
  connectionFile: z.string().default(join(homedir(), '.dsh-gateway', 'connection.json')),
  runtimeId: z.string().default('default'), name: z.string().default(hostname()),
  control: z.boolean().default(false), installation: z.string().default('external'), delegationWorkspace: z.string().default(''), trustedPackages: z.array(z.string()).default([]), updateExecutor: z.string().default(''),
})

/** Activate inside the existing DSH Runtime; no Web listener or Runtime is created. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const connection = await readConnectionConfig(config.connectionFile ?? join(homedir(), '.dsh-gateway', 'connection.json'))
  const { surface, dshVersion } = await createRuntimeSurface(ctx as unknown as RuntimeContext)
  let rpc: ControlRPC | undefined
  const runtimeId = config.runtimeId ?? 'default'
  const management = config.control ? await createManagement({ stateDirectory: join(connection.stateDir, 'control'), lockDirectory: join(connection.stateDir, 'management.lock'), version: dshVersion, trustedPackages: config.trustedPackages ?? [], installation: config.installation ?? 'external', ...(ctx.get('pluginManager') ? { manager: ctx.get('pluginManager') as Manager } : {}), ...(config.updateExecutor ? { updateExecutor: config.updateExecutor } : {}) }) : undefined
  const delegation = config.control && config.delegationWorkspace ? await createDelegation({
    tools: ctx.get('tools'), agents: ctx.get('agents'), agentDefaultModel: ctx.get('agentDefaultModel'), sessions: ctx.get('sessions'), sessionController: ctx.get('sessionController'),
  } as DelegationContext, { stateDirectory: join(connection.stateDir, 'control'), workspace: config.delegationWorkspace, runtimeId, call: async (method, input) => { if (!rpc) throw new Error('Control unsupported or disconnected'); return rpc.call(method, input) } }) : undefined
  const ready = ctx.get('appReady') as { onReady(listener: () => void): () => void } | undefined
  ctx.effect(() => {
    let connector: ReturnType<typeof startNodeConnector> | undefined
    const start = () => {
      connector = startNodeConnector({ config: connection, surface,
        ...(management ? { control: { capabilities: ['management', ...(delegation ? ['delegation'] : [])], connected: (value: ControlRPC | undefined) => { rpc = value }, handle: async (method: string, input: Record<string, unknown>) => { if (method.startsWith('management.')) return management.handle(method, input); if (delegation) return delegation.handle(method, input); throw new Error('Delegation not configured') } } } : {}),
        metadata: { name: config.name ?? connection.name, runtimeId: config.runtimeId ?? 'default', dshVersion, protocol: 1 },
        onStatus: (status) => { ctx.logger.info(`Gateway ${status.state}: ${status.message}`) },
      })
    }
    const cancelReady = ready?.onReady(start)
    if (!ready) start()
    return async () => { cancelReady?.(); await connector?.close(); await delegation?.close() }
  }, 'gateway-node: paired outbound tunnel')
}
