// ============================================================
// protocol.js — 博流 bootrom / eflash_loader 串口协议
//
// 由 bouffalo_flash.py 移植。对应关系:
//   BouffaloUART 的握手/ACK 部分  ->  BouffaloLink
//   libs/bflb_img_loader.py       ->  BootromProtocol
//   libs/bflb_eflash_loader.py    ->  EflashProtocol
//
// 包格式:
//   bootrom      : cmd_id(1B) + 0x00(1B)      + len(2B LE) + payload
//   eflash_loader: cmd_id(1B) + checksum(1B)  + len(2B LE) + payload
//                  checksum = (len[0] + len[1] + sum(payload)) & 0xFF
// ============================================================

import { sleep, hex, hasByte, readU32LE, packU16LE } from './util.js';

// ---------------------------------------------------------------------------
// 芯片能力表
//   bootHeaderLen: boot header 长度
//   segcntOff    : boot header 中段数(segcnt)的偏移 (小端)
//   bootromDirect: true = bootrom 自带 flash 命令, 直烧; false = 需先加载 eflash_loader
// ---------------------------------------------------------------------------
export const CHIPS = {
  bl602: { label: 'BL602', bootHeaderLen: 176, segcntOff: 120, bootromDirect: false },
  bl616: { label: 'BL616', bootHeaderLen: 256, segcntOff: 132, bootromDirect: true },
  bl618: { label: 'BL618', bootHeaderLen: 256, segcntOff: 132, bootromDirect: true },
  bl808: { label: 'BL808 (实验)', bootHeaderLen: 352, segcntOff: 140, bootromDirect: true },
  bl628: { label: 'BL628 (实验)', bootHeaderLen: 256, segcntOff: 136, bootromDirect: true },
};

export function chipInfo(chip) {
  const c = CHIPS[chip];
  if (!c) throw new Error('未支持的芯片: ' + chip);
  return c;
}

// ---------------------------------------------------------------------------
// 命令 ID
// ---------------------------------------------------------------------------
export const CMD = {
  GET_BOOT_INFO: 0x10,
  LOAD_BOOT_HDR: 0x11,
  LOAD_PUBKEY: 0x12,
  LOAD_PUBKEY2: 0x13,
  LOAD_SIG: 0x14,
  LOAD_SIG2: 0x15,
  LOAD_AES_IV: 0x16,
  LOAD_SEG_HDR: 0x17,
  LOAD_SEG_DATA: 0x18,
  CHECK_IMAGE: 0x19,
  RUN_IMAGE: 0x1a,
  CHANGE_RATE: 0x20,
  RESET: 0x21,
  SET_TIMEOUT: 0x23,
  FLASH_ERASE: 0x30,
  FLASH_WRITE: 0x31,
  FLASH_READ: 0x32,
  FLASH_BOOT: 0x33,
  FLASH_READ_JID: 0x36,
  FLASH_WRITE_CHK: 0x3a,
  FLASH_SET_PARA: 0x3b,
  FLASH_CHIPERASE: 0x3c,
  FLASH_READ_SHA: 0x3d,
  FLASH_DECOMP_W: 0x3f,
  EFUSE_WRITE: 0x40,
  EFUSE_READ: 0x41,
  EFUSE_READ_MAC: 0x42,
  MEM_WRITE: 0x50,
  MEM_READ: 0x51,
};

/** 需要返回数据的命令 */
export const RESP_CMDS = new Set([
  CMD.GET_BOOT_INFO,
  CMD.LOAD_SEG_HDR,
  CMD.FLASH_READ,
  CMD.FLASH_READ_JID,
  CMD.FLASH_READ_SHA,
  CMD.EFUSE_READ,
  CMD.EFUSE_READ_MAC,
]);

// ===========================================================================
// 第一层: 握手 / ACK  (对应 BouffaloUART)
// ===========================================================================
export class BouffaloLink {
  /**
   * @param {import('./transport.js').BouffaloSerial} serial
   * @param {string} chiptype
   * @param {{log?:Function, dbg?:Function}} hooks
   */
  constructor(serial, chiptype, hooks = {}) {
    this.serial = serial;
    this.chiptype = chiptype;
    this.log = hooks.log || (() => {});
    this.dbg = hooks.dbg || (() => {});
    this.handshakeDone = false;
  }

  get baudrate() { return this.serial.baudRate; }

