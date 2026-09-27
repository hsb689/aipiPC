// ============================================================
// flasher.js — 高层下载编排
//
// 由 bouffalo_flash_pro.py 的 BouffaloFlasherPro 移植，裁剪掉:
//   - LZMA 压缩写入 (0x3f)  —— 按需再补
//   - 波特率切换 (change_rate) —— Web Serial 不支持打开状态下改波特率,
//     故全程单波特率
// 保留:
//   - bootrom 直烧 (BL616/618/808/628) / eflash_loader 两阶段 (BL602)
//   - 擦除 / 写入(带重试) / write_check / SHA256 回读校验
//   - 多文件编排
//   - 进度回调 + 耗时/速率统计
// ============================================================

import { sleep, hex, hex32, jidToSize, packU32LE, concat } from './util.js';
import {
  CHIPS, CMD, chipInfo,
  BouffaloLink, BootromProtocol, EflashProtocol,
} from './protocol.js';
import { getLoaderBytes } from './loader-bl602.js';

/** 一次烧录任务里的一个文件 */
export class FlashFile {
  constructor(name, data, addr) {
    this.name = name;
    this.data = data;   // Uint8Array
    this.addr = addr >>> 0;
  }
}

export class BouffaloFlasher {
  /**
   * @param {object} o
   * @param {import('./transport.js').BouffaloSerial} o.serial  已打开的串口
   * @param {string} o.chip            bl602 / bl616 / ...
   * @param {string} o.loaderKey       BL602 用的 loader 档位 (24m/40m/...)
   * @param {boolean} o.resetRevert    复位电平是否取反
   * @param {Function} o.log           (level, msg)
   * @param {boolean} [o.verbose]
   */
  constructor(o) {
    this.chip = o.chip;
    this.info = chipInfo(o.chip);
    this.loaderKey = o.loaderKey || '40m';
    this.resetRevert = !!o.resetRevert;
    this.noReset = !!o.noReset;
    this.workBaud = o.workBaud || 2000000;
    this.serial = o.serial;
    this.verbose = !!o.verbose;
    this.txSize = 2056;   // 官方默认

    const self = this;
    this.log = o.log || (() => {});
    this.dbg = (msg) => { if (self.verbose) self.log('dbg', msg); };

    this.link = new BouffaloLink(this.serial, this.chip, {
      log: this.log,
      dbg: this.dbg,
    });
    this.boot = new BootromProtocol(this.link, this.chip);
    this.eflash = new EflashProtocol(this.link);

    this.bootromDirect = this.info.bootromDirect;
    this.needEflashProto = !this.bootromDirect;
    this._inited = false;
  }

  // ---- 命令分发: 按当前阶段选协议层 ----
  async flashCmd(cmdId, payload = new Uint8Array(0), wantResponse = false, retry = 3) {
    let last = 'FL';
    for (let attempt = 0; attempt < retry; attempt++) {
      const proto = this.needEflashProto ? this.eflash : this.boot;
      const [status, data] = await proto.cmd(cmdId, payload, wantResponse);
      if (status.startsWith('OK')) return [status, data];
      last = status;
      this.dbg(`命令 0x${cmdId.toString(16)} 失败(${status}), 重试 ${attempt + 1}/${retry}`);
      if (attempt < retry - 1) {
        // 断线智能重连: 不硬件复位, 仅重新 0x55 同步
        if (await this.link.syncHandshake(2)) continue;
        break;
      }
    }
    return [last, new Uint8Array(0)];
  }

