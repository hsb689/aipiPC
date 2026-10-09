use anyhow::Result;
use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::stream::StreamExt;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use uuid::Uuid;

const BLE_SERVICE_UUID: &str = "00009011-0000-1000-8000-00805f9b34fb";
const BLE_WRITE_UUID: &str = "00009012-0000-1000-8000-00805f9b34fb";
const BLE_NOTIFY_UUID: &str = "00009013-0000-1000-8000-00805f9b34fb";

// Android: JVM 裸指针缓存(JNI_OnLoad 时存入), 供任意 tokio 工作线程 attach
#[cfg(target_os = "android")]
static ANDROID_JVM: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

// eprintln! 在安卓上不进 logcat; 用 android_logger 输出, tag "aipi-ble"
#[cfg(target_os = "android")]
fn init_ble_logging() {
    android_logger::init_once(
        android_logger::Config::default()
            .with_max_level(log::LevelFilter::Info)
            .with_tag("aipi-ble"),
    );
}

// Android: tokio 工作线程是 native 线程, JNI 调用前必须 attach(幂等, daemon 永久)
#[cfg(target_os = "android")]
fn ensure_jni_attached() -> Result<(), String> {
    if let Some(&raw) = ANDROID_JVM.get() {
        let vm = unsafe { jni::JavaVM::from_raw(raw as *mut jni::sys::JavaVM) }
            .map_err(|e| format!("JavaVM: {e}"))?;
        vm.attach_current_thread_as_daemon().map_err(|e| format!("attach: {e}"))?;
    }
    Ok(())
}

// JVM 加载 so 时完成 btleplug/jni-utils 的 JNI 注册(扫描回调、Future 唤醒等),
// 必须在任何 BLE 调用前完成; 不能用 ndk_context(tao/tauri 不初始化它, 会 panic)
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn JNI_OnLoad(vm: *mut jni::sys::JavaVM, _reserved: *mut std::ffi::c_void) -> i32 {
    let res = (|| -> Result<(), String> {
        let jvm = unsafe { jni::JavaVM::from_raw(vm) }.map_err(|e| format!("JavaVM: {e}"))?;
        let _ = ANDROID_JVM.set(vm as usize);
        let guard = jvm.attach_current_thread().map_err(|e| format!("attach: {e}"))?;
        let env: &jni::JNIEnv = &guard;
        // jni-utils 的 native 方法(FnAdapter.callInternal 等)必须先注册,
        // 否则 Java 侧 GATT 完成后的 Future 唤醒链路断裂, 连接永久挂起
        jni_utils::init(env).map_err(|e| format!("jni_utils init: {e}"))?;
        btleplug::platform::init(env).map_err(|e| format!("btleplug init: {e}"))
    })();
    if let Err(e) = res {
        log::warn!("[BLE] JNI_OnLoad init failed: {e}");
    }
    jni::JNIVersion::V6.into()
}

struct BleState {
    adapter: Option<Adapter>,
    peripheral: Option<Peripheral>,
    connected: bool,
    // (address, name) of the last successfully connected device, so a scan
    // right after disconnect can still surface it before it re-advertises.
    last_device: Option<(String, String)>,
}

impl Default for BleState {
    fn default() -> Self {
        Self { adapter: None, peripheral: None, connected: false, last_device: None }
    }
}

type SharedBle = Arc<Mutex<BleState>>;

#[derive(Serialize)]
struct BleDevice { name: String, id: String }

async fn get_adapter() -> Result<Adapter, String> {
    #[cfg(target_os = "android")]
    ensure_jni_attached()?;
    let manager = Manager::new().await.map_err(|e| format!("BLE manager: {e}"))?;
    let adapters = manager.adapters().await.map_err(|e| format!("adapters: {e}"))?;
    adapters.into_iter().next().ok_or_else(|| "No BLE adapter found".into())
}

