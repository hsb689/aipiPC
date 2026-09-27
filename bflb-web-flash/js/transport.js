// ============================================================
// transport.js — Web Serial 传输层
//
// 对应 Python 版 bouffalo_flash.py 的 BouffaloUART 底层读写部分。
// 用 Web Serial API (navigator.serial) 实现:
//   - open / close / write / setSignals
//   - 后台读泵 + 软件环形缓冲
//   - read(n, timeout) / readAll(timeout)  —— 语义对齐 pyserial 的 timeout
//
// 注意: Web Serial 不支持在端口打开状态下修改波特率,
//       所以本工具"全程单波特率",不存在 setBaudrate。
// ============================================================

import { sleep, hasByte } from './util.js';

export { sleep, hex, hasByte } from './util.js';

export class BouffaloSerial {
  constructor(onLog) {
    this.port = null;
    this.baudRate = 0;

    this.writer = null;
    this.reader = null;
    this._pump = null;
    this._stopping = false;

    /** 收到的字节缓冲 (数组分片, 避免频繁大数组拷贝) */
    this._chunks = [];
    this._len = 0;

    /** 当前等待者: { need, resolve, timer } —— 协议是严格一问一答, 单个足够 */
    this._waiter = null;

    /** 读超时 (秒), 对齐 pyserial 的 ser.timeout */
    this.rxTimeout = 2.0;

    this._signalsUsable = true;
    this._signalsWarned = false;

    this.onLog = typeof onLog === 'function' ? onLog : () => {};
  }

  get isOpen() { return !!this.port; }

  /** 弹出端口选择框。必须在用户手势 (click) 内调用。 */
  async request() {
    if (!('serial' in navigator)) {
      throw new Error('当前浏览器不支持 Web Serial API, 请使用 Chrome / Edge 89+ 桌面版');
    }
    this.port = await navigator.serial.requestPort();
    return this.port;
  }

  /** 用之前已授权的端口 (免弹窗)。 */
  async useGrantedPort(port) {
    this.port = port;
    return port;
  }

  static async grantedPorts() {
    if (!('serial' in navigator)) return [];
    return navigator.serial.getPorts();
  }

  async open(baudRate, bufferSize = 1024 * 1024) {
    if (!this.port) throw new Error('尚未选择串口');
    if (this.port.readable || this.port.writable) {
      throw new Error('串口已打开');
    }
    await this.port.open({
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      bufferSize,
    });
    this.baudRate = baudRate;
    this._stopping = false;
    this._chunks = [];
    this._len = 0;
    this.writer = this.port.writable.getWriter();
    this._startPump();
    // CH340/CH340K 开口瞬间 DTR#/RTS# 电平不稳: 统一解除断言(引脚输出高)
    try { await this.setSignals({ rts: false, dtr: false }); } catch (e) { /* ignore */ }
    return true;
  }

  /**
   * 关闭并按新波特率重开 (保留已授权的 port 对象, 不弹窗)。
   * 用于波特率切换: serial.close() 会清空 this.port, 不能在这里复用。
   */
  async reopen(baudRate, bufferSize = 1024 * 1024) {
    if (!this.port) throw new Error('尚未选择串口');
    this._stopping = true;
    this._waiter = null;
    try { if (this.reader) await this.reader.cancel(); } catch (_) { /* ignore */ }
    try { if (this._pump) await this._pump; } catch (_) { /* ignore */ }
    try {
      if (this.writer) { this.writer.releaseLock(); this.writer = null; }
    } catch (_) { /* ignore */ }
    try {
      if (this.port.readable || this.port.writable) await this.port.close();
    } catch (_) { /* ignore */ }
    this._chunks = [];
    this._len = 0;
    this._stopping = false;
    await this.port.open({
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      bufferSize,
    });
    this.baudRate = baudRate;
    this.writer = this.port.writable.getWriter();
    this._startPump();
    try { await this.setSignals({ rts: false, dtr: false }); } catch (e) { /* ignore */ }
    return true;
  }

