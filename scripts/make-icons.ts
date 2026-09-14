#!/usr/bin/env bun
/// <reference lib="dom" />
/**
 * Renders apps/desktop/assets/icon.svg into the desktop app's icon files with Playwright's Chromium:
 * PNGs at every size, icon.ico (PNG-compressed entries, Windows Vista+), icon.icns (PNG payloads), and
 * icon-128.rgba (raw pixels for the window icon at runtime, since Bun ships no PNG decoder). Run once
 * after editing the SVG; the outputs are committed.
 *
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome bun scripts/make-icons.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const dir = resolve(import.meta.dir, "..", "apps", "desktop", "assets");
const svg = readFileSync(join(dir, "icon.svg"), "utf8");
const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024] as const;
const ICNS_TYPES: Record<number, string> = {
  16: "icp4",
  32: "icp5",
  64: "icp6",
  128: "ic07",
  256: "ic08",
  512: "ic09",
  1024: "ic10",
};

const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
const page = await browser.newPage();
const pngs = new Map<number, Buffer>();
let rgba128: Buffer | null = null;
for (const size of SIZES) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent"><img id="i" width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body></html>`,
  );
  await page.waitForFunction(() => (document.getElementById("i") as HTMLImageElement).complete);
  const png = await page.screenshot({
    omitBackground: true,
    type: "png",
    clip: { x: 0, y: 0, width: size, height: size },
  });
  pngs.set(size, Buffer.from(png));
  writeFileSync(join(dir, `icon-${size}.png`), png);
  if (size === 128) {
    const pixels = await page.evaluate((s) => {
      const canvas = document.createElement("canvas");
      canvas.width = s;
      canvas.height = s;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(document.getElementById("i") as HTMLImageElement, 0, 0, s, s);
      return Array.from(ctx.getImageData(0, 0, s, s).data);
    }, size);
    rgba128 = Buffer.from(Uint8Array.from(pixels));
    writeFileSync(join(dir, "icon-128.rgba"), rgba128);
  }
}
await browser.close();

// ICO: a directory of PNG-compressed entries.
const icoSizes = [16, 32, 48, 64, 128, 256] as const;
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(icoSizes.length, 4);
const entries: Buffer[] = [];
const images: Buffer[] = [];
let offset = 6 + 16 * icoSizes.length;
for (const size of icoSizes) {
  const png = pngs.get(size);
  if (!png) throw new Error(`missing png ${size}`);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size === 256 ? 0 : size, 0);
  entry.writeUInt8(size === 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  images.push(png);
  offset += png.length;
}
writeFileSync(join(dir, "icon.ico"), Buffer.concat([icoHeader, ...entries, ...images]));

// ICNS: "icns" + total length, then one chunk per PNG.
const chunks: Buffer[] = [];
for (const size of SIZES) {
  const type = ICNS_TYPES[size];
  const png = pngs.get(size);
  if (!type || !png) continue;
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(8 + png.length, 4);
  chunks.push(header, png);
}
const body = Buffer.concat(chunks);
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns", 0, "ascii");
icnsHeader.writeUInt32BE(8 + body.length, 4);
writeFileSync(join(dir, "icon.icns"), Buffer.concat([icnsHeader, body]));

console.log(
  `icons written to ${dir}: ${SIZES.map((s) => `icon-${s}.png`).join(", ")}, icon.ico, icon.icns, icon-128.rgba (${rgba128?.length ?? 0} bytes)`,
);
