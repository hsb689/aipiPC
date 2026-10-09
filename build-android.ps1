# AiPi 加热台上位机 - Android APK 一键构建 (arm64, debug 签名可直接安装)
# 流程: 强制重编 release .so -> 放入 jniLibs -> gradle 打包(排除 tauri 自带 rust 任务) -> 逐字节校验
# 坑位说明见 BUILD.md (最大的坑: 环境缺失时 cargo 会静默复用旧 .so, 不报任何错)

$ErrorActionPreference = 'Stop'
$root  = $PSScriptRoot
$tools = 'F:\123456\de\tools'
$ndk   = "$tools\android-sdk\ndk\26.3.11579264"
$abiDir   = "$root\gen\android\app\src\main\jniLibs\arm64-v8a"
$soTarget = "$root\target\aarch64-linux-android\release\libaipi_heater_upper_lib.so"

$env:RUSTUP_HOME  = "$tools\rustup"
$env:CARGO_HOME   = "$tools\cargo"
$env:JAVA_HOME    = "$tools\jdk17"
$env:ANDROID_HOME = "$tools\android-sdk"
$env:NDK_HOME     = $ndk
# NDK llvm bin 必须在 PATH 最前(提供 clang); 链接器必须直接指 clang.exe(.cmd 包装有 GBK 乱码问题)
$env:PATH = "$ndk\toolchains\llvm\prebuilt\windows-x86_64\bin;$env:CARGO_HOME\bin;$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = "$ndk\toolchains\llvm\prebuilt\windows-x86_64\bin\clang.exe"
$env:RUSTFLAGS = '-C link-arg=--target=aarch64-linux-android24'

Set-Location $root

Write-Host '== 1/4 force rebuild release .so (delete fingerprints to defeat cache) =='
Remove-Item -Recurse -Force "$root\target\aarch64-linux-android\release\.fingerprint\aipi-heater-upper-*" -ErrorAction SilentlyContinue
Remove-Item -Force "$root\target\aarch64-linux-android\release\deps\*aipi_heater_upper_lib*" -ErrorAction SilentlyContinue
cargo build --package aipi-heater-upper --target aarch64-linux-android --lib --release
if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

Write-Host '== 2/4 copy .so into jniLibs =='
New-Item -ItemType Directory -Force -Path $abiDir | Out-Null
Remove-Item "$abiDir\libaipi_heater_upper_lib.so" -Force -ErrorAction SilentlyContinue
Copy-Item $soTarget "$abiDir\libaipi_heater_upper_lib.so" -Force

Write-Host '== 3/4 gradle package (exclude tauri rust tasks) =='
Remove-Item "$root\gen\android\app\build\outputs\apk\arm64\debug\app-arm64-debug.apk" -ErrorAction SilentlyContinue
Set-Location "$root\gen\android"
& "$tools\gradle\gradle-8.14.3\bin\gradle.bat" assembleDebug `
  -x rustBuildArmDebug -x rustBuildArm64Debug -x rustBuildX86Debug -x rustBuildX86_64Debug
if ($LASTEXITCODE -ne 0) { throw "gradle package failed" }
Set-Location $root

Write-Host '== 4/4 verify: APK .so must be byte-identical to the fresh build =='
$apk = "$root\gen\android\app\build\outputs\apk\arm64\debug\app-arm64-debug.apk"
$tmp = Join-Path $env:TEMP ("apkchk_" + [guid]::NewGuid().ToString('N'))
Copy-Item $apk "$tmp.zip" -Force
Expand-Archive "$tmp.zip" $tmp -Force
$h1 = (Get-FileHash "$tmp\lib\arm64-v8a\libaipi_heater_upper_lib.so" -Algorithm MD5).Hash
$h2 = (Get-FileHash $soTarget -Algorithm MD5).Hash
Remove-Item "$tmp.zip" -Force -ErrorAction SilentlyContinue
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
if ($h1 -ne $h2) { throw "VERIFY FAILED: APK .so is stale (cache fooled you)" }
Write-Host "OK  verified. APK: $apk"
Write-Host ("OK  size: {0:N1} MB" -f ((Get-Item $apk).Length / 1MB))
