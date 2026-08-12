import test from "node:test";
import assert from "node:assert/strict";

import {
  allocateTableTender,
  canEditBill,
  canVoidOrder,
  createEqualSplitPlan,
  normalizePaymentLedger,
  PAYMENT_STATUSES,
  parsePositiveIntegerVnd,
  paymentHistoryView,
  paymentSummaryForOrder,
  paymentSummaryForOrders,
  recordPayment,
  recordPaymentVoid,
  recordRefund,
  remainingRefundableForPayment,
  syncPaidProjection
} from "../src/features/payments/index.js";

function order(overrides = {}) {
  return {
    id: "O1",
    orderNo: "D01-0001",
    status: "ACCEPTED",
    total: 100000,
    paidVnd: 0,
    payments: [],
    items: [{
      lineId: "line-1",
      nameVi: "Ca phe sua",
      qty: 1,
      servedQty: 0,
      billQty: 1,
      price: 100000,
      prepStatus: "QUEUED",
      status: "QUEUED",
      isBillable: true,
      isServiceable: true
    }],
    ...overrides
  };
}

test("normalizes legacy payments, refunds, and paidVnd-only orders into ledger transactions", () => {
  const legacyRefund = normalizePaymentLedger({
    id: "O-legacy",
    total: 100000,
    payments: [
      { id: "PAY-1", method: "cash", amountVnd: 100000, status: "SUCCEEDED", paidAt: "2026-08-12T01:00:00.000Z" },
      { id: "REF-1", method: "REFUND", amountVnd: 25000, status: "SUCCEEDED", relatedPaymentId: "PAY-1" }
    ]
  });

  assert.deepEqual(legacyRefund.map((transaction) => [transaction.id, transaction.type, transaction.amountVnd, transaction.relatedPaymentId]), [
    ["PAY-1", "PAYMENT", 100000, ""],
    ["REF-1", "REFUND", 25000, "PAY-1"]
  ]);

  const paidOnly = normalizePaymentLedger({ id: "O-paid", paidVnd: 50000, payments: [] }, { now: "2026-08-12T02:00:00.000Z" });
  assert.equal(paidOnly.length, 1);
  assert.equal(paidOnly[0].id, "LEGACY-PAID-O-paid");
  assert.equal(paidOnly[0].amountVnd, 50000);
});

test("positive integer VND parsing rejects malformed UI money inputs without sanitizing", () => {
  const invalidValues = [100.5, "100.5", "-100", "abc100", NaN, Infinity, 0, -100, "0", "", "00100"];

  invalidValues.forEach((value) => {
    assert.equal(parsePositiveIntegerVnd(value), null, String(value));
  });

  assert.equal(parsePositiveIntegerVnd(100), 100);
  assert.equal(parsePositiveIntegerVnd("100"), 100);
  assert.equal(parsePositiveIntegerVnd(" 100 "), 100);
});

test("payment domain rejects malformed integer VND amounts without mutation", () => {
  const invalidValues = [100.5, "100.5", "-100", "abc100", NaN, Infinity, 0, -100];

  invalidValues.forEach((amountVnd, index) => {
    const target = order();
    const before = structuredClone(target);
    const result = recordPayment(target, { id: `PAY-BAD-${index}`, amountVnd });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "INVALID_PAYMENT_AMOUNT");
    assert.deepEqual(target, before);
  });

  const split = createEqualSplitPlan("100.5", 2);
  assert.equal(split.ok, false);
  assert.equal(split.reason, "INVALID_SPLIT_AMOUNT");

  const allocation = allocateTableTender([order()], { amountVnd: "abc100" });
  assert.equal(allocation.ok, false);
  assert.equal(allocation.reason, "INVALID_TENDER_AMOUNT");
});

test("partial and mixed tender payments derive status and paidVnd from ledger", () => {
  const target = order({ total: 200000 });

  const first = recordPayment(target, { id: "PAY-CASH", method: "CASH", amountVnd: 75000, now: "2026-08-12T01:00:00.000Z" });
  assert.equal(first.ok, true);
  assert.equal(target.paymentStatus, PAYMENT_STATUSES.PARTIALLY_PAID);
  assert.equal(target.paidVnd, 75000);
  assert.equal(target.status, "ACCEPTED");

  const second = recordPayment(target, { id: "PAY-CARD", method: "CARD_EXTERNAL_TERMINAL", amountVnd: 125000, now: "2026-08-12T01:05:00.000Z" });
  assert.equal(second.ok, true);
  assert.equal(paymentSummaryForOrder(target).paymentStatus, PAYMENT_STATUSES.PAID);
  assert.equal(target.paidVnd, 200000);
  assert.equal(target.status, "ACCEPTED");
});

