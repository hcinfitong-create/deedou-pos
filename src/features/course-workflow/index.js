export const HOLD_STATES = Object.freeze({
  HELD: "HELD",
  FIRED: "FIRED"
});

const ACTIVE_PREP_STATUSES = Object.freeze(["ACKNOWLEDGED", "PREPARING", "READY"]);
const CLOSED_ORDER_STATUSES = Object.freeze(["PAID", "REJECTED", "VOIDED", "REFUNDED"]);
const OPERATIONAL_ORDER_STATUSES = Object.freeze(["ACCEPTED", "IN_PREPARATION", "READY"]);

export function normalizeCourse(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (!/^[0-9]+$/.test(text)) return "";
  const number = Number(text);
  return Number.isInteger(number) && number > 0 ? String(number) : "";
}

export function validateCourse(value) {
  const text = String(value ?? "").trim();
  if (!text) return { ok: true, course: "" };
  const course = normalizeCourse(text);
  if (!course) return { ok: false, reason: "INVALID_COURSE", course: "" };
  return { ok: true, course };
}

export function normalizeHoldState(value) {
  const state = String(value || "").trim().toUpperCase();
  return state === HOLD_STATES.HELD ? HOLD_STATES.HELD : HOLD_STATES.FIRED;
}

export function normalizeLineCourseScheduling(line = {}) {
  return {
    course: normalizeCourse(line.course),
    holdState: normalizeHoldState(line.holdState),
    heldAt: normalizeIsoTimestamp(line.heldAt),
    firedAt: normalizeIsoTimestamp(line.firedAt),
    parentLineId: normalizeLineId(line.parentLineId || inferParentLineId(line))
  };
}

export function isLineKdsReleased(line = {}) {
  return normalizeHoldState(line.holdState) === HOLD_STATES.FIRED;
}

export function courseLabel(course, lang = "en") {
  const normalized = normalizeCourse(course);
  if (!normalized) return lang === "vi" ? "Ra ngay" : "Immediate";
  return lang === "vi" ? `Món đợt ${normalized}` : `Course ${normalized}`;
}

export function courseSortValue(course) {
  const normalized = normalizeCourse(course);
  return normalized ? Number(normalized) : 0;
}

export function getServiceFamilies(order = {}) {
  const lines = order.items || [];
  const families = new Map();

  lines.forEach((line) => {
    if (!isServiceFamilyRoot(line)) return;
    ensureFamily(families, line.lineId, line).lines.push(line);
  });

  lines.filter(isRequiredStationLineLike).forEach((line) => {
    const rootLineId = serviceFamilyRootLineId(line);
    const family = ensureFamily(families, rootLineId, lines.find((item) => item.lineId === rootLineId) || line);
    if (!family.lines.includes(line)) family.lines.push(line);
    family.requiredLines.push(line);
  });

  return [...families.values()].map((family) => {
    const scheduleSource = family.root || family.lines[0] || {};
    const course = normalizeCourse(scheduleSource.course);
    const holdState = normalizeHoldState(scheduleSource.holdState);
    return {
      ...family,
      course,
      holdState,
      courseLabel: courseLabel(course),
      lineIds: family.lines.map((line) => line.lineId).filter(Boolean),
      requiredLineIds: family.requiredLines.map((line) => line.lineId).filter(Boolean),
      canEdit: canMutateQueuedFamily(family).ok
    };
  }).sort(compareFamilies);
}

export function findServiceFamily(order = {}, rootLineId) {
  const normalizedRootLineId = normalizeLineId(rootLineId);
  if (!normalizedRootLineId) return null;
  return getServiceFamilies(order).find((family) => family.rootLineId === normalizedRootLineId) || null;
}

export function canAssignCourse(order = {}, rootLineId, course) {
  if (isClosedOrder(order)) return { ok: false, reason: "ORDER_CLOSED" };
  const parsed = validateCourse(course);
  if (!parsed.ok) return parsed;
  const family = findServiceFamily(order, rootLineId);
  if (!family) return { ok: false, reason: "SERVICE_FAMILY_NOT_FOUND" };
  const mutable = canMutateQueuedFamily(family);
  if (!mutable.ok) return { ...mutable, family };
  return { ok: true, family, course: parsed.course };
}