fn is_heater_name(n: &str) -> bool {
    let n = n.trim();
    !n.is_empty()
        && n.ne("Unknown")
        && (n.contains("AiPi") || n.contains("AIPI") || n.contains("aipi")
            || n.contains("加热台") || n.contains("Heat") || n.contains("heat")
            || n.contains("Thermo") || n.contains("thermo"))
}

#[tauri::command]
async fn ble_scan(state: tauri::State<'_, SharedBle>) -> Result<Vec<BleDevice>, String> {
    // Reuse the adapter from a previous scan when possible: building a fresh
    // Manager on Windows loses the peripheral cache, so devices seen before a
    // disconnect vanish from the next scan and reconnect appears to find nothing.
    let adapter = {
        #[cfg(target_os = "android")]
        ensure_jni_attached()?;
        let s = state.lock().await;
        match s.adapter.as_ref() {
            Some(a) => a.clone(),
            None => get_adapter().await?,
        }
    };
    adapter.start_scan(ScanFilter::default()).await.map_err(|e| format!("start_scan: {e:?}"))?;

    // Poll up to 5s instead of a fixed 1s wait: BLE devices advertise every
    // 1~2s, so a 1s window often misses them entirely. Return early as soon
    // as a heater device shows up.
    let mut named: Vec<BleDevice> = Vec::new();
    for _ in 0..10 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let peripherals = adapter.peripherals().await.map_err(|e| format!("peripherals: {e}"))?;
        named.clear();
        let mut heaters: Vec<BleDevice> = Vec::new();
        for p in &peripherals {
            if let Ok(props) = p.properties().await {
                let name = props.and_then(|pr| pr.local_name).unwrap_or_else(|| "Unknown".into());
                let n = name.trim();
                if n.is_empty() || n == "Unknown" { continue; }
                let id = p.address().to_string();
                if is_heater_name(n) {
                    heaters.push(BleDevice { name: name.clone(), id });
                } else {
                    named.push(BleDevice { name, id });
                }
            }
        }
        if !heaters.is_empty() {
            adapter.stop_scan().await.ok();
            state.lock().await.adapter = Some(adapter);
            return Ok(heaters);
        }
        // Fallback: if the previously-connected device is still in the
        // adapter's peripheral cache (Windows keeps it a while after
        // disconnect), surface it even before it re-advertises.
        let recalled = { state.lock().await.last_device.clone() };
        if let Some((last_id, last_name)) = recalled {
            if heaters.iter().chain(named.iter()).all(|d| d.id != last_id)
                && peripherals.iter().any(|p| p.address().to_string() == last_id)
            {
                heaters.push(BleDevice { name: last_name, id: last_id });
                adapter.stop_scan().await.ok();
                state.lock().await.adapter = Some(adapter);
                return Ok(heaters);
            }
        }
    }
    adapter.stop_scan().await.map_err(|e| format!("stop_scan: {e}"))?;
    state.lock().await.adapter = Some(adapter);
    Ok(named)
}

// 连接成功后向设备发"空载荷查询帧"(电脑版同款修复):
// 设备把空载荷帧当作查询指令, 收到后才回传各项当前值(PID/风扇/LED/预设等),
// 否则下位机不主动推送配置, 手机端永远显示 "--"。
async fn query_all_config(target: &Peripheral) {
    // 仅值类/配置类命令(不含 SET_HEATER/SET_WORK_MODE, 避免误触发状态变更)
    const QUERY_CMDS: [u8; 17] = [
        0x01, // SET_TARGET_TEMP
        0x02, 0x03, 0x04, // SET_PRESET1..3
        0x05, 0x06, // SET_TCOMP / SET_ASHUT
        0x10, 0x11, 0x12, 0x13, 0x14, 0x15, // 回流参数
        0x20, 0x21, 0x22, // PID_KP/KI/KD
        0x26, // POWER_LIMIT
        0x27, // FAN_PWM
    ];
    let write_uuid = Uuid::parse_str(BLE_WRITE_UUID).unwrap();
    if let Some(ch) = target.characteristics().iter().find(|c| c.uuid == write_uuid) {
        for cmd in QUERY_CMDS {
            if target.write(ch, &[cmd, 0x00], WriteType::WithoutResponse).await.is_err() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        }
        // 风扇 PWM / LED 亮度 / 风扇模式 走单字节查询
        for cmd in [0x28u8, 0x29u8] {
            let _ = target.write(ch, &[cmd, 0x00], WriteType::WithoutResponse).await;
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        }
    }
    log::info!("[BLE] empty-packet config query sent");
}

