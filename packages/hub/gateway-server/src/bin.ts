#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { GatewayNetworkManager } from '@k1412/dsh-gateway-network'
import { CloudflareAccessVerifier } from '@k1412/dsh-hub-server'
import { createGateway } from './server.ts'

const env = process.env
const state = resolve(env.DSH_GATEWAY_STATE_DIRECTORY ?? './gateway-state')
const privatePort = Number(env.DSH_GATEWAY_PRIVATE_PORT ?? 8081)
const port = Number(env.PORT ?? 8080)
for (const value of [port, privatePort]) if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error('Invalid gateway port')
interface AuthFile { teamDomain?: string; audience?: string; operatorEmails?: string[]; originSecret?: string; ownerPassword?: string }
const auth: AuthFile = env.DSH_GATEWAY_AUTH_FILE ? JSON.parse(await readFile(env.DSH_GATEWAY_AUTH_FILE, 'utf8')) as AuthFile : {}
const teamDomain = auth.teamDomain ?? env.DSH_GATEWAY_CF_TEAM_DOMAIN
const audience = auth.audience ?? env.DSH_GATEWAY_CF_AUDIENCE
const operatorEmails = auth.operatorEmails ?? env.DSH_GATEWAY_OPERATOR_EMAILS?.split(',')
// Compose passes unset optional variables as empty strings. Only wholly blank
// Access settings are absent; any nonblank field still requires the full set.
const accessConfigured = [teamDomain, audience, operatorEmails?.join(',')].some(value => Boolean(value?.trim()))
if (accessConfigured
  && (!teamDomain?.trim() || !audience?.trim() || !operatorEmails?.length || operatorEmails.some(email => !email.trim()))) {
  throw new Error('Cloudflare authentication requires team domain, audience and operator emails together')
}
const verifier = accessConfigured && teamDomain && audience && operatorEmails ? new CloudflareAccessVerifier({ teamDomain, audience, operatorEmails }) : undefined
const originSecret = auth.originSecret ?? env.DSH_GATEWAY_ORIGIN_SECRET
const networks = new GatewayNetworkManager({ stateDirectory: join(state, 'network'), privatePort,
  overlayPort: Number(env.DSH_GATEWAY_OVERLAY_PORT ?? privatePort),
  ...(env.DSH_GATEWAY_NETWORK_BIN ? { binDirectory: env.DSH_GATEWAY_NETWORK_BIN } : {}),
  tailscaleMode: env.DSH_GATEWAY_TAILSCALE_MODE === 'host' ? 'host' : 'managed',
  ...(env.DSH_GATEWAY_TAILSCALE_SOCKET ? { tailscaleSocket: env.DSH_GATEWAY_TAILSCALE_SOCKET } : {}),
  hostname: env.DSH_GATEWAY_TAILSCALE_HOSTNAME ?? 'dsh-gateway',
})
const gateway = createGateway({ sessionDirectory: env.DSH_GATEWAY_SESSION_DIRECTORY === '1', publicUrl: env.DSH_GATEWAY_PUBLIC_URL ?? `http://localhost:${port}`,
  ...(env.DSH_GATEWAY_DOWNLOAD_URL ? { downloadUrl: env.DSH_GATEWAY_DOWNLOAD_URL } : {}),
  statePath: join(state, 'gateway.sqlite'), networks,
  downloadsDirectory: resolve(env.DSH_GATEWAY_DOWNLOADS_DIRECTORY ?? './downloads'),
  installerPath: resolve(env.DSH_GATEWAY_INSTALLER_PATH ?? './install.sh'),
  ...(originSecret ? { originSecret } : {}),
  ...(verifier ? { authenticateOperator: async (request) => { await verifier.verifyHuman(request.headers); return true } }
    : { adminPassword: auth.ownerPassword ?? env.DSH_GATEWAY_OWNER_PASSWORD ?? '' }),
})
const listen = (server: typeof gateway.publicServer, listenPort: number, host: string) => new Promise<void>((ok, fail) => {
  server.once('error', fail); server.listen(listenPort, host, () => { server.off('error', fail); ok() })
})
await listen(gateway.privateServer, privatePort, '127.0.0.1')
await listen(gateway.publicServer, port, env.DSH_GATEWAY_HOST ?? '0.0.0.0')
console.info(`DSH Gateway 2.0.0-alpha.1 listening on port ${port}`)
void networks.start().catch(() => console.error('Network initialization failed; check connection settings'))
let closing = false
async function shutdown(): Promise<void> {
  if (closing) return; closing = true
  // Keep the overlay alive long enough to deliver the carrier disconnect.
  // Otherwise remote nodes can only notice a planned restart via heartbeat.
  try { await gateway.close() }
  finally { await networks.close() }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void shutdown().then(() => process.exit(0), () => process.exit(1)) })