  // =========================================================================
  // 初始化: 复位 -> 握手 -> bootinfo -> (loader) -> flash 参数 -> JID
  // =========================================================================
  async init() {
    if (this._inited) return this._info;
    // BL616/618 采用官方两段式: 500k 握手+bootinfo -> clk_set 升频 -> 高速烧录
    // (官方 speed_uart_boot=500000; bootrom 跑内部 RC 时钟, 2M 下自动测频不可靠,
    //  CH340K 上直接 2M 握手会失败, 这正是原"全程单波特率"实现的死穴)
    const useTwoStage = (this.chip === 'bl616' || this.chip === 'bl618');

    this.log('info', '============================================================');
    this.log('info', `芯片: ${this.chip}   握手: ${useTwoStage ? 500000 : this.serial.baudRate} bps   ` +
      `工作: ${this.workBaud} bps   模式: ${this.bootromDirect ? 'bootrom 直烧' : 'eflash_loader 两阶段'}`);
    this.log('info', `复位电平: ${this.resetRevert ? '取反(博流专用下载器)' : '常规(USB-TTL)'}`);
    this.log('info', '============================================================');

    // 0a. 官方流程固定 500k 握手 (bflb_iot_tool speed_uart_boot)
    if (useTwoStage && this.serial.baudRate !== 500000) {
      this.log('info', '切换到握手波特率 500000 (官方 speed_uart_boot) ...');
      await this.serial.reopen(500000);
      try { await this.serial.setSignals({ rts: false, dtr: false }); } catch (e) { /* ignore */ }
    }
    this.serial.setRxTimeout(2);

    // 0b. 复位进入 bootrom (勾选"不复位直接握手"时跳过 RTS 脉冲, 适配手动进 bootrom)
    this.log('info', this.noReset
      ? '不复位, 直接与 bootrom 握手 ...'
      : '复位进入 bootrom ...');
    const ok = await this.link.resetToBootrom({
      doReset: !this.noReset,
      resetRevert: this.resetRevert,
      retry: 3,
    });
    if (!ok) {
      throw new Error('无法进入下载模式。请检查: ①boot pin 是否上拉 ②TX/RX 是否交叉 ' +
        '③复位电平选项是否选对 ④是否被其他串口工具占用');
    }

    // 1. bootinfo
    const bootinfo = await this.boot.getBootInfo();
    if (!bootinfo) throw new Error('读取 bootinfo 失败');
    if (bootinfo.length >= 4 &&
        bootinfo[0] === 0xff && bootinfo[1] === 0xff &&
        bootinfo[2] === 0xff && bootinfo[3] === 0xff) {
      throw new Error('芯片已在 eflash_loader 模式, 请重新上电/复位后再试');
    }

    // 2. bootrom 超时 10s
    await this.boot.setBootromTimeout(10000);

    // 3. 清除 boot 状态标志 0x2000F108 = 0 (BL616/618)
    if (this.chip === 'bl616' || this.chip === 'bl618') {
      await this.clearBootStatus();
    }

    // 4. BL602: 把 eflash_loader 装进 RAM 并运行
    if (!this.bootromDirect) {
      let img;
      try {
        img = getLoaderBytes(this.loaderKey);
      } catch (e) {
        throw new Error(`BL602 需要 eflash_loader, 但未内置档位 "${this.loaderKey}"。` +
          `请用 tools/bin2js.py 重新生成 js/loader-bl602.js`);
      }
      this.log('info', `加载 eflash_loader_${this.loaderKey}.bin (${img.length} 字节) ...`);
      await this.boot.loadEflashLoader(img);
      await sleep(300);
      if (!(await this.link.syncHandshake(3))) {
        throw new Error('与 eflash_loader 握手失败');
      }
      this.needEflashProto = true;
    }

    // 4b. 升频到工作波特率: clk_set(0x22) + 重开串口 (官方 speed_uart_load 流程)
    if (useTwoStage && this.workBaud !== this.serial.baudRate) {
      await this.changeBaudrate(this.workBaud);
    }

    // 5. 设置 flash 参数 —— 必须在读 JID 之前
    await this.setFlashPara(bootinfo);

    // 6. 读 JEDEC ID
    const jid = await this.readFlashJid();
    if (jid && jid.length) {
      this.log('ok', `Flash JEDEC ID: ${hex(jid)}  (容量约 ${jidToSize(jid)})`);
    } else {
      this.log('warn', '未能读取 Flash JEDEC ID (不影响后续烧录)');
    }

    // 7. flash 操作超时降到 2s
    await this.boot.setFlashTimeout(2000);

    this._inited = true;
    this._info = { bootinfo, jid };
    return this._info;
  }

