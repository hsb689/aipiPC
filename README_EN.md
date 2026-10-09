<div align="center">

# 🔥 AiPi Heater Platform Host

**A BLE host for the AiPi heater platform & reflow soldering, built with Tauri 2**

[![Version](https://img.shields.io/badge/Version-V1.0.0-30d158?style=flat-square)](https://github.com/hsb689/aipiPC/releases)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64%20%7C%20Android-0a84ff?style=flat-square)](https://github.com/hsb689/aipiPC/releases)
[![Framework](https://img.shields.io/badge/Framework-Tauri%202-ff9f0a?style=flat-square)](https://v2.tauri.app)
[![BLE](https://img.shields.io/badge/Comm-BLE%20%7C%20btleplug-8ab4ff?style=flat-square)](#ble-protocol)
[![Serial](https://img.shields.io/badge/Firmware%20Flash-Web%20Serial%20%7C%20BL616%2F618-ffd60a?style=flat-square)](#-firmware-flasher)
[![License](https://img.shields.io/badge/License-MIT-98989d?style=flat-square)](#-acknowledgements)

[简体中文](README.md) · **English**

[Download](https://github.com/hsb689/aipiPC/releases) · [Features](#-features) · [BLE Protocol](#ble-protocol) · [Build](#build)

</div>

---

## 📖 Overview

This project started as a constant-temperature heating platform built to showcase **SGL GUI**, and gradually grew into a complete product. The host is built with **Tauri 2** (Rust backend + system WebView frontend) and communicates with the AiPi heater hardware over BLE. It supports constant-temperature control, reflow soldering curves, online parameter tuning, real-time electrical monitoring, and ships with a built-in BL616/BL618 serial firmware flasher.

- **Desktop (Windows)**: three-column workbench — electrical params & comm log on the left, temperature curve & controls in the middle, parameter panels on the right. Single-file frontend, portable.
- **Mobile (Android)**: a fully rewritten UI — immersive top bar, drawer menu, bottom heater action bar, constant-temp / reflow tabs, settings dialogs. Adaptive to high-resolution screens and safe areas.
- Both share the same Rust backend and BLE protocol, with independent frontends.

## ✨ Features

### Desktop (Windows)

| | Feature | Description |
|---|---|---|
| 🔵 | **BLE Connection** | Auto-scans and identifies heater devices, direct connect by fixed advertised name, auto-reconnect on disconnect, remembers the last device |
| 🌡 | **Constant-Temp Mode** | Real-time temperature readout, progress bar, target temperature & 3 presets with online read/write, bidirectional heater toggle sync |
| 📈 | **Reflow Mode** | 4-segment curve (preheat→soak→reflow→cool) with per-segment coloring + live actual-temperature overlay, phase card highlight & timer |
| ⚙️ | **Parameter Config** | Constant-temp / reflow / heater / PID / power limit / fan / LED / temp compensation / auto-shutdown, in tabbed panels |
| ⚡ | **Electrical Monitoring** | Real-time input/output voltage, power, current, VPWM/IPWM duty sampling with a 5-minute rolling chart |
| 📦 | **Firmware Flasher** | Built-in BL616/BL618 serial firmware flasher (Web Serial), one tap from the title bar |
| 🔔 | **Toast Notifications** | Slide-in cards from the bottom-right, green/blue/red severity levels with countdown progress bars |
| 📋 | **Comm Log** | Color-coded by level; sticky slots for high-frequency data frames and connection status — no scrolling spam |
| 🎨 | **Themes** | Follow system / light / dark |

### Mobile (Android)

- Immersive top bar (connection status / theme / about) + drawer menu
- Constant-temp page: live temperature readout + progress bar + oscilloscope-style scrolling curve (adaptive time window, 2/5/10 min presets)
- Reflow page: per-segment colored reference curve + live temperature overlay + phase timer
- Electrical page: real-time voltage / power / current / duty monitoring
- Settings page: online PID, presets, fan, LED read/write with live value echo
- Packet reassembly: long frames split into ≤20-byte chunks are automatically reassembled, compatible with any MTU
- Auto-reconnect on disconnect; firmware update page (Web Serial flasher)

## 🧰 Tech Stack

| Layer | Technology |
|---|---|
| Framework | Tauri 2 (Rust backend + system WebView frontend) |
| BLE | [btleplug](https://github.com/deviceplug/btleplug) 0.11 (Windows WinRT / Android JNI) |
| Frontend | Vanilla HTML/CSS/JS single file, no build step — desktop `frontend/index.html`, mobile `frontend/mobile.html` |
| Async | tokio + futures |
| Firmware Flash | Web Serial API (BL616/BL618, two-stage handshake + MTU negotiation) |

## BLE Protocol

| Item | UUID |
|---|---|
| Service | `00009011-0000-1000-8000-00805f9b34fb` |
| Write characteristic (APP→device) | `00009012-0000-1000-8000-00805f9b34fb` |
| Notify characteristic (device→APP) | `00009013-0000-1000-8000-00805f9b34fb` |

**Frame format**: downlink `[commandId, payloadLength, payload...]`; uplink falls into three categories —

- **Live status group frames** `[0x03][groupId][length][TLV...]`: pushed every 300ms — 0x4F (temp / set-temp / voltage / heater / mode) + 0x57 (work seconds) + 0x58 (electrical); TLV is `[id][len][value]`, little-endian
- **Config snapshot**: ~2s after connect, 7 config groups (0x50~0x5A: basic / other / reflow / PID / fan) are pushed once
- **Single-value echo frames** `[type][commandId][length][value]`: type 0x10~0x14 (U8/U16/I16/U32/FLOAT), one echo per written command

> On Android the BLE MTU is limited, so long frames are split into ≤20-byte chunks; the mobile frontend reassembles them by frame header before parsing.

## 📦 Firmware Flasher

Built-in Bouffalo BL616/BL618 serial firmware flasher (enter via「Firmware Update」in the title bar):

- Same two-stage flow as the official bflb_iot_tool: 500k handshake reads bootinfo / chip ID → clk_set (0x22) upgrades to the working baud rate
- Automatic fallback to 500k all-the-way if the upgrade fails; baud-rate scan / no-reset handshake / erase before flash / write verify / SHA256 readback
- Multiple files with independent start addresses (default 0x10000), byte-level verification against cache illusions

## Build

### Desktop (Windows)

```bash
powershell build-tauri.ps1   # recommended: handles frontend re-embed & packaging
cargo tauri build            # or use the Tauri CLI directly
```

### Android (APK)

```bash
powershell build-android.ps1   # one-shot: cross-compile release .so → jniLibs → gradle package → byte verification
```

Requires JDK 17, Android SDK/NDK, and the Rust `aarch64-linux-android` target. **Key pitfalls in [BUILD.md](BUILD.md)**:

1. Frontend changes require deleting build fingerprints to force `generate_context!` to re-embed assets — otherwise the APK keeps serving the old page
2. The cdylib link needs the NDK clang directly (the `.cmd` wrapper garbles errors) plus `RUSTFLAGS` with the target
3. btleplug's Java support classes (`gen/android/java-src/`) are compiled to a jar manually; patches for MTU negotiation and the Android 13+ callback signature are included
4. Attach the JVM before calling JNI from tokio worker threads

## ⬇️ Download

[GitHub Releases](https://github.com/hsb689/aipiPC/releases):

- **Windows**: portable zip (unzip and run; Win11 usually ships the WebView2 runtime) or MSI installer
- **Android**: APK (arm64)

## 🙏 Acknowledgements

- Thanks to **AiPi (安信可科技)** — special thanks to 园长爱笑
- Thanks to **LiShanwen**, author of **SGL**, and every contributor of the SGL open-source team — <https://github.com/sgl-org/sgl>
- Special thanks to **沈工 (沈夜)** for providing the auto-download host source, avoiding the Bouffalo approach
- The UI is still being polished — contributions on color schemes or design ideas are welcome; we can make this project look even better together with the SGL designer

---

<div align="center">

**简体中文**: see [README.md](README.md)

</div>
