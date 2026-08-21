import test from "node:test";
import assert from "node:assert/strict";

import { createQrMatrix, qrSvg, QR_MAX_BYTE_LENGTH } from "../src/shared/qr/index.js";

test("DD-010A QR generator creates deterministic Version 6 matrix for Preview-length URL", () => {
  const url = `https://deedou-pos-git-agent-dd008p-pr-bb01ce-hcinfitong-3230s-projects.vercel.app/#/t/ddt_${"x".repeat(32)}`;
  assert.ok(Buffer.byteLength(url, "utf8") <= QR_MAX_BYTE_LENGTH);
  const first = createQrMatrix(url);
  const second = createQrMatrix(url);
  assert.equal(first.length, 41);
  assert.ok(first.every((row) => row.length === 41));
  assert.deepEqual(first, second);
  assert.equal(first[3][3], true);
  assert.equal(first[3][2], true);
  assert.equal(first[3][1], false);
  assert.equal(first[34][34], true);
});

test("DD-010A QR SVG is self-contained and does not call an external QR service", () => {
  const svg = qrSvg("https://deedou-pos.vercel.app/#/t/ddt_12345678901234567890", { scale: 4, border: 4 });
  assert.match(svg, /^<svg /);
  assert.match(svg, /<path /);
  assert.doesNotMatch(svg, /https?:\/\//);
  assert.doesNotMatch(svg, /<image/i);
});

test("DD-010A QR generator fails explicitly when URL exceeds capacity", () => {
  assert.throws(() => createQrMatrix("x".repeat(QR_MAX_BYTE_LENGTH + 1)), /QR_TEXT_TOO_LONG/);
});
