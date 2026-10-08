#!/bin/sh
set -eu
umask 077

hub=''
invite=''
profile=''
instance=''
package_alias=''
control=''
state_directory="${XDG_STATE_HOME:-${HOME:?}/.local/state}/dsh-gateway"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --hub) hub="$2"; shift 2 ;;
    --invite) invite="$2"; shift 2 ;;
    --package-alias) package_alias="$2"; shift 2 ;;
    --instance) instance="$2"; shift 2 ;;
    --control) control=1; shift ;;
    --profile) profile="$2"; shift 2 ;;
    --state-directory) state_directory="$2"; shift 2 ;;
    *) printf 'Unknown installer option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
if [ -z "$hub" ] || [ -z "$invite" ]; then
  printf 'Usage: install.sh --hub https://hub.example --invite TOKEN [--profile NAME] [--instance NAME --package-alias npm-name]\n' >&2
  exit 2
fi
case "$invite" in *[!A-Za-z0-9_-]*) printf 'Invalid invitation token.\n' >&2; exit 2 ;; esac
if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js 22 or newer is required. Run this command as the user who owns the existing DSH installation.\n' >&2
  exit 1
fi
node -e 'if(Number(process.versions.node.split(".")[0])<22){process.stderr.write("Node.js 22 or newer is required.\n");process.exit(1)}'
mkdir -p "$state_directory"
state_directory=$(cd "$state_directory" && pwd)
installer_directory=$(mktemp -d "$state_directory/install.XXXXXX")
trap 'rm -rf "$installer_directory"' EXIT
trap 'exit 130' INT
trap 'exit 129' HUP
trap 'exit 143' TERM
printf 'Downloading the Hub invitation and connection plugin…\n'
node --input-type=module - "$hub" "$invite" "$state_directory" "$installer_directory" <<'NODE'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, chmod, open, rename, unlink, access, realpath, symlink, lstat } from 'node:fs/promises'
import { createReadStream, constants } from 'node:fs'
import { join, resolve, delimiter } from 'node:path'
import { spawnSync } from 'node:child_process'

