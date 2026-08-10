import { escapeHtml, formatMoney } from "../../shared/utils/index.js";

export function addCartItem(cart, id, productById, maxQty = 10) {
  const item = productById(id);
  if (!item?.available) return cart;
  const existing = cart.find((line) => line.id === id);
  if (existing) {
    return cart.map((line) => line.id === id ? { ...line, qty: Math.min(maxQty, line.qty + 1) } : line);
  }
  return [...cart, { id, qty: 1 }];
}

export function decrementCartItem(cart, id) {
  return cart
    .map((line) => line.id === id ? { ...line, qty: line.qty - 1 } : line)
    .filter((line) => line.qty > 0);
}

export function removeCartItem(cart, id) {
  return cart.filter((line) => line.id !== id);
}

export function clearCart() {
  return [];
}

export function cartSubtotal(cart, productById) {
  return (cart || []).reduce((sum, line) => {
    const item = productById(line.id);
    if (!item) return sum;
    return sum + line.qty * (Number(item.price) || 0);
  }, 0);
}

export function canSubmitCart(cart, productById = null) {
  if (!(cart || []).length) return false;
  if (!productById) return true;
  return cart.every((line) => !!productById(line.id));
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
  return `
    <div class="cart-line">
      <div><strong>${escapeHtml(item[lang])}</strong><br><span class="muted">${formatMoney(item.price)}</span></div>
      <div class="qty">
        <button data-dec="${item.id}">-</button>
        <strong>${line.qty}</strong>
        <button data-inc="${item.id}">+</button>
      </div>
    </div>
  `;
}