#[tauri::command]
async fn ble_connect(
    state: tauri::State<'_, SharedBle>,
    device_id: String,
    app: AppHandle,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    ensure_jni_attached()?;
    let mut s = state.lock().await;
    let adapter = s.adapter.as_ref().ok_or("No adapter, call ble_scan first")?;
    let peripherals = adapter.peripherals().await.map_err(|e| format!("peripherals: {e}"))?;
    let target = peripherals.into_iter().find(|p| p.address().to_string() == device_id);
    let target = match target {
        Some(p) => p,
        None => {
            adapter.start_scan(ScanFilter::default()).await.map_err(|e| format!("start_scan: {e:?}"))?;
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            adapter.stop_scan().await.ok();
            let peripherals = adapter.peripherals().await.map_err(|e| format!("peripherals: {e}"))?;
            peripherals.into_iter().find(|p| p.address().to_string() == device_id)
                .ok_or_else(|| format!("Device {device_id} not found"))?
        }
    };

    // Windows btleplug 常见首连失败; 重试 5 次。若 OS 层已连上则跳过握手。
    let mut connected = false;
    for attempt in 1..=5 {
        if target.is_connected().await.unwrap_or(false) { connected = true; break; }
        match target.connect().await {
            Ok(_) => { connected = true; break; }
            Err(e) => {
                log::warn!("[BLE] connect attempt {attempt} failed: {e}");
                if attempt < 5 { tokio::time::sleep(std::time::Duration::from_millis(400)).await; }
            }
        }
    }
    if !connected {
        return Err("连接失败(重试5次)。请确认设备未被其他手机/电脑占用。".into());
    }
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    target.discover_services().await.map_err(|e| format!("discover: {e}"))?;

    let write_uuid = Uuid::parse_str(BLE_WRITE_UUID).unwrap();
    let notify_uuid = Uuid::parse_str(BLE_NOTIFY_UUID).unwrap();

    let chars = target.characteristics();
    for c in &chars {
        log::info!("[BLE] char uuid={} props={:?}", c.uuid, c.properties);
    }
    let has_write = chars.iter().any(|c| c.uuid == write_uuid);
    if !has_write {
        let list: Vec<String> = chars.iter().map(|c| format!("{}", c.uuid)).collect();
        return Err(format!("写特征9012未发现! 设备实际暴露: {}", list.join(", ")));
    }

    // 先注册通知流(与电脑版一致), 再订阅 9013。找不到时明确报错并列出实际特征。
    let p_clone = target.clone();
    let mut events = p_clone.notifications().await.map_err(|e| format!("notifications: {e}"))?;

    let notify_ch = chars.iter().find(|c| c.uuid == notify_uuid)
        .ok_or_else(|| {
            let list: Vec<String> = chars.iter().map(|c| format!("{}", c.uuid)).collect();
            format!("通知特征9013未发现! 设备实际暴露: {}", list.join(", "))
        })?;
    #[cfg(target_os = "android")]
    {
        // Android: 先退订再订阅会立刻终结 notifications 流(表现为连上了但永远
        // 收不到任何数据) —— 设备每 300ms 无条件周期推送, 订阅一次即可
        target.subscribe(notify_ch).await.map_err(|e| format!("subscribe: {e}"))?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = target.unsubscribe(notify_ch).await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        target.subscribe(notify_ch).await.map_err(|e| format!("subscribe: {e}"))?;
    }
    log::info!("[BLE] subscribed notify char OK");

    // 通知监听: 流结束 = 断连
    let app_clone = app.clone();
    let state_monitor = state.inner().clone();
    tokio::spawn(async move {
        #[cfg(target_os = "android")]
        { let _ = ensure_jni_attached(); }
        while let Some(event) = events.next().await {
            log::info!("[BLE] notify {}B {:02X?}", event.value.len(), &event.value[..event.value.len().min(10)]);
            let _ = app_clone.emit("ble-notify", event.value);
        }
        let _ = app_clone.emit("ble-disconnected", ());
        let mut s = state_monitor.lock().await;
        s.peripheral = None;
        s.connected = false;
    });

    // 健康检查: 连续 3 次失败(~6s)判死, 避免误报
    let p_health = target.clone();
    let app_health = app.clone();
    let state_health = state.inner().clone();
    tokio::spawn(async move {
        let mut fails = 0u32;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            // tokio 可能在线程间迁移任务, 每次轮询前重新 attach
            #[cfg(target_os = "android")]
            { let _ = ensure_jni_attached(); }
            match p_health.is_connected().await {
                Ok(true) => fails = 0,
                _ => {
                    fails += 1;
                    if fails >= 3 {
                        let _ = app_health.emit("ble-disconnected", ());
                        let mut s = state_health.lock().await;
                        s.peripheral = None;
                        s.connected = false;
                        break;
                    }
                }
            }
        }
    });

    let name = target.properties().await.ok().flatten()
        .and_then(|p| p.local_name).unwrap_or_else(|| "Connected".into());
    s.last_device = Some((device_id.clone(), name.clone()));
    s.peripheral = Some(target);
    s.connected = true;
    drop(s);

    // 注意: 连接后不要发送逐项查询([cmd,0x00]) —— 实测会打断设备的 300ms 周期上报,
    // 导致只有连接瞬间有数据。设备在连接后 ~2s 会主动补发 7 个配置组快照。
    Ok(name)
}

