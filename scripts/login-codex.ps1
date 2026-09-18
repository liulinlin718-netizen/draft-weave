param([switch]$DeviceAuth, [switch]$Status)
$ErrorActionPreference = 'Stop'
# The Node launcher creates an isolated environment ONLY for its CLI child.
$loginArguments = @((Join-Path $PSScriptRoot 'login-codex.mjs'))
if ($DeviceAuth) { $loginArguments += '--device-auth' }
if ($Status) { $loginArguments += '--status' }
node @loginArguments
exit $LASTEXITCODE
