#!/usr/bin/env node
// Generates minimal valid PNG icons without any external dependencies
// Uses raw PNG binary construction with Node.js built-in zlib

import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, "../assets/icons");
mkdirSync(iconsDir, { recursive: true });

// CRC32 table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf, off = 0, len = buf.length - off) {
  let crc = 0xffffffff;
  for (let i = off; i < off + len; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u32be(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const crcSource = Buffer.concat([typeBytes, data]);
  const crcVal = crc32(crcSource);
  return Buffer.concat([u32be(data.length), typeBytes, data, u32be(crcVal)]);
}

// Draw a simple icon: orange circle on dark background with 'H' letter
function drawIconPixels(size) {
  const cx = size / 2,
    cy = size / 2;
  const r1 = size * 0.5,
    r2 = size * 0.4,
    r3 = size * 0.26;
  const pixels = [];

  for (let y = 0; y < size; y++) {
    const row = [0]; // filter byte
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx,
        dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);

      let r = 0,
        g = 0,
        b = 0,
        a = 0;

      if (d <= r1) {
        // outer dark fill
        r = 13;
        g = 17;
        b = 23;
        a = 255;
      }
      if (d <= r2) {
        // orange ring
        r = 255;
        g = 107;
        b = 53;
        a = 255;
      }
      if (d <= r3) {
        // inner dark
        r = 13;
        g = 17;
        b = 23;
        a = 255;
      }

      // Draw an 'H' character inside the dark inner circle (for sizes >= 32)
      if (size >= 32 && d <= r3) {
        const relX = dx / r3,
          relY = dy / r3;
        const stemW = 0.18,
          barH = 0.08,
          barY = 0.05;
        if (
          (Math.abs(relX + 0.38) < stemW ||
            Math.abs(relX - 0.38) < stemW ||
            (Math.abs(relY - barY) < barH && relX > -0.52 && relX < 0.52)) &&
          relY > -0.7 &&
          relY < 0.7
        ) {
          r = 255;
          g = 107;
          b = 53;
          a = 255;
        }
      }

      row.push(r, g, b, a);
    }
    pixels.push(...row);
  }
  return Buffer.from(pixels);
}

import { deflateSync as zlibDeflateSync } from "zlib";

function buildPng(size) {
  const rawData = drawIconPixels(size);
  const compressed = zlibDeflateSync(rawData, { level: 6 });

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const IHDR = chunk("IHDR", Buffer.concat([u32be(size), u32be(size), Buffer.from([8, 6, 0, 0, 0])]));
  const IDAT = chunk("IDAT", compressed);
  const IEND = chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([sig, IHDR, IDAT, IEND]);
}

const sizes = [16, 32, 48, 128];
for (const sz of sizes) {
  writeFileSync(join(iconsDir, `icon${sz}.png`), buildPng(sz));
  console.log(`✓ icon${sz}.png`);
}
console.log("Icons generated!");