  /**
   * 官方升频流程: clk_set(0x22) 帧后关闭串口, 按新波特率重开。
   * 载荷 = irq_enable(4B) + 新波特率(4B LE)。
   * 注意: CH340/CH340K 重开瞬间 DTR#/RTS# 会拉低一瞬, RTS#->NRST 直连时可能把芯片
   * 打回 bootrom —— 因此重开后统一重新同步(bootrom 支持任意波特率自动测频),
   * 同步既确认升频生效, 也能从毛刺复位中恢复; 2M 同步不稳时自动回退全程 500k。
   */
  async changeBaudrate(newBaud) {
    this.log('info', `升频: ${this.serial.baudRate} -> ${newBaud} (官方 clk_set 流程) ...`);
    const pkt = new Uint8Array(12);
    pkt[0] = 0x22; pkt[1] = 0x00; pkt[2] = 0x08; pkt[3] = 0x00;
    pkt[4] = 0x01; pkt[5] = 0x00; pkt[6] = 0x00; pkt[7] = 0x00;
    pkt.set(packU32LE(newBaud), 8);
    await this.serial.write(pkt);
    await sleep(2); // 官方等待发送完成 ~1ms
    await this.serial.reopen(newBaud);
    try { await this.serial.setSignals({ rts: false, dtr: false }); } catch (e) { /* ignore */ }
    await sleep(50); // 让重开毛刺过去 / 芯片完成切换
    if (await this.link.syncHandshake(2)) {
      this.link.handshakeDone = true;
      this.log('ok', `工作波特率已切换到 ${newBaud}`);
      return;
    }
    // 2M 同步失败(自动测频不可靠): 回退官方兜底 —— 全程 500k 慢速烧录
    this.log('warn', '升频后同步失败, 回退全程 500k 慢速模式 ...');
    await this.serial.reopen(500000);
    try { await this.serial.setSignals({ rts: false, dtr: false }); } catch (e) { /* ignore */ }
    // 升频毛刺可能让芯片处于未知状态: 用完整"复位进 bootrom + 握手"序列回到干净状态
    if (!(await this.link.resetToBootrom({ doReset: true, resetRevert: this.resetRevert, retry: 2 }))) {
      throw new Error('回退 500k 后同步失败');
    }
    this.workBaud = 500000;
    this.log('ok', '已回退: 全程 500k 慢速烧录');
  }

  // =========================================================================
  // 烧录入口
  // =========================================================================
  /**
   * @param {FlashFile[]} files
   * @param {object} opts { erase, verify, shaVerify, onProgress }
   */
  async flash(files, opts = {}) {
    const { erase = true, verify = true, shaVerify = false, onProgress } = opts;
    if (!files || !files.length) throw new Error('没有待烧录的文件');

    await this.init();

    const t0 = performance.now();
    let totalBytes = 0;

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      this.log('info', `--- [${i + 1}/${files.length}] ${f.name} @ ${hex32(f.addr)} ` +
        `(${f.data.length} 字节) ---`);

      if (!f.data.length) { this.log('warn', '文件为空, 跳过'); continue; }
      totalBytes += f.data.length;

      if (erase) {
        this.log('info', `擦除 ${hex32(f.addr)} - ${hex32(f.addr + f.data.length - 1)} ...`);
        if (!(await this.erase(f.addr, f.addr + f.data.length - 1))) {
          throw new Error(`擦除失败: ${f.name}`);
        }
      }

      this.log('info', `写入 ${f.data.length} 字节到 ${hex32(f.addr)} ...`);
      if (!(await this.writeFlash(f.addr, f.data, onProgress, files.length > 1 ? f.name : ''))) {
        throw new Error(`写入失败: ${f.name}`);
      }

      if (verify) {
        if (shaVerify) {
          this.log('info', 'SHA256 回读校验 ...');
          if (!(await this.verifySha256(f.addr, f.data))) {
            throw new Error(`SHA256 校验失败: ${f.name}`);
          }
          this.log('ok', 'SHA256 校验通过');
        } else {
          this.log('info', '写入校验 (write_check) ...');
          if (!(await this.writeCheck())) throw new Error(`校验失败: ${f.name}`);
          this.log('ok', '校验通过');
        }
      }
    }

    const elapsed = (performance.now() - t0) / 1000;
    const speed = elapsed > 0 ? totalBytes / elapsed / 1024 : 0;
    this.log('info', `耗时 ${elapsed.toFixed(2)}s   平均速率 ${speed.toFixed(1)} KB/s`);

