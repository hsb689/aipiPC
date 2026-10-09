<div align="center">

# AiPi 加热台上位机 V1.0

基于 Tauri 2 的恒温加热台 / 回流焊 BLE 上位机

**Windows 桌面端** · **Android 手机端** · 同一套 BLE 协议 · 各自独立的原生 UI

</div>

## 项目简介

本 heating 台上位机最初是为了宣传 SGL GUI 而做, 后来逐步成长为一个完整成品; 在 AI 能力越来越强的当下, 有了这个项目。

- **桌面端(Windows)**: 三栏工作台布局 — 左侧电气参数与日志、中间温度曲线与控制、右侧参数设置
- **手机端(Android)**: 完全独立重写的 UI — 沉浸式顶栏、抽屉菜单、底部加热操作条、恒温/回流焊页签、设置弹窗, 适配高分辨率屏与安全区

## 功能特性

### 恒温模式
- 实时温度大字显示 + 目标温度进度条
- 温度曲线: 2 / 5 / 10 分钟三档时间窗, 目标温度虚线叠加
- 预设 1/2/3 快捷调用与写入
- PID (Kp/Ki/Kd)、功率限制、风扇 PWM/模式、LED 亮度、温度补偿、自动关机等参数在线读写

### 回流焊模式
- 四阶段流程: 预热 → 恒温 → 回流 → 冷却, 各阶段独立着色曲线(蓝/绿/橙/灰)+ 阶段标签
- 实际温度红色曲线实时叠加在参考曲线上
- 阶段计时走秒显示, 当前阶段卡片高亮
- 各阶段温度/时间参数独立下发

### 连接与数据
- BLE 扫描过滤(加热台名称优先), 断线自动重连(手机端后台重连, 顶栏设备名可点击手动重连)
- 连接成功后自动发空包查询帧, 拉取全部参数当前值(与下位机状态实时同步)
- 加热开关双向同步: 下位机本地操作, 上位机按钮状态实时跟随

## BLE 协议

| 项目 | UUID |
|---|---|
| 服务 | `00009011-0000-1000-8000-00805f9b34fb` |
| 写特征 | `00009012-0000-1000-8000-00805f9b34fb` |
| 通知特征 | `00009013-0000-1000-8000-00805f9b34fb` |

帧格式: `[命令ID][长度][载荷...]`, 通知回传分实时状态组帧与单项配置回执帧两类。

## 构建

### 桌面版(Windows)

```bash
cargo tauri build
```

### 安卓版

需要 JDK 17、Android SDK/NDK、Rust android target(aarch64-linux-android 等), 并注意:

1. Tauri 的 `generate_context!` 不追踪前端文件变化, 重编前需 touch `src/lib.rs` 强制重嵌资源
2. Android 端 cdylib 链接需要 NDK clang(`CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER` + `RUSTFLAGS` 指定 target)
3. btleplug 的 Java 支撑类需要手动编译进 APK(工程内 `gen/android/java-src/` → `app/libs/btleplug-android.jar`), 并已为其补上 Android 13+ 的 `onCharacteristicChanged` 新签名重载
4. `JNI_OnLoad` 中完成 `jni_utils::init` + `btleplug::platform::init`, tokio 工作线程调用前需 attach JVM
5. 打包: 复制 so 到 `jniLibs` 后用 gradle `assembleDebug` 产出 APK

## 致谢

- 感谢安信可科技的园长爱笑
- 感谢 SGL 开源作者 LiShanwen 及 SGL 开源团队的每一位贡献者 — <https://github.com/sgl-org/sgl>
- 特别感谢沈工(沈夜)提供的上位机自动下载源码, 避免了使用博流方案
- UI 仍在持续打磨, 欢迎提供配色或设计思路, 我们可以用 SGL 设计器一起把这个项目做得更好看、更完美

---

<div align="center">

**English**: see [README_EN.md](README_EN.md) (may lag behind the Chinese version)

</div>
