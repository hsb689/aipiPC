<div align="center">

# 🔥 AiPi 加热台上位机

**基于 Tauri 2 的 BLE 加热台桌面控制中心**

[![Version](https://img.shields.io/badge/版本-V0.02-30d158?style=flat-square)](https://github.com/hsb689/aipiPC/releases)
[![Platform](https://img.shields.io/badge/平台-Windows%20x64-0a84ff?style=flat-square)](https://github.com/hsb689/aipiPC/releases)
[![Framework](https://img.shields.io/badge/框架-Tauri%202-ff9f0a?style=flat-square)](https://v2.tauri.app)
[![BLE](https://img.shields.io/badge/通信-BLE%20%7C%20btleplug-8ab4ff?style=flat-square)](#ble-协议)
[![License](https://img.shields.io/badge/协议-MIT-98989d?style=flat-square)](#license)

**简体中文** · [English](README_EN.md)

[下载最新版](https://github.com/hsb689/aipiPC/releases) · [功能特性](#-功能特性) · [构建指南](#-从源码构建) · [使用说明](#-使用说明)

</div>

---

## 📖 简介

AiPi 加热台上位机是一款基于 **Tauri 2**(Rust + 系统 WebView)的桌面应用,通过低功耗蓝牙(BLE)与 AiPi 加热台下位机通信,提供恒温控制、回流焊曲线配置、参数下发与电气信号实时监控,单文件免安装运行。

## ✨ 功能特性

| | 功能 | 说明 |
|---|---|---|
| 🔵 | **BLE 连接** | 自动扫描识别加热台,断开后快速重连,自动记忆上次连接的设备 |
| 🌡 | **恒温模式** | 实时温度曲线、目标温度下发、3 组温度预设、加热开关 |
| 📈 | **回流焊模式** | 多段回流焊温度曲线配置与下发 |
| ⚙️ | **参数配置** | 恒温 / 回流焊 / 加热参数分组标签页下发 |
| ⚡ | **电气信号监控** | VPWM / IPWM 占用率实时采集,5 分钟滚动曲线 |
| 📋 | **通信日志** | 按等级着色(🔴 错误 🟢 连接 🟠 数据 🔵 发送 ⚪ 信息),数据日志与连接状态固定槽位替换,不刷屏 |
| 🎨 | **主题** | 跟随系统 / 浅色 / 深色 |

## 🧰 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Tauri 2(Rust 后端 + 系统 WebView 前端) |
| BLE | [btleplug](https://github.com/deviceplug/btleplug) 0.11(Windows WinRT 后端) |
| 前端 | 原生 HTML/CSS/JS,单文件 `frontend/index.html`,无构建步骤 |
| 异步 | tokio + futures |

### BLE 协议

自定义帧格式:`[命令ID, 载荷长度, 载荷...]`

| UUID | 用途 |
|---|---|
| `9011` | Service |
| `9012` | Write(上位机 → 下位机) |
| `9013` | Notify(下位机 → 上位机) |

## 🛠 从源码构建

依赖:Rust(GNU 工具链)、Node.js、Tauri 2 CLI。

```bash
npm install
npx tauri build          # 或使用 build-tauri.ps1(Windows)
```

产物位于 `target/release/aipi-heater-upper.exe`。

> [!IMPORTANT]
> 前端 HTML 是编译时嵌入 exe 的。只改 `frontend/` 下的文件后直接 `cargo build` **不会**重嵌资源——请使用仓库内的 `build-tauri.ps1`,它会在编译前 touch `src/main.rs`,强制 `generate_context!` 重新嵌入。

## 🚀 使用说明

1. 运行上位机,开启加热台电源;
2. 点击「连接设备」,应用自动扫描(约 5 秒),从列表中选择你的加热台;
3. 选择工作模式(恒温 / 回流焊),下发目标温度或曲线参数;
4. 右侧标签页下发各类配置参数,通信日志面板查看全部收发数据。

## 📁 目录结构

```
├── src/main.rs          # Tauri 后端:BLE 扫描 / 连接 / 读写 / 通知
├── frontend/index.html  # 完整前端(界面 + 逻辑)
├── build-tauri.ps1      # Windows 构建脚本(强制重嵌前端资源)
├── tauri.conf.json      # Tauri 配置(版本号在此维护)
└── icons/               # 应用图标
```

## 📥 下载

前往 [**Releases**](https://github.com/hsb689/aipiPC/releases) 下载最新版 `AiPi-Heater-Upper-V0.02.exe`,免安装、单文件运行。

## License

[MIT](LICENSE)
