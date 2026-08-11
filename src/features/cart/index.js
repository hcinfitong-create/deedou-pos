import {
  configuredCartLineKey,
  defaultConfiguredSelection,
  hasProductOptions,
  optionSummaryLines,
  validateConfiguredSelection
} from "../product-options/index.js";
import { escapeAttr, escapeHtml, formatMoney } from "../../shared/utils/index.js";

export function addCartItem(cart, idOrKey, productById, maxQty = 10, selection = null) {
  const existingLine = findCartLine(cart, idOrKey, productById);
  if (existingLine && !productById(idOrKey)) {
    return incrementCartLine(cart, existingLine, productById, maxQty);
  }

  const item = productById(idOrKey);
  if (!item?.available) return cart;
  const selectedOptions = selection || defaultConfiguredSelection(item);
  const configured = validateConfiguredSelection(item, selectedOptions);
  if (!configured.ok) return cart;
  const key = configured.configuredKey;
  const existing = findCartLine(cart, key, productById);
  if (existing) {
    return incrementCartLine(cart, existing, productById, maxQty);
  }
  const configuredLine = hasProductOptions(item)
    ? { id: item.id, key, selection: configured.selection, qty: 1 }
    : { id: item.id, qty: 1 };
  return [...cart, configuredLine];
}

export function decrementCartItem(cart, idOrKey, productById = null) {
  return cart
    .map((line) => cartLineMatches(line, idOrKey, productById) ? { ...line, qty: line.qty - 1 } : line)
    .filter((line) => line.qty > 0);
}

export function removeCartItem(cart, idOrKey, productById = null) {
  return cart.filter((line) => !cartLineMatches(line, idOrKey, productById));
}

export function clearCart() {
  return [];
}

export function cartSubtotal(cart, productById) {
  return (cart || []).reduce((sum, line) => {
    const item = productById(line.id);
    if (!item) return sum;
    const configured = validateConfiguredSelection(item, selectionForCartLine(line, item));
    if (!configured.ok) return sum;
    return sum + line.qty * configured.unitPrice;
  }, 0);
}

export function canSubmitCart(cart, productById = null) {
  if (!(cart || []).length) return false;
  if (!productById) return true;
  return cart.every((line) => {
    const item = productById(line.id);
    return !!item?.available && validateConfiguredSelection(item, selectionForCartLine(line, item)).ok;
  });
}

export function renderCartPanel({ table, cart, lang, copy, productById, orderStatusHtml = "" }) {
  const validLines = (cart || []).filter((line) => !!productById(line.id));
  const total = cartSubtotal(validLines, productById);
  return `
    <aside class="panel cart">
      <h2>${copy.cart}</h2>
      <p class="muted">${copy.table} ${table.code} - ${table.zone}</p>
      <div class="cart-list">
        ${validLines.length ? validLines.map((line) => renderCartLine(line, { lang, productById })).join("") : `<div class="empty">${copy.empty}</div>`}
      </div>
      <label>
        <span class="muted">${copy.note}</span>
        <textarea id="note" placeholder="Less spicy, no sugar..."></textarea>
      </label>
      <div class="total"><span>${copy.total}</span><strong>${formatMoney(total)}</strong></div>
      <div class="actions">
        <button class="primary" data-submit="${table.token}" ${canSubmitCart(validLines, productById) ? "" : "disabled"}>${copy.submit}</button>
      </div>
      ${orderStatusHtml}
    </aside>
  `;
}

function renderCartLine(line, { lang, productById }) {
  const item = productById(line.id);
  if (!item) return "";
  const configured = validateConfiguredSelection(item, selectionForCartLine(line, item));
  const price = configured.ok ? configured.unitPrice : Number(item.price) || 0;
  const identity = cartLineIdentity(line, productById);
  const summaries = configured.ok ? optionSummaryLines({ optionSnapshot: {
    variant: configured.variant,
    modifierGroups: configured.modifierGroups
  } }, lang) : [];
  return `
    <div class="cart-line">
      <div>
        <strong>${escapeHtml(item[lang])}</strong>
        ${summaries.map((summary) => `<br><small class="muted">${escapeHtml(summary)}</small>`).join("")}
        <br><span class="muted">${formatMoney(price)}</span>
      </div>
      <div class="qty">
        <button data-dec="${escapeAttr(identity)}">-</button>
        <strong>${line.qty}</strong>
        <button data-inc="${escapeAttr(identity)}">+</button>
        <button data-remove-cart="${escapeAttr(identity)}">Remove</button>
      </div>
    </div>
  `;
}

export function cartLineIdentity(line, productById = null) {
  if (line.key) return line.key;
  const item = typeof productById === "function" ? productById(line.id) : null;
  return item ? configuredCartLineKey(item, selectionForCartLine(line, item)) : line.id;
}

export function selectionForCartLine(line = {}, product = {}) {
  if (line.selection) return line.selection;
  return defaultConfiguredSelection(product);
}

function incrementCartLine(cart, target, productById, maxQty) {
  const identity = cartLineIdentity(target, productById);
  return cart.map((line) => {
    if (cartLineIdentity(line, productById) !== identity) return line;
    return { ...line, qty: Math.min(maxQty, line.qty + 1) };
  });
}

function findCartLine(cart = [], idOrKey, productById = null) {
  return (cart || []).find((line) => cartLineMatches(line, idOrKey, productById)) || null;
}

function cartLineMatches(line, idOrKey, productById = null) {
  return line.id === idOrKey || cartLineIdentity(line, productById) === idOrKey;
}