  /**
   * 通过 RTS 电平序列让芯片复位并进入 bootrom (ISP 下载模式)。
   * 对应 if_shakehand / if_toggle_boot。
   *
   * pyserial 语义映射:
   *   ser.setRTS(1) === port.setSignals({ requestToSend: true  })
   *   ser.setRTS(0) === port.setSignals({ requestToSend: false })
   */
  async resetToBootrom({
    doReset = true,
    resetHoldMs = 50,
    shakeDelayMs = 100,
    resetRevert = false,
    retry = 3,
  } = {}) {
    for (let i = 0; i < retry; i++) {
      if (doReset) {
        // 官方 if_shakehand 第一步 "default set DTR high":
        // CH340/CH340K 开口瞬间 DTR# 电平不稳, 显式解除断言(引脚输出高)让 BOOT 持续拉高,
        // 等 100ms 稳定; 之后的复位脉冲期间 DTR 保持不动(官方全程不碰 DTR)
        await this.serial.setSignals({ rts: false, dtr: false });
        await sleep(100);
        // 官方: "reset high to make boot pin high"
        await this.serial.setSignals({ rts: false });
        await sleep(200);
        // 官方: reset_cnt=2; 每个脉冲 = 复位(resetHoldMs) -> 释放(shakeDelayMs),
        // 序列结束时必须处于"释放"态, 否则芯片被摁在复位里无法应答
        let resetCnt = 2;
        while (resetCnt > 0) {
          // 常规(USB-TTL): setRTS(1)=复位(引脚低); 取反: setRTS(0)=复位
          const assertRts = resetRevert ? false : true;
          await this.serial.setSignals({ rts: assertRts });
          await sleep(resetHoldMs);
          await this.serial.setSignals({ rts: !assertRts });
          await sleep(shakeDelayMs > 0 ? shakeDelayMs : 5);
          // 官方会连打两次, "do reset again to make sure boot pin is high"
          await this.serial.setSignals({ rts: assertRts });
          await sleep(resetHoldMs);
          await this.serial.setSignals({ rts: !assertRts });
          await sleep(shakeDelayMs > 0 ? shakeDelayMs : 5);
          resetCnt--;
        }
      }
      this.serial.setRxTimeout(0.1);
      await this.serial.readAll(0.1);

      if (await this.syncHandshake()) return true;
      this.log('warn', '握手失败, 重试...');
      await sleep(500);
    }
    return false;
  }

  /**
   * 发 0x55 同步字节, 等 "O"(0x4F) / "K"(0x4B) 应答。
   * 同步字节个数 = int(0.006 * baud / 10), bl702/bl702l 用 0.003。
   */
  async syncHandshake(retry = 3) {
    const factor = (this.chiptype === 'bl702' || this.chiptype === 'bl702l') ? 0.003 : 0.006;
    const count = Math.max(Math.floor(factor * this.baudrate / 10), 1);
    const sync = new Uint8Array(count).fill(0x55);

    for (let i = 0; i < retry; i++) {
      this.serial.setRxTimeout(0.1);
      await this.serial.readAll(0.1);
      this.serial.setRxTimeout(0.5);
      await this.serial.write(sync);
      const ack = await this.serial.read(1000, 0.5);
      this.dbg('handshake ack: ' + (ack.length ? hex(ack.subarray(0, 16)) : '(empty)'));
      if (hasByte(ack, 0x4f) || hasByte(ack, 0x4b)) {
        this.serial.setRxTimeout(0.03);
        await this.serial.readAll(0.05);
        this.handshakeDone = true;
        return true;
      }
      if (ack.length) this.log('warn', '收到非预期应答, 重新握手');
      await sleep(300);
    }
    return false;
  }

  /** 对应 if_deal_ack: "OK" / "PD" / "FL<code>" */
  async dealAck() {
    const [full, ack] = await this.serial.readExact(2);
    if (!full) return 'FL';
    if (hasByte(ack, 0x4f) || hasByte(ack, 0x4b)) return 'OK';
    if (hasByte(ack, 0x50) || hasByte(ack, 0x44)) return 'PD';
    const [, e] = await this.serial.readExact(2);
    const code = e.length === 2 ? hex(new Uint8Array([e[1], e[0]])) : '????';
    this.log('err', 'ACK 错误码: ' + code);
    return 'FL' + code;
  }