test("duplicate payment transaction ids are deterministic non-mutating no-ops", () => {
  const target = order();
  recordPayment(target, { id: "PAY-1", method: "CASH", amountVnd: 50000, now: "2026-08-12T01:00:00.000Z" });
  const before = structuredClone(target);

  const duplicate = recordPayment(target, { id: "PAY-1", method: "CARD", amountVnd: 50000, now: "2026-08-12T02:00:00.000Z" });

  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.noOp, true);
  assert.equal(duplicate.reason, "DUPLICATE_TRANSACTION_ID");
  assert.deepEqual(target, before);
});

test("fully paid order stays operational until service is complete", () => {
  const target = order({ status: "IN_PREPARATION", total: 100000 });
  recordPayment(target, { id: "PAY-1", method: "VNPAY", amountVnd: 100000, now: "2026-08-12T01:00:00.000Z" });

  assert.equal(target.paymentStatus, PAYMENT_STATUSES.PAID);
  assert.equal(target.paidVnd, 100000);
  assert.equal(target.status, "IN_PREPARATION");
  assert.equal(target.items[0].prepStatus, "QUEUED");
  assert.equal(target.items[0].servedQty, 0);
  assert.equal(target.items[0].billQty, 1);

  target.status = "SERVED";
  syncPaidProjection(target, { serviceComplete: true });
  assert.equal(target.status, "PAID");
});

test("bill and order void are locked after any effective payment", () => {
  const target = order();
  assert.equal(canEditBill(target).ok, true);
  assert.equal(canVoidOrder(target).ok, true);

  recordPayment(target, { id: "PAY-1", method: "CASH", amountVnd: 1 });

  assert.equal(canEditBill(target).ok, false);
  assert.equal(canEditBill(target).reason, "PAYMENT_EXISTS");
  assert.equal(canVoidOrder(target).ok, false);
});

test("payment void appends a void transaction and unlocks unpaid bill state", () => {
  const target = order({ status: "SERVED" });
  recordPayment(target, { id: "PAY-1", method: "CASH", amountVnd: 100000 });

  const result = recordPaymentVoid(target, { id: "VOID-1", paymentId: "PAY-1" });

  assert.equal(result.ok, true);
  assert.equal(target.payments.length, 2);
  assert.equal(target.payments[1].type, "PAYMENT_VOID");
  const summary = paymentSummaryForOrder(target);
  assert.equal(summary.voidedPaymentVnd, 100000);
  assert.equal(summary.effectivePaidVnd, 0);
  assert.equal(summary.outstandingVnd, 100000);
  assert.equal(canEditBill(target).ok, true);
  assert.equal(target.status, "SERVED");
});

test("refunds target original payments, remain positive, and prevent over-refunds", () => {
  const target = order({ status: "SERVED" });
  recordPayment(target, { id: "PAY-1", method: "CASH", amountVnd: 70000 });
  recordPayment(target, { id: "PAY-2", method: "CARD", amountVnd: 30000 });

  const refund = recordRefund(target, { id: "REF-1", paymentId: "PAY-1", amountVnd: 25000 });

  assert.equal(refund.ok, true);
  assert.equal(target.payments.at(-1).type, "REFUND");
  assert.equal(target.payments.at(-1).amountVnd, 25000);
  assert.equal(target.payments.at(-1).relatedPaymentId, "PAY-1");
  assert.equal(remainingRefundableForPayment(target, "PAY-1"), 45000);
  assert.equal(remainingRefundableForPayment(target, "PAY-2"), 30000);
  assert.equal(paymentSummaryForOrder(target).paymentStatus, PAYMENT_STATUSES.PARTIALLY_REFUNDED);

  const tooMuch = recordRefund(target, { id: "REF-2", paymentId: "PAY-1", amountVnd: 45001 });
  assert.equal(tooMuch.ok, false);
  assert.equal(tooMuch.reason, "REFUND_EXCEEDS_REMAINING");
});

