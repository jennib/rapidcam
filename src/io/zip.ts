/**
 * Minimal, dependency-free ZIP writer (store / no compression).
 *
 * Enough to bundle a handful of text files (e.g. Stitch tile G-code) into one
 * download. No compression keeps it tiny and correct; G-code zips fine as-is for
 * the handful-of-files case this serves.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** File name (use forward slashes for folders). */
  name: string;
  data: string;
}

/** Build a store-only ZIP archive from the given text entries. */
export function zipStore(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const files = entries.map((e) => ({ name: enc.encode(e.name), data: enc.encode(e.data) }));

  // Local headers + data.
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const offsets: number[] = [];
  let offset = 0;

  for (const f of files) {
    const crc = crc32(f.data);
    const lh = new Uint8Array(30 + f.name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 filename
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true); // compressed size
    lv.setUint32(22, f.data.length, true); // uncompressed size
    lv.setUint16(26, f.name.length, true);
    lv.setUint16(28, 0, true); // extra length
    lh.set(f.name, 30);

    offsets.push(offset);
    locals.push(lh, f.data);
    offset += lh.length + f.data.length;

    const ch = new Uint8Array(46 + f.name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true); // flags: UTF-8
    cv.setUint16(10, 0, true); // method: store
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0, true); // mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, f.name.length, true);
    // extra (30), comment (32), disk (34), internal attrs (36) all zero
    cv.setUint32(42, offsets[offsets.length - 1], true); // local header offset
    ch.set(f.name, 46);
    central.push(ch);
  }

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const cdOffset = offset;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(8, files.length, true); // entries on this disk
  ev.setUint16(10, files.length, true); // total entries
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);

  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of [...locals, ...central, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