  /** 对应 if_deal_response: 返回 [status, data] */
  async dealResponse() {
    const ack = await this.dealAck();
    if (ack !== 'OK') return [ack, new Uint8Array(0)];

    let full, lenb;
    for (;;) {
      [full, lenb] = await this.serial.readExact(2);
      if (lenb[0] !== 0x4f || lenb[1] !== 0x4b) break; // != "OK"
      if (!full) return ['FL', new Uint8Array(0)];
    }
    if (!full) return ['FL', new Uint8Array(0)];

    const dataLen = lenb[0] | (lenb[1] << 8);
    const [, data] = await this.serial.readExact(dataLen);
    if (data.length !== dataLen) return ['FL', data];
    return ['OK', data];
  }
}

// ===========================================================================
// 第二层: bootrom 协议  (对应 bflb_img_loader.py)
// ===========================================================================
export class BootromProtocol {
  constructor(link, chiptype) {
    this.link = link;
    this.chiptype = chiptype;
    this.bl616A0 = false;
  }

  async cmd(cmdId, payload = new Uint8Array(0), wantResponse = false) {
    const len = packU16LE(payload.length);
    const pkt = new Uint8Array(4 + payload.length);
    pkt[0] = cmdId;
    pkt[1] = 0x00;           // bootrom 包第 2 字节固定 0
    pkt[2] = len[0];
    pkt[3] = len[1];
    pkt.set(payload, 4);
    await this.link.serial.write(pkt);

    if (wantResponse || RESP_CMDS.has(cmdId)) return this.link.dealResponse();
    return [await this.link.dealAck(), new Uint8Array(0)];
  }

  /** 读 bootinfo, 返回 Uint8Array 或 null */
  async getBootInfo() {
    const [status, data] = await this.cmd(CMD.GET_BOOT_INFO, new Uint8Array(0), true);
    if (status !== 'OK') return null;
    if (this.chiptype === 'bl616' || this.chiptype === 'bl618') {
      this.bl616A0 = data.length > 0 && data[0] === 0x01;
      this.link.log('info', 'BL616/618 版本: ' + (this.bl616A0 ? 'A0' : 'A1+'));
    }
    this.link.log('info', 'bootinfo: ' + hex(data));
    return data;
  }

  /**
   * BL616 设置 bootrom 超时。
   *   A0  : memory_write 0x6102DF04 = 0x27101200 (10s)
   *   A1+ : set_timeout 命令
   */
  async setBootromTimeout(ms = 10000) {
    if (this.chiptype !== 'bl616' && this.chiptype !== 'bl618') return;
    let pkt;
    if (this.bl616A0) {
      pkt = new Uint8Array(12);
      pkt[0] = CMD.MEM_WRITE; pkt[1] = 0x00; pkt[2] = 8; pkt[3] = 0;
      pkt.set(new Uint8Array([0x04, 0xdf, 0x02, 0x61]), 4); // 0x6102DF04
      pkt.set(new Uint8Array([0x00, 0x12, 0x10, 0x27]), 8); // 0x27101200
    } else {
      pkt = new Uint8Array(8);
      pkt[0] = CMD.SET_TIMEOUT; pkt[1] = 0x00; pkt[2] = 4; pkt[3] = 0;
      pkt.set(new Uint8Array([ms & 0xff, (ms >>> 8) & 0xff, (ms >>> 16) & 0xff, (ms >>> 24) & 0xff]), 4);
    }
    await this.link.serial.write(pkt);
    await this.link.dealAck();
    this.link.dbg('bootrom 超时设置为 ' + ms + ' ms');
  }

  /** flash 操作前把超时降到 2s, 加速失败检测 */
  async setFlashTimeout(ms = 2000) {
    if (this.chiptype !== 'bl616' && this.chiptype !== 'bl618') return;
    let pkt;
    if (this.bl616A0) {
      const val = ((ms << 16) | 0x1200) >>> 0;
      pkt = new Uint8Array(12);
      pkt[0] = CMD.MEM_WRITE; pkt[1] = 0x00; pkt[2] = 8; pkt[3] = 0;
      pkt.set(new Uint8Array([0x04, 0xdf, 0x02, 0x61]), 4);
      pkt.set(new Uint8Array([val & 0xff, (val >>> 8) & 0xff, (val >>> 16) & 0xff, (val >>> 24) & 0xff]), 8);
    } else {
      pkt = new Uint8Array(8);
      pkt[0] = CMD.SET_TIMEOUT; pkt[1] = 0x00; pkt[2] = 4; pkt[3] = 0;
      pkt.set(new Uint8Array([ms & 0xff, (ms >>> 8) & 0xff, (ms >>> 16) & 0xff, (ms >>> 24) & 0xff]), 4);
    }
    await this.link.serial.write(pkt);
    await this.link.dealAck();
    this.link.dbg('flash 操作超时设置为 ' + ms + ' ms');
  }

