# Runs the tests and packages Branch Reaper on Linux in WSL. The sources are copied to
# ~/builds/branch-reaper, since building on /mnt/c is slow. The VSIX contains only JavaScript, so
# the one built on Windows works on Linux too; this proves that the tests pass there.
# The integration tests need a display: WSLg's, or xvfb-run if it is installed.
param([switch]$SkipTests, [string]$Distro = "Ubuntu")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$wslRoot = (wsl -d $Distro -- wslpath -a ($root -replace '\\', '/')).Trim()
$test = if ($SkipTests) { "true" } else { 'if command -v xvfb-run >/dev/null; then xvfb-run -a npm test; else npm test; fi' }
$script = @"
set -e
mkdir -p ~/builds/branch-reaper
rsync -a --delete --exclude node_modules --exclude .vscode-test --exclude out --exclude dist --exclude '*.vsix' '$wslRoot/' ~/builds/branch-reaper/
cd ~/builds/branch-reaper
export npm_config_allow_remote=all
npm ci --no-audit --no-fund
$test
npx vsce package --out ~/builds/branch-reaper/branch-reaper-linux.vsix
"@
# bash -i loads ~/.bashrc, where nvm puts node on the PATH.
wsl -d $Distro -- bash -ic ($script -replace "`r", "")
if ($LASTEXITCODE -ne 0) { throw "WSL build failed with exit code $LASTEXITCODE" }
