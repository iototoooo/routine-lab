// アプリのアイコン（PNG）を生成する。外部パッケージなし（node:zlib だけ）。
// 使い方：node scripts/gen-icons.mjs  → public/icons/*.png
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "public", "icons");
const BG = [0x0f, 0x6b, 0x5c];
const FG = [0xff, 0xff, 0xff];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 円（時計）とチェックマークの図柄。scale は図柄の大きさ（maskable は余白を広くとる）
function mark(x, y, size, scale) {
  const cx = size / 2;
  const cy = size / 2;
  const r = (size / 2) * scale;
  const d = Math.hypot(x - cx, y - cy);
  const ring = Math.abs(d - r * 0.78) < r * 0.09;
  // チェックマーク：2本の線分
  const p = (px, py) => [cx + px * r, cy + py * r];
  const seg = (a, b, w) => {
    const [ax, ay] = a;
    const [bx, by] = b;
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))) < w;
  };
  const w = r * 0.09;
  const check = seg(p(-0.36, 0.02), p(-0.1, 0.28), w) || seg(p(-0.1, 0.28), p(0.38, -0.24), w);
  return ring || check;
}

function solidIcon(scale) {
  return (x, y, size) => (mark(x, y, size, scale) ? [...FG, 255] : [...BG, 255]);
}

// モノクロのバッジ（Android の通知バー用。透明背景に白）
function badge(x, y, size) {
  return mark(x, y, size, 0.95) ? [255, 255, 255, 255] : [0, 0, 0, 0];
}

mkdirSync(OUT, { recursive: true });
const files = [
  ["icon-192.png", 192, solidIcon(0.8)],
  ["icon-512.png", 512, solidIcon(0.8)],
  ["icon-maskable-512.png", 512, solidIcon(0.6)],
  ["apple-touch-icon.png", 180, solidIcon(0.75)],
  ["badge-96.png", 96, badge],
];
for (const [name, size, fn] of files) {
  writeFileSync(join(OUT, name), png(size, fn));
  console.log(`wrote public/icons/${name}`);
}
