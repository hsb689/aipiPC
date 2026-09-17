<div align="center">

# 🔥 AiPi Heater Platform Host

**A BLE desktop control center for the AiPi heater platform, built with Tauri 2**

[![Version](https://img.shields.io/badge/Version-V0.2-30d158?style=flat-square)](https://github.com/hsb689/aipiPC/releases)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64-0a84ff?style=flat-square)](https://github.com/hsb689/aipiPC/releases)
[![Framework](https://img.shields.io/badge/Framework-Tauri%202-ff9f0a?style=flat-square)](https://v2.tauri.app)
[![BLE](https://img.shields.io/badge/Comm-BLE%20%7C%20btleplug-8ab4ff?style=flat-square)](#ble-protocol)
[![License](https://img.shields.io/badge/License-MIT-98989d?style=flat-square)](#license)

[简体中文](README.md) · **English**

[Download](https://github.com/hsb689/aipiPC/releases) · [Features](#-features) · [Build from Source](#-build-from-source) · [Usage](#-usage)

</div>

---

## 📖 Overview

AiPi Heater Platform Host is a desktop application built with **Tauri 2** (Rust + system WebView). It communicates with the AiPi heater platform controller over Bluetooth Low Energy (BLE), providing constant-temperature control, reflow curve configuration, parameter provisioning, and real-time electrical signal monitoring — all in a single portable executable.

## ✨ Features

| | Feature | Description |
|---|---|---|
| 🔵 | **BLE Connection** | Auto-scans and identifies heater devices, fast reconnect after disconnect, remembers the last connected device |
| 🌡 | **Constant-Temp Mode** | Real-time temperature chart, target temperature provisioning, 3 presets, heater toggle |
| 📈 | **Reflow Mode** | Multi-segment reflow temperature curve configuration and provisioning |
| ⚙️ | **Parameter Config** | Constant-temp / reflow / heater parameters, grouped in tabbed panels |
| ⚡ | **Electrical Monitoring** | Real-time VPWM / IPWM duty sampling with a 5-minute rolling chart |
| 📋 | **Comm Log** | Color-coded by level (🔴 error 🟢 connect 🌿 info 🟠 data 🔵 write); high-frequency data logs and connection status use fixed sticky slots — no scrolling spam |
| 🎨 | **Themes** | Follow system / light / dark |

## 🧰 Tech Stack

| Layer | Technology |
|---|---|
| Framework | Tauri 2 (Rust backend + system WebView frontend) |
| BLE | [btleplug](https://github.com/deviceplug/btleplug) 0.11 (Windows WinRT backend) |
| Frontend | Vanilla HTML/CSS/JS in a single file `frontend/index.html`, no build step |
| Async | tokio + futures |

### BLE Protocol

Custom frame format: `[commandId, payloadLength, payload...]`

| UUID | Purpose |
|---|---|
| `9011` | Service |
| `9012` | Write (host → device) |
| `9013` | Notify (device → host) |

## 🛠 Build from Source

Prerequisites: Rust (GNU toolchain), Node.js, Tauri 2 CLI.

```bash
npm install
npx tauri build          # or use build-tauri.ps1 (Windows)
```

The output is located at `target/release/aipi-heater-upper.exe`.

> [!IMPORTANT]
> The frontend HTML is embedded into the exe at compile time. If you only change files under `frontend/`, a plain `cargo build` will **not** re-embed them — use the repository's `build-tauri.ps1`, which touches `src/main.rs` before compiling to force `generate_context!` to re-embed the assets.

## 🚀 Usage

1. Launch the host app and power on the heater platform;
2. Click "连接设备" (Connect). The app auto-scans for ~5 seconds — pick your heater from the list;
3. Choose a working mode (constant-temp / reflow) and send the target temperature or curve parameters;
4. Use the tabs on the right to provision configuration parameters; the comm log panel shows all traffic.

## 📁 Project Layout

```
├── src/main.rs          # Tauri backend: BLE scan / connect / read-write / notify
├── frontend/index.html  # Complete frontend (UI + logic)
├── build-tauri.ps1      # Windows build script (forces asset re-embed)
├── tauri.conf.json      # Tauri config (app version is maintained here)
└── icons/               # App icons
```

## 📥 Download

Grab the latest `AiPi-Heater-Upper-V0.2.exe` from [**Releases**](https://github.com/hsb689/aipiPC/releases) — portable, single file, no installation required.

## License

[MIT](LICENSE)