test("refund command rejects unsettled unknown voided duplicate and over-cumulative cases", () => {
  const unsettled = order({ status: "SERVED", total: 100000 });
  recordPayment(unsettled, { id: "PAY-PARTIAL", amountVnd: 50000 });
  const unsettledRefund = recordRefund(unsettled, { id: "REF-PARTIAL", paymentId: "PAY-PARTIAL", amountVnd: 10000 });
  assert.equal(unsettledRefund.ok, false);
  assert.equal(unsettledRefund.reason, "BILL_NOT_SETTLED");

  const target = order({ status: "SERVED", total: 100000 });
  recordPayment(target, { id: "PAY-1", amountVnd: 100000 });

  const unknown = recordRefund(target, { id: "REF-UNKNOWN", paymentId: "PAY-NOPE", amountVnd: 10000 });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "PAYMENT_NOT_FOUND");

  const firstRefund = recordRefund(target, { id: "REF-1", paymentId: "PAY-1", amountVnd: 40000 });
  assert.equal(firstRefund.ok, true);
  const beforeDuplicate = structuredClone(target);
  const duplicate = recordRefund(target, { id: "REF-1", paymentId: "PAY-1", amountVnd: 60000 });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.noOp, true);
  assert.deepEqual(target, beforeDuplicate);

  const excessive = recordRefund(target, { id: "REF-2", paymentId: "PAY-1", amountVnd: 60001 });
  assert.equal(excessive.ok, false);
  assert.equal(excessive.reason, "REFUND_EXCEEDS_REMAINING");

  const voided = order({ status: "SERVED", total: 100000 });
  recordPayment(voided, { id: "PAY-VOID", amountVnd: 50000 });
  recordPayment(voided, { id: "PAY-KEEP", amountVnd: 50000 });
  recordPaymentVoid(voided, { id: "VOID-1", paymentId: "PAY-VOID" });
  recordPayment(voided, { id: "PAY-REPLACE", amountVnd: 50000 });
  const voidedRefund = recordRefund(voided, { id: "REF-VOIDED", paymentId: "PAY-VOID", amountVnd: 10000 });
  assert.equal(voidedRefund.ok, false);
  assert.equal(voidedRefund.reason, "PAYMENT_VOIDED");
});

test("payment void twice and payment void after refund are blocked without mutation", () => {
  const voidTwice = order({ status: "SERVED", total: 100000 });
  recordPayment(voidTwice, { id: "PAY-1", amountVnd: 100000 });
  recordPaymentVoid(voidTwice, { id: "VOID-1", paymentId: "PAY-1" });
  const beforeSecondVoid = structuredClone(voidTwice);
  const secondVoid = recordPaymentVoid(voidTwice, { id: "VOID-2", paymentId: "PAY-1" });
  assert.equal(secondVoid.ok, false);
  assert.equal(secondVoid.reason, "PAYMENT_ALREADY_VOIDED");
  assert.deepEqual(voidTwice, beforeSecondVoid);

  const refunded = order({ status: "SERVED", total: 100000 });
  recordPayment(refunded, { id: "PAY-2", amountVnd: 100000 });
  recordRefund(refunded, { id: "REF-1", paymentId: "PAY-2", amountVnd: 10000 });
  const beforeVoidAfterRefund = structuredClone(refunded);
  const voidAfterRefund = recordPaymentVoid(refunded, { id: "VOID-REF", paymentId: "PAY-2" });
  assert.equal(voidAfterRefund.ok, false);
  assert.equal(voidAfterRefund.reason, "PAYMENT_ALREADY_REFUNDED");
  assert.deepEqual(refunded, beforeVoidAfterRefund);
});

test("takeaway orders are independent checks without shared table allocation or sessions", () => {
  const first = order({
    id: "TAKE-1",
    orderNo: "D01-TA1",
    total: 100000,
    serviceMode: "COUNTER_SERVICE",
    fulfillmentType: "TAKEAWAY",
    table: "",
    tableSessionId: ""
  });
  const second = order({
    id: "TAKE-2",
    orderNo: "D01-TA2",
    total: 200000,
    serviceMode: "COUNTER_SERVICE",
    fulfillmentType: "TAKEAWAY",
    table: "",
    tableSessionId: ""
  });
  const beforeSecond = structuredClone(second);

  const result = recordPayment(first, { id: "PAY-TAKE-1", method: "CASH", amountVnd: 100000, tenderGroupId: "ORDER-TAKE-1" });

  assert.equal(result.ok, true);
  assert.equal(paymentSummaryForOrder(first).paymentStatus, PAYMENT_STATUSES.PAID);
  assert.deepEqual(second, beforeSecond);
  assert.equal(first.tableSessionId, "");
  assert.equal(second.tableSessionId, "");
  assert.equal(first.payments[0].tenderGroupId, "ORDER-TAKE-1");
  assert.equal(second.payments.length, 0);
});

