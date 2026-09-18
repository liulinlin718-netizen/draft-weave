param(
    [ValidateSet('external-api','codex-cli')][string]$Provider,
    [switch]$Status,
    [string]$Project,
    [switch]$PrepareOnly,
    [ValidateRange(50,600000)][int]$TimeoutMs
)
$ErrorActionPreference = 'Stop'
$checkArguments = @((Join-Path $PSScriptRoot 'check-model.mjs'))
if ($PrepareOnly) { $checkArguments += '--prepare-only' }
elseif ($Status -or -not $Provider) { $checkArguments += '--status' }
if ($Provider) { $checkArguments += @('--provider', $Provider) }
if ($Project) { $checkArguments += @('--project', $Project) }
if ($PSBoundParameters.ContainsKey('TimeoutMs')) { $checkArguments += @('--timeout-ms', [string]$TimeoutMs) }
node @checkArguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
exit $LASTEXITCODE
