export const PAYMENT_TRANSACTION_TYPES = Object.freeze({
  PAYMENT: "PAYMENT",
  REFUND: "REFUND",
  PAYMENT_VOID: "PAYMENT_VOID"
});

export const PAYMENT_TRANSACTION_STATUS = "SUCCEEDED";

export const PAYMENT_STATUSES = Object.freeze({
  UNPAID: "UNPAID",
  PARTIALLY_PAID: "PARTIALLY_PAID",
  PAID: "PAID",
  PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
  REFUNDED: "REFUNDED"
});

export const PAYMENT_METHODS = Object.freeze({
  CASH: "CASH",
  CARD: "CARD",
  BANK_TRANSFER: "BANK_TRANSFER",
  VNPAY: "VNPAY",
  MOMO: "MOMO",
  ZALOPAY: "ZALOPAY",
  SPLIT_CASH: "SPLIT_CASH",
  REFUND: "REFUND"
});

const DEMO_PROVIDER_METHODS = Object.freeze(["VNPAY", "MOMO", "ZALOPAY"]);
const DEFAULT_CREATED_AT = "1970-01-01T00:00:00.000Z";
const TERMINAL_ORDER_STATUSES = Object.freeze(["PAID", "REJECTED", "VOIDED", "REFUNDED", "PARTIALLY_REFUNDED"]);

export function normalizePaymentMethod(method) {
  const key = String(method || "").trim().toUpperCase();
  const aliases = {
    CARD_EXTERNAL_TERMINAL: PAYMENT_METHODS.CARD,
    CARD_MANUAL: PAYMENT_METHODS.CARD,
    TRANSFER: PAYMENT_METHODS.BANK_TRANSFER,
    BANK: PAYMENT_METHODS.BANK_TRANSFER,
    BANKING: PAYMENT_METHODS.BANK_TRANSFER,
    REFUND: PAYMENT_METHODS.REFUND
  };
  return aliases[key] || key || PAYMENT_METHODS.CASH;
}