#[tauri::command]
async fn ble_disconnect(state: tauri::State<'_, SharedBle>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    ensure_jni_attached()?;
    let mut s = state.lock().await;
    if let Some(ref p) = s.peripheral {
        let chars = p.characteristics();
        let notify_uuid = Uuid::parse_str(BLE_NOTIFY_UUID).unwrap();
        if let Some(ch) = chars.iter().find(|c| c.uuid == notify_uuid) {
            let _ = p.unsubscribe(ch).await;
        }
        let _ = p.disconnect().await;
    }
    s.peripheral = None;
    s.connected = false;
    Ok(())
}

#[tauri::command]
async fn ble_write(state: tauri::State<'_, SharedBle>, data: Vec<u8>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    ensure_jni_attached()?;
    let s = state.lock().await;
    let p = s.peripheral.as_ref().ok_or("Not connected")?;
    let write_uuid = Uuid::parse_str(BLE_WRITE_UUID).unwrap();
    let chars = p.characteristics();
    let ch = chars.iter().find(|c| c.uuid == write_uuid)
        .ok_or("Write characteristic not found")?;
    p.write(ch, &data, WriteType::WithoutResponse).await.map_err(|e| format!("write: {e}"))
}

#[tauri::command]
async fn ble_is_connected(state: tauri::State<'_, SharedBle>) -> Result<bool, String> {
    let s = state.lock().await;
    Ok(s.connected)
}

// 用系统默认浏览器打开外部链接(更新页等)。
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs are allowed".into());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| format!("open failed: {e}"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "android")]
    init_ble_logging();
    tauri::Builder::default()
        .manage(SharedBle::default())
        .invoke_handler(tauri::generate_handler![
            ble_scan, ble_connect, ble_disconnect, ble_write, ble_is_connected, open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