test("equal split plans divide odd VND without recording payments", () => {
  const split = createEqualSplitPlan(100001, 2);

  assert.equal(split.ok, true);
  assert.deepEqual(split.shares, [
    { shareNo: 1, amountVnd: 50001 },
    { shareNo: 2, amountVnd: 50000 }
  ]);
});

test("table tender allocation pays current orders oldest first without mutation", () => {
  const first = order({ id: "O1", orderNo: "D01-0001", total: 100000, createdAt: "2026-08-12T01:00:00.000Z" });
  const second = order({ id: "O2", orderNo: "D01-0002", total: 200000, createdAt: "2026-08-12T01:05:00.000Z" });
  const before = structuredClone([first, second]);

  const allocation = allocateTableTender([second, first], { amountVnd: 150000, tenderGroupId: "TG-1" });

  assert.equal(allocation.ok, true);
  assert.equal(allocation.tenderGroupId, "TG-1");
  assert.deepEqual(allocation.allocations, [
    { orderId: "O1", orderNo: "D01-0001", amountVnd: 100000 },
    { orderId: "O2", orderNo: "D01-0002", amountVnd: 50000 }
  ]);
  assert.deepEqual([first, second], before);
});

test("table tender payments share one tenderGroupId across allocated orders", () => {
  const first = order({ id: "O1", orderNo: "D01-0001", total: 100000, createdAt: "2026-08-12T01:00:00.000Z" });
  const second = order({ id: "O2", orderNo: "D01-0002", total: 200000, createdAt: "2026-08-12T01:05:00.000Z" });
  const allocation = allocateTableTender([first, second], { amountVnd: 250000, tenderGroupId: "TG-TABLE-A01" });

  allocation.allocations.forEach((entry) => {
    const target = [first, second].find((item) => item.id === entry.orderId);
    recordPayment(target, { id: `PAY-${entry.orderId}`, amountVnd: entry.amountVnd, tenderGroupId: allocation.tenderGroupId });
  });

  assert.equal(first.payments[0].tenderGroupId, "TG-TABLE-A01");
  assert.equal(second.payments[0].tenderGroupId, "TG-TABLE-A01");
  assert.equal(first.payments[0].amountVnd, 100000);
  assert.equal(second.payments[0].amountVnd, 150000);
});

test("paying a current table session order leaves previous closed-session and unrelated orders untouched", () => {
  const previousClosed = order({ id: "OLD", status: "PAID", tableSessionId: "TS-old", total: 100000, payments: [{ id: "PAY-OLD", amountVnd: 100000 }] });
  const current = order({ id: "NEW", status: "SERVED", tableSessionId: "TS-new", total: 100000 });
  const counter = order({ id: "COUNTER", status: "SERVED", serviceMode: "COUNTER_SERVICE", fulfillmentType: "DINE_IN", table: "", tableSessionId: "", total: 50000 });
  const takeaway = order({ id: "TAKE", status: "SERVED", serviceMode: "COUNTER_SERVICE", fulfillmentType: "TAKEAWAY", table: "", tableSessionId: "", total: 50000 });
  const before = structuredClone({ previousClosed, counter, takeaway });

  recordPayment(current, { id: "PAY-NEW", amountVnd: 100000, tenderGroupId: "TG-CURRENT" });

  assert.deepEqual(previousClosed, before.previousClosed);
  assert.deepEqual(counter, before.counter);
  assert.deepEqual(takeaway, before.takeaway);
  assert.equal(current.payments.length, 1);
});

test("malformed legacy payment normalization drops unsafe amounts instead of coercing them", () => {
  const transactions = normalizePaymentLedger({
    id: "LEGACY-BAD",
    paidVnd: "100.5",
    payments: [
      { id: "BAD-DECIMAL", amountVnd: "100.5" },
      { id: "BAD-NEGATIVE", amountVnd: "-100" },
      { id: "BAD-TEXT", amountVnd: "abc100" },
      { id: "BAD-NAN", amountVnd: NaN },
      { id: "GOOD", amountVnd: "100", method: "CASH" },
      { id: "GOOD-REF", type: "REFUND", amountVnd: "25", relatedPaymentId: "GOOD" }
    ]
  });

  assert.deepEqual(transactions.map((transaction) => [transaction.id, transaction.type, transaction.amountVnd]), [
    ["GOOD", "PAYMENT", 100],
    ["GOOD-REF", "REFUND", 25]
  ]);
});

