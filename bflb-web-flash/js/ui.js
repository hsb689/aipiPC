// ============================================================
// ui.js — 界面绑定
// ============================================================

import { BouffaloSerial, isSerialSupported, isSecureContextOk } from './transport.js';
import { CHIPS, BouffaloLink } from './protocol.js';
import { BouffaloFlasher, FlashFile } from './flasher.js';
import { loaderKeys } from './loader-bl602.js';
import { parseAddr, humanSize, hex32 } from './util.js';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const chipSel = $('chip');
const baudSel = $('baud');
const loaderSel = $('loader');
const loaderWrap = $('loader-wrap');
const resetSel = $('reset-mode');
const btnConnect = $('btn-connect');
const btnDetect = $('btn-detect');
const btnScan = $('btn-scan');
const btnDisconnect = $('btn-disconnect');
const btnFlash = $('btn-flash');
const btnAddFile = $('btn-add-file');
const btnClear = $('btn-clear');
const portLabel = $('port-label');
const fileList = $('filelist');
const bar = $('bar');
const pctEl = $('pct');
const speedEl = $('speed');
const optErase = $('opt-erase');
const optNoReset = $('opt-noreset');
const optVerify = $('opt-verify');
const optSha = $('opt-sha');
const optVerbose = $('opt-verbose');
const envWarn = $('env-warn');

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------
const MAX_LINES = 3000;
let verbose = false;

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function log(level, msg) {
  if (level === 'dbg' && !verbose) return;
  const el = $('log');
  const line = document.createElement('div');
  line.className = 'ln ' + level;
  line.textContent = `${ts()}  ${msg}`;
  el.appendChild(line);
  while (el.childElementCount > MAX_LINES) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
const serial = new BouffaloSerial(log);
let busy = false;
let connected = false;

function setBusy(b) {
  busy = b;
  updateButtons();
}

function updateButtons() {
  btnConnect.disabled = busy || connected;
  btnDisconnect.disabled = busy || !connected;
  btnDetect.disabled = busy || !connected;
  btnScan.disabled = busy || !connected;
  btnFlash.disabled = busy || !connected;
  btnAddFile.disabled = busy;
  chipSel.disabled = busy || connected;
  baudSel.disabled = busy || connected;
  loaderSel.disabled = busy || connected;
  resetSel.disabled = busy || connected;
}

// ---------------------------------------------------------------------------
// 初始化下拉框
// ---------------------------------------------------------------------------
function initSelects() {
  for (const [key, info] of Object.entries(CHIPS)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = info.label + (info.bootromDirect ? '' : '  (需 eflash_loader)');
    chipSel.appendChild(o);
  }
  chipSel.value = 'bl616';

  const keys = loaderKeys();
  for (const k of keys) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = `eflash_loader_${k}.bin`;
    loaderSel.appendChild(o);
  }
  if (keys.includes('40m')) loaderSel.value = '40m';

  chipSel.addEventListener('change', syncLoaderVisibility);
  syncLoaderVisibility();
}

function syncLoaderVisibility() {
  loaderWrap.style.visibility = (chipSel.value === 'bl602') ? 'visible' : 'hidden';
}

// ---------------------------------------------------------------------------
// 文件行
// ---------------------------------------------------------------------------
function addFileRow() {
  const row = document.createElement('div');
  row.className = 'filerow';

  const fi = document.createElement('input');
  fi.type = 'file';
  fi.accept = '.bin,application/octet-stream';

  const addr = document.createElement('input');
  addr.type = 'text';
  addr.className = 'addr';
  addr.value = '0x0000';
  addr.spellcheck = false;

  const rm = document.createElement('button');
  rm.className = 'rm';
  rm.textContent = '×';
  rm.title = '移除';
  rm.addEventListener('click', () => {
    if (fileList.childElementCount <= 1) {
      fi.value = '';
      addr.value = '0x0000';
      return;
    }
    row.remove();
  });

  fi.addEventListener('change', () => {
    const f = fi.files && fi.files[0];
    if (f) log('info', `选择文件: ${f.name} (${humanSize(f.size)})`);
  });

  row.append(fi, addr, rm);
  fileList.appendChild(row);
}

