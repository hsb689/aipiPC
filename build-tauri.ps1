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
