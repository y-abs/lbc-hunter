// Script to generate PNG icons for the extension
// Run once with: node scripts/generate-icons.js

import { createCanvas } from "canvas";
import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, "../assets/icons");
mkdirSync(iconsDir, { recursive: true });

const sizes = [16, 32, 48, 128];

for (const size of sizes) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // Background circle
  ctx.fillStyle = "#0D1117";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  // Orange circle accent
  ctx.fillStyle = "#FF6B35";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2);
  ctx.fill();

  // Inner dark circle
  ctx.fillStyle = "#0D1117";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.28, 0, Math.PI * 2);
  ctx.fill();

  // Letter H in the center
  if (size >= 32) {
    ctx.fillStyle = "#FF6B35";
    ctx.font = `bold ${Math.floor(size * 0.32)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("H", size / 2, size / 2);
  }

  const buffer = canvas.toBuffer("image/png");
  writeFileSync(join(iconsDir, `icon${size}.png`), buffer);
  console.log(`Generated icon${size}.png`);
}

console.log("All icons generated!");
