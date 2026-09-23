param([switch]$Clean)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:RUSTUP_HOME = 'f:/123456/de/tools/rustup'
$env:CARGO_HOME  = 'f:/123456/de/tools/cargo'
$env:PATH = "$env:CARGO_HOME/bin;$env:PATH"

if ($Clean) {
    cargo clean
    Write-Host '[OK] Clean done.' -ForegroundColor Green
    exit 0
}

# Force cargo to re-embed frontend assets: incremental build only tracks
# Rust sources, so HTML changes alone are invisible to generate_context!
(Get-Item 'src/main.rs').LastWriteTime = Get-Date

npx tauri build
if ($LASTEXITCODE -ne 0) {
    Write-Host '[ERROR] Build failed.' -ForegroundColor Red
    exit 1
}

$exe = Get-ChildItem -Path 'target/release' -Filter '*.exe' -Recurse |
       Where-Object { $_.Name -notlike '*build*' } |
       Select-Object -First 1
if ($exe) {
    Write-Host "[OK] Launching $($exe.FullName)" -ForegroundColor Green
    Start-Process $exe.FullName
} else {
    Write-Host '[WARN] exe not found in target/release' -ForegroundColor Yellow
}

# Package portable zip: exe + WebView2Loader.dll must stay together
# Version read from tauri.conf.json so zip name always tracks the app version.
$conf = Get-Content (Join-Path $PSScriptRoot 'tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $conf.version
$dll = Join-Path $PSScriptRoot 'target/release/WebView2Loader.dll'
if (Test-Path $exe.FullName) {
  if (-not (Test-Path $dll)) { Write-Host '[WARN] WebView2Loader.dll not found next to exe' -ForegroundColor Yellow }
  $zip = Join-Path $PSScriptRoot "target/release/AiPi-Heater-Upper-V$ver-win64.zip"
  if (Test-Path $zip) { Remove-Item $zip -Force }
  $stage = Join-Path $env:TEMP 'aipi_pkg'
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  New-Item -ItemType Directory -Path $stage | Out-Null
  Copy-Item $exe.FullName (Join-Path $stage "AiPi-Heater-Upper-V$ver.exe")
  if (Test-Path $dll) { Copy-Item $dll $stage }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
  Remove-Item $stage -Recurse -Force
  Write-Host "[OK] Portable zip: $zip" -ForegroundColor Green
  $msi = Get-ChildItem (Join-Path $PSScriptRoot 'target/release/bundle/msi') -Filter '*.msi' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($msi) { Write-Host "[OK] Installer: $($msi.FullName)" -ForegroundColor Green }
}
