# Install one released Hub Connector plugin and its persistent Node Agent for
# the current Windows user. The Cloudflare secret is collected with a secure
# prompt and never enters the command line.

param([switch]$Upgrade)

$ErrorActionPreference = 'Stop'
$ReleaseVersion = '@VERSION@'
$ReleaseRoot = "https://github.com/k1412/dsh-hub/releases/download/hub-v$ReleaseVersion"

$HubUrl = $env:DSH_HUB_URL
$NodeId = $env:DSH_HUB_NODE_ID
$ProfileName = if ($env:DSH_HUB_PROFILE) { $env:DSH_HUB_PROFILE } else { 'web' }
$StateDirectory = if ($env:DSH_HUB_STATE_DIRECTORY) { $env:DSH_HUB_STATE_DIRECTORY } else { Join-Path $HOME '.dsh-hub' }

if (-not $Upgrade) {
  if (-not $HubUrl) { $HubUrl = Read-Host 'Hub HTTPS origin' }
  if (-not $NodeId) { $NodeId = Read-Host 'Node ID' }
  if ($HubUrl -notmatch '^https://[^/?#]+/?$') { throw 'Hub URL must be an HTTPS origin without a path, query, or fragment' }
  $HubUrl = $HubUrl.TrimEnd('/')
  if ($NodeId -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw 'Node ID contains unsupported characters' }
}
if ($ProfileName -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw 'Profile name contains unsupported characters' }

foreach ($CommandName in @('node', 'npm', 'dsh')) {
  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) { throw "Required command is missing: $CommandName" }
}

$NodeVersion = (& node -p "process.versions.node").Split('.')
$NodeMajor = [int]$NodeVersion[0]
$NodeMinor = [int]$NodeVersion[1]
if ($NodeMajor -lt 22 -or ($NodeMajor -eq 22 -and $NodeMinor -lt 19) -or $NodeMajor -eq 23) {
  throw 'Node.js 22.19+ or 24+ is required'
}

$AccessClientId = $null
$AccessSecret = $null
$EnrollmentCode = $null
if (-not $Upgrade) {
  $AccessClientId = if ($env:DSH_HUB_ACCESS_CLIENT_ID) { $env:DSH_HUB_ACCESS_CLIENT_ID } else { Read-Host 'Cloudflare Access Client ID' }
  $AccessSecretSecure = if ($env:DSH_HUB_ACCESS_CLIENT_SECRET) {
    ConvertTo-SecureString $env:DSH_HUB_ACCESS_CLIENT_SECRET -AsPlainText -Force
  } else {
    Read-Host 'Cloudflare Access Client Secret' -AsSecureString
  }
  $EnrollmentSecure = if ($env:DSH_HUB_ENROLLMENT_CODE) {
    ConvertTo-SecureString $env:DSH_HUB_ENROLLMENT_CODE -AsPlainText -Force
  } else {
    Read-Host 'Hub one-time enrollment code' -AsSecureString
  }
  $AccessSecret = [System.Net.NetworkCredential]::new('', $AccessSecretSecure).Password
  $EnrollmentCode = [System.Net.NetworkCredential]::new('', $EnrollmentSecure).Password
  if (-not $AccessClientId -or -not $AccessSecret -or -not $EnrollmentCode) { throw 'Credentials cannot be empty' }
}

New-Item -ItemType Directory -Force -Path $StateDirectory | Out-Null
$TemporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-hub-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TemporaryDirectory | Out-Null

