param([ValidateRange(6410,6419)][int]$Port = 6410)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$env:DW_PORT = [string]$Port
node (Join-Path $projectDirectory 'server.mjs')
exit $LASTEXITCODE