// ---------------------------------------------------------------------------
// 连接 / 断开
// ---------------------------------------------------------------------------
function describePort(port) {
  try {
    const info = port.getInfo ? port.getInfo() : {};
    if (info && (info.usbVendorId || info.usbProductId)) {
      const h = (v) => v === undefined ? '????' : v.toString(16).padStart(4, '0');
      return `已连接 (VID:${h(info.usbVendorId)} PID:${h(info.usbProductId)})`;
    }
  } catch (_) { /* ignore */ }
  return '已连接';
}

btnConnect.addEventListener('click', async () => {
  if (!isSerialSupported()) {
    log('err', '当前浏览器不支持 Web Serial API。请使用 Chrome / Edge 89+ 桌面版。');
    return;
  }
  setBusy(true);
  try {
    const baud = parseInt(baudSel.value, 10);
    log('info', '请在弹出的对话框中选择串口设备 ...');
    await serial.request();          // 必须在用户手势内
    await serial.open(baud);
    connected = true;
    portLabel.textContent = describePort(serial.port);
    portLabel.classList.add('on');
    log('ok', `串口已打开, 波特率 ${baud} bps`);
  } catch (e) {
    log('err', '打开串口失败: ' + (e && e.message ? e.message : e));
    try { await serial.close(); } catch (_) { /* ignore */ }
    connected = false;
    portLabel.textContent = '未连接';
    portLabel.classList.remove('on');
  } finally {
    setBusy(false);
    updateButtons();
  }
});

btnDisconnect.addEventListener('click', async () => {
  setBusy(true);
  try {
    await serial.close();
    log('info', '串口已关闭');
  } catch (e) {
    log('warn', '关闭串口时出错: ' + (e && e.message ? e.message : e));
  } finally {
    connected = false;
    portLabel.textContent = '未连接';
    portLabel.classList.remove('on');
    setBusy(false);
    updateButtons();
  }
});

// ---------------------------------------------------------------------------
// 读取配置
// ---------------------------------------------------------------------------
function readCfg() {
  return {
    chip: chipSel.value,
    baud: parseInt(baudSel.value, 10),
    loaderKey: loaderSel.value,
    resetRevert: resetSel.value === 'revert',
    noReset: optNoReset.checked,
    erase: optErase.checked,
    verify: optVerify.checked,
    sha: optSha.checked,
  };
}

function makeFlasher(cfg) {
  return new BouffaloFlasher({
    serial,
    chip: cfg.chip,
    loaderKey: cfg.loaderKey,
    resetRevert: cfg.resetRevert,
    noReset: cfg.noReset,
    workBaud: cfg.baud,
    log,
    verbose,
  });
}

// ---------------------------------------------------------------------------
// 检测芯片信息
// ---------------------------------------------------------------------------
btnDetect.addEventListener('click', async () => {
  if (!connected) { log('warn', '请先连接串口'); return; }
  const cfg = readCfg();
  setBusy(true);
  resetProgress();
  try {
    const flasher = makeFlasher(cfg);
    const { bootinfo, jid } = await flasher.init();
    log('ok', `检测完成: bootinfo=${bootinfo ? bootinfo.length : 0} 字节` +
      (jid && jid.length ? `, JID=${Array.from(jid, (b) => b.toString(16).padStart(2, '0')).join('')}` : ''));
  } catch (e) {
    log('err', '检测失败: ' + (e && e.message ? e.message : e));
  } finally {
    setBusy(false);
  }
});

// ---------------------------------------------------------------------------
// 扫描波特率: 芯片已在 bootrom 时逐个波特率试握手 (不复位)
// ---------------------------------------------------------------------------
const SCAN_BAUDS = [500000, 921600, 2000000, 1500000, 115200];
btnScan.addEventListener('click', async () => {
  if (!connected) { log('warn', '请先连接串口'); return; }
  setBusy(true);
  const revert = resetSel.value === 'revert';
  try {
    let found = 0;
    for (const b of SCAN_BAUDS) {
      log('info', '尝试 ' + b + ' bps (先复位进 bootrom 再握手) ...');
      try {
        await serial.reopen(b);
      } catch (e) {
        log('err', '切换到 ' + b + ' 失败: ' + (e && e.message ? e.message : e));
        continue;
      }
      const link = new BouffaloLink(serial, chipSel.value, { log, dbg: () => {} });
      if (await link.resetToBootrom({ doReset: true, resetRevert: revert, retry: 1 })) {
        found = b;
        baudSel.value = String(b);
        log('ok', '握手成功! 波特率 = ' + b + ' (已自动选中)');
        log('ok', '直接点「检测芯片信息」即可; 「不复位直接握手」保持不勾选');
        break;
      }
      log('warn', b + ' 无应答');
    }
    if (!found) {
      log('err', '所有波特率都握手失败。检查: TX/RX 是否接反 / 共地 / 复位电平是否选对(试另一个)');
    }
  } finally {
    setBusy(false);
    updateButtons();
  }
});

