/** Reviewed upstream releases. Installation never follows a mutable latest URL. */
export const NETWORK_VERSIONS = { tailscale: '1.102.4', tailcat: '0.7.0' } as const

export type LinuxArchitecture = 'amd64' | 'arm64'
export interface NetworkAsset {
  tool: 'tailscale' | 'tailcat'
  platform: 'linux'
  architecture: LinuxArchitecture
  file: string
  url: string
  sha256: string
}

const tailscaleHashes: Record<LinuxArchitecture, string> = {
  amd64: '50748df1045e60b5b695f19f4c56b0da36c019948b440fb456b6584a50f0d8b9',
  arm64: '9dd1e6a592a014bbaea0103167ffe299adeda4ba14e078ce9c2895364f6c4c3f',
}
const tailcatHashes: Record<LinuxArchitecture, string> = {
  amd64: '23c0b1887a5ec422f0d18a9c52b4f5357815febdaae738a1eb54036d10bd9ee6',
  arm64: 'bbb1ab50f24f00effe1e1fd86d0501803fb80793a90785a2a16ff3428f03d8ef',
}

export function networkAssets(architecture: LinuxArchitecture): NetworkAsset[] {
  const tailscaleFile = `tailscale_${NETWORK_VERSIONS.tailscale}_${architecture}.tgz`
  const tailcatFile = `tailcat_${NETWORK_VERSIONS.tailcat}_linux_${architecture}.tar.gz`
  return [
    { tool: 'tailscale', platform: 'linux', architecture, file: tailscaleFile,
      url: `https://pkgs.tailscale.com/stable/${tailscaleFile}`, sha256: tailscaleHashes[architecture] },
    { tool: 'tailcat', platform: 'linux', architecture, file: tailcatFile,
      url: `https://github.com/tailscale/tailcat/releases/download/v${NETWORK_VERSIONS.tailcat}/${tailcatFile}`,
      sha256: tailcatHashes[architecture] },
  ]
}