  /**
   * 从 bootinfo 解析 flash_pin。对应官方 flash_get_pin_from_bootinfo。
   * bootinfo 为原始字节, 内部取 hex 串后按位拼接。
   */
  getFlashPinFromBootinfo(bootinfo) {
    const h = hex(bootinfo);
    if (h.length < 24) return 0xff;
    const ct = this.chiptype;
    if (ct === 'bl616' || ct === 'bl618' || ct === 'wb03') {
      const sw = parseInt(h.slice(22, 24) + h.slice(20, 22) + h.slice(18, 20) + h.slice(16, 18), 16);
      return (sw >> 14) & 0x3f;
    }
    if (ct === 'bl808') {
      const sw = parseInt(h.slice(22, 24) + h.slice(20, 22) + h.slice(18, 20) + h.slice(16, 18), 16);
      return (sw >> 14) & 0x1f;
    }
    return 0xff;
  }

  /**
   * 把 eflash_loader.bin 加载进 RAM 并运行 (BL602 两阶段模式)。
   * @param {Uint8Array} img loader 二进制内容
   */
  async loadEflashLoader(img) {
    const info = chipInfo(this.chiptype);
    const hdrLen = info.bootHeaderLen;
    const segcntOff = info.segcntOff;

    let off = 0;
    const hdr = img.subarray(off, off + hdrLen);
    off += hdrLen;
    const segcnt = readU32LE(hdr, segcntOff);
    this.link.log('info', 'eflash_loader 段数: ' + segcnt);

    let st;
    [st] = await this.cmd(CMD.LOAD_BOOT_HDR, hdr);
    if (st !== 'OK') throw new Error('load boot header 失败: ' + st);

    for (let seg = 0; seg < segcnt; seg++) {
      const segHdr = img.subarray(off, off + 16);
      off += 16;
      let resp;
      [st, resp] = await this.cmd(CMD.LOAD_SEG_HDR, segHdr, true);
      if (st !== 'OK') throw new Error('load seg header 失败: ' + st);

      const segLen = readU32LE(resp, 4);
      this.link.dbg('段 ' + seg + ' 数据长度 ' + segLen);
      let sent = 0;
      while (sent < segLen) {
        const chunk = Math.min(segLen - sent, 4080);
        [st] = await this.cmd(CMD.LOAD_SEG_DATA, img.subarray(off, off + chunk));
        if (st !== 'OK') throw new Error('load seg data 失败: ' + st);
        off += chunk;
        sent += chunk;
      }
    }

    [st] = await this.cmd(CMD.CHECK_IMAGE);
    if (st !== 'OK') throw new Error('check image 失败: ' + st);
    [st] = await this.cmd(CMD.RUN_IMAGE);
    if (st !== 'OK') throw new Error('run image 失败: ' + st);

    this.link.log('ok', 'eflash_loader 已加载并在 RAM 运行');
  }
}

// ===========================================================================
// 第三层: eflash_loader 协议 (带 checksum)
// ===========================================================================
export class EflashProtocol {
  constructor(link) {
    this.link = link;
  }

  async cmd(cmdId, payload = new Uint8Array(0), wantResponse = false) {
    let sum = 0;
    for (let i = 0; i < payload.length; i++) sum += payload[i];
    const len = packU16LE(payload.length);
    const checksum = (len[0] + len[1] + sum) & 0xff;

    const pkt = new Uint8Array(4 + payload.length);
    pkt[0] = cmdId;
    pkt[1] = checksum;
    pkt[2] = len[0];
    pkt[3] = len[1];
    pkt.set(payload, 4);
    await this.link.serial.write(pkt);

    if (wantResponse || RESP_CMDS.has(cmdId)) return this.link.dealResponse();
    return [await this.link.dealAck(), new Uint8Array(0)];
  }
}
