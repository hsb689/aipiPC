# AiPi 加热台上位机

基于 Tauri 2 的 BLE(低功耗蓝牙)加热台上位机,通过 BLE 与 AiPi 加热台下位机通信,提供恒温控制、回流焊曲线、参数配置与电气信号监控等功能。

当前版本:**V0.01**

## 功能特性

- **BLE 连接**:自动扫描并识别加热台设备(按设备名过滤),断开后可快速重连;支持多设备选择,自动记忆上次连接的设备
- **恒温模式**:实时温度曲线显示、目标温度下发、3 组温度预设、加热开关
- **回流焊模式**:回流焊温度曲线配置与下发(多段参数)
- **参数配置**:恒温/回流焊/加热参数(目标温度、PID、告警等)通过右侧标签页分组下发
- **电气信号监控**:VPWM / IPWM 占用率实时采集,5 分钟滚动曲线
- **通信日志**:按等级着色(错误红、连接绿、数据橙、发送蓝、信息灰),高频数据日志与连接状态日志固定槽位替换,不刷屏
- **主题**:跟随系统 / 浅色 / 深色

## 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Tauri 2(Rust 后端 + 系统 WebView 前端) |
| BLE | [btleplug](https://github.com/deviceplug/btleplug) 0.11(Windows WinRT 后端) |
| 前端 | 原生 HTML/CSS/JS,单文件 `frontend/index.html`,无构建步骤 |
| 异步 | tokio + futures |

BLE 协议(SERVICE `9011` / WRITE `9012` / NOTIFY `9013`)为自定义帧格式:`[命令ID, 载荷长度, 载荷...]`。

## 从源码构建

依赖:Rust(GNU 工具链)、Node.js、Tauri 2 CLI。

```bash
npm install
npx tauri build          # 或使用 build-tauri.ps1(Windows)
```

产物位于 `target/release/aipi-heater-upper.exe`。

> 注意:前端 HTML 是编译时嵌入 exe 的。只改了 `frontend/` 下的文件时,直接 `cargo build` 不会重嵌资源——请使用仓库里的 `build-tauri.ps1`,它会在编译前 touch `src/main.rs` 强制 `generate_context!` 重新嵌入。

## 使用说明

1. 安装并运行上位机,开启加热台电源;
2. 点击「连接设备」,应用会自动扫描(约 5 秒),从列表中选择你的加热台;
3. 选择工作模式(恒温 / 回流焊),下发目标温度或曲线参数;
4. 右侧标签页可下发各类配置参数,通信日志面板可查看全部收发数据。

## 目录结构

```
├── src/main.rs          # Tauri 后端:BLE 扫描/连接/读写/通知
├── frontend/index.html  # 完整前端(界面 + 逻辑)
├── build-tauri.ps1      # Windows 构建脚本(强制重嵌前端资源)
├── tauri.conf.json      # Tauri 配置(版本号在此维护)
└── icons/               # 应用图标
```

## 下载

前往 [Releases](https://github.com/hsb689/aipiPC/releases) 下载最新版 `AiPi-Heater-Upper-V0.01.exe`(免安装,单文件运行)。

## License

MIT
