import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "src-tauri", "icons");

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function png(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size * 0.36;

  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = y * stride + 1 + x * 4;
      const dx = x - cx;
      const dy = y - cy;
      const distance = Math.hypot(dx, dy);
      let r = 243;
      let g = 238;
      let b = 230;
      if (distance <= radius) {
        r = 196;
        g = 83;
        b = 42;
      }
      const mouth = distance <= radius * 0.42 && dy > radius * 0.02 && dy < radius * 0.28;
      const bubble = distance <= radius * 0.16;
      if (mouth || bubble) {
        r = 255;
        g = 253;
        b = 248;
      }
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = 255;
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = 6 + directory.length;
  const parts = [header, directory];
  images.forEach((image, index) => {
    const entry = index * 16;
    directory[entry] = image.size >= 256 ? 0 : image.size;
    directory[entry + 1] = image.size >= 256 ? 0 : image.size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
    parts.push(image.png);
  });
  return Buffer.concat(parts);
}

function icns(entries) {
  const blobs = entries.map((entry) => {
    const header = Buffer.alloc(8);
    header.write(entry.type, 0, "ascii");
    header.writeUInt32BE(8 + entry.png.length, 4);
    return Buffer.concat([header, entry.png]);
  });
  const body = Buffer.concat(blobs);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(root, "public"), { recursive: true });
const sizes = {
  32: png(32),
  128: png(128),
  256: png(256),
  512: png(512),
};
fs.writeFileSync(path.join(outDir, "32x32.png"), sizes[32]);
fs.writeFileSync(path.join(outDir, "128x128.png"), sizes[128]);
fs.writeFileSync(path.join(outDir, "128x128@2x.png"), sizes[256]);
fs.writeFileSync(path.join(outDir, "icon.png"), sizes[512]);
fs.writeFileSync(path.join(root, "public", "icon.png"), sizes[32]);
fs.writeFileSync(
  path.join(outDir, "icon.ico"),
  ico([
    { size: 32, png: sizes[32] },
    { size: 128, png: sizes[128] },
    { size: 256, png: sizes[256] },
  ]),
);
fs.writeFileSync(
  path.join(outDir, "icon.icns"),
  icns([
    { type: "icp5", png: sizes[32] },
    { type: "ic07", png: sizes[128] },
    { type: "ic08", png: sizes[256] },
    { type: "ic09", png: sizes[512] },
  ]),
);
console.log(`Wrote icons to ${outDir}`);
