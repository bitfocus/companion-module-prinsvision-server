/**
 * Minimal PNG generator for Companion button backgrounds (`png64`).
 *
 * Pure Node (zlib + Buffer, no external image dependency) so button art is
 * generated at module load — no asset files to bundle. Encodes 8-bit RGB
 * (colour type 2). Reusable base for richer button graphics later.
 */
import zlib from 'node:zlib'

export type RGB = [number, number, number]

const CRC_TABLE: Uint32Array = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        t[n] = c >>> 0
    }
    return t
})()

function crc32(buf: Buffer): number {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const typeBuf = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
    return Buffer.concat([len, typeBuf, data, crc])
}

/** Encode a row-major RGB buffer (3 bytes/px) as a base64 PNG (no data: prefix). */
export function encodePngBase64(width: number, height: number, rgb: Buffer): string {
    const stride = width * 3
    // Prepend the per-scanline filter byte (0 = None).
    const raw = Buffer.alloc((stride + 1) * height)
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0
        rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
    }
    const idat = zlib.deflateSync(raw)
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8   // bit depth
    ihdr[9] = 2   // colour type 2 = truecolour RGB
    // 10-12: compression / filter / interlace = 0
    const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
    return png.toString('base64')
}

/**
 * Horizontal 2-stop linear gradient as a base64 PNG. Used for the bipolar
 * axes (temperature blue→amber, tint green→magenta) that a single solid
 * colour can't represent.
 */
export function horizontalGradientPngBase64(from: RGB, to: RGB, width = 72, height = 72): string {
    const rgb = Buffer.alloc(width * height * 3)
    for (let x = 0; x < width; x++) {
        const t = width === 1 ? 0 : x / (width - 1)
        const r = Math.round(from[0] + (to[0] - from[0]) * t)
        const g = Math.round(from[1] + (to[1] - from[1]) * t)
        const b = Math.round(from[2] + (to[2] - from[2]) * t)
        for (let y = 0; y < height; y++) {
            const i = (y * width + x) * 3
            rgb[i] = r
            rgb[i + 1] = g
            rgb[i + 2] = b
        }
    }
    return encodePngBase64(width, height, rgb)
}
