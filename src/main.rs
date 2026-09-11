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
}

impl Default for BleState {
    fn default() -> Self {
        Self { adapter: None, peripheral: None, connected: false }
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

#[tauri::command]
async fn ble_scan(state: tauri::State<'_, SharedBle>) -> Result<Vec<BleDevice>, String> {
    let adapter = get_adapter().await?;
    adapter.start_scan(ScanFilter::default()).await.map_err(|e| format!("start_scan: {e}"))?;
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    let peripherals = adapter.peripherals().await.map_err(|e| format!("peripherals: {e}"))?;
    let mut devices = Vec::new();
    for p in &peripherals {
        if let Ok(props) = p.properties().await {
            let name = props.and_then(|pr| pr.local_name).unwrap_or_else(|| "Unknown".into());
            let id = p.address().to_string();
            devices.push(BleDevice { name, id });
        }
    }
    adapter.stop_scan().await.map_err(|e| format!("stop_scan: {e}"))?;
    let mut s = state.lock().await;
    s.adapter = Some(adapter);
    Ok(devices)
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
    let target = peripherals.into_iter().find(|p| p.address().to_string() == device_id)
        .ok_or_else(|| format!("Device {device_id} not found"))?;

    // Windows btleplug often fails first connect attempt; retry up to 3 times
    let mut connected = false;
    for attempt in 1..=3 {
        match target.connect().await {
            Ok(_) => { connected = true; break; }
            Err(e) => {
                eprintln!("[BLE] connect attempt {attempt} failed: {e}");
                if attempt < 3 {
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        }
    }
    if !connected {
        return Err("Failed to connect after 3 attempts. Make sure the device is advertising and not already connected.".into());
    }
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    target.discover_services().await.map_err(|e| format!("discover: {e}"))?;

    let service_uuid = Uuid::parse_str(BLE_SERVICE_UUID).unwrap();
    let write_uuid = Uuid::parse_str(BLE_WRITE_UUID).unwrap();
    let notify_uuid = Uuid::parse_str(BLE_NOTIFY_UUID).unwrap();

    let chars = target.characteristics();
    let has_write = chars.iter().any(|c| c.uuid == write_uuid && c.service_uuid == service_uuid);
    if !has_write { return Err("Write characteristic not found".into()); }

    let p_clone = target.clone();
    let app_clone = app.clone();

    // Set up notification stream BEFORE subscribing
    let mut events = p_clone.notifications().await.map_err(|e| format!("notifications: {e}"))?;

    if let Some(ch) = chars.iter().find(|c| c.uuid == notify_uuid && c.service_uuid == service_uuid) {
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
    let service_uuid = Uuid::parse_str(BLE_SERVICE_UUID).unwrap();
    let write_uuid = Uuid::parse_str(BLE_WRITE_UUID).unwrap();
    let chars = p.characteristics();
    let ch = chars.iter().find(|c| c.uuid == write_uuid && c.service_uuid == service_uuid)
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
