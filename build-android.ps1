# build-android.ps1 — AIPI_Thermostatic 安卓一键打包脚本
# 用法: 在工程根目录执行  powershell -ExecutionPolicy Bypass -File build-android.ps1
# 前置: 工具链全部位于 f:\123456\de\tools (JDK17 / Android SDK+NDK / rustup / gradle), 不装系统目录。

$ErrorActionPreference = "Stop"

# ---- 路径(全部本地化, 不依赖系统安装) ----
$TOOLS    = "f:\123456\de\tools"
$PROJ     = "f:\123456\de\AIPI_Thermostatic"
$NDK      = "$TOOLS\android-sdk\ndk\26.3.11579264"
$APK_OUT  = "$PROJ\gen\android\app\build\outputs\apk\arm64\debug\app-arm64-debug.apk"

# ---- 环境: JDK / SDK / rustup(工具链本地化) ----
$env:JAVA_HOME    = "$TOOLS\jdk17"
$env:ANDROID_HOME = "$TOOLS\android-sdk"
$env:NDK_HOME     = $NDK
$env:RUSTUP_HOME  = "$TOOLS\rustup"
$env:CARGO_HOME   = "$TOOLS\cargo"
$env:PATH = "$NDK\toolchains\llvm\prebuilt\windows-x86_64\bin;$TOOLS\cargo\bin;$env:ANDROID_HOME\platform-tools;" + $env:PATH

# ---- Rust→JNI 链接配置(关键! 缺失时 cdylib 被静默跳过且复用旧 so) ----
# 链接器必须直接指 clang.exe; 不能用同目录 .cmd 包装(GBK 乱码导致参数解析失败)
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = "$NDK\toolchains\llvm\prebuilt\windows-x86_64\bin\clang.exe"
$env:RUSTFLAGS = "-C link-arg=--target=aarch64-linux-android24"

Set-Location $PROJ

# ---- Step 0: btleplug Java 支撑类(源码在 gen/android/java-src, 改过 Java 才需重编; jar 存在即跳过) ----
$JAR = "$PROJ\gen\android\app\libs\btleplug-android.jar"
if (-not (Test-Path $JAR)) {
    Write-Host "[0/5] compiling btleplug-android.jar from gen/android/java-src ..."
    $SRC = "$PROJ\gen\android\java-src"
    $AJ  = "$TOOLS\android-sdk\platforms\android-34\android.jar"
    $TMP = "$env:TEMP\btjava-build"
    Remove-Item -Recurse -Force $TMP -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path "$TMP\classes" | Out-Null
    & "$TOOLS\jdk17\bin\javac.exe" -cp $AJ -encoding UTF-8 -d "$TMP\classes" (Get-ChildItem -Recurse $SRC -Filter *.java | ForEach-Object FullName)
    & "$TOOLS\jdk17\bin\jar.exe" cf $JAR -C "$TMP\classes" .
    Write-Host "      jar written: $JAR"
} else {
    Write-Host "[0/5] btleplug-android.jar exists, skip"
}

# ---- Step 1: 强制 cargo 重嵌前端资源并重编 so ----
# generate_context! 不追踪前端文件变化; 不清指纹则改了 HTML 也会打进旧资源。
# cdylib 链接环境缺失时 cargo 静默打印 "dropping unsupported crate type cdylib" 并复用旧 so。
Write-Host "[1/5] cargo build (aarch64-linux-android release) ..."
$fps = "$PROJ\target\aarch64-linux-android\release\.fingerprint"
Get-ChildItem $fps -Filter "aipi-heater-upper-*" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
Get-ChildItem "$PROJ\target\aarch64-linux-android\release\deps" -Filter "*aipi_heater_upper_lib*" -ErrorAction SilentlyContinue | Remove-Item -Force
& "$TOOLS\cargo\bin\cargo.exe" build --package aipi-heater-upper --target aarch64-linux-android --lib --release
if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

# so 必须真实存在(若链接器配置丢失, 这里就会暴露)
$SO = "$PROJ\target\aarch64-linux-android\release\libaipi_heater_upper_lib.so"
if (-not (Test-Path $SO)) { throw "so not found — cdylib was silently skipped, check linker env" }

# ---- Step 2: so 放进 jniLibs ----
Write-Host "[2/5] copy so -> jniLibs ..."
New-Item -ItemType Directory -Force -Path "$PROJ\gen\android\app\src\main\jniLibs\arm64-v8a" | Out-Null
Copy-Item -Force $SO "$PROJ\gen\android\app\src\main\jniLibs\arm64-v8a\"

# ---- Step 3: gradle 打 APK(本地 gradle, 依赖走阿里云镜像, 排除 tauri 的 rust 任务) ----
Write-Host "[3/5] gradle assembleDebug ..."
Remove-Item -Force $APK_OUT -ErrorAction SilentlyContinue   # 先删旧包防时间戳假象
$gradleEnv = @{
    JAVA_HOME    = "$TOOLS\jdk17"
    ANDROID_HOME = "$TOOLS\android-sdk"
}
$gradle = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"$TOOLS\gradle\gradle-8.14.3\bin\gradle.bat`" assembleDebug -x rustBuildArmDebug -x rustBuildArm64Debug -x rustBuildX86Debug -x rustBuildX86_64Debug --console=plain" -WorkingDirectory "$PROJ\gen\android" -NoNewWindow -Wait -PassThru -Environment $gradleEnv
if ($gradle.ExitCode -ne 0) { throw "gradle build failed" }

# ---- Step 4: 校验 APK 内嵌 so 与刚编译的 so 逐字节一致(防缓存假象) ----
Write-Host "[4/5] verify embedded so ..."
$CHK = "$env:TEMP\apk-so-check"
Remove-Item -Recurse -Force $CHK -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$CHK\x" | Out-Null
$APK_COPY = "$CHK\app.zip"
Copy-Item $APK_OUT $APK_COPY
# 用 .NET 解包 APK(zip 格式), 取 lib/ 下 so 比对 MD5
Expand-Archive -Path $APK_COPY -DestinationPath "$CHK\x" -Force
$embedded = "$CHK\x\lib\arm64-v8a\libaipi_heater_upper_lib.so"
if (-not (Test-Path $embedded)) { throw "embedded so missing in APK" }
if ((Get-FileHash $embedded -Algorithm MD5).Hash -ne (Get-FileHash $SO -Algorithm MD5).Hash) {
    throw "APK embedded so != new build (stale packaging?)"
}
Write-Host "      APK so matches new build"

# ---- Step 5: 完成 ----
Write-Host "[5/5] DONE"
Write-Host "  APK: $APK_OUT"
Write-Host "  安装: adb install -r `"$APK_OUT`""