export function parsePositiveIntegerVnd(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const amount = Number(trimmed);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

export function normalizePaymentLedger(input = {}, options = {}) {
  const source = Array.isArray(input) ? { payments: input } : input || {};
  const rawPayments = Array.isArray(source.payments) ? source.payments : [];
  const now = normalizeIsoTimestamp(options.now) || DEFAULT_CREATED_AT;
  const transactions = [];
  const seenIds = new Set();

  rawPayments.forEach((record, index) => {
    const transaction = normalizePaymentTransaction(record, {
      index,
      now,
      previousTransactions: transactions
    });
    if (!transaction || seenIds.has(transaction.id)) return;
    seenIds.add(transaction.id);
    transactions.push(transaction);
  });

  const legacyPaidVnd = normalizeMoney(source.paidVnd);
  const hasPayment = transactions.some((transaction) => transaction.type === PAYMENT_TRANSACTION_TYPES.PAYMENT);
  if (!hasPayment && legacyPaidVnd > 0) {
    const id = `LEGACY-PAID-${normalizeId(source.id || source.orderId || "ORDER")}`;
    if (!seenIds.has(id)) {
      transactions.push({
        id,
        type: PAYMENT_TRANSACTION_TYPES.PAYMENT,
        method: PAYMENT_METHODS.CASH,
        provider: "LEGACY",
        amountVnd: legacyPaidVnd,
        status: PAYMENT_TRANSACTION_STATUS,
        relatedPaymentId: "",
        tenderGroupId: "",
        createdAt: now,
        note: "Legacy paidVnd-only payment"
      });
    }
  }

  return transactions;
}

export function paymentSummaryForOrder(order = {}) {
  return paymentSummaryForLedger({
    billTotalVnd: order.total,
    payments: normalizePaymentLedger(order)
  });
}

export function paymentSummaryForOrders(orders = []) {
  const orderSummaries = orders.map(paymentSummaryForOrder);
  const billTotalVnd = orderSummaries.reduce((sum, summary) => sum + summary.billTotalVnd, 0);
  const grossPaidVnd = orderSummaries.reduce((sum, summary) => sum + summary.grossPaidVnd, 0);
  const voidedPaymentVnd = orderSummaries.reduce((sum, summary) => sum + summary.voidedPaymentVnd, 0);
  const effectivePaidVnd = orderSummaries.reduce((sum, summary) => sum + summary.effectivePaidVnd, 0);
  const refundedVnd = orderSummaries.reduce((sum, summary) => sum + summary.refundedVnd, 0);
  const netCollectedVnd = orderSummaries.reduce((sum, summary) => sum + summary.netCollectedVnd, 0);
  const outstandingVnd = orderSummaries.reduce((sum, summary) => sum + summary.outstandingVnd, 0);
  const refundableVnd = orderSummaries.reduce((sum, summary) => sum + summary.refundableVnd, 0);
  return {
    billTotalVnd,
    grossPaidVnd,
    voidedPaymentVnd,
    effectivePaidVnd,
    refundedVnd,
    netCollectedVnd,
    outstandingVnd,
    refundableVnd,
    paymentStatus: aggregatePaymentStatus(orderSummaries),
    orderSummaries
  };
}

export function paymentSummaryForLedger({ billTotalVnd = 0, payments = [] } = {}) {
  const transactions = normalizePaymentLedger(payments);
  const analysis = analyzeLedger(transactions);
  const billTotal = normalizeMoney(billTotalVnd);
  const grossPaidVnd = analysis.payments.reduce((sum, payment) => sum + payment.amountVnd, 0);
  const voidedPaymentVnd = analysis.payments
    .filter((payment) => analysis.voidedPaymentIds.has(payment.id))
    .reduce((sum, payment) => sum + payment.amountVnd, 0);
  const effectivePaidVnd = Math.max(0, grossPaidVnd - voidedPaymentVnd);
  const refundedVnd = Math.min(effectivePaidVnd, [...analysis.refundedByPayment.values()].reduce((sum, amount) => sum + amount, 0));
  const netCollectedVnd = Math.max(0, effectivePaidVnd - refundedVnd);
  const outstandingVnd = Math.max(0, billTotal - effectivePaidVnd);
  const refundableVnd = Math.max(0, effectivePaidVnd - refundedVnd);
  return {
    billTotalVnd: billTotal,
    grossPaidVnd,
    voidedPaymentVnd,
    effectivePaidVnd,
    refundedVnd,
    netCollectedVnd,
    outstandingVnd,
    refundableVnd,
    paymentStatus: derivePaymentStatus({ billTotalVnd: billTotal, effectivePaidVnd, refundedVnd, refundableVnd }),
    payments: transactions,
    voidedPaymentIds: [...analysis.voidedPaymentIds],
    refundedByPayment: Object.fromEntries(analysis.refundedByPayment)
  };
}

export function canAcceptPayment(order = {}, amountVnd) {
  const amount = normalizeMoney(amountVnd);
  const summary = paymentSummaryForOrder(order);
  if (!amount) return { ok: false, reason: "INVALID_PAYMENT_AMOUNT", summary };
  if (summary.refundedVnd > 0) return { ok: false, reason: "REFUND_STARTED", summary };
  if (TERMINAL_ORDER_STATUSES.includes(normalizeOrderStatusLike(order.status)) && normalizeOrderStatusLike(order.status) !== "PAID") {
    return { ok: false, reason: "ORDER_TERMINAL", summary };
  }
  if (summary.outstandingVnd <= 0) return { ok: false, reason: "NO_OUTSTANDING_BALANCE", summary };
  if (amount > summary.outstandingVnd) return { ok: false, reason: "PAYMENT_EXCEEDS_OUTSTANDING", summary };
  return { ok: true, amountVnd: amount, summary };
}

export function recordPayment(order = {}, options = {}) {
  const id = normalizeId(options.id);
  if (!id) return { ok: false, reason: "PAYMENT_ID_REQUIRED", order };
  if (hasTransactionId(order, id)) return { ok: true, noOp: true, reason: "DUPLICATE_TRANSACTION_ID", order, summary: paymentSummaryForOrder(order) };

  const allowed = canAcceptPayment(order, options.amountVnd);
  if (!allowed.ok) return { ...allowed, order };

  order.payments = normalizePaymentLedger(order);
  const method = normalizePaymentMethod(options.method);
  const transaction = {
    id,
    type: PAYMENT_TRANSACTION_TYPES.PAYMENT,
    method,
    provider: normalizeProvider(options.provider, method),
    amountVnd: allowed.amountVnd,
    status: PAYMENT_TRANSACTION_STATUS,
    relatedPaymentId: "",
    tenderGroupId: normalizeId(options.tenderGroupId),
    createdAt: normalizeIsoTimestamp(options.now) || new Date().toISOString(),
    note: String(options.note || "")
  };
  order.payments.push(transaction);
  const summary = syncPaidProjection(order, options);
  return { ok: true, order, transaction, summary };
}

export function recordPaymentVoid(order = {}, options = {}) {
  const id = normalizeId(options.id);
  const paymentId = normalizeId(options.paymentId || options.relatedPaymentId);
  if (!id) return { ok: false, reason: "PAYMENT_VOID_ID_REQUIRED", order };
  if (hasTransactionId(order, id)) return { ok: true, noOp: true, reason: "DUPLICATE_TRANSACTION_ID", order, summary: paymentSummaryForOrder(order) };

  order.payments = normalizePaymentLedger(order);
  const analysis = analyzeLedger(order.payments);
  const original = analysis.paymentById.get(paymentId);
  if (!original) return { ok: false, reason: "PAYMENT_NOT_FOUND", order, summary: paymentSummaryForOrder(order) };
  if (analysis.voidedPaymentIds.has(paymentId)) return { ok: false, reason: "PAYMENT_ALREADY_VOIDED", order, summary: paymentSummaryForOrder(order) };
  if ((analysis.refundedByPayment.get(paymentId) || 0) > 0) return { ok: false, reason: "PAYMENT_ALREADY_REFUNDED", order, summary: paymentSummaryForOrder(order) };
  if ([...analysis.refundedByPayment.values()].some((amount) => amount > 0)) {
    return { ok: false, reason: "REFUND_STARTED", order, summary: paymentSummaryForOrder(order) };
  }

  const transaction = {
    id,
    type: PAYMENT_TRANSACTION_TYPES.PAYMENT_VOID,
    method: original.method,
    provider: original.provider,
    amountVnd: original.amountVnd,
    status: PAYMENT_TRANSACTION_STATUS,
    relatedPaymentId: original.id,
    tenderGroupId: original.tenderGroupId || "",
    createdAt: normalizeIsoTimestamp(options.now) || new Date().toISOString(),
    note: String(options.note || "")
  };
  order.payments.push(transaction);
  const summary = syncPaidProjection(order, options);
  return { ok: true, order, transaction, summary };
}

export function recordRefund(order = {}, options = {}) {
  const id = normalizeId(options.id);
  const paymentId = normalizeId(options.paymentId || options.relatedPaymentId);
  if (!id) return { ok: false, reason: "REFUND_ID_REQUIRED", order };
  if (hasTransactionId(order, id)) return { ok: true, noOp: true, reason: "DUPLICATE_TRANSACTION_ID", order, summary: paymentSummaryForOrder(order) };

  order.payments = normalizePaymentLedger(order);
  const summary = paymentSummaryForOrder(order);
  if (summary.effectivePaidVnd < summary.billTotalVnd || summary.billTotalVnd <= 0) {
    return { ok: false, reason: "BILL_NOT_SETTLED", order, summary };
  }

  const analysis = analyzeLedger(order.payments);
  const original = analysis.paymentById.get(paymentId);
  if (!original) return { ok: false, reason: "PAYMENT_NOT_FOUND", order, summary };
  if (analysis.voidedPaymentIds.has(paymentId)) return { ok: false, reason: "PAYMENT_VOIDED", order, summary };

  const amount = normalizeMoney(options.amountVnd);
  const refundable = remainingRefundableForPayment(order, paymentId);
  if (!amount) return { ok: false, reason: "INVALID_REFUND_AMOUNT", order, summary };
  if (amount > refundable) return { ok: false, reason: "REFUND_EXCEEDS_REMAINING", order, summary, refundableVnd: refundable };

  const transaction = {
    id,
    type: PAYMENT_TRANSACTION_TYPES.REFUND,
    method: PAYMENT_METHODS.REFUND,
    provider: original.provider || "MANUAL",
    amountVnd: amount,
    status: PAYMENT_TRANSACTION_STATUS,
    relatedPaymentId: original.id,
    tenderGroupId: original.tenderGroupId || "",
    createdAt: normalizeIsoTimestamp(options.now) || new Date().toISOString(),
    note: String(options.note || "")
  };
  order.payments.push(transaction);
  const nextSummary = syncPaidProjection(order, options);
  return { ok: true, order, transaction, summary: nextSummary };
}

export function remainingRefundableForPayment(order = {}, paymentId) {
  const transactions = normalizePaymentLedger(order);
  const analysis = analyzeLedger(transactions);
  const id = normalizeId(paymentId);
  const payment = analysis.paymentById.get(id);
  if (!payment || analysis.voidedPaymentIds.has(id)) return 0;
  return Math.max(0, payment.amountVnd - (analysis.refundedByPayment.get(id) || 0));
}

export function createEqualSplitPlan(amountVnd, parts = 2) {
  const amount = normalizeMoney(amountVnd);
  const count = Number(parts);
  if (!amount) return { ok: false, reason: "INVALID_SPLIT_AMOUNT", shares: [] };
  if (!Number.isInteger(count) || count < 2) return { ok: false, reason: "INVALID_SPLIT_PARTS", shares: [] };
  const base = Math.floor(amount / count);
  const remainder = amount % count;
  const shares = Array.from({ length: count }, (_, index) => ({
    shareNo: index + 1,
    amountVnd: base + (index < remainder ? 1 : 0)
  }));
  return { ok: true, amountVnd: amount, parts: count, shares };
}

export function allocateTableTender(orders = [], options = {}) {
  const amount = normalizeMoney(options.amountVnd);
  if (!amount) return { ok: false, reason: "INVALID_TENDER_AMOUNT", allocations: [] };
  const payable = [...orders]
    .map((order, index) => ({ order, index, summary: paymentSummaryForOrder(order) }))
    .filter((entry) => entry.summary.outstandingVnd > 0)
    .sort(compareOrderSequence);
  const totalOutstanding = payable.reduce((sum, entry) => sum + entry.summary.outstandingVnd, 0);
  if (!totalOutstanding) return { ok: false, reason: "NO_OUTSTANDING_BALANCE", allocations: [] };
  if (amount > totalOutstanding) return { ok: false, reason: "TENDER_EXCEEDS_OUTSTANDING", allocations: [] };

  let remaining = amount;
  const allocations = [];
  payable.forEach((entry) => {
    if (remaining <= 0) return;
    const amountVnd = Math.min(entry.summary.outstandingVnd, remaining);
    allocations.push({
      orderId: entry.order.id,
      orderNo: entry.order.orderNo || entry.order.id || "",
      amountVnd
    });
    remaining -= amountVnd;
  });
  return {
    ok: remaining === 0,
    reason: remaining === 0 ? "" : "ALLOCATION_INCOMPLETE",
    amountVnd: amount,
    tenderGroupId: normalizeId(options.tenderGroupId),
    allocations
  };
}

export function canEditBill(order = {}) {
  const summary = paymentSummaryForOrder(order);
  if (summary.effectivePaidVnd > 0 || summary.refundedVnd > 0) return { ok: false, reason: "PAYMENT_EXISTS", summary };
  return { ok: true, summary };
}

export function canVoidOrder(order = {}) {
  const summary = paymentSummaryForOrder(order);
  if (summary.effectivePaidVnd > 0 || summary.refundedVnd > 0) return { ok: false, reason: "PAYMENT_EXISTS", summary };
  return { ok: true, summary };
}

export function syncPaidProjection(order = {}, options = {}) {
  order.payments = normalizePaymentLedger(order, options);
  const summary = paymentSummaryForOrder(order);
  order.paidVnd = summary.effectivePaidVnd;
  order.paymentStatus = summary.paymentStatus;

  const current = normalizeOrderStatusLike(order.status);
  const serviceComplete = options.serviceComplete
    || ["SERVED", "PAID", "REFUNDED", "PARTIALLY_REFUNDED"].includes(current);
  if (summary.paymentStatus === PAYMENT_STATUSES.REFUNDED && serviceComplete) {
    order.status = "REFUNDED";
  } else if (summary.paymentStatus === PAYMENT_STATUSES.PARTIALLY_REFUNDED && serviceComplete) {
    order.status = "PAID";
  } else if (summary.paymentStatus === PAYMENT_STATUSES.PAID && serviceComplete) {
    order.status = "PAID";
  } else if (current === "PAID" && serviceComplete) {
    order.status = "SERVED";
  }

  return summary;
}

export function paymentHistoryView(order = {}) {
  const transactions = normalizePaymentLedger(order);
  const analysis = analyzeLedger(transactions);
  return transactions.map((transaction) => ({
    ...transaction,
    voided: transaction.type === PAYMENT_TRANSACTION_TYPES.PAYMENT && analysis.voidedPaymentIds.has(transaction.id),
    refundedVnd: transaction.type === PAYMENT_TRANSACTION_TYPES.PAYMENT ? analysis.refundedByPayment.get(transaction.id) || 0 : 0,
    refundableVnd: transaction.type === PAYMENT_TRANSACTION_TYPES.PAYMENT ? remainingRefundableForPayment({ ...order, payments: transactions }, transaction.id) : 0
  }));
}

function normalizePaymentTransaction(record = {}, context = {}) {
  if (!record || typeof record !== "object") return null;
  const rawStatus = String(record.status || PAYMENT_TRANSACTION_STATUS).trim().toUpperCase();
  if (rawStatus && rawStatus !== PAYMENT_TRANSACTION_STATUS) return null;

  const type = normalizeTransactionType(record);
  const amountVnd = normalizeTransactionAmount(record, type);
  if (!amountVnd) return null;

  const id = normalizeId(record.id || `${type === PAYMENT_TRANSACTION_TYPES.REFUND ? "LEGACY-REF" : "LEGACY-PAY"}-${context.index + 1}`);
  const method = type === PAYMENT_TRANSACTION_TYPES.REFUND
    ? PAYMENT_METHODS.REFUND
    : normalizePaymentMethod(record.method || record.paymentMethod);
  const relatedPaymentId = normalizeId(record.relatedPaymentId || record.paymentId || (
    type === PAYMENT_TRANSACTION_TYPES.REFUND ? inferPreviousPaymentId(context.previousTransactions) : ""
  ));

  return {
    id,
    type,
    method,
    provider: normalizeProvider(record.provider, method),
    amountVnd,
    status: PAYMENT_TRANSACTION_STATUS,
    relatedPaymentId,
    tenderGroupId: normalizeId(record.tenderGroupId),
    createdAt: normalizeIsoTimestamp(record.createdAt || record.paidAt || record.timestamp) || context.now || DEFAULT_CREATED_AT,
    note: String(record.note || record.reason || "")
  };
}

function normalizeTransactionType(record = {}) {
  const key = String(record.type || "").trim().toUpperCase();
  const method = normalizePaymentMethod(record.method);
  if (key === PAYMENT_TRANSACTION_TYPES.PAYMENT_VOID || method === PAYMENT_TRANSACTION_TYPES.PAYMENT_VOID) return PAYMENT_TRANSACTION_TYPES.PAYMENT_VOID;
  if (key === PAYMENT_TRANSACTION_TYPES.REFUND || method === PAYMENT_METHODS.REFUND) return PAYMENT_TRANSACTION_TYPES.REFUND;
  return PAYMENT_TRANSACTION_TYPES.PAYMENT;
}

function normalizeTransactionAmount(record = {}, type) {
  const value = record.amountVnd ?? record.amount ?? record.value;
  const positiveAmount = normalizeMoney(value);
  if (positiveAmount) return positiveAmount;
  if (type !== PAYMENT_TRANSACTION_TYPES.REFUND) return 0;
  if (typeof value === "number" && Number.isSafeInteger(value) && value < 0) return Math.abs(value);
  if (typeof value === "string" && /^-[1-9]\d*$/.test(value.trim())) {
    const amount = Number(value.trim());
    return Number.isSafeInteger(amount) ? Math.abs(amount) : 0;
  }
  return 0;
}

function analyzeLedger(transactions = []) {
  const normalized = normalizePaymentLedger(transactions);
  const payments = normalized.filter((transaction) => transaction.type === PAYMENT_TRANSACTION_TYPES.PAYMENT);
  const paymentById = new Map(payments.map((payment) => [payment.id, payment]));
  const voidedPaymentIds = new Set();
  normalized
    .filter((transaction) => transaction.type === PAYMENT_TRANSACTION_TYPES.PAYMENT_VOID)
    .forEach((transaction) => {
      if (paymentById.has(transaction.relatedPaymentId)) voidedPaymentIds.add(transaction.relatedPaymentId);
    });

  const refundedByPayment = new Map();
  normalized
    .filter((transaction) => transaction.type === PAYMENT_TRANSACTION_TYPES.REFUND)
    .forEach((transaction) => {
      const payment = paymentById.get(transaction.relatedPaymentId);
      if (!payment || voidedPaymentIds.has(payment.id)) return;
      const current = refundedByPayment.get(payment.id) || 0;
      refundedByPayment.set(payment.id, Math.min(payment.amountVnd, current + transaction.amountVnd));
    });

  return { transactions: normalized, payments, paymentById, voidedPaymentIds, refundedByPayment };
}

function derivePaymentStatus({ billTotalVnd, effectivePaidVnd, refundedVnd, refundableVnd }) {
  if (refundedVnd > 0 && refundableVnd === 0) return PAYMENT_STATUSES.REFUNDED;
  if (refundedVnd > 0) return PAYMENT_STATUSES.PARTIALLY_REFUNDED;
  if (effectivePaidVnd >= billTotalVnd && billTotalVnd > 0) return PAYMENT_STATUSES.PAID;
  if (effectivePaidVnd > 0) return PAYMENT_STATUSES.PARTIALLY_PAID;
  return PAYMENT_STATUSES.UNPAID;
}

function aggregatePaymentStatus(summaries = []) {
  if (!summaries.length) return PAYMENT_STATUSES.UNPAID;
  if (summaries.every((summary) => summary.paymentStatus === PAYMENT_STATUSES.REFUNDED)) return PAYMENT_STATUSES.REFUNDED;
  if (summaries.some((summary) => summary.refundedVnd > 0)) return PAYMENT_STATUSES.PARTIALLY_REFUNDED;
  if (summaries.every((summary) => summary.outstandingVnd === 0 && summary.billTotalVnd > 0)) return PAYMENT_STATUSES.PAID;
  if (summaries.some((summary) => summary.effectivePaidVnd > 0)) return PAYMENT_STATUSES.PARTIALLY_PAID;
  return PAYMENT_STATUSES.UNPAID;
}

function compareOrderSequence(left, right) {
  return comparableOrderTime(left.order).localeCompare(comparableOrderTime(right.order))
    || String(left.order.orderNo || "").localeCompare(String(right.order.orderNo || ""))
    || String(left.order.id || "").localeCompare(String(right.order.id || ""))
    || left.index - right.index;
}

function comparableOrderTime(order = {}) {
  return normalizeIsoTimestamp(order.createdAt || order.submittedAt || order.acceptedAt) || DEFAULT_CREATED_AT;
}

function normalizeProvider(provider, method) {
  const key = String(provider || "").trim().toUpperCase();
  if (key) return key;
  return DEMO_PROVIDER_METHODS.includes(method) ? method : "MANUAL";
}

function hasTransactionId(order = {}, id) {
  const safeId = normalizeId(id);
  return !!safeId && (order.payments || []).some((transaction) => normalizeId(transaction?.id) === safeId);
}

function inferPreviousPaymentId(transactions = []) {
  const previous = [...transactions].reverse().find((transaction) => transaction.type === PAYMENT_TRANSACTION_TYPES.PAYMENT);
  return previous?.id || "";
}

function normalizeOrderStatusLike(status) {
  const aliases = {
    PENDING: "PENDING_ACCEPTANCE",
    PREPARING: "IN_PREPARATION",
    CANCELLED: "VOIDED"
  };
  const key = String(status || "").trim().toUpperCase();
  return aliases[key] || key;
}

function normalizeMoney(value) {
  return parsePositiveIntegerVnd(value) || 0;
}

function normalizeId(value) {
  return String(value || "").trim();
}

function normalizeIsoTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : "";
}