// ---------------------------------------------------------------------------
// 烧录
// ---------------------------------------------------------------------------
function resetProgress() {
  bar.style.width = '0%';
  pctEl.textContent = '0%';
  speedEl.textContent = '';
}

function onProgress(cur, total, elapsedMs, suffix) {
  const pct = total ? Math.floor((cur * 100) / total) : 100;
  bar.style.width = pct + '%';
  pctEl.textContent = pct + '%';
  const kb = elapsedMs > 0 ? cur / (elapsedMs / 1000) / 1024 : 0;
  speedEl.textContent =
    `${humanSize(cur)} / ${humanSize(total)}` +
    `   ${kb.toFixed(0)} KB/s` +
    (suffix ? `   [${suffix}]` : '');
}

async function collectFiles() {
  const rows = Array.from(fileList.querySelectorAll('.filerow'));
  const files = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const input = row.querySelector('input[type="file"]');
    const addrIn = row.querySelector('input.addr');
    const f = input.files && input.files[0];
    if (!f) continue;

    let addr;
    try {
      addr = parseAddr(addrIn.value);
    } catch (e) {
      throw new Error(`第 ${i + 1} 行地址非法: ${addrIn.value}`);
    }
    const buf = await f.arrayBuffer();
    files.push(new FlashFile(f.name, new Uint8Array(buf), addr));
  }
  return files;
}

btnFlash.addEventListener('click', async () => {
  if (!connected) { log('warn', '请先连接串口'); return; }
  const cfg = readCfg();

  let files;
  try {
    files = await collectFiles();
  } catch (e) {
    log('err', e.message);
    return;
  }
  if (!files.length) { log('warn', '请先选择至少一个固件文件'); return; }

  log('info', `准备烧录 ${files.length} 个文件:`);
  for (const f of files) log('info', `    ${hex32(f.addr)}  ${f.name}  (${f.data.length} 字节)`);

  setBusy(true);
  resetProgress();
  const t0 = performance.now();
  try {
    const flasher = makeFlasher(cfg);
    await flasher.flash(files, {
      erase: cfg.erase,
      verify: cfg.verify,
      shaVerify: cfg.sha,
      onProgress,
    });
    bar.style.width = '100%';
    pctEl.textContent = '100%';
    log('ok', `全部完成, 总耗时 ${((performance.now() - t0) / 1000).toFixed(2)}s`);
  } catch (e) {
    log('err', '烧录失败: ' + (e && e.message ? e.message : e));
    if (e && e.stack && verbose) log('dbg', e.stack);
  } finally {
    setBusy(false);
  }
});

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------
btnAddFile.addEventListener('click', addFileRow);
btnClear.addEventListener('click', () => { $('log').textContent = ''; });
optVerbose.addEventListener('change', () => {
  verbose = optVerbose.checked;
  log('info', '详细日志: ' + (verbose ? '开' : '关'));
});

window.addEventListener('beforeunload', () => {
  try { if (serial.isOpen) serial.close(); } catch (_) { /* ignore */ }
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
(function boot() {
  initSelects();
  addFileRow();

  if (!isSerialSupported()) {
    envWarn.classList.remove('hidden');
    envWarn.textContent =
      '当前浏览器不支持 Web Serial API。请改用 Chrome / Edge 89+ 桌面版打开本页面。';
  } else if (!isSecureContextOk()) {
    envWarn.classList.remove('hidden');
    envWarn.textContent =
      'Web Serial 需要安全上下文 (HTTPS 或 http://localhost)。' +
      '请用 web/start-server.bat 启动本地服务后访问 http://localhost:8000。';
  }

  log('info', 'Bouffalo Web Flash 就绪。点「连接串口」开始。');
  updateButtons();
})();
