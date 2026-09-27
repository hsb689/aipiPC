// ============================================================
// util.js — 通用小工具 (对应 Python 版的 struct / binascii 内联实现)
// ============================================================

/** 延时 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Uint8Array -> 十六进制小写字符串 (对应 binascii.hexlify) */
export function hex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

/** 0x1234 -> "0x00001234" */
export function hex32(v) {
  return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/** 小端读 u32 */
export function readU32LE(b, off) {
  if (!b || b.length < off + 4) return 0;
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

/** 小端写 u32 */
export function writeU32LE(b, off, v) {
  b[off] = v & 0xff;
  b[off + 1] = (v >>> 8) & 0xff;
  b[off + 2] = (v >>> 16) & 0xff;
  b[off + 3] = (v >>> 24) & 0xff;
}

/** 拼字节 */
export function bytes(...arr) {
  return new Uint8Array(arr);
}

/** 小端 u32 -> 4 字节 */
export function packU32LE(v) {
  const b = new Uint8Array(4);
  writeU32LE(b, 0, v);
  return b;
}

/** 小端 u16 -> 2 字节 */
export function packU16LE(v) {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
}

/** 拼接多个 Uint8Array */
export function concat(...arrs) {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

/** 解析地址字符串, 支持 0x 前缀与十进制 */
export function parseAddr(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return 0;
  const v = Number(t);
  if (!Number.isFinite(v) || v < 0) throw new Error('非法地址: ' + s);
  return Math.floor(v);
}

/** 字节数 -> 人类可读 */
export function humanSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

/** JEDEC ID -> flash 容量 (对应 Python _jid_to_size) */
export function jidToSize(jid) {
  if (!jid || jid.length < 3) return '未知';
  const capId = jid[2];
  const table = {
    0x13: '512KB', 0x14: '1MB', 0x15: '2MB', 0x16: '4MB',
    0x17: '8MB', 0x18: '16MB', 0x19: '32MB', 0x20: '64MB',
  };
  return table[capId] || ('0x' + capId.toString(16).padStart(2, '0'));
}

/** 判断 Uint8Array 中是否含某字节 (对应 Python 的 `b"\x4F" in ack`) */
export function hasByte(u8, v) {
  for (let i = 0; i < u8.length; i++) if (u8[i] === v) return true;
  return false;
}
