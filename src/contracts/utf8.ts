/**
 * UTF-8 measurement and encoding.
 *
 * Identifier fitting and SHA-256 share this walk so neither keeps its own copy.
 */

/**
 * UTF-8 byte length of a string.
 *
 * @param value - Text to measure
 * @returns Byte length
 */
export function utf8ByteLength(value: string): number {
  const length = value.length;
  for (let index = 0; index < length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return utf8ByteLengthFull(value);
    }
  }
  return length;
}

function utf8ByteLengthFull(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length;) {
    const unit = readCode(value, index);
    bytes += utf8Width(unit.code);
    index += unit.units;
  }
  return bytes;
}

/**
 * UTF-8 bytes of a string.
 *
 * ASCII, the usual catalog text, is one pass into one buffer. Anything else
 * uses the same width rules as {@link utf8ByteLength}.
 *
 * @param value - Text to encode
 * @returns UTF-8 bytes
 */
export function encodeUtf8(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code > 0x7f) {
      return encodeUtf8Slow(value);
    }
    bytes[index] = code;
  }
  return bytes;
}

/**
 * UTF-8 prefix of `value` that fits in `budget` bytes.
 *
 * A code point that would cross the budget is left off, so a surrogate pair
 * is never split.
 *
 * @param value - Text to cut
 * @param budget - Maximum UTF-8 bytes
 * @returns The prefix
 */
export function truncateUtf8(value: string, budget: number): string {
  if (budget <= 0) {
    return "";
  }
  let bytes = 0;
  let end = 0;
  for (let index = 0; index < value.length;) {
    const unit = readCode(value, index);
    const width = utf8Width(unit.code);
    if (bytes + width > budget) {
      break;
    }
    bytes += width;
    index += unit.units;
    end = index;
  }
  return value.slice(0, end);
}

function encodeUtf8Slow(value: string): Uint8Array {
  const bytes = new Uint8Array(utf8ByteLength(value));
  let offset = 0;
  for (let index = 0; index < value.length;) {
    const unit = readCode(value, index);
    offset = writeUtf8(bytes, offset, unit.code);
    index += unit.units;
  }
  return bytes;
}
function readCode(value: string, index: number): { readonly code: number; readonly units: number } {
  const lead = value.charCodeAt(index);
  const next = value.charCodeAt(index + 1);
  if (lead >= 0xd800 && lead <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    return {
      code: 0x1_0000 + ((lead - 0xd800) << 10) + (next - 0xdc00),
      units: 2,
    };
  }
  return { code: lead, units: 1 };
}

function utf8Width(code: number): number {
  if (code <= 0x7f) {
    return 1;
  }
  if (code <= 0x7ff) {
    return 2;
  }
  if (code <= 0xffff) {
    return 3;
  }
  return 4;
}

function writeUtf8(bytes: Uint8Array, offset: number, code: number): number {
  if (code <= 0x7f) {
    bytes[offset] = code;
    return offset + 1;
  }
  if (code <= 0x7ff) {
    bytes[offset] = 0xc0 | (code >> 6);
    bytes[offset + 1] = 0x80 | (code & 0x3f);
    return offset + 2;
  }
  if (code <= 0xffff) {
    bytes[offset] = 0xe0 | (code >> 12);
    bytes[offset + 1] = 0x80 | ((code >> 6) & 0x3f);
    bytes[offset + 2] = 0x80 | (code & 0x3f);
    return offset + 3;
  }
  bytes[offset] = 0xf0 | (code >> 18);
  bytes[offset + 1] = 0x80 | ((code >> 12) & 0x3f);
  bytes[offset + 2] = 0x80 | ((code >> 6) & 0x3f);
  bytes[offset + 3] = 0x80 | (code & 0x3f);
  return offset + 4;
}