    this.log('info', '烧录完成, 硬件复位 ...');
    await this.hwResetOnly();
    this.log('ok', '============================================================');
    this.log('ok', '下载完成! 芯片将从 flash 启动 (必要时手动复位/重新上电)');
    this.log('ok', '============================================================');
    return true;
  }

  // =========================================================================
  // 子流程
  // =========================================================================

  /** flash_set_para: payload = flash_set(4B LE) */
  async setFlashPara(bootinfo) {
    const flashClockCfg = 0x41;
    const flashIoMode = 1;
    const flashClkDelay = 0;
    let flashPin = 0x80; // 0x80 = 从 bootinfo 解析

    if (bootinfo && flashPin === 0x80) {
      flashPin = this.boot.getFlashPinFromBootinfo(bootinfo);
      this.dbg(`从 bootinfo 解析 flash_pin: 0x${flashPin.toString(16).padStart(2, '0')}`);
    }
    const flashSet = (flashPin | (flashClockCfg << 8) |
      (flashIoMode << 16) | (flashClkDelay << 24)) >>> 0;
    this.dbg(`flash_set: ${hex32(flashSet)}`);

    const [st] = await this.flashCmd(CMD.FLASH_SET_PARA, packU32LE(flashSet));
    if (st !== 'OK') this.log('warn', 'set flash para: ' + st);
    else this.dbg('set flash para: OK');
  }

  async readFlashJid() {
    const [st, data] = await this.flashCmd(CMD.FLASH_READ_JID, new Uint8Array(0), true);
    if (st === 'OK') return data;
    this.log('warn', '读 JID 失败: ' + st);
    return null;
  }

  async erase(start, end) {
    const payload = concat(packU32LE(start >>> 0), packU32LE(end >>> 0));
    this.serial.setRxTimeout(15);
    const [st] = await this.flashCmd(CMD.FLASH_ERASE, payload);
    this.serial.setRxTimeout(2);
    return st === 'OK';
  }

  /**
   * 分块写入, 每块 tx_size-8 = 2048 字节, 每块最多重试 3 次。
   * onProgress(cur, total, elapsedMs, suffix)
   */
  async writeFlash(addr, data, onProgress, suffix = '') {
    const chunkSize = this.txSize - 8;
    const total = data.length;
    let i = 0;
    this.serial.setRxTimeout(10);
    const t0 = performance.now();

    while (i < total) {
      const cur = Math.min(total - i, chunkSize);
      const payload = new Uint8Array(4 + cur);
      payload.set(packU32LE((addr + i) >>> 0), 0);
      payload.set(data.subarray(i, i + cur), 4);

      let ok = false;
      let last = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const [st] = await this.flashCmd(CMD.FLASH_WRITE, payload, false, 1);
        last = st;
        if (st.startsWith('OK')) { ok = true; break; }
      }
      if (!ok) {
        this.serial.setRxTimeout(2);
        this.log('err', `写入失败 @ offset ${i}: ${last}`);
        return false;
      }
      i += cur;
      if (onProgress) onProgress(i, total, performance.now() - t0, suffix);
    }

    this.serial.setRxTimeout(2);
    return true;
  }

  async writeCheck() {
    this.serial.setRxTimeout(10);
    const [st] = await this.flashCmd(CMD.FLASH_WRITE_CHK);
    this.serial.setRxTimeout(2);
    return st === 'OK';
  }

  /** SHA256 回读校验: 芯片算 flash 区域 SHA256, 本地算固件 SHA256, 比对 */
  async verifySha256(addr, data) {
    const payload = concat(packU32LE(addr >>> 0), packU32LE(data.length >>> 0));
    const [st, chipSha] = await this.flashCmd(CMD.FLASH_READ_SHA, payload, true);
    if (st !== 'OK') {
      this.log('warn', '读 SHA 失败: ' + st);
      return false;
    }
    const localBuf = await crypto.subtle.digest('SHA-256', data);
    const localSha = new Uint8Array(localBuf);
    this.dbg('芯片SHA: ' + hex(chipSha));
    this.dbg('本地SHA: ' + hex(localSha));
    if (chipSha.length !== localSha.length) return false;
    for (let i = 0; i < localSha.length; i++) {
      if (chipSha[i] !== localSha[i]) return false;
    }
    return true;
  }

  /** BL616/618 清除 boot 状态: 写内存 0x2000F108 = 0 */
  async clearBootStatus() {
    const pkt = new Uint8Array(12);
    pkt[0] = CMD.MEM_WRITE; pkt[1] = 0x00; pkt[2] = 8; pkt[3] = 0;
    pkt.set(new Uint8Array([0x08, 0xf1, 0x00, 0x20]), 4); // 0x2000F108
    pkt.set(new Uint8Array([0, 0, 0, 0]), 8);
    await this.serial.write(pkt);
    await this.link.dealAck();
    this.dbg('clear boot status: 0x2000F108 = 0');
  }

  /** 仅硬件复位 (RTS 脉冲), 与官方 BL616 行为一致: 不发软件 reset/flash_boot */
  async hwResetOnly() {
    try {
      await this.serial.setSignals({ rts: true });
      await sleep(100);
      await this.serial.setSignals({ rts: false });
      await sleep(200);
    } catch (_) { /* ignore */ }
  }
}
