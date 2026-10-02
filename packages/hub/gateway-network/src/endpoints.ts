import { isIP } from 'node:net'

export type NetworkMode = 'tailscale' | 'tailcat'
export function isNetworkMode(value: unknown): value is NetworkMode {
  return value === 'tailscale' || value === 'tailcat'
}

export function isTailnetIP(host: string): boolean {
  if (isIP(host) === 4) {
    const octets = host.split('.').map(Number)
    const second = octets[1]
    return octets[0] === 100 && second !== undefined && second >= 64 && second <= 127
  }
  return isIP(host) === 6 && host.toLowerCase().startsWith('fd7a:115c:a1e0:')
}

export interface OverlayDestination { host: string; port: number }
function validPort(port: string): number {
  const result = Number(port)
  if (!/^\d+$/.test(port) || result < 1 || result > 65_535) throw new Error('Invalid overlay endpoint port')
  return result
}

export function parseTailscaleEndpoint(endpoint: string): OverlayDestination {
  const url = new URL(endpoint)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== '' ||
      url.search !== '' || url.hash !== '' || url.pathname !== '/' || !isTailnetIP(host)) {
    throw new Error('Tailscale endpoint must be an explicit Tailnet IP; LAN and public endpoints are unsupported')
  }
  return { host, port: validPort(url.port || '80') }
}

export function parseTailcatEndpoint(endpoint: string): OverlayDestination {
  // Do not normalize via HTTP URL parsing: tailcat addresses are case-sensitive.
  const match = /^tailcat:\/\/(tc[A-Za-z0-9_-]{20,}):(\d+)$/.exec(endpoint)
  if (match === null || match[1] === undefined || match[2] === undefined) throw new Error('Invalid Tailcat endpoint')
  return { host: match[1], port: validPort(match[2]) }
}

export function tailscaleEndpoint(ip: string, port: number): string {
  if (!isTailnetIP(ip)) throw new Error('Tailscale reported an unsupported address')
  validPort(String(port))
  return `http://${isIP(ip) === 6 ? `[${ip}]` : ip}:${port}`
}
