#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use anyhow::Result;
use btleplug::api::{Central, CharPropFlags, Manager as _, Peripheral as _, ScanFilter, WriteType};
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
        let s = state.lock().await;
        match s.adapter.as_ref() {
            Some(a) => a.clone(),
            None => get_adapter().await?,
        }
    };
    adapter.start_scan(ScanFilter::default()).await.map_err(|e| format!("start_scan: {e}"))?;

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
                // Filter: drop empty/unknown names (BLE scan spam). Prefer
                // heater devices; if none advertised yet, fall back to all
                // named devices so the picker still shows something (the
                // web Bluetooth picker behaves the same way).
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
            let mut s = state.lock().await;
            s.adapter = Some(adapter);
            return Ok(heaters);
        }
        // Fallback: if the previously-connected device is still in the
        // adapter's peripheral cache (Windows keeps it a while after
        // disconnect), surface it even before it re-advertises.
        let recalled = {
            let s = state.lock().await;
            s.last_device.clone()
        };
        if let Some((last_id, last_name)) = recalled {
            if heaters.iter().chain(named.iter()).all(|d| d.id != last_id)
                && peripherals.iter().any(|p| p.address().to_string() == last_id)
            {
                heaters.push(BleDevice { name: last_name, id: last_id });
                adapter.stop_scan().await.ok();
                let mut s = state.lock().await;
                s.adapter = Some(adapter);
                return Ok(heaters);
            }
        }
    }
    adapter.stop_scan().await.map_err(|e| format!("stop_scan: {e}"))?;
    let mut s = state.lock().await;
    s.adapter = Some(adapter);
    Ok(named)
}

#[tauri::command]
async fn ble_connect(
    state: tauri::State<'_, SharedBle>,
    device_id: String,
    app: AppHandle,
) -> Result<String, String> {
    let mut s = state.lock().await;
    let adapter = s.adapter.as_ref().ok_or("No adapter, call ble_scan first")?;
    let peripherals = adapter.peripherals().await.map_err(|e| format!("peripherals: {e}"))?;
    let target = peripherals.into_iter().find(|p| p.address().to_string() == device_id);
    let target = match target {
        Some(p) => p,
        None => {
            // Device may have started advertising after the scan ended.
            // Do one quick re-scan before giving up.
            adapter.start_scan(ScanFilter::default()).await.map_err(|e| format!("start_scan: {e}"))?;
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            adapter.stop_scan().await.ok();
            let peripherals = adapter.peripherals().await.map_err(|e| format!("peripherals: {e}"))?;
            peripherals.into_iter().find(|p| p.address().to_string() == device_id)
                .ok_or_else(|| format!("Device {device_id} not found"))?
        }
    };

    // Windows btleplug often fails first connect attempt; retry up to 5 times.
    // If the OS-level link is already up (e.g. quick reconnect after
    // disconnect), skip the handshake entirely — calling connect() again on
    // an already-connected peripheral can error out on Windows.
    let mut connected = false;
    for attempt in 1..=5 {
        if target.is_connected().await.unwrap_or(false) {
            connected = true;
            break;
        }
        match target.connect().await {
            Ok(_) => { connected = true; break; }
            Err(e) => {
                eprintln!("[BLE] connect attempt {attempt} failed: {e}");
                if attempt < 5 {
                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                }
            }
        }
    }
    if !connected {
        return Err("Failed to connect after 5 attempts. Make sure the device is advertising and not already connected.".into());
    }
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    target.discover_services().await.map_err(|e| format!("discover: {e}"))?;

    let write_uuid = Uuid::parse_str(BLE_WRITE_UUID).unwrap();
    let notify_uuid = Uuid::parse_str(BLE_NOTIFY_UUID).unwrap();

    let chars = target.characteristics();
    for c in &chars {
        eprintln!("[BLE] char uuid={} service={:?} props={:?}", c.uuid, c.service_uuid, c.properties);
    }
    // Match by characteristic UUID only: on Windows btleplug may report
    // service_uuid in a different form (128-bit expanded / nil) after a
    // firmware GATT change, which breaks exact service_uuid equality.
    let has_write = chars.iter().any(|c| c.uuid == write_uuid);
    if !has_write { return Err("Write characteristic not found".into()); }

    let p_clone = target.clone();
    let app_clone = app.clone();

    // Set up notification stream BEFORE subscribing
    let mut events = p_clone.notifications().await.map_err(|e| format!("notifications: {e}"))?;

    if let Some(ch) = chars.iter().find(|c| c.uuid == notify_uuid) {
        // Force CCCD refresh: unsubscribe first, then subscribe
        let _ = target.unsubscribe(ch).await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        target.subscribe(ch).await.map_err(|e| format!("subscribe: {e}"))?;
    }

    // Monitor connection via notification stream ending (most reliable)
    let app_clone2 = app.clone();
    let state_monitor = state.inner().clone();
    tokio::spawn(async move {
        use futures::stream::StreamExt;
        while let Some(event) = events.next().await {
            let _ = app_clone2.emit("ble-notify", event.value);
        }
        // Stream ended = connection lost
        let _ = app_clone2.emit("ble-disconnected", ());
        let mut s = state_monitor.lock().await;
        s.peripheral = None;
        s.connected = false;
    });

    // Poll-based health check: Windows may not end the notification stream
    // when the device powers off. Require 3 consecutive failures (~6s) to
    // avoid false positives seen with is_connected() on WinRT.
    let p_health = target.clone();
    let app_health = app.clone();
    let state_health = state.inner().clone();
    tokio::spawn(async move {
        let mut fails = 0u32;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
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
    Ok(name)
}

#[tauri::command]
async fn ble_disconnect(state: tauri::State<'_, SharedBle>) -> Result<(), String> {
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

fn main() {
    tauri::Builder::default()
        .manage(SharedBle::default())
        .invoke_handler(tauri::generate_handler![
            ble_scan, ble_connect, ble_disconnect, ble_write, ble_is_connected
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
