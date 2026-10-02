#!/bin/sh
set -eu
umask 077

hub=''
invite=''
profile=''
instance=''
state_directory="${XDG_STATE_HOME:-${HOME:?}/.local/state}/dsh-gateway"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --hub) hub="$2"; shift 2 ;;
    --invite) invite="$2"; shift 2 ;;
    --instance) instance="$2"; shift 2 ;;
    --profile) profile="$2"; shift 2 ;;
    --state-directory) state_directory="$2"; shift 2 ;;
    *) printf 'Unknown installer option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
if [ -z "$hub" ] || [ -z "$invite" ]; then
  printf 'Usage: install.sh --hub https://hub.example --invite TOKEN [--profile NAME]\n' >&2
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
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import { join } from 'node:path'
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
async function download(url, path, hash) {
  const response = await fetch(checkedURL(url), { signal: AbortSignal.timeout(60_000), redirect: 'follow' })
  checkedURL(response.url)
  if (!response.ok) throw new Error(`Download failed (${response.status})`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > 300 * 1024 * 1024) throw new Error('Download is too large')
  if (hash !== undefined && createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Downloaded package checksum did not match')
  await writeFile(path, bytes, { mode: 0o600 })
  return bytes
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
  await download(manifest.package.url, packageFile, manifest.package.sha256)
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
  const binariesDirectory = join(stateDirectory, 'bin')
  await mkdir(binariesDirectory, { recursive: true, mode: 0o700 })
  if (process.platform === 'linux') {
    const architecture = { x64: 'amd64', arm64: 'arm64' }[process.arch]
    if (architecture === undefined) throw new Error('Automatic binary installation supports Linux amd64 and arm64')
    let assets = manifest.networkBinaries?.[`linux-${architecture}`]
    if (!Array.isArray(assets)) {
      const pinsFile = join(temporary, 'network-pins.json')
      await download(`${hubURL.origin}/downloads/network-pins.json`, pinsFile)
      const pins = JSON.parse(await readFile(pinsFile, 'utf8'))
      assets = pins.assets.filter(asset => asset.architecture === architecture)
        .map(asset => ({ ...asset, url: `${hubURL.origin}/downloads/${asset.file}` }))
    }
    const asset = assets.find(asset => asset.tool === manifest.mode)
    if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invitation is missing the verified network binary')
    const networkFile = join(temporary, 'network.tgz')
    await download(asset.url, networkFile, asset.sha256)
    const listing = spawnSync('tar', ['-tzf', networkFile], { encoding: 'utf8' })
    if (listing.status !== 0) throw new Error('Cannot inspect the network archive')
    for (const binary of manifest.mode === 'tailscale' ? ['tailscale', 'tailscaled'] : ['tailcat']) {
      const member = listing.stdout.split('\n').find(path => path === binary || path.endsWith(`/${binary}`))
      if (!member) throw new Error(`Network archive is missing ${binary}`)
      const extracted = spawnSync('tar', ['-xOzf', networkFile, member], { maxBuffer: 100 * 1024 * 1024 })
      if (extracted.status !== 0) throw new Error('Cannot extract the network tool')
      await writeFile(join(binariesDirectory, binary), extracted.stdout, { mode: 0o700 })
      await chmod(join(binariesDirectory, binary), 0o700)
    }
  } else if (process.platform === 'darwin') {
    const required = manifest.mode === 'tailscale' ? ['tailscale'] : ['tailcat']
    for (const binary of required) {
      const detected = spawnSync('/usr/bin/which', [binary], { encoding: 'utf8' })
      if (detected.status !== 0) throw new Error(`On macOS, install and configure ${binary} before running this invitation command`)
      if (binary === 'tailscale') {
        const status = spawnSync(detected.stdout.trim(), ['status', '--json'], { encoding: 'utf8' })
        let online = false
        try { online = status.status === 0 && JSON.parse(status.stdout).BackendState === 'Running' } catch {}
        if (!online) throw new Error('On macOS, sign in to the existing Tailscale application before running this invitation command')
      }
      // Preserve the existing tool; CLI receives this bin directory on every OS.
      const { symlink } = await import('node:fs/promises')
      try { await symlink(detected.stdout.trim(), join(binariesDirectory, binary)) } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
  } else throw new Error('This installer supports Linux and macOS only')
  manifest.inviteToken = invite
  manifest.packageFile = packageFile
  manifest.packageDirectory = packageDirectory
  await writeFile(join(temporary, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
  await writeFile(join(temporary, 'cli-path'), join(packageDirectory, 'lib', 'cli.js'), { mode: 0o600 })
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
NODE
cli_path=$(cat "$installer_directory/cli-path")
set -- install --manifest "$installer_directory/manifest.json" --state-directory "$state_directory" --bin-directory "$state_directory/bin"
if [ -n "$profile" ]; then set -- "$@" --profile "$profile"; fi
if [ -n "$instance" ]; then set -- "$@" --instance "$instance"; fi
node "$cli_path" "$@"
