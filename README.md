<div align="center">

# 🔥 AiPi 加热台上位机

**基于 Tauri 2 的恒温加热台 / 回流焊 BLE 上位机**

[![Version](https://img.shields.io/badge/Version-V1.0.0-30d158?style=flat-square)](https://github.com/hsb689/aipiPC/releases)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64%20%7C%20Android-0a84ff?style=flat-square)](https://github.com/hsb689/aipiPC/releases)
[![Framework](https://img.shields.io/badge/Framework-Tauri%202-ff9f0a?style=flat-square)](https://v2.tauri.app)
[![BLE](https://img.shields.io/badge/Comm-BLE%20%7C%20btleplug-8ab4ff?style=flat-square)](#ble-协议)
[![Serial](https://img.shields.io/badge/固件下载-Web%20Serial%20%7C%20BL616%2F618-ffd60a?style=flat-square)](#-固件下载器)
[![License](https://img.shields.io/badge/License-MIT-98989d?style=flat-square)](#-致谢)

**简体中文** · [English](README_EN.md)

[下载](https://github.com/hsb689/aipiPC/releases) · [功能](#-功能特性) · [BLE 协议](#ble-协议) · [构建](#构建)

</div>

---

## 📖 项目简介

本项目最初只是为了宣传 **SGL GUI** 而做的一个恒温加热台, 后来逐步成长为一个完整成品。上位机基于 **Tauri 2** (Rust 后端 + 系统 WebView 前端), 通过 BLE 与安信可 AiPi 加热台硬件通信, 支持恒温控制、回流焊曲线、参数在线整定、电气信号实时监控, 并内置 BL616/BL618 串口固件下载器。

- **桌面端 (Windows)**: 三栏工作台 — 左侧电气参数与通信日志、中间温度曲线与控制、右侧参数设置, 单文件前端, 解压即用
- **手机端 (Android)**: 完全独立重写的 UI — 沉浸式顶栏、抽屉菜单、底部加热操作条、恒温/回流焊页签、设置弹窗, 适配高分辨率屏与安全区
- 两端共用同一套 Rust 后端与 BLE 协议, 前端各自独立

## ✨ 功能特性

### 桌面端 (Windows)

| | 功能 | 说明 |
|---|---|---|
| 🔵 | **BLE 连接** | 自动扫描识别加热台设备, 按固定广播名直连, 断线自动重连, 记住上次设备 |
| 🌡 | **恒温模式** | 实时温度大字显示, 温度进度条, 目标温度/3 组预设在线读写, 加热开关双向同步 |
| 📈 | **回流焊模式** | 四段曲线 (预热→恒温→回流→冷却) 分段着色 + 实际温度红色曲线叠加, 阶段卡片高亮与计时 |
| ⚙️ | **参数配置** | 恒温/回流焊/加热/PID/功率限制/风扇/LED/温度补偿/自动关机, 分页面板 |
| ⚡ | **电气监控** | 输入/输出电压、功率、电流、VPWM/IPWM 占空比实时采样, 5 分钟滚动图表 |
| 📦 | **固件下载器** | 内置 BL616/BL618 串口固件下载 (Web Serial), 标题栏一键进入 |
| 🔔 | **消息提醒** | 右下角滑入式提醒卡片, 绿/蓝/红三级 (成功/一般/警告), 带倒计时进度条 |
| 📋 | **通信日志** | 按级别着色, 高频数据帧与连接状态固定槽位, 不刷屏 |
| 🎨 | **主题** | 跟随系统 / 浅色 / 深色 |

### 手机端 (Android)

- 沉浸式顶栏 (连接状态 / 主题切换 / 关于) + 抽屉菜单
- 恒温页: 实时温度大字 + 进度条 + 示波器风格滚动曲线 (时间窗自适应, 2/5/10 分钟档)
- 回流焊页: 分段着色参考曲线 + 实际温度叠加 + 阶段计时
- 电器参数页: 电压/功率/电流/占空比实时监控
- 设置页: PID、预设、风扇、LED 等参数在线读写, 当前值实时回显
- 拼包重组: 长帧按 ≤20 字节分片自动重组, 兼容任意 MTU
- 断线自动重连, 固件更新页 (Web Serial 下载器)

## 🧰 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Tauri 2 (Rust 后端 + 系统 WebView 前端) |
| BLE | [btleplug](https://github.com/deviceplug/btleplug) 0.11 (Windows WinRT / Android JNI) |
| 前端 | 原生 HTML/CSS/JS 单文件, 无构建步骤 — 桌面 `frontend/index.html`, 安卓 `frontend/mobile.html` |
| 异步 | tokio + futures |
| 固件下载 | Web Serial API (BL616/BL618, 两段式握手 + MTU 协商) |

## BLE 协议

| 项目 | UUID |
|---|---|
| 服务 | `00009011-0000-1000-8000-00805f9b34fb` |
| 写特征 (APP→设备) | `00009012-0000-1000-8000-00805f9b34fb` |
| 通知特征 (设备→APP) | `00009013-0000-1000-8000-00805f9b34fb` |

**帧格式**: 下发 `[命令ID][长度][载荷...]`; 上报分三类 —

- **实时状态组帧** `[0x03][组ID][长度][TLV...]`: 每 300ms 推送 0x4F (温度/设定/电压/加热/模式) + 0x57 (工作秒) + 0x58 (电气), TLV 为 `[id][len][value]` 小端
- **配置快照**: 连接后约 2s 一次性补发 0x50~0x5A 七个配置组 (基础/其他/回流/PID/风扇)
- **单值回执帧** `[type][命令ID][长度][value]`: type 取 0x10~0x14 (U8/U16/I16/U32/FLOAT), 每条写入命令对应一条当前值回显

> 安卓端 BLE MTU 有限, 长帧会被拆成 ≤20 字节分片发送, 手机端解析前按帧头自动重组。

## 📦 固件下载器

内置博流 BL616/BL618 串口固件下载 (标题栏「固件更新」进入):

- 官方 bflb_iot_tool 同款两段式流程: 500k 握手读 bootinfo/芯片ID → clk_set(0x22) 升频到工作波特率
- 升频失败自动回退全程 500k; 扫描波特率 / 不复位直接握手 / 烧录前擦除 / 写入校验 / SHA256 回读
- 多文件 + 独立起始地址 (默认 0x10000), 逐字节校验防缓存假象

## 构建

### 桌面版 (Windows)

```bash
powershell build-tauri.ps1   # 推荐: 自动处理前端重嵌与打包
cargo tauri build            # 或直接用 Tauri CLI
```

### 安卓版 (APK)

```bash
powershell build-android.ps1   # 一键: 交叉编译 release .so → jniLibs → gradle 打包 → 逐字节校验
```

需要 JDK 17、Android SDK/NDK、Rust `aarch64-linux-android` target。**关键坑位见 [BUILD.md](BUILD.md)**:

1. 前端改动必须删指纹强制 `generate_context!` 重嵌资源, 否则 APK 里永远是旧页面
2. cdylib 链接需要 NDK clang 直指 (`.cmd` 包装有 GBK 乱码问题) + `RUSTFLAGS` 指定 target
3. btleplug 的 Java 支撑类 (`gen/android/java-src/`) 需手动 javac 编译为 jar, 已打 MTU 协商 / Android 13+ 回调签名补丁
4. tokio 工作线程调用 JNI 前需 attach JVM

## ⬇️ 下载

[GitHub Releases](https://github.com/hsb689/aipiPC/releases):

- **Windows**: 绿色版 zip (解压即用, Win11 一般自带 WebView2 运行时) 或 MSI 安装包
- **Android**: APK (arm64)

## 🙏 致谢

- 感谢**安信可科技**的园长爱笑
- 感谢 **SGL 开源作者 LiShanwen** 及 SGL 开源团队的每一位贡献者 — <https://github.com/sgl-org/sgl>
- 特别感谢**沈工 (沈夜)**提供的上位机自动下载源码, 避免了使用博流方案
- UI 仍在持续打磨, 欢迎提供配色或设计思路 — 我们可以用 SGL 设计器一起把这个项目做得更好看

---

<div align="center">

**English**: see [README_EN.md](README_EN.md)

</div>
