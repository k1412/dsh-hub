/** Safe in-place replacement of the Hub Connector in one existing DSH profile. */

import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const CONNECTOR_PACKAGE = '@k1412/dsh-hub-connector'

export type ConnectorInstallCommand = (program: string, args: string[]) => Promise<void>

/**
 * Point an existing profile at a persistent verified Connector tarball, then
 * ask DSH to reconcile the profile. The new pointer remains retryable if the
 * package manager fails; it never points back to an already-deleted temp file.
 */
export async function upgradeConnectorPackage(input: {
  profileDirectory: string
  profileName: string
  dshExecutable: string
  connectorPackage: string
  run: ConnectorInstallCommand
}): Promise<void> {
  const profileDirectory = resolve(input.profileDirectory)
  const connectorPackage = resolve(input.connectorPackage)
  await access(connectorPackage)
  const manifestPath = join(profileDirectory, 'package.json')
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('DSH profile package.json must contain an object')
  }
  const manifest = parsed as Record<string, unknown>
  const dependencies = typeof manifest.dependencies === 'object' && manifest.dependencies !== null
    && !Array.isArray(manifest.dependencies)
    ? manifest.dependencies as Record<string, unknown>
    : {}
  manifest.dependencies = { ...dependencies, [CONNECTOR_PACKAGE]: `file:${connectorPackage}` }
  await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  await input.run(input.dshExecutable, ['plugin', '--profile', input.profileName, 'install'])
}
