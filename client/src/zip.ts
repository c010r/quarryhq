// Empaquetador ZIP mínimo (método "store", sin compresión) para exportar un
// grupo de notas como archivos .md descargables de una — no agrega una
// dependencia nueva solo para esto; los .md son chicos y no necesitan
// comprimirse. Implementa lo justo del formato APPNOTE.TXT de PKWARE.

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function u16(n: number): Uint8Array { return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]); }
function u32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

export interface ZipEntry { name: string; content: string }

// Escritor de bytes simple: junta todos los chunks y al final los copia a
// un único Uint8Array (evita líos de tipos con Blob([...Uint8Array[]])).
class ByteWriter {
  private chunks: Uint8Array[] = [];
  length = 0;
  write(chunk: Uint8Array) { this.chunks.push(chunk); this.length += chunk.length; }
  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.length);
    let pos = 0;
    for (const c of this.chunks) { out.set(c, pos); pos += c.length; }
    return out;
  }
}

export function buildZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const UTF8_FLAG = 0x0800;
  const body = new ByteWriter();
  const central = new ByteWriter();
  const offsets: number[] = [];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = encoder.encode(entry.content);
    const crc = crc32(data);
    offsets.push(body.length);

    for (const chunk of [
      u32(0x04034b50), u16(20), u16(UTF8_FLAG), u16(0), u16(time), u16(date),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0),
      nameBytes, data,
    ]) body.write(chunk);
  }

  entries.forEach((entry, i) => {
    const nameBytes = encoder.encode(entry.name);
    const data = encoder.encode(entry.content);
    const crc = crc32(data);
    for (const chunk of [
      u32(0x02014b50), u16(20), u16(20), u16(UTF8_FLAG), u16(0), u16(time), u16(date),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offsets[i]), nameBytes,
    ]) central.write(chunk);
  });

  const eocd = new ByteWriter();
  for (const chunk of [
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(body.length), u16(0),
  ]) eocd.write(chunk);

  // TS tipa el Uint8Array de retorno como ArrayBufferLike (incluye
  // SharedArrayBuffer) mientras que BlobPart exige ArrayBuffer puro; en
  // tiempo de ejecución siempre es un ArrayBuffer normal.
  return new Blob([body.toUint8Array(), central.toUint8Array(), eocd.toUint8Array()] as BlobPart[], { type: 'application/zip' });
}