  _startPump() {
    this._pump = (async () => {
      while (!this._stopping && this.port && this.port.readable) {
        let reader = null;
        try {
          reader = this.port.readable.getReader();
          this.reader = reader;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.length) this._push(value);
          }
        } catch (e) {
          if (!this._stopping) {
            this.onLog('warn', '串口读取异常(已自动重建流): ' + (e && e.message ? e.message : e));
          }
        } finally {
          try { if (reader) reader.releaseLock(); } catch (_) { /* ignore */ }
          this.reader = null;
        }
      }
    })();
  }

  _push(chunk) {
    this._chunks.push(chunk.slice());
    this._len += chunk.length;
    const w = this._waiter;
    if (w && this._len >= w.need) {
      this._waiter = null;
      clearTimeout(w.timer);
      w.resolve(true);
    }
  }

  /** 从缓冲区头部取走最多 n 字节 */
  _take(n) {
    n = Math.min(n, this._len);
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const head = this._chunks[0];
      const need = n - off;
      if (head.length <= need) {
        out.set(head, off);
        off += head.length;
        this._chunks.shift();
      } else {
        out.set(head.subarray(0, need), off);
        this._chunks[0] = head.subarray(need);
        off += need;
      }
    }
    this._len -= n;
    return out;
  }

  /** 等待缓冲内达到 >= n 字节, 或超时。返回是否达标。 */
  _waitFor(n, timeoutMs) {
    if (this._len >= n) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._waiter && this._waiter.timer === timer) this._waiter = null;
        resolve(false);
      }, Math.max(timeoutMs, 0));
      this._waiter = { need: n, resolve, timer };
    });
  }

  /**
   * 读最多 n 字节, 超时返回已收到的部分。
   * 对应 Python: ok, data = uart.read(n)  (ok 表示是否读满)
   */
  async read(n, timeoutS) {
    if (n <= 0) return new Uint8Array(0);
    const t = timeoutS === undefined ? this.rxTimeout : timeoutS;
    await this._waitFor(n, t * 1000);
    return this._take(n);
  }

  /** 同 read, 但额外返回是否读满。 */
  async readExact(n, timeoutS) {
    const data = await this.read(n, timeoutS);
    return [data.length === n, data];
  }

  /**
   * 排空缓冲区。
   * 对应 Python: ser.read_all() —— 先等首字节最多 timeout, 再取出当前全部。
   */
  async readAll(timeoutS = 0.1) {
    if (this._len === 0) {
      await this._waitFor(1, timeoutS * 1000);
    }
    if (this._len === 0) return new Uint8Array(0);
    await sleep(5); // 给残余数据一点点时间
    return this._take(this._len);
  }

  /** 丢弃软件缓冲里的一切数据 (Web Serial 无 flushInput, 用软件缓冲代替) */
  flushInput() {
    this._len = 0;
    this._chunks = [];
  }

  async write(data) {
    if (!this.writer) throw new Error('串口未打开');
    const u8 = data instanceof Uint8Array ? data : Uint8Array.from(data);
    await this.writer.write(u8);
  }

  /**
   * 控制 DTR / RTS。对应 Python 的 ser.setRTS(0/1) / setDTR(0/1)。
   * requestToSend:true   等价于 pyserial setRTS(1)
   * dataTerminalReady:true 等价于 pyserial setDTR(1)
   */
  async setSignals({ rts, dtr } = {}) {
    if (!this._signalsUsable) return;
    const opts = {};
    if (rts !== undefined) opts.requestToSend = !!rts;
    if (dtr !== undefined) opts.dataTerminalReady = !!dtr;
    if (!Object.keys(opts).length) return;
    try {
      await this.port.setSignals(opts);
    } catch (e) {
      this._signalsUsable = false;
      if (!this._signalsWarned) {
        this._signalsWarned = true;
        this.onLog('warn',
          'setSignals 不可用(' + (e && e.message ? e.message : e) +
          '), 将无法自动复位进 bootrom —— 请手动按住 BOOT 键再点烧录');
      }
    }
  }

  setRxTimeout(sec) { this.rxTimeout = sec; }
  getRxTimeout() { return this.rxTimeout; }

  async close() {
    this._stopping = true;
    this._waiter = null;
    try { if (this.reader) await this.reader.cancel(); } catch (_) { /* ignore */ }
    try { if (this._pump) await this._pump; } catch (_) { /* ignore */ }
    try {
      if (this.writer) { this.writer.releaseLock(); this.writer = null; }
    } catch (_) { /* ignore */ }
    try {
      if (this.port && (this.port.readable || this.port.writable)) await this.port.close();
    } catch (_) { /* ignore */ }
    this.port = null;
    this.baudRate = 0;
    this.flushInput();
  }
}

/** 判断当前环境是否支持 Web Serial */
export function isSerialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/** 是否安全上下文 (Web Serial 要求) */
export function isSecureContextOk() {
  return typeof window !== 'undefined' && window.isSecureContext === true;
}