try {
  $AgentAsset = "k1412-dsh-hub-node-agent-$ReleaseVersion.tgz"
  $ConnectorAsset = "k1412-dsh-hub-connector-$ReleaseVersion.tgz"
  foreach ($Asset in @('SHA256SUMS', $AgentAsset, $ConnectorAsset)) {
    Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseRoot/$Asset" -OutFile (Join-Path $TemporaryDirectory $Asset)
  }
  $Checksums = @{}
  foreach ($Line in Get-Content (Join-Path $TemporaryDirectory 'SHA256SUMS')) {
    if ($Line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') { $Checksums[$Matches[2]] = $Matches[1].ToLowerInvariant() }
  }
  foreach ($Asset in @($AgentAsset, $ConnectorAsset)) {
    $Actual = (Get-FileHash -Algorithm SHA256 (Join-Path $TemporaryDirectory $Asset)).Hash.ToLowerInvariant()
    if ($Checksums[$Asset] -ne $Actual) { throw "Checksum verification failed for $Asset" }
  }

  $RuntimePrefix = Join-Path $StateDirectory "runtime\$ReleaseVersion"
  New-Item -ItemType Directory -Force -Path $RuntimePrefix | Out-Null
  @{ private = $true; allowScripts = @{ 'node-pty' = $true } } |
    ConvertTo-Json -Depth 3 | Set-Content -Encoding utf8 (Join-Path $RuntimePrefix 'package.json')
  & npm install --prefix $RuntimePrefix --no-package-lock --omit=dev --legacy-peer-deps (Join-Path $TemporaryDirectory $AgentAsset)
  if ($LASTEXITCODE -ne 0) { throw 'Node Agent package installation failed' }
  & node -e "require(process.argv[1])" (Join-Path $RuntimePrefix 'node_modules\node-pty')
  if ($LASTEXITCODE -ne 0) { throw 'node-pty native runtime validation failed' }

  $AgentExecutable = Join-Path $RuntimePrefix 'node_modules\.bin\dsh-hub-node.cmd'
  $DshExecutable = (Get-Command dsh).Source
  $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
  $ProfileDirectory = Join-Path $DshHome "profiles\$ProfileName"
  $ConfigPath = Join-Path $StateDirectory 'node-agent.json'
  $PackageDirectory = Join-Path $StateDirectory 'packages'
  New-Item -ItemType Directory -Force -Path $PackageDirectory | Out-Null
  $ConnectorPackage = Join-Path $PackageDirectory $ConnectorAsset
  Copy-Item -Force (Join-Path $TemporaryDirectory $ConnectorAsset) $ConnectorPackage
  if ($Upgrade) {
    if (-not (Test-Path -PathType Leaf $ConfigPath)) { throw "Existing private config not found: $ConfigPath" }
    & $AgentExecutable upgrade-connector --config $ConfigPath --profile $ProfileName --connector $ConnectorPackage
    if ($LASTEXITCODE -ne 0) { throw 'Connector upgrade failed' }
  } else {
    $env:DSH_HUB_ACCESS_CLIENT_SECRET = $AccessSecret
    $env:DSH_HUB_ENROLLMENT_CODE = $EnrollmentCode
    & $AgentExecutable init --hub $HubUrl --node $NodeId --access-client-id $AccessClientId --profile $ProfileName --runtime-id default --profile-directory $ProfileDirectory --dsh-executable $DshExecutable --install-connector $ConnectorPackage
    if ($LASTEXITCODE -ne 0) { throw 'Node enrollment failed' }
  }

  $TaskName = 'DSH Hub Node Agent'
  $TaskCommand = '"' + $AgentExecutable + '" --config "' + $ConfigPath + '"'
  & schtasks.exe /End /TN $TaskName 2>$null | Out-Null
  & schtasks.exe /Create /F /SC ONLOGON /TN $TaskName /TR $TaskCommand | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to install the current-user startup task' }
  Start-Process -FilePath $AgentExecutable -ArgumentList @('--config', $ConfigPath) -WindowStyle Hidden
  if ($Upgrade) {
    Write-Host "Node Agent and Connector are upgraded to $ReleaseVersion. Restart DSH profile $ProfileName once to activate the Connector."
  } else {
    Write-Host "Node $NodeId is installed. Restart DSH profile $ProfileName once so it loads the Hub Connector plugin."
  }
} finally {
  $env:DSH_HUB_ACCESS_CLIENT_SECRET = $null
  $env:DSH_HUB_ENROLLMENT_CODE = $null
  $AccessSecret = $null
  $EnrollmentCode = $null
  if (Test-Path $TemporaryDirectory) { Remove-Item -Recurse -Force $TemporaryDirectory }
}