test("closed paid order can refund a specific payment without reopening operational context", () => {
  const target = order({
    status: "PAID",
    total: 100000,
    table: "A01",
    tableSessionId: "TS-closed",
    payments: [{ id: "PAY-1", type: "PAYMENT", method: "CASH", amountVnd: 100000, status: "SUCCEEDED" }]
  });

  const partial = recordRefund(target, { id: "REF-PARTIAL", paymentId: "PAY-1", amountVnd: 40000, serviceComplete: true });
  assert.equal(partial.ok, true);
  assert.equal(target.status, "PAID");
  assert.equal(target.tableSessionId, "TS-closed");
  assert.equal(target.payments.at(-1).relatedPaymentId, "PAY-1");
  assert.equal(paymentSummaryForOrder(target).paymentStatus, PAYMENT_STATUSES.PARTIALLY_REFUNDED);

  const full = recordRefund(target, { id: "REF-FULL", paymentId: "PAY-1", amountVnd: 60000, serviceComplete: true });
  assert.equal(full.ok, true);
  assert.equal(target.status, "REFUNDED");
  assert.equal(target.tableSessionId, "TS-closed");
  assert.equal(paymentSummaryForOrder(target).paymentStatus, PAYMENT_STATUSES.REFUNDED);
});

test("table payment summaries distinguish bill, paid, refunds, net, and outstanding", () => {
  const first = order({ id: "O1", total: 100000, status: "SERVED" });
  const second = order({ id: "O2", total: 200000, status: "SERVED" });
  recordPayment(first, { id: "PAY-1", amountVnd: 100000 });
  recordPayment(second, { id: "PAY-2", amountVnd: 50000 });
  recordRefund(first, { id: "REF-1", paymentId: "PAY-1", amountVnd: 10000 });

  const summary = paymentSummaryForOrders([first, second]);

  assert.equal(summary.billTotalVnd, 300000);
  assert.equal(summary.effectivePaidVnd, 150000);
  assert.equal(summary.refundedVnd, 10000);
  assert.equal(summary.netCollectedVnd, 140000);
  assert.equal(summary.outstandingVnd, 150000);
  assert.equal(summary.paymentStatus, PAYMENT_STATUSES.PARTIALLY_REFUNDED);
});

test("payment history exposes per-payment void/refund state for UI", () => {
  const target = order({ status: "SERVED" });
  recordPayment(target, { id: "PAY-1", method: "CASH", amountVnd: 100000 });
  recordRefund(target, { id: "REF-1", paymentId: "PAY-1", amountVnd: 40000 });

  const history = paymentHistoryView(target);

  assert.equal(history[0].id, "PAY-1");
  assert.equal(history[0].refundedVnd, 40000);
  assert.equal(history[0].refundableVnd, 60000);
  assert.equal(history[1].type, "REFUND");
});

test("payment commands preserve DD-003 through DD-006 operational fields", () => {
  const target = order({
    status: "READY",
    total: 150000,
    items: [{
      lineId: "combo-1",
      qty: 2,
      servedQty: 1,
      billQty: 2,
      price: 75000,
      prepStatus: "READY",
      status: "READY",
      isBillable: true,
      isServiceable: true,
      optionSnapshot: { variant: { vi: "Premium" }, modifierGroups: [{ vi: "Sauce", selectedOptions: [{ vi: "Spicy" }] }] },
      course: "2",
      holdState: "FIRED",
      queuedAt: "2026-08-12T01:00:00.000Z",
      firedAt: "2026-08-12T01:00:00.000Z"
    }]
  });
  const beforeLine = structuredClone(target.items[0]);

  recordPayment(target, { id: "PAY-1", method: "CASH", amountVnd: 150000, now: "2026-08-12T02:00:00.000Z" });

  assert.deepEqual(target.items[0], beforeLine);
  assert.equal(target.status, "READY");
  assert.equal(target.paymentStatus, PAYMENT_STATUSES.PAID);
});
