param([ValidateRange(6410,6419)][int]$Port = 6410, [string]$Browser)
$ErrorActionPreference = 'Stop'
$browserArguments = @((Join-Path $PSScriptRoot 'start-browser.mjs'), '--port', [string]$Port)
if ($Browser) { $browserArguments += @('--browser', $Browser) }
node @browserArguments
exit $LASTEXITCODE
