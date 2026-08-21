const VERSION = 6;
const SIZE = 17 + VERSION * 4;
const DATA_CODEWORDS = 136;
const ECC_CODEWORDS_PER_BLOCK = 18;
const BLOCKS = 2;
const MAX_BYTE_LENGTH = 134;

export const QR_MAX_BYTE_LENGTH = MAX_BYTE_LENGTH;

export function createQrMatrix(text) {
  const codewords = encodeCodewords(String(text ?? ""));
  const matrix = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
  const functionModules = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
  const setFunction = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    matrix[y][x] = !!dark;
    functionModules[y][x] = true;
  };

  drawFinder(setFunction, 3, 3);
  drawFinder(setFunction, SIZE - 4, 3);
  drawFinder(setFunction, 3, SIZE - 4);
  drawAlignment(setFunction, 34, 34);
  for (let i = 8; i < SIZE - 8; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }
  drawFormat(setFunction, 0);

  let bitIndex = 0;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < SIZE; vertical += 1) {
      const upward = ((right + 1) & 2) === 0;
      const y = upward ? SIZE - 1 - vertical : vertical;
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        if (functionModules[y][x]) continue;
        let bit = false;
        if (bitIndex < codewords.length * 8) {
          bit = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
        }
        bitIndex += 1;
        if ((x + y) % 2 === 0) bit = !bit;
        matrix[y][x] = bit;
      }
    }
  }
  drawFormat(setFunction, 0);
  return matrix;
}

export function qrSvg(text, options = {}) {
  const matrix = createQrMatrix(text);
  const scale = clampInt(options.scale, 1, 32, 6);
  const border = clampInt(options.border, 2, 12, 4);
  const size = matrix.length;
  const dimension = (size + border * 2) * scale;
  const path = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (matrix[y][x]) path.push(`M${(x + border) * scale},${(y + border) * scale}h${scale}v${scale}h-${scale}z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="QR code" width="${dimension}" height="${dimension}" viewBox="0 0 ${dimension} ${dimension}"><rect width="100%" height="100%" fill="white"/><path d="${path.join("")}" fill="black"/></svg>`;
}

function encodeCodewords(text) {
  const bytes = [...new TextEncoder().encode(text)];
  if (bytes.length > MAX_BYTE_LENGTH) throw new Error(`QR_TEXT_TOO_LONG:${bytes.length}`);
  const bits = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, 8);
  for (const byte of bytes) pushBits(bits, byte, 8);
  const totalBits = DATA_CODEWORDS * 8;
  for (let i = 0; i < Math.min(4, totalBits - bits.length); i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = bitsToBytes(bits, DATA_CODEWORDS);
  const dataBlocks = [data.slice(0, 68), data.slice(68, 136)];
  const divisor = rsDivisor(ECC_CODEWORDS_PER_BLOCK);
  const eccBlocks = dataBlocks.map((block) => rsRemainder(block, divisor));
  const result = [];
  for (let i = 0; i < 68; i += 1) {
    for (let block = 0; block < BLOCKS; block += 1) result.push(dataBlocks[block][i]);
  }
  for (let i = 0; i < ECC_CODEWORDS_PER_BLOCK; i += 1) {
    for (let block = 0; block < BLOCKS; block += 1) result.push(eccBlocks[block][i]);
  }
  return result;
}

function drawFinder(setFunction, cx, cy) {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(cx + dx, cy + dy, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignment(setFunction, cx, cy) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFormat(setFunction, mask) {
  const data = (1 << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;
  const bit = (index) => ((bits >>> index) & 1) !== 0;
  for (let i = 0; i <= 5; i += 1) setFunction(8, i, bit(i));
  setFunction(8, 7, bit(6));
  setFunction(8, 8, bit(7));
  setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) setFunction(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) setFunction(SIZE - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) setFunction(8, SIZE - 15 + i, bit(i));
  setFunction(8, SIZE - 8, true);
}

function pushBits(target, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) target.push((value >>> i) & 1);
}

function bitsToBytes(bits, count) {
  const result = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | (bits[i + j] || 0);
    result.push(value);
  }
  while (result.length < count) result.push(result.length % 2 === 0 ? 0xec : 0x11);
  return result;
}

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = Array(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < result.length; i += 1) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}
