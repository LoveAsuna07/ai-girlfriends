param([ValidateSet('login', 'status')][string]$Action = 'login')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$bundledNode = Join-Path $projectRoot '..\node\node.exe'
$nodeBinary = if (Test-Path -LiteralPath $bundledNode) { (Resolve-Path -LiteralPath $bundledNode).Path } else { (Get-Command node -ErrorAction Stop).Source }
$cli = Join-Path $projectRoot 'src\cli.mjs'
$launchFile = Join-Path $projectRoot '..\..\local-launch.json'
if (Test-Path -LiteralPath $launchFile) {
    $launch = Get-Content -LiteralPath $launchFile -Raw | ConvertFrom-Json
    if (-not $env:COMPANION_HOME -and $launch.home -and (Test-Path -LiteralPath $launch.home)) { $env:COMPANION_HOME = $launch.home }
    if (-not $env:COMPANION_RUNTIME -and $launch.runtime -and (Test-Path -LiteralPath $launch.runtime)) { $env:COMPANION_RUNTIME = $launch.runtime }
}
$privateHome = if ($env:COMPANION_HOME) { $env:COMPANION_HOME } else { Join-Path $env:USERPROFILE '.local-companion' }
function Invoke-Companion {
    & $nodeBinary $cli @args
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE). See the message above." }
}
if ($Action -eq 'status') { Invoke-Companion wechat status; exit }
if (-not (Test-Path -LiteralPath (Join-Path $privateHome 'companion.json'))) { Invoke-Companion init }
$runtime = if ($env:COMPANION_RUNTIME) { $env:COMPANION_RUNTIME } else { Join-Path $privateHome 'runtime' }
if (-not (Test-Path -LiteralPath (Join-Path $runtime 'node_modules\openclaw\openclaw.mjs'))) { Invoke-Companion install-runtime }
Invoke-Companion stop
$configFile = Join-Path $privateHome 'openclaw\openclaw.json'
$config = if (Test-Path -LiteralPath $configFile) { Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json } else { $null }
if (-not $config.plugins.entries.'openclaw-weixin'.enabled) { Invoke-Companion wechat setup }
Invoke-Companion wechat login
Write-Host 'WeChat linked. Open Local Companion and click Start to chat.'
