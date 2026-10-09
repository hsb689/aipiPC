# BUILD.md — 编译与打包指南

> 给任何人(以及任何 AI)看:照着本文件即可完成编译。工具链全部本地化在 `f:\123456\de\tools`,不依赖系统安装。

## 一键打包(推荐)

```powershell
powershell -ExecutionPolicy Bypass -File build-android.ps1
```

脚本自动完成:编译 so → 复制到 jniLibs → gradle 打 APK → 校验 APK 内嵌 so 与最新编译一致。
产物:`gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk`
安装:`adb install -r "<apk路径>"`

**改了 Java(`gen/android/java-src/`)后**,删掉 `gen/android/app/libs/btleplug-android.jar` 再跑脚本,它会自动重编 jar。

## 手动流程(等价于脚本,调试时用)

### 环境

```powershell
$TOOLS="f:\123456\de\tools"
$env:JAVA_HOME="$TOOLS\jdk17"; $env:ANDROID_HOME="$TOOLS\android-sdk"
$env:NDK_HOME="$TOOLS\android-sdk\ndk\26.3.11579264"
$env:RUSTUP_HOME="$TOOLS\rustup"; $env:CARGO_HOME="$TOOLS\cargo"
$env:PATH="$env:NDK_HOME\toolchains\llvm\prebuilt\windows-x86_64\bin;$TOOLS\cargo\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$env:NDK_HOME\toolchains\llvm\prebuilt\windows-x86_64\bin\clang.exe"
$env:RUSTFLAGS="-C link-arg=--target=aarch64-linux-android24"
```

### 1. 编译 so

```powershell
# 改过前端(HTML/JS)必须先清指纹,否则 generate_context! 复用旧资源:
Remove-Item -Recurse -Force target/aarch64-linux-android/release/.fingerprint/aipi-heater-upper-*
cargo build --package aipi-heater-upper --target aarch64-linux-android --lib --release
```

### 2. 复制 so 并打包

```powershell
Copy-Item target/aarch64-linux-android/release/libaipi_heater_upper_lib.so `
          gen/android/app/src/main/jniLibs/arm64-v8a/ -Force
cd gen/android
./..\..\..\tools\gradle\gradle-8.14.3\bin\gradle.bat assembleDebug `
  -x rustBuildArmDebug -x rustBuildArm64Debug -x rustBuildX86Debug -x rustBuildX86_64Debug
```

### 3. 校验(强烈建议)

APK 解包后比对 `lib/arm64-v8a/libaipi_heater_upper_lib.so` 与第 1 步产物 MD5 一致。

## 必须知道的坑(每一条都真实踩过)

| 坑 | 症状 | 对策 |
|---|---|---|
| 链接器环境缺失 | cargo 静默打印 `dropping unsupported crate type cdylib` 并**复用旧 so**,不报错 | `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER` 直接指 **clang.exe**;不能用同目录 `.cmd` 包装(GBK 乱码);`RUSTFLAGS` 带 `--target=aarch64-linux-android24` |
| cargo 不追踪前端 | 改了 HTML/JS,APK 里还是旧页面 | 删 `.fingerprint/aipi-heater-upper-*` 和 `deps/*aipi_heater_upper_lib*` 强制重嵌重链 |
| btleplug 缺 Java 类 | 权限全给、扫描永远空 | 支撑类必须打进 APK:`gen/android/java-src/` → javac → `app/libs/btleplug-android.jar`(其中已补 Android 13+ `onCharacteristicChanged` 新签名重载,缺它则通知收不到) |
| btleplug 未初始化 | 连接卡死、UI 永挂"正在扫描" | `JNI_OnLoad` 里做 `jni_utils::init` + `btleplug::platform::init`(jni 0.19);**不能用 `ndk_context`**(tao/tauri 不初始化它,会 panic) |
| tokio 工作线程 JNI 失败 | 温度/状态不实时、假断线 | 所有 BLE 路径(含 spawn 的通知/健康检查任务)先 `attach_current_thread_as_daemon` |
| 下位机不主动上报 | 各参数"当前值"全是 `--` | 连接成功后发**空载荷查询帧**触发设备回传(见 `query_all_config`) |
| gradle 依赖下载失败 | TLS 握手/超时 | `settings.gradle` 已配阿里云镜像;gradle 本体在 `tools/gradle/8.14.3` |
| APK 时间戳假象 | gradle 跳过打包,APK 还是旧的 | 打包前先删旧 APK;打完比对内嵌 so |

## 桌面版(Windows)

右下角"编译"按钮 → `.vscode/commands.json` → `build-tauri.ps1`(脚本在编译前 touch `src/main.rs` 强制重嵌前端)。不要在助手侧主动跑,用户手动触发。

## 相关文件

- `build-android.ps1` — 安卓一键脚本
- `src/lib.rs` — BLE 全部逻辑(含 JNI_OnLoad / ensure_jni_attached / query_all_config)
- `frontend/mobile.html` — 手机端独立 UI;`frontend/index.html` 头部按 UA 跳转
- `gen/android/java-src/` — btleplug Java 源(打过 API 33+ 补丁)
- `tools/set-android-env.ps1` — 环境变量样板
