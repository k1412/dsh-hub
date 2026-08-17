/** Copy-safe one-command entry points for the released node installers. */

import type { EnrollmentGrant } from './api.ts'

const releaseVersion = '1.0.2'
const releaseAssetRoot = `https://github.com/k1412/dsh-hub/releases/download/hub-v${releaseVersion}`

/** Installer command family exposed by the enrollment panel. */
export type NodeInstallPlatform = 'unix' | 'windows'

function shellLiteral(value: string): string {
  return `'${value.replaceAll('\u0027', String.raw`'"'"'`)}'`
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll('\u0027', '\u0027\u0027')}'`
}

/**
 * Build the one command that installs the Connector plugin and Node Agent.
 * The short-lived enrollment code may enter shell history; the installer
 * prompts for the long-lived Cloudflare secret through the terminal.
 * @param grant - one-time node enrollment reservation.
 * @param hubOrigin - authenticated Hub HTTPS origin.
 * @param platform - Unix shell or Windows PowerShell command family.
 * @returns a complete command with no placeholder fields.
 */
export function nodeInstallCommand(
  grant: Pick<EnrollmentGrant, 'nodeId' | 'code'>,
  hubOrigin: string,
  platform: NodeInstallPlatform,
): string {
  if (platform === 'windows') {
    return [
      `$env:DSH_HUB_URL=${powershellLiteral(hubOrigin)}`,
      `$env:DSH_HUB_NODE_ID=${powershellLiteral(grant.nodeId)}`,
      `$env:DSH_HUB_ENROLLMENT_CODE=${powershellLiteral(grant.code)}`,
      `irm ${releaseAssetRoot}/install-node.ps1 | iex`,
    ].join('; ')
  }
  return `curl -fsSL ${releaseAssetRoot}/install-node.sh | DSH_HUB_ENROLLMENT_CODE=${shellLiteral(grant.code)} bash -s -- --hub ${shellLiteral(hubOrigin)} --node ${shellLiteral(grant.nodeId)}`
}
