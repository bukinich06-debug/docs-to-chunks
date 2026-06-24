export const ICON_MAX_SIDE_PX = 128;

export type ImageDimensions = {
  width: number;
  height: number;
};

function readPngDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 24) return null;
  if (
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47
  ) {
    return null;
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readGifDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 10) return null;
  const sig = buffer.toString("ascii", 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;

  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  };
}

function readBmpDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 26) return null;
  if (buffer.toString("ascii", 0, 2) !== "BM") return null;

  const width = buffer.readInt32LE(18);
  const height = Math.abs(buffer.readInt32LE(22));
  if (width <= 0 || height <= 0) return null;

  return { width, height };
}

function isJpegSofMarker(marker: number): boolean {
  return (
    marker === 0xc0 ||
    marker === 0xc1 ||
    marker === 0xc2 ||
    marker === 0xc3 ||
    marker === 0xc5 ||
    marker === 0xc6 ||
    marker === 0xc7 ||
    marker === 0xc9 ||
    marker === 0xca ||
    marker === 0xcb ||
    marker === 0xcd ||
    marker === 0xce ||
    marker === 0xcf
  );
}

function readJpegDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }

    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;

    if (isJpegSofMarker(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + segmentLength;
  }

  return null;
}

function readWebpVp8xDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 30) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  if (buffer.toString("ascii", 12, 16) !== "VP8X") return null;

  const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
  const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
  if (width <= 0 || height <= 0) return null;

  return { width, height };
}

function readWebpVp8lDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 25) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  if (buffer.toString("ascii", 12, 16) !== "VP8L") return null;
  if (buffer[21] !== 0x2f) return null;

  const bits = buffer.readUInt32LE(21) >>> 8;
  const width = (bits & 0x3fff) + 1;
  const height = ((bits >> 14) & 0x3fff) + 1;
  if (width <= 0 || height <= 0) return null;

  return { width, height };
}

function readWebpDimensions(buffer: Buffer): ImageDimensions | null {
  return (
    readWebpVp8xDimensions(buffer) ?? readWebpVp8lDimensions(buffer)
  );
}

function isValidDimensions(dims: ImageDimensions): boolean {
  return (
    Number.isFinite(dims.width) &&
    Number.isFinite(dims.height) &&
    dims.width > 0 &&
    dims.height > 0
  );
}

/**
 * Читает ширину и высоту растрового изображения из буфера (PNG, JPEG, GIF, WebP, BMP).
 */
export function readImageDimensions(buffer: Buffer): ImageDimensions | null {
  if (!buffer.length) return null;

  const readers = [
    readPngDimensions,
    readJpegDimensions,
    readGifDimensions,
    readWebpDimensions,
    readBmpDimensions,
  ];

  for (const read of readers) {
    const dims = read(buffer);
    if (dims && isValidDimensions(dims)) {
      return dims;
    }
  }

  return null;
}

export function isSmallIconBySize(width: number, height: number): boolean {
  return Math.max(width, height) <= ICON_MAX_SIDE_PX;
}
