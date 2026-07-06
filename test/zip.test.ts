import { test, expect } from "vitest";
import { zipStore } from "../src/io/zip";

const u32 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);

test("produces a well-formed store archive with local, central and EOCD records", () => {
  const z = zipStore([{ name: "a.nc", data: "G0 X0\n" }, { name: "b.nc", data: "G1 X1\n" }]);

  expect(u32(z, 0)).toBe(0x04034b50); // first local file header
  // EOCD sits at the end and records both entries.
  const eocd = z.length - 22;
  expect(u32(z, eocd)).toBe(0x06054b50);
  expect(u16(z, eocd + 10)).toBe(2); // total entries

  // Central directory offset/size point at valid central headers.
  const cdSize = u32(z, eocd + 12);
  const cdOff = u32(z, eocd + 16);
  expect(u32(z, cdOff)).toBe(0x02014b50);
  expect(cdOff + cdSize).toBe(eocd);
});

test("stored size equals the raw data size (no compression) and names are embedded", () => {
  const data = "G90\nG0 Z5\n";
  const z = zipStore([{ name: "tile_c1_r1.nc", data }]);
  const lv = new DataView(z.buffer);
  expect(lv.getUint16(8, true)).toBe(0); // method: store
  expect(lv.getUint32(18, true)).toBe(new TextEncoder().encode(data).length); // compressed == raw
  const name = new TextDecoder().decode(z.slice(30, 30 + u16(z, 26)));
  expect(name).toBe("tile_c1_r1.nc");
});

test("CRC-32 matches the standard check value", () => {
  // The IEEE CRC-32 of "123456789" is 0xCBF43926 — a well-known check value.
  const z = zipStore([{ name: "x", data: "123456789" }]);
  const lv = new DataView(z.buffer);
  expect(lv.getUint32(14, true) >>> 0).toBe(0xcbf43926);
});
