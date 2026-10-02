#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const options = new Map()
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1])
const directory = resolve(options.get('--directory') ?? 'dist/gateway/downloads')
const installDirectory = options.get('--install-directory')
const architecture = options.get('--arch') ?? (process.arch === 'arm64' ? 'arm64' : 'amd64')
if (!['amd64', 'arm64'].includes(architecture)) throw new Error('Only linux amd64/arm64 images are supported')
const pins = JSON.parse(await readFile(fileURLToPath(new URL('./network-pins.json', import.meta.url)), 'utf8'))
await mkdir(directory, { recursive: true })
await writeFile(join(directory, 'network-pins.json'), JSON.stringify(pins) + '\n')
for (const asset of pins.assets) {
  const archive = join(directory, asset.file)
  let data
  try { data = await readFile(archive) } catch {}
  if (data === undefined || createHash('sha256').update(data).digest('hex') !== asset.sha256) {
    // curl honors standard HTTP(S)_PROXY/NO_PROXY variables and the system
    // trust store in controlled build environments. Retries stay bounded.
    const temporary = `${archive}.partial`
    const downloaded = spawnSync('curl', ['--fail', '--silent', '--show-error', '--location',
      '--proto', '=https', '--proto-redir', '=https', '--retry', '3', '--retry-delay', '1',
      '--connect-timeout', '20', '--max-time', '120', '--output', temporary, asset.url],
      { env: process.env, timeout: 180_000, encoding: 'utf8' })
    if (downloaded.status !== 0) throw new Error(`Download failed: ${asset.tool}/${asset.architecture}`)
    data = await readFile(temporary)
    if (createHash('sha256').update(data).digest('hex') !== asset.sha256) {
      throw new Error(`Checksum mismatch: ${asset.tool}/${asset.architecture}`)
    }
    await writeFile(archive, data)
    const { unlink } = await import('node:fs/promises')
    await unlink(temporary)
  }
  if (installDirectory !== undefined && asset.architecture === architecture) {
    await mkdir(installDirectory, { recursive: true })
    const names = asset.tool === 'tailscale' ? ['tailscale', 'tailscaled'] : ['tailcat']
    const list = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    if (list.status !== 0) throw new Error('Cannot inspect network archive')
    for (const name of names) {
      const member = list.stdout.split('\n').find(entry => entry === name || entry.endsWith(`/${name}`))
      if (member === undefined) throw new Error(`Missing ${name} binary`)
      const extraction = spawnSync('tar', ['-xOzf', archive, member], { maxBuffer: 100 * 1024 * 1024 })
      if (extraction.status !== 0) throw new Error(`Cannot extract ${name}`)
      const binary = join(installDirectory, name)
      await writeFile(binary, extraction.stdout)
      await chmod(binary, 0o755)
    }
  }
  process.stdout.write(`Verified ${asset.file}\n`)
}