export function assignServiceFamilyCourse(order = {}, rootLineId, course) {
  const allowed = canAssignCourse(order, rootLineId, course);
  if (!allowed.ok) return { ...allowed, order };
  applyToFamily(allowed.family, { course: allowed.course });
  return {
    ok: true,
    order,
    family: allowed.family,
    course: allowed.course,
    lineIds: allowed.family.lineIds
  };
}

export function canHoldServiceFamily(order = {}, rootLineId) {
  if (isClosedOrder(order)) return { ok: false, reason: "ORDER_CLOSED" };
  const family = findServiceFamily(order, rootLineId);
  if (!family) return { ok: false, reason: "SERVICE_FAMILY_NOT_FOUND" };
  const mutable = canMutateQueuedFamily(family);
  if (!mutable.ok) return { ...mutable, family };
  return { ok: true, family };
}

export function holdServiceFamily(order = {}, rootLineId, options = {}) {
  const allowed = canHoldServiceFamily(order, rootLineId);
  if (!allowed.ok) return { ...allowed, order };
  const now = normalizeIsoTimestamp(options.now) || new Date().toISOString();
  applyToFamily(allowed.family, {
    holdState: HOLD_STATES.HELD,
    heldAt: now,
    firedAt: "",
    queuedAt: ""
  });
  allowed.family.requiredLines.forEach((line) => {
    line.prepStatus = "QUEUED";
    line.status = "QUEUED";
    line.acknowledgedAt = "";
    line.prepStartedAt = "";
    line.readyAt = "";
  });
  return {
    ok: true,
    order,
    family: allowed.family,
    holdState: HOLD_STATES.HELD,
    lineIds: allowed.family.lineIds,
    heldAt: now
  };
}

export function canFireServiceFamily(order = {}, rootLineId) {
  if (isClosedOrder(order)) return { ok: false, reason: "ORDER_CLOSED" };
  const family = findServiceFamily(order, rootLineId);
  if (!family) return { ok: false, reason: "SERVICE_FAMILY_NOT_FOUND" };
  const unsafeHeld = family.holdState === HOLD_STATES.HELD && !canMutateQueuedFamily(family).ok;
  if (unsafeHeld) return { ok: false, reason: "FIRE_NOT_ALLOWED", family };
  return { ok: true, family };
}

export function fireServiceFamily(order = {}, rootLineId, options = {}) {
  const allowed = canFireServiceFamily(order, rootLineId);
  if (!allowed.ok) return { ...allowed, order };
  if (allowed.family.holdState === HOLD_STATES.FIRED) {
    return {
      ok: true,
      noOp: true,
      reason: "ALREADY_FIRED",
      order,
      family: allowed.family,
      holdState: HOLD_STATES.FIRED,
      lineIds: allowed.family.lineIds,
      firedAt: normalizeIsoTimestamp(allowed.family.root?.firedAt)
    };
  }
  const now = normalizeIsoTimestamp(options.now) || new Date().toISOString();
  const operational = isOperationalOrder(order);
  applyToFamily(allowed.family, {
    holdState: HOLD_STATES.FIRED,
    firedAt: now
  });
  if (operational) {
    allowed.family.requiredLines.forEach((line) => {
      if (normalizePrepStatusLike(line.prepStatus || line.status) === "QUEUED") line.queuedAt = now;
    });
  }
  return {
    ok: true,
    order,
    family: allowed.family,
    holdState: HOLD_STATES.FIRED,
    lineIds: allowed.family.lineIds,
    firedAt: now
  };
}

