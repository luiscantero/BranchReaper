# Runs the tests on Linux in WSL. The sources are copied to ~/builds/branch-reaper, since building
# on /mnt/c is slow. The VSIX built on Windows contains only JavaScript, so no Linux package is needed.
# The integration tests need a display: WSLg's, or xvfb-run if it is installed.
param([string]$Distro = "Ubuntu")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$wslRoot = (wsl -d $Distro -- wslpath -a ($root -replace '\\', '/')).Trim()
$script = @"
set -e
mkdir -p ~/builds/branch-reaper
rsync -a --delete --exclude node_modules --exclude .vscode-test --exclude out --exclude dist --exclude '*.vsix' '$wslRoot/' ~/builds/branch-reaper/
cd ~/builds/branch-reaper
export npm_config_allow_remote=all
npm ci --no-audit --no-fund
if command -v xvfb-run >/dev/null; then xvfb-run -a npm test; else npm test; fi
"@
# bash -i loads ~/.bashrc, where nvm puts node on the PATH.
wsl -d $Distro -- bash -ic ($script -replace "`r", "")
if ($LASTEXITCODE -ne 0) { throw "WSL tests failed with exit code $LASTEXITCODE" }