# Android APK 构建指南 (build-android.ps1)

## 一键构建

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File build-android.ps1
```

产物（本次新构建，已逐字节校验）：

```
gen\android\app\build\outputs\apk\arm64\debug\app-arm64-debug.apk
```

## 流程（脚本自动执行）

1. **强制重编 release .so**：删除 `aipi-heater-upper` 的指纹和 deps 产物，带官方同款链接器环境交叉编译
2. **放入 jniLibs**：`libaipi_heater_upper_lib.so` → `gen\android\app\src\main\jniLibs\arm64-v8a\`
3. **gradle 打包**：`assembleDebug -x rustBuild*`（.so 已自己编好，排除 tauri 自带 rust 任务）
4. **逐字节校验**：解包 APK，MD5 对比包内 .so 与新编译的 .so

## 为什么必须这么做（最大的坑）

环境缺失（NDK clang 不在 PATH / 链接器用 .cmd 包装 / 缺 RUSTFLAGS）时，cargo 会**静默打印
`dropping unsupported crate type cdylib` 并复用旧 so**——不报错、不失败，APK 里永远是旧代码。

三个关键环境项：

| 环境项 | 值 | 原因 |
|---|---|---|
| PATH 最前 | NDK 的 `llvm\prebuilt\...\bin` | 提供 clang |
| `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER` | 直接指 **clang.exe** | `.cmd` 包装有 GBK 乱码报错 |
| `RUSTFLAGS` | `-C link-arg=--target=aarch64-linux-android24` | 不设则链接失败 |

另两个坑：

- **改了前端（HTML/JS）必须删指纹**强制 cargo 重跑 `generate_context!` 重嵌资源并重链接，
  否则 APK 里永远是旧页面（同桌面版 build-tauri.ps1 里 touch main.rs 的道理）
- **改了 Java（gen/android/java-src）必须重跑 javac/jar**：btleplug 的 Java 支撑类是从
  cargo registry 源码手动编译的，编成 `app/libs/btleplug-android.jar` 挂在 build.gradle.kts；
  里面打了 Android 13+ 通知回调补丁

## 依赖

所有工具都在 `F:\123456\de\tools`（不装系统目录）：

- JDK17：`tools\jdk17`
- Android SDK：`tools\android-sdk`（NDK 26.3.11579264）
- Gradle：`tools\gradle\gradle-8.14.3`（wrapper 下载被墙，用本地版）
- Rust：`tools\rustup` / `tools\cargo`（aarch64-linux-android target 已装）

依赖下载走 `gen\android\gradle.properties` 里配置的阿里云镜像。
