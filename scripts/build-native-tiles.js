// Build-time only: convert the existing PMTiles/MVT archive into the small
// geometry-only format consumed by the independent Canvas renderer.
const fs = require('node:fs');
const path = require('node:path');
const { PMTiles } = require('pmtiles');

const input = path.join(__dirname, '../public/data/base_slim_final.pmtiles');
const output = path.join(__dirname, '../public/data/native-base-tiles.bin');
const layerNames = ['AdmArea', 'Cstline', 'AdmBdry'];

class Reader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  varint() {
    let value = 0; let shift = 0;
    while (this.pos < this.bytes.length && shift < 56) {
      const b = this.bytes[this.pos++];
      value += (b & 127) * 2 ** shift;
      if (!(b & 128)) return value;
      shift += 7;
    }
    throw new Error('invalid protobuf varint');
  }
  bytesField() { const n = this.varint(); const end = this.pos + n; if (end > this.bytes.length) throw new Error('truncated protobuf field'); const b = this.bytes.subarray(this.pos, end); this.pos = end; return b; }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytesField();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported protobuf wire type ${wire}`);
    if (this.pos > this.bytes.length) throw new Error('truncated protobuf message');
  }
}

function fields(bytes, visit) {
  const r = new Reader(bytes);
  while (r.pos < bytes.length) {
    const tag = r.varint();
    const field = tag >> 3; const wire = tag & 7;
    if (!visit(r, field, wire)) r.skip(wire);
  }
}
const string = bytes => new TextDecoder().decode(bytes);
const zigzag = n => (n >>> 1) ^ -(n & 1);

function decodeGeometry(bytes) {
  const r = new Reader(bytes); const paths = [];
  let x = 0; let y = 0; let current = null;
  while (r.pos < bytes.length) {
    const cmd = r.varint(); const id = cmd & 7; const count = cmd >>> 3;
    if (id === 1 || id === 2) {
      for (let i = 0; i < count; i++) {
        x += zigzag(r.varint()); y += zigzag(r.varint());
        if (id === 1) { current = []; paths.push(current); }
        if (!current) throw new Error('LineTo before MoveTo');
        current.push(x, y);
      }
    } else if (id !== 7) throw new Error(`unsupported MVT geometry command ${id}`);
  }
  return paths;
}

function decodeValue(bytes) {
  let value = null;
  fields(bytes, (r, f, w) => {
    if (f === 1 && w === 2) { value = string(r.bytesField()); return true; }
    if ((f === 4 || f === 5 || f === 6) && w === 0) { const n = r.varint(); value = f === 6 ? zigzag(n) : n; return true; }
    return false;
  });
  return value;
}

function decodeLayer(bytes) {
  let name = ''; let extent = 4096;
  const rawFeatures = []; const keys = []; const values = [];
  fields(bytes, (r, f, w) => {
    if (f === 1 && w === 2) { name = string(r.bytesField()); return true; }
    if (f === 2 && w === 2) { rawFeatures.push(r.bytesField()); return true; }
    if (f === 3 && w === 2) { keys.push(string(r.bytesField())); return true; }
    if (f === 4 && w === 2) { values.push(decodeValue(r.bytesField())); return true; }
    if (f === 5 && w === 0) { extent = r.varint(); return true; }
    return false;
  });
  if (!layerNames.includes(name)) return null;
  const features = rawFeatures.map(bytes => {
    let type = 0; let tags = new Uint8Array(); let geometry = new Uint8Array();
    fields(bytes, (r, f, w) => {
      if (f === 2 && w === 2) { tags = r.bytesField(); return true; }
      if (f === 3 && w === 0) { type = r.varint(); return true; }
      if (f === 4 && w === 2) { geometry = r.bytesField(); return true; }
      return false;
    });
    let adminLevel = -1;
    const tr = new Reader(tags);
    while (tr.pos < tags.length) {
      const key = keys[tr.varint()]; const value = values[tr.varint()];
      if (key === 'admin_level') adminLevel = Number(value);
    }
    return { type, adminLevel, paths: decodeGeometry(geometry) };
  });
  return { name, extent, features };
}

function decodeTile(bytes) {
  const layers = Object.fromEntries(layerNames.map(name => [name, { extent: 4096, features: [] }]));
  fields(bytes, (r, f, w) => {
    if (f !== 3 || w !== 2) return false;
    const layer = decodeLayer(r.bytesField());
    if (layer) layers[layer.name] = layer;
    return true;
  });
  return layers;
}

class Writer {
  constructor() { this.bytes = []; }
  u8(n) { this.bytes.push(n & 255); }
  u16(n) { this.u8(n); this.u8(n >> 8); }
  i16(n) { if (n < -32768 || n > 32767) throw new Error(`tile coordinate out of range: ${n}`); this.u16(n); }
  u32(n) { this.u16(n); this.u16(n >>> 16); }
  finish() { return Buffer.from(this.bytes); }
}

function packTile(layers) {
  const w = new Writer();
  for (const name of layerNames) {
    const { extent, features } = layers[name];
    w.u16(extent);
    w.u16(features.length);
    for (const feature of features) {
      w.u8(feature.type); w.i16(feature.adminLevel); w.u16(feature.paths.length);
      for (const points of feature.paths) {
        w.u16(points.length / 2);
        for (const coordinate of points) w.i16(coordinate);
      }
    }
  }
  return w.finish();
}

function tileRange(minLon, minLat, maxLon, maxLat, z) {
  const n = 2 ** z;
  const x = lon => Math.max(0, Math.min(n - 1, Math.floor((lon + 180) / 360 * n)));
  const y = lat => Math.max(0, Math.min(n - 1, Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n)));
  return { minX: x(minLon), maxX: x(maxLon), minY: y(maxLat), maxY: y(minLat) };
}

async function build() {
  const file = fs.readFileSync(input);
  const source = { getKey: () => input, getBytes: async (offset, length) => ({
    data: file.buffer.slice(file.byteOffset + offset, file.byteOffset + offset + length),
  }) };
  const archive = new PMTiles(source);
  const header = await archive.getHeader();
  const tiles = [];
  for (let z = header.minZoom; z <= header.maxZoom; z++) {
    const range = tileRange(header.minLon, header.minLat, header.maxLon, header.maxLat, z);
    for (let x = range.minX; x <= range.maxX; x++) for (let y = range.minY; y <= range.maxY; y++) {
      const result = await archive.getZxy(z, x, y);
      if (!result) continue;
      tiles.push({ z, x, y, data: packTile(decodeTile(new Uint8Array(result.data))) });
    }
  }
  const indexSize = 5 + 2 + tiles.length * 13;
  const index = new Writer();
  for (const char of 'QZVT1') index.u8(char.charCodeAt(0));
  index.u16(tiles.length);
  let offset = indexSize;
  for (const tile of tiles) {
    index.u8(tile.z); index.u16(tile.x); index.u16(tile.y);
    index.u32(offset); index.u32(tile.data.length);
    offset += tile.data.length;
  }
  fs.writeFileSync(output, Buffer.concat([index.finish(), ...tiles.map(t => t.data)]));
  console.log(`Converted ${tiles.length} vector tiles to ${path.relative(process.cwd(), output)} (${offset} bytes)`);
}

if (require.main === module) build().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { decodeGeometry, decodeTile, packTile, tileRange };