export function fireCourse(order = {}, course, options = {}) {
  if (isClosedOrder(order)) return { ok: false, order, reason: "ORDER_CLOSED" };
  const parsed = validateCourse(course);
  if (!parsed.ok || !parsed.course) return { ok: false, order, reason: parsed.reason || "COURSE_REQUIRED" };
  const families = getServiceFamilies(order).filter((family) => family.course === parsed.course);
  if (!families.length) return { ok: false, order, reason: "COURSE_NOT_FOUND", course: parsed.course };

  const blocked = families.find((family) => {
    return family.holdState === HOLD_STATES.HELD && !canFireServiceFamily(order, family.rootLineId).ok;
  });
  if (blocked) return { ok: false, order, reason: "FIRE_NOT_ALLOWED", course: parsed.course, family: blocked };

  const fired = families
    .filter((family) => family.holdState === HOLD_STATES.HELD)
    .map((family) => fireServiceFamily(order, family.rootLineId, options));

  return {
    ok: true,
    order,
    course: parsed.course,
    families,
    firedFamilies: fired.filter((result) => result.ok).map((result) => result.family.rootLineId)
  };
}

export function getHeldCourseNumbers(order = {}) {
  return [...new Set(getServiceFamilies(order)
    .filter((family) => family.course && family.holdState === HOLD_STATES.HELD)
    .map((family) => family.course))]
    .sort((left, right) => courseSortValue(left) - courseSortValue(right));
}

function ensureFamily(families, rootLineId, root) {
  const safeRootLineId = normalizeLineId(rootLineId || root?.lineId);
  if (!families.has(safeRootLineId)) {
    families.set(safeRootLineId, {
      rootLineId: safeRootLineId,
      root,
      lines: [],
      requiredLines: []
    });
  }
  return families.get(safeRootLineId);
}

function isServiceFamilyRoot(line = {}) {
  return !!line.lineId && line.isBillable !== false && !line.isComponent;
}

function serviceFamilyRootLineId(line = {}) {
  return normalizeLineId(line.parentLineId || inferParentLineId(line) || line.lineId);
}

function canMutateQueuedFamily(family = {}) {
  const requiredLines = family.requiredLines || [];
  if (!requiredLines.length) return { ok: true };
  const unsafe = requiredLines.find((line) => !isQueuedUntouchedLine(line));
  if (unsafe) return { ok: false, reason: "FAMILY_PREP_STARTED", line: unsafe };
  return { ok: true };
}

function isQueuedUntouchedLine(line = {}) {
  return normalizePrepStatusLike(line.prepStatus || line.status) === "QUEUED"
    && normalizeServedQtyLike(line.servedQty) === 0
    && !line.acknowledgedAt
    && !line.prepStartedAt
    && !line.readyAt;
}

function applyToFamily(family, values) {
  (family.lines || []).forEach((line) => {
    Object.entries(values).forEach(([key, value]) => {
      line[key] = value;
    });
  });
}

function isRequiredStationLineLike(line = {}) {
  return !!line
    && line.station
    && line.station !== "COMBO"
    && !line.isMeta
    && line.type !== "META"
    && line.type !== "COURSE_MARKER";
}

function inferParentLineId(line = {}) {
  const lineId = normalizeLineId(line.lineId);
  if (!line.isComponent || !lineId.includes(":component-")) return "";
  return lineId.split(":component-")[0];
}

function compareFamilies(left, right) {
  return courseSortValue(left.course) - courseSortValue(right.course)
    || String(left.rootLineId).localeCompare(String(right.rootLineId));
}

function normalizePrepStatusLike(status) {
  const key = String(status || "").trim().toUpperCase();
  if (key === "PENDING" || key === "PENDING_ACCEPTANCE" || key === "ACCEPTED") return "QUEUED";
  if (key === "IN_PROGRESS") return "PREPARING";
  if (key === "COMPLETED" || key === "SERVED") return "READY";
  return ACTIVE_PREP_STATUSES.includes(key) ? key : "QUEUED";
}

function normalizeServedQtyLike(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function isOperationalOrder(order = {}) {
  return OPERATIONAL_ORDER_STATUSES.includes(String(order.status || "").trim().toUpperCase());
}

function isClosedOrder(order = {}) {
  return CLOSED_ORDER_STATUSES.includes(String(order.status || "").trim().toUpperCase());
}

function normalizeLineId(value) {
  return String(value || "").trim();
}

function normalizeIsoTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : "";
}