const [hub, invite, stateDirectory, temporary] = process.argv.slice(2)
function checkedURL(value) {
  const url = new URL(value)
  const testLocal = process.env.DSH_GATEWAY_ALLOW_HTTP_TEST === '1' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !testLocal) || url.username || url.password) throw new Error('Downloads require HTTPS')
  return url
}
const hubURL = checkedURL(hub)
if (hubURL.pathname !== '/' || hubURL.search || hubURL.hash) throw new Error('Hub must be a plain origin URL')
function assetName(file, fallback) {
  // Resource paths may contain an invitation capability. Only reviewed public
  // archive naming patterns are eligible for logs; never print URLs or tokens.
  if (typeof file === 'string' && /^(?:gateway-node\.tgz|network\.tgz|network-pins\.json|tailscale_\d+\.\d+\.\d+_(?:amd64|arm64)\.tgz|tailcat_\d+\.\d+\.\d+_linux_(?:amd64|arm64)\.tar\.gz)$/.test(file)) return file
  return fallback
}
const mib = bytes => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
async function existingTailscale(binariesDirectory) {
  process.stderr.write('Tailscale: checking the existing local client (status timeout: 4s).\n')
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory, 'tailscale')
    try {
      await access(candidate, constants.X_OK)
      const binary = await realpath(candidate)
      const socket = process.env.DSH_GATEWAY_TAILSCALE_SOCKET
      const status = spawnSync(binary, [...(socket ? [`--socket=${socket}`] : []), 'status', '--json'],
        { encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024 })
      if (status.status !== 0 || JSON.parse(status.stdout)?.BackendState !== 'Running') return false
      const target = join(binariesDirectory, 'tailscale')
      // Keep an absolute reference: the existing Runtime may have a different PATH.
      // Never replace a binary with a link pointing to itself.
      if (binary !== target) {
        const link = join(temporary, 'host-tailscale')
        await symlink(binary, link)
        await rename(link, target)
      }
      process.stderr.write('Tailscale: reusing the logged-in local client; no network package download or new login.\n')
      return true
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') continue
      // Malformed status is not a usable client. Do not expose status/account data.
      if (error instanceof SyntaxError) return false
      throw error
    }
  }
  return false
}
async function verifiedArchive(path, expected) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > 300 * 1024 * 1024) return false
    const digest = createHash('sha256')
    let bytes = 0
    for await (const chunk of createReadStream(path)) {
      bytes += chunk.length
      if (bytes > 300 * 1024 * 1024) return false
      digest.update(chunk)
    }
    return digest.digest('hex') === expected
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}
async function download(url, path, hash, { name = 'invitation manifest', archive = false } = {}) {
  const maximum = (archive ? 300 : 1) * 1024 * 1024
  const totalMs = archive ? 300_000 : 30_000
  const controller = new AbortController()
  const started = Date.now()
  const partial = `${path}.partial`
  const digest = createHash('sha256')
  const chunks = []
  let phase = 'headers'
  let received = 0
  let expected
  let failure
  let termination
  let file
  let reader
  let idleTimer
  let lastLog = started
  let lastLoggedBytes = 0
  const stop = reason => {
    if (!controller.signal.aborted) { termination = reason; controller.abort() }
  }
  const headerTimer = setTimeout(() => stop('no HTTP response headers within 30 seconds'), 30_000)
  const totalTimer = setTimeout(() => stop(`total download time exceeded ${archive ? '5 minutes' : '30 seconds'}`), totalMs)
  const resetIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => stop('no download progress for 30 seconds'), 30_000)
  }
  process.stderr.write(`Downloading ${name}: headers <=30s, total <=${archive ? '5min' : '30s'}, limit ${mib(maximum)}.\n`)
  try {
    const response = await fetch(checkedURL(url), { signal: controller.signal, redirect: 'follow' })
    clearTimeout(headerTimer)
    checkedURL(response.url)
    if (!response.ok) { failure = `HTTP ${response.status}`; throw new Error(failure) }
    phase = 'body'
    const length = response.headers.get('content-length')
    // fetch decodes compressed HTTP responses. Content-Length then describes
    // compressed bytes, while our limit/hash must apply to decoded bytes.
    if (length !== null && /^\d+$/.test(length) && (!response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity')) expected = Number(length)
    if (expected !== undefined && expected > maximum) {
      failure = `declared size exceeds the ${mib(maximum)} limit`
      throw new Error(failure)
    }
    if (response.body === null) { failure = 'empty download response'; throw new Error(failure) }
    file = await open(partial, 'w', 0o600)
    reader = response.body.getReader()
    resetIdle()
    process.stderr.write(`${name}: connected, ${mib(0)}${expected === undefined ? '' : ` / ${mib(expected)}`}.\n`)
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength === 0) continue
      received += value.byteLength
      resetIdle()
      if (received > maximum) { failure = `received size exceeds the ${mib(maximum)} limit`; throw new Error(failure) }
      digest.update(value)
      if (!archive) chunks.push(Buffer.from(value))
      let offset = 0
      while (offset < value.byteLength) {
        const written = await file.write(value, offset, value.byteLength - offset)
        if (written.bytesWritten === 0) throw new Error('file-write-failed')
        offset += written.bytesWritten
      }
      const now = Date.now()
      if (now - lastLog >= 5000 || received - lastLoggedBytes >= 8 * 1024 * 1024) {
        process.stderr.write(`${name}: ${mib(received)}${expected === undefined ? '' : ` / ${mib(expected)}`}, ${Math.round((now - started) / 1000)}s elapsed.\n`)
        lastLog = now
        lastLoggedBytes = received
      }
    }
    if (expected !== undefined && received !== expected) { failure = 'response ended before the declared size was received'; throw new Error(failure) }
    if (hash !== undefined && digest.digest('hex') !== hash) { failure = 'downloaded package checksum did not match'; throw new Error(failure) }
    await file.close()
    file = undefined
    await rename(partial, path)
    process.stderr.write(`${name}: complete, ${mib(received)}, ${Math.round((Date.now() - started) / 1000)}s${hash === undefined ? '' : ', checksum verified'}.\n`)
    return archive ? undefined : Buffer.concat(chunks)
  } catch (error) {
    controller.abort()
    const reason = termination ?? failure ?? (error?.code === 'ENOSPC' ? 'not enough disk space'
      : phase === 'headers' ? 'connection failed before response headers; check the Hub network'
      : `connection or file write interrupted after ${mib(received)}`)
    throw new Error(`${name}: ${reason}. No partial file was installed; retry the installation command.`)
  } finally {
    clearTimeout(headerTimer)
    clearTimeout(totalTimer)
    clearTimeout(idleTimer)
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
    await file?.close().catch(() => {})
    await unlink(partial).catch(() => {})
  }
}
try {
  const bytes = await download(`${hubURL.origin}/api/enrollment/${invite}`, join(temporary, 'manifest.json'))
  const manifest = JSON.parse(bytes.toString())
  if (!['tailscale', 'tailcat'].includes(manifest.mode)) throw new Error('Only Tailscale and Tailcat invitations are supported')
  if (manifest.protocol !== 1) throw new Error('Unsupported invitation protocol')
  const downloadOrigin = manifest.downloadUrl ?? manifest.hubUrl
  if (downloadOrigin !== undefined && new URL(downloadOrigin).origin !== hubURL.origin) throw new Error('Invitation download origin did not match')
  const expiration = typeof manifest.expiresAt === 'string' ? Date.parse(manifest.expiresAt) : manifest.expiresAt
  if (!Number.isFinite(expiration) || (expiration <= Date.now() && manifest.claimed !== true)) throw new Error('Invitation has expired. Create a new invitation in Hub.')
  if (!manifest.package || !/^[a-f0-9]{64}$/.test(manifest.package.sha256)) throw new Error('Invitation is missing the verified node package')
  const packageFile = join(temporary, 'node.tgz')
  await download(manifest.package.url, packageFile, manifest.package.sha256, { name: 'gateway-node.tgz', archive: true })
  const packageDirectory = join(stateDirectory, 'packages', `gateway-node-${manifest.package.sha256.slice(0, 12)}`)
  await mkdir(packageDirectory, { recursive: true, mode: 0o700 })
  const archiveList = spawnSync('tar', ['-tzf', packageFile], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  if (archiveList.status !== 0) throw new Error('Cannot read plugin archive')
  const paths = archiveList.stdout.split('\n').filter(Boolean)
  if (paths.some(path => path.startsWith('/') || path.split('/').includes('..') || path.includes('\\'))) throw new Error('Unsafe plugin archive paths')
  const prefixes = new Set(paths.map(path => path.split('/')[0]))
  const strip = prefixes.size === 1 && !paths.includes('package.json') ? ['--strip-components=1'] : []
  const unpack = spawnSync('tar', ['-xzf', packageFile, '-C', packageDirectory, ...strip], { stdio: 'inherit' })
  if (unpack.status !== 0) throw new Error('Cannot unpack the connection plugin')
  await mkdir(join(stateDirectory, 'bin'), { recursive: true, mode: 0o700 })
  // macOS /var is an alias for /private/var; compare canonical parents too.
  const binariesDirectory = await realpath(join(stateDirectory, 'bin'))
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('This installer supports Linux and macOS only')
  const reuseTailscale = manifest.mode === 'tailscale' && await existingTailscale(binariesDirectory)
  if (process.platform === 'linux' && !reuseTailscale) {
    const architecture = { x64: 'amd64', arm64: 'arm64' }[process.arch]
    if (architecture === undefined) throw new Error('Automatic binary installation supports Linux amd64 and arm64')
    let assets = manifest.networkBinaries?.[`linux-${architecture}`]
    if (!Array.isArray(assets)) {
      const pinsFile = join(temporary, 'network-pins.json')
      await download(`${hubURL.origin}/downloads/network-pins.json`, pinsFile, undefined, { name: 'network-pins.json' })
      const pins = JSON.parse(await readFile(pinsFile, 'utf8'))
      assets = pins.assets.filter(asset => asset.architecture === architecture)
        .map(asset => ({ ...asset, url: `${hubURL.origin}/downloads/${asset.file}` }))
    }
    const asset = assets.find(asset => asset.tool === manifest.mode)
    if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invitation is missing the verified network binary')
    const cacheDirectory = join(stateDirectory, 'network-cache')
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 })
    const networkFile = join(cacheDirectory, `${asset.sha256}.tgz`)
    if (await verifiedArchive(networkFile, asset.sha256)) {
      process.stderr.write(`${manifest.mode}: reusing the cached network archive, checksum verified.\n`)
    } else {
      const downloaded = join(temporary, 'network.tgz')
      await download(asset.url, downloaded, asset.sha256, { name: assetName(asset.file, `${manifest.mode} archive`), archive: true })
      await rename(downloaded, networkFile)
    }
    const listing = spawnSync('tar', ['-tzf', networkFile], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
    if (listing.status !== 0) throw new Error('Cannot inspect the network archive')
    for (const binary of manifest.mode === 'tailscale' ? ['tailscale', 'tailscaled'] : ['tailcat']) {
      const member = listing.stdout.split('\n').find(path => path === binary || path.endsWith(`/${binary}`))
      if (!member) throw new Error(`Network archive is missing ${binary}`)
      const extracted = spawnSync('tar', ['-xOzf', networkFile, member], { timeout: 10_000, maxBuffer: 100 * 1024 * 1024 })
      if (extracted.status !== 0) throw new Error('Cannot extract the network tool')
      // Replace the directory entry, never write/chmod through a previous host link.
      const staged = join(temporary, binary)
      await writeFile(staged, extracted.stdout, { mode: 0o700 })
      await chmod(staged, 0o700)
      await rename(staged, join(binariesDirectory, binary))
    }
  } else if (process.platform === 'darwin' && !reuseTailscale) {
    if (manifest.mode === 'tailscale') throw new Error('On macOS, sign in to an accessible existing Tailscale application before running this invitation command')
    for (const binary of ['tailcat']) {
      const detected = spawnSync('/usr/bin/which', [binary], { encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024 })
      if (detected.status !== 0) throw new Error(`On macOS, install and configure ${binary} before running this invitation command`)
      // Preserve the existing tool; CLI receives this bin directory on every OS.
      const target = await realpath(detected.stdout.trim())
      if (target !== join(binariesDirectory, binary)) {
        const link = join(temporary, 'host-tailcat')
        await symlink(target, link)
        await rename(link, join(binariesDirectory, binary))
      }
    }
  }
  manifest.inviteToken = invite
  manifest.packageFile = packageFile
  manifest.packageDirectory = packageDirectory
  await writeFile(join(temporary, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
  await writeFile(join(temporary, 'cli-path'), join(packageDirectory, 'lib', 'cli.js'), { mode: 0o600 })
  if (reuseTailscale) await writeFile(join(temporary, 'reuse-tailscale'), '', { mode: 0o600 })
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
NODE
cli_path=$(cat "$installer_directory/cli-path")
set -- install --manifest "$installer_directory/manifest.json" --state-directory "$state_directory" --bin-directory "$state_directory/bin"
if [ -f "$installer_directory/reuse-tailscale" ]; then
  set -- "$@" --reuse-tailscale
fi
if [ -n "$profile" ]; then
  set -- "$@" --profile "$profile"
fi
if [ -n "$instance" ]; then set -- "$@" --instance "$instance"; fi
if [ -n "$control" ]; then set -- "$@" --control; fi
if [ -n "$package_alias" ]; then set -- "$@" --package-alias "$package_alias"; fi
node "$cli_path" "$@"
