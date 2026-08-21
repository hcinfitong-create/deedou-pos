export const TABLE_SHAPES = Object.freeze(["RECTANGLE", "ROUND", "SQUARE"]);

export function normalizeAdminTable(value = {}) {
  return {
    id: text(value.id),
    code: text(value.code).toUpperCase(),
    zone: text(value.zone),
    qrToken: text(value.qrToken ?? value.qr_token),
    isActive: value.isActive ?? value.is_active ?? true,
    displayOrder: integer(value.displayOrder ?? value.display_order, 0),
    seatCount: clamp(integer(value.seatCount ?? value.seat_count, 4), 1, 50),
    layoutX: clamp(integer(value.layoutX ?? value.layout_x, 0), 0, 99),
    layoutY: clamp(integer(value.layoutY ?? value.layout_y, 0), 0, 99),
    layoutWidth: clamp(integer(value.layoutWidth ?? value.layout_width, 2), 1, 12),
    layoutHeight: clamp(integer(value.layoutHeight ?? value.layout_height, 2), 1, 12),
    shape: normalizeShape(value.shape),
    version: Math.max(1, integer(value.version, 1)),
    updatedAt: text(value.updatedAt ?? value.updated_at),
    hasOpenSession: value.hasOpenSession ?? value.has_open_session ?? false
  };
}

export function groupAdminTablesByZone(tables = []) {
  const zones = new Map();
  for (const raw of tables) {
    const table = normalizeAdminTable(raw);
    const zone = table.zone || "Unassigned";
    if (!zones.has(zone)) zones.set(zone, []);
    zones.get(zone).push(table);
  }
  return [...zones.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "vi"))
    .map(([zone, zoneTables]) => ({
      zone,
      tables: zoneTables.sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code))
    }));
}

export function buildCustomerTableUrl(qrToken, href = "") {
  const token = text(qrToken);
  if (!token) return "";
  const fallback = typeof globalThis.location?.href === "string" ? globalThis.location.href : "https://deedou-pos.vercel.app/";
  const url = new URL(text(href) || fallback);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/[^/]*$/, "");
  return `${url.origin}${url.pathname.replace(/\/$/, "")}/#/t/${encodeURIComponent(token)}`;
}

export function layoutStyle(table = {}) {
  const normalized = normalizeAdminTable(table);
  const widthPercent = Math.min(48, Math.max(8, normalized.layoutWidth * 4));
  const heightPercent = Math.min(40, Math.max(12, normalized.layoutHeight * 5));
  return {
    left: Math.min(100 - widthPercent, normalized.layoutX),
    top: Math.min(100 - heightPercent, normalized.layoutY),
    width: widthPercent,
    height: heightPercent
  };
}

export function dropPositionFromPointer({ clientX, clientY, rect, table } = {}) {
  const source = normalizeAdminTable(table);
  if (!rect || rect.width <= 0 || rect.height <= 0) return { layoutX: source.layoutX, layoutY: source.layoutY };
  const style = layoutStyle(source);
  const x = ((Number(clientX) - rect.left) / rect.width) * 100 - style.width / 2;
  const y = ((Number(clientY) - rect.top) / rect.height) * 100 - style.height / 2;
  return {
    layoutX: Math.round(clamp(x, 0, 100 - style.width)),
    layoutY: Math.round(clamp(y, 0, 100 - style.height))
  };
}

export function validateTableDraft(value = {}) {
  const table = normalizeAdminTable(value);
  const errors = [];
  if (!/^[A-Z0-9][A-Z0-9_-]{0,15}$/.test(table.code)) errors.push("INVALID_TABLE_CODE");
  if (!table.zone || table.zone.length > 64) errors.push("INVALID_ZONE");
  if (!TABLE_SHAPES.includes(table.shape)) errors.push("INVALID_SHAPE");
  return { ok: errors.length === 0, errors, table };
}

function normalizeShape(value) {
  const shape = text(value).toUpperCase();
  return TABLE_SHAPES.includes(shape) ? shape : "RECTANGLE";
}

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function text(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
