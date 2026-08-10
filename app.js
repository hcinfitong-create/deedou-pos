import { COUNTER_DRAFT_KEY, COUNTER_SEARCH_KEY, PRODUCT_KEY, STATE_KEY, stationAliases, stations, tables } from "./src/shared/config/index.js";
import { copy } from "./src/shared/i18n/index.js";
import { escapeAttr, escapeHtml, formatMoney, normalizeSearch, slugify } from "./src/shared/utils/index.js";
import { categories, categoryAliases, compareMenuItems, defaultProducts, menuKinds } from "./src/features/customer-menu/index.js";
import { billableTotal, chargedQty, clampBillQty, countPrepItems, countServedItems, countStatusItems, lineSubtotal, normalizeItemStatus, normalizeOrderStatus, recalcOrderTotal, stationStatusFor } from "./src/features/ordering/index.js";
import { addCartItem, canSubmitCart, clearCart, decrementCartItem, removeCartItem, renderCartPanel } from "./src/features/cart/index.js";
import { renderCustomerOrderStatusStrip } from "./src/features/customer-orders/index.js";
import { createServiceRequestEvent, renderCustomerServiceActions } from "./src/features/service-requests/index.js";

let products = loadProducts();
let state = loadState();
let lang = localStorage.getItem("deedou_lang") || "vi";
let activeKind = localStorage.getItem("deedou_kind") || "all";
let activeCategory = "all";
let activeCashierTable = localStorage.getItem("deedou_cashier_table") || tables[0].code;
let counterDraft = loadCounterDraft();
let counterSearch = localStorage.getItem(COUNTER_SEARCH_KEY) || "";
let pendingVoidOrderId = "";

const bus = "BroadcastChannel" in window ? new BroadcastChannel("deedou-pos") : null;
if (bus) {
  bus.onmessage = () => {
    products = loadProducts();
    state = loadState();
    render();
  };
}

window.addEventListener("hashchange", render);
window.addEventListener("storage", () => {
  products = loadProducts();
  state = loadState();
  render();
});
render();

function loadState() {
  const saved = localStorage.getItem(STATE_KEY);
  if (saved) return normalizeState(JSON.parse(saved));
  return { cart: [], orders: [], events: [], audit: [], sequence: 1 };
}

function emptyCounterDraft() {
  return { active: false, table: "", items: [], note: "" };
}

function loadCounterDraft() {
  const saved = localStorage.getItem(COUNTER_DRAFT_KEY);
  if (!saved) return emptyCounterDraft();
  const draft = JSON.parse(saved);
  return { ...emptyCounterDraft(), ...draft, items: draft.items || [] };
}

function saveCounterDraft() {
  localStorage.setItem(COUNTER_DRAFT_KEY, JSON.stringify(counterDraft));
}

function normalizeState(value) {
  return {
    cart: value.cart || [],
    orders: (value.orders || []).map(normalizeOrder),
    events: value.events || [],
    audit: value.audit || [],
    sequence: value.sequence || Math.max(1, (value.orders || []).length + 1)
  };
}

function normalizeOrder(order) {
  const items = (order.items || []).map((line) => {
    const source = products.find((item) => item.id === line.id) || {};
    const station = stationAliases[line.station] || line.station || source.station || "KITCHEN_HOT";
    const qty = Number(line.qty || 1);
    const isComponent = !!line.isComponent;
    const isBillable = line.isBillable ?? !isComponent;
    return {
      id: line.id,
      qty,
      billQty: isBillable ? clampBillQty(line.billQty, qty) : 0,
      station,
      nameVi: line.nameVi || source.vi || line.id,
      nameEn: line.nameEn || source.en || line.id,
      price: line.price || source.price || 0,
      status: normalizeItemStatus(line.status || order.status),
      isComponent,
      isBillable,
      parentComboId: line.parentComboId || ""
    };
  });
  const payments = order.payments || [];
  const paidVnd = payments.length ? payments.filter((payment) => payment.status === "SUCCEEDED").reduce((sum, payment) => sum + payment.amountVnd, 0) : order.paidVnd || 0;
  return {
    ...order,
    orderNo: order.orderNo || order.id || "D01-0000",
    channel: order.channel || "QR",
    status: normalizeOrderStatus(order.status || "PENDING_ACCEPTANCE"),
    items,
    total: billableTotal(items),
    payments,
    paidVnd,
    stationStatus: order.stationStatus || stationStatusFor(items, order.status || "PENDING_ACCEPTANCE")
  };
}

function loadProducts() {
  const saved = localStorage.getItem(PRODUCT_KEY);
  if (saved) return JSON.parse(saved).map(normalizeProduct);
  const oldAvailability = localStorage.getItem("deedou_products");
  if (oldAvailability) {
    const map = JSON.parse(oldAvailability);
    return defaultProducts.map((item) => normalizeProduct({ ...item, available: map[item.id] ?? item.available }));
  }
  return structuredClone(defaultProducts).map(normalizeProduct);
}

function normalizeProduct(item) {
  const base = defaultProducts.find((defaultItem) => defaultItem.id === item.id);
  const category = categoryAliases[item.category] || item.category;
  const categoryInfo = categories.find((cat) => cat.id === category);
  const kind = categoryInfo?.kind || item.kind || "FOOD";
  const oldBroadStation = ["BAR", "KITCHEN"].includes(item.station);
  const station = oldBroadStation && base?.station ? base.station : stationAliases[item.station] || item.station || base?.station || (kind === "DRINK" ? "BAR" : "KITCHEN_HOT");
  const components = item.components?.length ? item.components : base?.components || [];
  return {
    ...item,
    category,
    kind,
    station,
    components,
    periods: item.periods?.length ? item.periods : categoryInfo?.periods || ["morning", "afternoon", "evening"]
  };
}

function saveProducts() {
  localStorage.setItem(PRODUCT_KEY, JSON.stringify(products));
  broadcast();
}

function saveState() {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  broadcast();
}

function broadcast() {
  if (bus) bus.postMessage({ type: "sync", at: Date.now() });
}

function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);
  if (!parts.length) return { name: "customer", token: tables[0].token };
  if (["staff", "cashier", "bar", "kitchen", "dessert", "admin"].includes(parts[0])) return { name: parts[0] };
  if (parts[0] === "t") return { name: "customer", token: parts[1] || tables[0].token };
  return { name: "customer", token: tables[0].token };
}

function render() {
  const current = route();
  document.getElementById("app").innerHTML = shell(current);
  if (current.name === "customer") bindCustomer(current.token);
  if (current.name === "staff") bindStaff();
  if (current.name === "cashier") bindCashier();
  if (["bar", "kitchen", "dessert"].includes(current.name)) bindStation();
  if (current.name === "admin") bindAdmin();
}

function shell(current) {
  const c = copy[lang];
  const active = current.name;
  return `
    <main class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="mark">DD</div>
          <div><strong>DeeDou</strong><span>QR Ordering POS</span></div>
        </div>
        <nav class="nav">
          <button class="${active === "customer" ? "active" : ""}" data-route="#/t/${tables[0].token}">${c.table} A01</button>
          <button class="${active === "cashier" ? "active" : ""}" data-route="#/cashier">${c.cashier}</button>
          <button class="${active === "staff" ? "active" : ""}" data-route="#/staff">${c.staff}</button>
          <button class="${active === "bar" ? "active" : ""}" data-route="#/bar">${c.bar}</button>
          <button class="${active === "kitchen" ? "active" : ""}" data-route="#/kitchen">${c.kitchen}</button>
          <button class="${active === "dessert" ? "active" : ""}" data-route="#/dessert">${c.dessert}</button>
          <button class="${active === "admin" ? "active" : ""}" data-route="#/admin">${c.admin}</button>
          <button data-lang="vi" class="${lang === "vi" ? "active" : ""}">VI</button>
          <button data-lang="en" class="${lang === "en" ? "active" : ""}">EN</button>
        </nav>
      </header>
      ${pageFor(active, current)}
    </main>
  `;
}

function pageFor(active, current) {
  if (active === "customer") return customerPage(current.token);
  if (active === "cashier") return cashierPage();
  if (active === "staff") return staffPage();
  if (active === "bar") return stationPage("BAR");
  if (active === "kitchen") return stationPage("KITCHEN");
  if (active === "dessert") return stationPage("DESSERT");
  return adminPage();
}

function customerPage(token) {
  const table = tables.find((item) => item.token === token) || tables[0];
  const c = copy[lang];
  const period = currentPeriod();
  const visibleCategories = categories.filter((cat) => activeKind === "all" || cat.kind === activeKind);
  if (activeCategory !== "all" && !visibleCategories.some((cat) => cat.id === activeCategory)) activeCategory = "all";
  const categoryIds = visibleCategories.map((cat) => cat.id);
  const filtered = products.filter((item) => {
    const kindMatch = activeKind === "all" || item.kind === activeKind;
    const inPeriod = (item.periods || []).includes(period) || categoryIds.includes(item.category);
    return kindMatch && inPeriod && (activeCategory === "all" || item.category === activeCategory);
  }).sort(compareMenuItems);

  return `
    <section class="page customer-grid">
      <div class="menu-area">
        <section class="hero">
          <div class="hero-copy">
            <div class="kicker">${c.tagline} - ${c.table} ${table.code}</div>
            <h1>${c.title}</h1>
            <p>${c.intro}</p>
            ${renderCustomerServiceActions(c)}
          </div>
          <div class="hero-media" aria-hidden="true"></div>
        </section>
        <div class="menu-filter">
          <div class="tabs main-tabs" aria-label="Menu lớn">
            ${menuKinds.map((kind) => `<button class="tab main-tab ${activeKind === kind.id ? "active" : ""}" data-kind="${kind.id}">${kind[lang]}</button>`).join("")}
          </div>
          <div class="tabs sub-tabs" aria-label="Nhóm món">
            <button class="tab ${activeCategory === "all" ? "active" : ""}" data-cat="all">${activeKind === "FOOD" ? (lang === "vi" ? "Tất cả món ăn" : "All food") : activeKind === "DRINK" ? (lang === "vi" ? "Tất cả đồ uống" : "All drinks") : c.all}</button>
            ${visibleCategories.map((cat) => `<button class="tab ${activeCategory === cat.id ? "active" : ""}" data-cat="${cat.id}">${cat[lang]}</button>`).join("")}
          </div>
        </div>
        ${menuContent(filtered, visibleCategories)}
      </div>
      ${renderCartPanel({
        table,
        cart: state.cart,
        lang,
        copy: c,
        productById,
        orderStatusHtml: renderCustomerOrderStatusStrip({ orders: state.orders, tableCode: table.code, lang, copy })
      })}
    </section>
  `;
}

function menuContent(items, visibleCategories) {
  if (!items.length && activeKind === "all") return `<div class="menu-grid"><div class="empty">Admin chưa bật món cho khung giờ này.</div></div>`;
  if (activeCategory !== "all") return `<div class="menu-grid">${items.map(itemCard).join("")}</div>`;
  const sectionCategories = activeKind === "all" ? visibleCategories.filter((cat) => items.some((item) => item.category === cat.id)) : visibleCategories;
  return sectionCategories.map((cat) => `
    <section class="menu-section">
      <div class="section-title">
        <h2>${cat[lang]}</h2>
        <span class="muted">${cat.kind === "FOOD" ? (lang === "vi" ? "Đồ ăn" : "Food") : (lang === "vi" ? "Đồ uống" : "Drinks")}</span>
      </div>
      <div class="menu-grid">
        ${items.filter((item) => item.category === cat.id).map(itemCard).join("") || `<div class="empty">${lang === "vi" ? "Chưa phục vụ trong khung giờ này." : "Not served in this service period."}</div>`}
      </div>
    </section>
  `).join("");
}

function itemCard(item) {
  const c = copy[lang];
  return `
    <article class="item-card ${item.available ? "" : "sold-out"}">
      ${productVisual(item)}
      <div class="item-body">
        <div>
          <h3>${escapeHtml(item[lang])}</h3>
          <p>${escapeHtml(lang === "vi" ? item.descVi : item.descEn)}</p>
        </div>
        <div class="split-actions">
          <span class="station">${item.kind === "DRINK" ? "DRINK" : "FOOD"}</span>
          <span class="station">${item.station}</span>
        </div>
        <div class="price-row">
          <span class="price">${formatMoney(item.price)}</span>
          <button class="add-btn" data-add="${item.id}" ${item.available ? "" : "disabled"}>${item.available ? c.add : c.soldOut}</button>
        </div>
      </div>
    </article>
  `;
}

function productVisual(item) {
  if (item.image) return `<img class="food-image" src="${item.image}" alt="${escapeHtml(item.en)}" />`;
  return `<div class="food-art" style="--art:${item.color || "#dcefe5"}">${artSvg(item.art || "plate")}</div>`;
}

function staffPage() {
  const columns = ["PENDING_ACCEPTANCE", "ACCEPTED", "IN_PREPARATION", "READY", "SERVED"];
  const total = state.orders.filter((order) => order.status !== "REJECTED").reduce((sum, order) => sum + order.total, 0);
  return `
    <section class="page">
      <div class="summary-row">
        <div class="metric"><span class="muted">New orders</span><strong>${state.orders.filter((o) => o.status === "PENDING").length}</strong></div>
        <div class="metric"><span class="muted">Open tables</span><strong>${new Set(state.orders.filter((o) => !["PAID", "REJECTED"].includes(o.status)).map((o) => o.table)).size}</strong></div>
        <div class="metric"><span class="muted">Service requests</span><strong>${state.events.filter((e) => !e.done).length}</strong></div>
        <div class="metric"><span class="muted">Today total</span><strong>${formatMoney(total)}</strong></div>
      </div>
      <div class="board staff-board">
        ${columns.map((status) => `
          <section class="column">
            <h2>${status}</h2>
            ${state.orders.filter((order) => order.status === status).map(orderCard).join("") || `<div class="empty">No orders</div>`}
          </section>
        `).join("")}
      </div>
      <section class="panel section-pad">
        <h2>Waiter and payment requests</h2>
        <div class="cart-list">
          ${state.events.slice().reverse().map(eventCard).join("") || `<div class="empty">No requests</div>`}
        </div>
      </section>
    </section>
  `;
}

function cashierPage() {
  const openOrders = state.orders.filter((order) => !["PAID", "REJECTED", "VOIDED"].includes(order.status));
  const openTables = tables.filter((table) => tableOrders(table.code).length);
  if (!tables.some((table) => table.code === activeCashierTable) && activeCashierTable !== "TAKEAWAY") activeCashierTable = tables[0].code;
  const selectedOrders = tableOrders(activeCashierTable);
  const selectedTable = tables.find((table) => table.code === activeCashierTable) || { code: activeCashierTable, zone: "Takeaway" };
  const paidOrders = state.orders.filter((order) => ["PAID", "VOIDED"].includes(order.status)).slice(-6).reverse();
  const total = state.orders.filter((order) => order.status !== "REJECTED").reduce((sum, order) => sum + order.total, 0);
  return `
    <section class="page admin-page">
      <div class="ops-head">
        <div>
          <div class="kicker">Cashier POS</div>
          <h1>Thu ngân DeeDou</h1>
          <p class="muted">Nhận QR order, gọi món tại quầy, đối soát phục vụ, in tạm tính, split bill và ghi nhận thanh toán Cash/Card/VNPAY/MoMo/ZaloPay.</p>
        </div>
        <button class="primary" data-counter-open="TAKEAWAY">Gọi món mang đi</button>
      </div>
      <div class="summary-row">
        <div class="metric"><span class="muted">QR pending</span><strong>${state.orders.filter((o) => o.status === "PENDING_ACCEPTANCE").length}</strong></div>
        <div class="metric"><span class="muted">Open tables</span><strong>${openTables.length}</strong></div>
        <div class="metric"><span class="muted">Order batches</span><strong>${openOrders.length}</strong></div>
        <div class="metric"><span class="muted">Paid today</span><strong>${state.orders.filter((o) => o.status === "PAID").length}</strong></div>
        <div class="metric"><span class="muted">Gross</span><strong>${formatMoney(total)}</strong></div>
      </div>
      <div class="cashier-layout">
        <section class="panel section-pad">
          <h2>Sơ đồ bàn</h2>
          <div class="zone-map">
            ${zoneNames().map((zone) => `
              <section class="zone-section">
                <div class="zone-title">${zoneLabel(zone)}</div>
                <div class="table-map">
                  ${tables.filter((table) => table.zone === zone).map(tableTile).join("")}
                </div>
              </section>
            `).join("")}
          </div>
        </section>
        <section class="panel section-pad">
          ${cashierTableDetail(selectedTable, selectedOrders)}
        </section>
      </div>
      <section class="panel section-pad">
        <h2>Order đã đóng gần đây</h2>
        <div class="cashier-orders compact-list">
          ${paidOrders.map((order) => `<div class="status-pill"><span>${order.orderNo} - Table ${order.table} - ${order.status}</span><strong>${formatMoney(order.total)}</strong></div>`).join("") || `<div class="empty">Chưa có lịch sử đóng order.</div>`}
        </div>
      </section>
      <section class="panel section-pad">
        <h2>Audit history</h2>
        <div class="audit-list">
          ${state.audit.slice(-14).reverse().map((log) => `<div class="status-pill"><span>${log.type}: ${escapeHtml(log.detail)}</span><strong>${log.time}</strong></div>`).join("") || `<div class="empty">Chưa có audit.</div>`}
        </div>
      </section>
    </section>
  `;
}

function tableTile(table) {
  const orders = tableOrders(table.code);
  const total = orders.reduce((sum, order) => sum + order.total - (order.paidVnd || 0), 0);
  const served = countServedItems(orders);
  const totalItems = countPrepItems(orders);
  return `
    <button class="table-tile ${orders.length ? "busy" : ""} ${activeCashierTable === table.code ? "selected" : ""}" data-select-table="${table.code}">
      <strong>${table.code}</strong>
      <span>${zoneLabel(table.zone)}</span>
      <small>${orders.length ? `${orders.length} batch - ${formatMoney(total)}` : "Trống"}</small>
      ${orders.length ? `<small>${served}/${totalItems} món đã phục vụ</small>` : ""}
    </button>
  `;
}

function cashierTableDetail(table, orders) {
  const balance = orders.reduce((sum, order) => sum + order.total - (order.paidVnd || 0), 0);
  const served = countServedItems(orders);
  const ready = countStatusItems(orders, "READY");
  const preparing = countStatusItems(orders, "PREPARING") + countStatusItems(orders, "ACKNOWLEDGED") + countStatusItems(orders, "QUEUED");
  return `
    <div class="order-head table-detail-head">
      <div>
        <h2>Chi tiết bàn ${table.code}</h2>
        <p class="muted">${zoneLabel(table.zone)} - ${orders.length ? "Đang có khách" : "Chưa mở bàn"}</p>
      </div>
      <button class="primary" data-counter-open="${table.code}">Gọi món tại quầy</button>
    </div>
    <div class="reconcile-grid">
      <div class="metric"><span class="muted">Order batches</span><strong>${orders.length}</strong></div>
      <div class="metric"><span class="muted">Đã phục vụ</span><strong>${served}</strong></div>
      <div class="metric"><span class="muted">Đang chờ/bếp</span><strong>${preparing}</strong></div>
      <div class="metric"><span class="muted">Sẵn sàng</span><strong>${ready}</strong></div>
      <div class="metric"><span class="muted">Còn phải thu</span><strong>${formatMoney(balance)}</strong></div>
    </div>
    ${counterDraft.active && counterDraft.table === table.code ? counterOrderPanel(table) : ""}
    <div class="cashier-orders">
      ${orders.map(cashierOrderCard).join("") || `<div class="empty">Bàn này chưa có order. Bấm “Gọi món tại quầy” nếu khách gọi trực tiếp, hoặc chờ khách QR order.</div>`}
    </div>
    ${orders.length ? tablePaymentPanel(table, orders, balance) : ""}
  `;
}

function tablePaymentPanel(table, orders, balance) {
  const total = orders.reduce((sum, order) => sum + order.total, 0);
  const paid = orders.reduce((sum, order) => sum + (order.paidVnd || 0), 0);
  return `
    <section class="table-payment-panel">
      <div class="order-head">
        <div>
          <h2>Thanh toán bàn ${table.code}</h2>
          <p class="muted">${orders.length} lượt gọi món - Tổng bill ${formatMoney(total)}</p>
        </div>
        <strong>${formatMoney(balance)}</strong>
      </div>
      <div class="reconcile-grid payment-summary">
        <div class="metric"><span class="muted">Tổng bill</span><strong>${formatMoney(total)}</strong></div>
        <div class="metric"><span class="muted">Đã thu</span><strong>${formatMoney(paid)}</strong></div>
        <div class="metric"><span class="muted">Còn phải thu</span><strong>${formatMoney(balance)}</strong></div>
      </div>
      <div class="split-actions table-payment-actions">
        <button class="ghost" data-table-prebill="${table.code}">Pre-bill</button>
        <button class="primary" data-table-pay="${table.code}" data-method="CASH">Cash</button>
        <button class="primary" data-table-pay="${table.code}" data-method="CARD_EXTERNAL_TERMINAL">Card</button>
        <button class="ghost" data-table-pay="${table.code}" data-method="VNPAY">VNPAY</button>
        <button class="ghost" data-table-pay="${table.code}" data-method="MOMO">MoMo</button>
        <button class="ghost" data-table-pay="${table.code}" data-method="ZALOPAY">ZaloPay</button>
        <button class="ghost" data-table-split="${table.code}">Split 2</button>
        <button class="danger" data-table-void="${table.code}">Void bill</button>
        ${paid > 0 ? `<button class="danger" data-table-refund="${table.code}">Refund</button>` : ""}
      </div>
    </section>
  `;
}

function counterOrderPanel(table) {
  const draftLines = counterDraft.items || [];
  const total = draftLines.reduce((sum, line) => sum + line.qty * productById(line.id).price, 0);
  const query = normalizeSearch(counterSearch);
  const availableProducts = products.filter((item) => item.available && matchesCounterSearch(item, query)).sort(compareMenuItems);
  return `
    <section class="counter-panel">
      <div class="order-head">
        <div>
          <h2>Gọi món tại quầy - ${table.code}</h2>
          <p class="muted">Thu ngân chọn món, khách kiểm tra lại, rồi bấm xác nhận để gửi Bar/Bếp.</p>
        </div>
        <button class="ghost" data-counter-cancel>Hủy</button>
      </div>
      <div class="counter-search-row">
        <label>
          <span class="muted">Tìm món nhanh</span>
          <input id="counter-search" value="${escapeAttr(counterSearch)}" placeholder="Nhập tên món, ví dụ: cà phê, trà xoài, BBQ..." autocomplete="off" />
        </label>
      </div>
      <div class="counter-layout">
        <div class="counter-menu">
          ${categories.map((cat) => {
            const categoryItems = availableProducts.filter((item) => item.category === cat.id);
            if (!categoryItems.length) return "";
            return `
              <section class="counter-category">
                <h3>${cat.vi}</h3>
                <div class="counter-product-grid">
                  ${categoryItems.map(counterProductButton).join("")}
                </div>
              </section>
            `;
          }).join("") || `<div class="empty">Không tìm thấy món phù hợp.</div>`}
        </div>
        <aside class="counter-cart">
          <h3>Phiếu tạm</h3>
          <div class="cart-list">
            ${draftLines.length ? draftLines.map(counterDraftLine).join("") : `<div class="empty">Chưa chọn món.</div>`}
          </div>
          <label>
            <span class="muted">Ghi chú lượt gọi món</span>
            <textarea id="counter-note">${escapeHtml(counterDraft.note || "")}</textarea>
          </label>
          <div class="total"><span>Tổng tạm</span><strong>${formatMoney(total)}</strong></div>
          <div class="split-actions">
            <button class="primary" data-counter-submit ${draftLines.length ? "" : "disabled"}>Khách xác nhận - Gửi bếp/bar</button>
          </div>
        </aside>
      </div>
    </section>
  `;
}

function counterProductButton(item) {
  return `
    <button class="counter-product" data-counter-add="${item.id}">
      <strong>${escapeHtml(item.vi)}</strong>
      <span>${formatMoney(item.price)}</span>
      <small>${item.station}</small>
    </button>
  `;
}

function counterDraftLine(line) {
  const item = productById(line.id);
  return `
    <div class="cart-line">
      <div><strong>${escapeHtml(item.vi)}</strong><br><span class="muted">${formatMoney(item.price)}</span></div>
      <div class="qty">
        <button data-counter-dec="${item.id}">-</button>
        <strong>${line.qty}</strong>
        <button data-counter-inc="${item.id}">+</button>
      </div>
    </div>
  `;
}

function cashierOrderCard(order) {
  const served = countServedItems([order]);
  const totalItems = countPrepItems([order]);
  const billableItems = order.items.map((line, index) => ({ line, index })).filter((item) => item.line.isBillable);
  return `
    <article class="order-card cashier-card compact-batch">
      <div class="order-head">
        <strong>${order.orderNo} - ${order.channel}</strong>
        <span class="station">${order.status}</span>
      </div>
      <div class="batch-meta">
        <span>Đối soát phục vụ</span>
        <strong>${served}/${totalItems} món</strong>
        <strong>${formatMoney(order.total)}</strong>
      </div>
      <ul class="item-list compact-items">
        ${billableItems.map(({ line, index }) => cashierBillLine(order, line, index)).join("") || `<li class="muted">Chưa có món trong batch này.</li>`}
      </ul>
      ${pendingVoidOrderId === order.id ? `
        <div class="void-confirm">
          <label>
            <span class="muted">Lý do hủy lượt gọi</span>
            <input data-void-reason="${order.id}" value="Khách đổi món hoặc thu ngân nhập sai" />
          </label>
          <div class="split-actions compact-actions">
            <button class="danger compact" data-void-confirm="${order.id}">Xác nhận hủy</button>
            <button class="ghost compact" data-void-cancel>Giữ lại</button>
          </div>
        </div>
      ` : `
        <div class="split-actions compact-actions">
          ${order.status === "PENDING_ACCEPTANCE" ? `<button class="primary compact" data-order="${order.id}" data-status="ACCEPTED">Accept QR</button><button class="danger compact" data-order="${order.id}" data-status="REJECTED">Reject</button>` : ""}
          <button class="danger compact" data-void="${order.id}">Hủy lượt gọi</button>
        </div>
      `}
    </article>
  `;
}

function cashierBillLine(order, line, index) {
  const billQty = chargedQty(line);
  const returnedQty = Math.max(0, line.qty - billQty);
  return `
    <li class="bill-adjust-line">
      <div class="bill-item-main">
        <span>${line.qty} x ${escapeHtml(line.nameVi)}</span>
        <small class="muted">${returnedQty ? `Tính tiền ${billQty}/${line.qty} - trả ${returnedQty}` : `Tính tiền đủ ${billQty}/${line.qty}`}</small>
      </div>
      <span class="station">${line.status}</span>
      <div class="bill-qty-control" aria-label="Điều chỉnh số lượng tính tiền">
        <button class="ghost compact" data-bill-dec="${order.id}" data-line-index="${index}" ${billQty <= 0 ? "disabled" : ""}>-</button>
        <strong>${billQty}</strong>
        <button class="ghost compact" data-bill-inc="${order.id}" data-line-index="${index}" ${billQty >= line.qty ? "disabled" : ""}>+</button>
      </div>
      <strong>${formatMoney(lineSubtotal(line))}</strong>
    </li>
  `;
}

function orderCard(order) {
  return `
    <article class="order-card">
      <div class="order-head"><strong>${order.orderNo} - Table ${order.table}</strong><span class="muted">${order.time}</span></div>
      <ul class="item-list">
        ${order.items.map((line) => `<li class="${line.isComponent ? "component-line" : ""}">${line.isComponent ? "-> " : ""}${line.qty} x ${escapeHtml(line.nameEn)} <span class="station">${line.station}</span> <span class="station">${line.status}</span></li>`).join("")}
      </ul>
      ${order.note ? `<p class="muted">Note: ${escapeHtml(order.note)}</p>` : ""}
      <div class="station-grid">${Object.entries(order.stationStatus || {}).map(([station, status]) => `<span class="status-pill"><span>${station}</span><strong>${status}</strong></span>`).join("")}</div>
      <strong>${formatMoney(order.total)}</strong>
      <div class="split-actions">
        ${order.status === "PENDING_ACCEPTANCE" ? `<button class="primary" data-order="${order.id}" data-status="ACCEPTED">Accept</button><button class="danger" data-order="${order.id}" data-status="REJECTED">Reject</button>` : ""}
        ${order.status === "ACCEPTED" ? `<button class="primary" data-order="${order.id}" data-status="IN_PREPARATION">Send to prep</button>` : ""}
        ${order.status === "READY" ? `<button class="primary" data-order="${order.id}" data-status="SERVED">Served</button>` : ""}
        ${order.status === "SERVED" ? `<button class="primary" data-order="${order.id}" data-status="PAID">Paid and close</button>` : ""}
      </div>
    </article>
  `;
}

function eventCard(event) {
  return `
    <div class="status-pill ${event.done ? "done" : ""}">
      <span>${event.type.replace("_", " ")} - Table ${event.table}</span>
      <div class="split-actions">
        <strong>${event.time}</strong>
        ${event.done ? "" : `<button class="ghost compact" data-event="${event.id}">Done</button>`}
      </div>
    </div>
  `;
}

function stationPage(stationGroup) {
  const groupStations = stations.filter((station) => station.group === stationGroup).map((station) => station.code);
  const relevant = state.orders.filter((order) => {
    return groupStations.some((station) => {
      const stationState = order.stationStatus?.[station];
      return stationState && stationState !== "READY";
    }) && !["READY", "SERVED", "PAID", "REJECTED", "VOIDED"].includes(order.status);
  });
  return `
    <section class="page">
      <div class="ops-head">
        <div>
          <div class="kicker">${stationGroup} display</div>
          <h1>${stationGroup === "BAR" ? "Bar drinks queue" : stationGroup === "DESSERT" ? "Dessert queue" : "Kitchen queue"}</h1>
          <p class="muted">Only accepted orders appear here. Combo items are exploded into station-level tickets.</p>
        </div>
        <button class="ghost" data-route="#/staff">Back to staff</button>
      </div>
      <div class="station-board">
        ${relevant.map((order) => stationTicket(order, stationGroup, groupStations)).join("") || `<div class="empty">No active ${stationGroup.toLowerCase()} tickets.</div>`}
      </div>
    </section>
  `;
}

function stationTicket(order, stationGroup, groupStations) {
  const stationItems = order.items.filter((item) => groupStations.includes(item.station));
  const activeStatuses = stationItems.map((item) => item.status);
  const status = activeStatuses.includes("PREPARING") ? "PREPARING" : activeStatuses.includes("ACKNOWLEDGED") ? "ACKNOWLEDGED" : "QUEUED";
  return `
    <article class="order-card ticket">
      <div class="order-head"><strong>${order.orderNo} - Table ${order.table}</strong><span class="station">${status}</span></div>
      <ul class="item-list">
        ${stationItems.map((line) => `<li><strong>${line.qty} x ${escapeHtml(line.nameVi)}</strong> <span class="station">${line.station}</span><br><span class="muted">${escapeHtml(line.nameEn)} - ${line.status}</span></li>`).join("")}
      </ul>
      ${order.note ? `<p class="muted">Note: ${escapeHtml(order.note)}</p>` : ""}
      <div class="split-actions">
        ${status === "QUEUED" ? `<button class="primary" data-station-order="${order.id}" data-station-group="${stationGroup}" data-station-status="ACKNOWLEDGED">Acknowledge</button>` : ""}
        ${status === "ACKNOWLEDGED" ? `<button class="primary" data-station-order="${order.id}" data-station-group="${stationGroup}" data-station-status="PREPARING">Start</button>` : ""}
        ${status === "PREPARING" ? `<button class="primary" data-station-order="${order.id}" data-station-group="${stationGroup}" data-station-status="READY">Ready</button>` : ""}
      </div>
    </article>
  `;
}

function adminPage() {
  const origin = location.href.split("#")[0];
  return `
    <section class="page admin-page">
      <div class="ops-head">
        <div>
          <div class="kicker">Admin control center</div>
          <h1>DeeDou POS setup</h1>
          <p class="muted">Quản lý món ăn, đồ uống, hình ảnh, mô tả, khu chế biến, bàn QR và tình trạng bán trong một nơi.</p>
        </div>
        <button class="danger" data-reset>Reset demo data</button>
      </div>
      <div class="admin-layout">
        <section class="panel section-pad">
          <h2 id="form-title">Thêm món ăn / đồ uống</h2>
          ${productForm()}
        </section>
        <section class="panel section-pad">
          <div class="order-head">
            <h2>Menu hiện tại</h2>
            <button class="ghost" data-new-product>Món mới</button>
          </div>
          <div class="admin-menu-list">
            ${products.map(adminProductRow).join("")}
          </div>
        </section>
      </div>
      <section class="panel section-pad">
        <h2>QR bàn</h2>
        <div class="admin-grid">
          ${tables.map((table) => {
            const link = `${origin}#/t/${table.token}`;
            const qr = `https://api.qrserver.com/v1/create-qr-code/?size=420x420&data=${encodeURIComponent(link)}`;
            return `<article class="qr-card">
              <img src="${qr}" alt="QR for table ${table.code}" />
              <h3>${table.code}</h3>
              <p class="muted">${table.zone}</p>
              <button class="ghost" data-copy="${link}">Copy link</button>
            </article>`;
          }).join("")}
        </div>
      </section>
    </section>
  `;
}

function productForm(item = {}) {
  const selectedPeriods = item.periods || ["morning", "afternoon", "evening"];
  return `
    <form class="product-form" id="product-form">
      <input type="hidden" name="id" value="${item.id || ""}" />
      <input type="hidden" name="image" value="${item.image || ""}" />
      <label>Loại
        <select name="kind">
          <option value="FOOD" ${(item.kind || "FOOD") === "FOOD" ? "selected" : ""}>Món ăn</option>
          <option value="DRINK" ${item.kind === "DRINK" ? "selected" : ""}>Đồ uống</option>
        </select>
      </label>
      <label>Nhóm menu
        <select name="category">
          <optgroup label="Đồ ăn">
            ${categories.filter((cat) => cat.kind === "FOOD").map((cat) => `<option value="${cat.id}" ${item.category === cat.id ? "selected" : ""}>${cat.vi} / ${cat.en}</option>`).join("")}
          </optgroup>
          <optgroup label="Đồ uống">
            ${categories.filter((cat) => cat.kind === "DRINK").map((cat) => `<option value="${cat.id}" ${item.category === cat.id ? "selected" : ""}>${cat.vi} / ${cat.en}</option>`).join("")}
          </optgroup>
        </select>
      </label>
      <label>Tên tiếng Việt <input name="vi" value="${escapeAttr(item.vi || "")}" required /></label>
      <label>Tên tiếng Anh <input name="en" value="${escapeAttr(item.en || "")}" required /></label>
      <label>Mô tả tiếng Việt <textarea name="descVi" required>${escapeHtml(item.descVi || "")}</textarea></label>
      <label>Mô tả tiếng Anh <textarea name="descEn" required>${escapeHtml(item.descEn || "")}</textarea></label>
      <div class="form-grid">
        <label>Giá VND <input name="price" type="number" min="0" step="1000" value="${item.price || 0}" required /></label>
        <label>Khu chế biến
          <select name="station">
            ${stations.map((station) => `<option value="${station.code}" ${item.station === station.code ? "selected" : ""}>${station.code} - ${station.vi}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="form-grid">
        <label>Màu nền ảnh mẫu <input name="color" type="color" value="${item.color || "#dcefe5"}" /></label>
        <label>Icon mẫu
          <select name="art">
            ${["cup", "glass", "plate", "dessert", "grill", "pot"].map((art) => `<option value="${art}" ${item.art === art ? "selected" : ""}>${art}</option>`).join("")}
          </select>
        </label>
      </div>
      <label>Link hình ảnh <input name="imageUrl" value="${escapeAttr(item.image && !item.image.startsWith("data:") ? item.image : "")}" placeholder="https://..." /></label>
      <label>Hoặc tải ảnh từ máy <input name="imageFile" type="file" accept="image/*" /></label>
      <fieldset>
        <legend>Khung giờ bán</legend>
        ${["morning", "afternoon", "evening"].map((period) => `<label class="check"><input type="checkbox" name="periods" value="${period}" ${selectedPeriods.includes(period) ? "checked" : ""} /> ${period}</label>`).join("")}
      </fieldset>
      <label class="check"><input type="checkbox" name="available" ${item.available ?? true ? "checked" : ""} /> Đang bán</label>
      <div class="split-actions">
        <button class="primary" type="submit">Lưu món</button>
        <button class="ghost" type="button" data-new-product>Nhập món mới</button>
      </div>
      <div id="image-preview">${item.image ? `<img class="preview-image" src="${item.image}" alt="Preview" />` : ""}</div>
    </form>
  `;
}

function adminProductRow(item) {
  return `
    <article class="admin-product">
      ${productVisual(item)}
      <div>
        <h3>${escapeHtml(item.vi)}</h3>
        <p class="muted">${escapeHtml(item.en)} - ${formatMoney(item.price)}</p>
        <div class="split-actions">
          <span class="station">${item.kind}</span>
          <span class="station">${categoryLabel(item.category)}</span>
          <span class="station">${item.station}</span>
          <button class="pill ${item.available ? "active" : ""}" data-toggle="${item.id}">${item.available ? "AVAILABLE" : "SOLD OUT"}</button>
        </div>
      </div>
      <div class="row-actions">
        <button class="ghost" data-edit="${item.id}">Sửa</button>
        <button class="danger" data-delete="${item.id}">Xóa</button>
      </div>
    </article>
  `;
}

function bindCustomer(token) {
  bindGlobal();
  document.querySelectorAll("[data-kind]").forEach((button) => button.addEventListener("click", () => {
    activeKind = button.dataset.kind;
    activeCategory = "all";
    localStorage.setItem("deedou_kind", activeKind);
    render();
  }));
  document.querySelectorAll("[data-cat]").forEach((button) => button.addEventListener("click", () => {
    activeCategory = button.dataset.cat;
    render();
  }));
  document.querySelectorAll("[data-add]").forEach((button) => button.addEventListener("click", () => {
    state.cart = addCartItem(state.cart, button.dataset.add, productById);
    saveState();
    render();
  }));
  document.querySelectorAll("[data-inc]").forEach((button) => button.addEventListener("click", () => {
    state.cart = addCartItem(state.cart, button.dataset.inc, productById);
    saveState();
    render();
  }));
  document.querySelectorAll("[data-dec]").forEach((button) => button.addEventListener("click", () => {
    state.cart = decrementCartItem(state.cart, button.dataset.dec);
    saveState();
    render();
  }));
  document.querySelector("[data-submit]")?.addEventListener("click", () => submitOrder(token));
  document.querySelectorAll("[data-service]").forEach((button) => button.addEventListener("click", () => serviceRequest(token, button.dataset.service)));
}

function bindStaff() {
  bindGlobal();
  document.querySelectorAll("[data-order]").forEach((button) => button.addEventListener("click", () => updateOrderStatus(button.dataset.order, button.dataset.status)));
  document.querySelectorAll("[data-event]").forEach((button) => button.addEventListener("click", () => {
    const event = state.events.find((item) => item.id === button.dataset.event);
    if (event) event.done = true;
    audit("EVENT_DONE", `Handled ${event?.type || "event"}`);
    saveState();
    render();
  }));
}

function bindCashier() {
  bindGlobal();
  document.querySelectorAll("[data-order]").forEach((button) => button.addEventListener("click", () => updateOrderStatus(button.dataset.order, button.dataset.status)));
  document.querySelectorAll("[data-pay]").forEach((button) => button.addEventListener("click", () => payOrder(button.dataset.pay, button.dataset.method)));
  document.querySelectorAll("[data-split]").forEach((button) => button.addEventListener("click", () => splitOrderInTwo(button.dataset.split)));
  document.querySelectorAll("[data-prebill]").forEach((button) => button.addEventListener("click", () => preBill(button.dataset.prebill)));
  document.querySelectorAll("[data-void]").forEach((button) => button.addEventListener("click", () => startVoidOrder(button.dataset.void)));
  document.querySelectorAll("[data-void-confirm]").forEach((button) => button.addEventListener("click", () => confirmVoidOrder(button.dataset.voidConfirm)));
  document.querySelectorAll("[data-void-cancel]").forEach((button) => button.addEventListener("click", cancelVoidOrder));
  document.querySelectorAll("[data-bill-dec]").forEach((button) => button.addEventListener("click", () => adjustBillQty(button.dataset.billDec, button.dataset.lineIndex, -1)));
  document.querySelectorAll("[data-bill-inc]").forEach((button) => button.addEventListener("click", () => adjustBillQty(button.dataset.billInc, button.dataset.lineIndex, 1)));
  document.querySelectorAll("[data-refund]").forEach((button) => button.addEventListener("click", () => refundOrder(button.dataset.refund)));
  document.querySelectorAll("[data-table-pay]").forEach((button) => button.addEventListener("click", () => payTable(button.dataset.tablePay, button.dataset.method)));
  document.querySelectorAll("[data-table-split]").forEach((button) => button.addEventListener("click", () => splitTableInTwo(button.dataset.tableSplit)));
  document.querySelectorAll("[data-table-prebill]").forEach((button) => button.addEventListener("click", () => preBillTable(button.dataset.tablePrebill)));
  document.querySelectorAll("[data-table-void]").forEach((button) => button.addEventListener("click", () => voidTable(button.dataset.tableVoid)));
  document.querySelectorAll("[data-table-refund]").forEach((button) => button.addEventListener("click", () => refundTable(button.dataset.tableRefund)));
  document.querySelectorAll("[data-select-table]").forEach((button) => button.addEventListener("click", () => selectCashierTable(button.dataset.selectTable)));
  document.querySelectorAll("[data-counter-open]").forEach((button) => button.addEventListener("click", () => openCounterOrder(button.dataset.counterOpen)));
  document.querySelectorAll("[data-counter-add]").forEach((button) => button.addEventListener("click", () => addCounterItem(button.dataset.counterAdd)));
  document.querySelectorAll("[data-counter-inc]").forEach((button) => button.addEventListener("click", () => addCounterItem(button.dataset.counterInc)));
  document.querySelectorAll("[data-counter-dec]").forEach((button) => button.addEventListener("click", () => decCounterItem(button.dataset.counterDec)));
  document.querySelector("[data-counter-cancel]")?.addEventListener("click", cancelCounterOrder);
  document.querySelector("[data-counter-submit]")?.addEventListener("click", submitCounterOrder);
  document.getElementById("counter-search")?.addEventListener("input", (event) => {
    counterSearch = event.target.value;
    localStorage.setItem(COUNTER_SEARCH_KEY, counterSearch);
    render();
  });
  document.getElementById("counter-note")?.addEventListener("input", (event) => {
    counterDraft.note = event.target.value;
    saveCounterDraft();
  });
}

function bindStation() {
  bindGlobal();
  document.querySelectorAll("[data-station-order]").forEach((button) => button.addEventListener("click", () => {
    updateStationStatus(button.dataset.stationOrder, button.dataset.stationGroup, button.dataset.stationStatus);
  }));
}

function bindAdmin() {
  bindGlobal();
  bindAdminForm();
  document.querySelectorAll("[data-toggle]").forEach((button) => button.addEventListener("click", () => {
    const item = productById(button.dataset.toggle);
    item.available = !item.available;
    saveProducts();
    audit("MENU_AVAILABILITY", `${item.en}: ${item.available ? "AVAILABLE" : "SOLD OUT"}`);
    saveState();
    render();
  }));
  document.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", () => loadProductIntoForm(button.dataset.edit)));
  document.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () => deleteProduct(button.dataset.delete)));
  document.querySelectorAll("[data-new-product]").forEach((button) => button.addEventListener("click", () => loadProductIntoForm("")));
  document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(button.dataset.copy);
    button.textContent = "Copied";
  }));
  document.querySelector("[data-reset]")?.addEventListener("click", resetDemoData);
}

function bindAdminForm() {
  const form = document.getElementById("product-form");
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const id = formData.get("id") || slugify(formData.get("en") || formData.get("vi"));
    const imageFileValue = form.querySelector("[name=image]").value;
    const imageUrl = (formData.get("imageUrl") || "").trim();
    const selectedCategory = formData.get("category");
    const categoryInfo = categories.find((cat) => cat.id === selectedCategory);
    const existingIndex = products.findIndex((item) => item.id === id);
    const next = {
      id,
      kind: categoryInfo?.kind || formData.get("kind"),
      category: selectedCategory,
      vi: (formData.get("vi") || "").trim(),
      en: (formData.get("en") || "").trim(),
      descVi: (formData.get("descVi") || "").trim(),
      descEn: (formData.get("descEn") || "").trim(),
      price: Number(formData.get("price") || 0),
      station: formData.get("station"),
      available: formData.has("available"),
      color: formData.get("color") || "#dcefe5",
      art: formData.get("art") || "plate",
      periods: formData.getAll("periods"),
      image: imageUrl || imageFileValue,
      components: existingIndex >= 0 ? products[existingIndex].components || [] : []
    };
    if (existingIndex >= 0) products[existingIndex] = next;
    else products.unshift(next);
    saveProducts();
    audit("MENU_SAVE", `${next.en} saved`);
    saveState();
    render();
  });
  form.querySelectorAll("[data-new-product]").forEach((button) => button.addEventListener("click", () => loadProductIntoForm("")));
  const imageFile = form.querySelector("[name=imageFile]");
  const categorySelect = form.querySelector("[name=category]");
  categorySelect.addEventListener("change", () => {
    const categoryInfo = categories.find((cat) => cat.id === categorySelect.value);
    if (categoryInfo) form.querySelector("[name=kind]").value = categoryInfo.kind;
  });
  imageFile.addEventListener("change", () => {
    const file = imageFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      form.querySelector("[name=image]").value = reader.result;
      form.querySelector("[name=imageUrl]").value = "";
      document.getElementById("image-preview").innerHTML = `<img class="preview-image" src="${reader.result}" alt="Preview" />`;
    };
    reader.readAsDataURL(file);
  });
}

function bindGlobal() {
  document.querySelectorAll("[data-route]").forEach((button) => button.addEventListener("click", () => {
    location.hash = button.dataset.route;
  }));
  document.querySelectorAll("[data-lang]").forEach((button) => button.addEventListener("click", () => {
    lang = button.dataset.lang;
    localStorage.setItem("deedou_lang", lang);
    render();
  }));
}

function loadProductIntoForm(id) {
  const target = productById(id);
  const panel = document.querySelector(".product-form")?.parentElement;
  if (!panel) return;
  panel.innerHTML = `<h2>${id ? "Sửa món" : "Thêm món ăn / đồ uống"}</h2>${productForm(id ? target : {})}`;
  bindAdminForm();
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function deleteProduct(id) {
  const item = productById(id);
  if (!confirm(`Xóa ${item.vi}?`)) return;
  products = products.filter((productItem) => productItem.id !== id);
  state.cart = removeCartItem(state.cart, id);
  saveProducts();
  audit("MENU_DELETE", `${item.en} deleted`);
  saveState();
  render();
}

function submitOrder(token) {
  if (!canSubmitCart(state.cart)) return;
  const table = tables.find((item) => item.token === token) || tables[0];
  const note = document.getElementById("note")?.value || "";
  const items = expandCartLines(state.cart);
  const total = billableTotal(items);
  const orderNo = nextOrderNo();
  state.orders.push({
    id: `D${Date.now().toString().slice(-6)}`,
    orderNo,
    table: table.code,
    token,
    items,
    note,
    total,
    paidVnd: 0,
    payments: [],
    channel: "QR",
    status: "PENDING_ACCEPTANCE",
    stationStatus: stationStatusFor(items, "PENDING_ACCEPTANCE"),
    time: new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })
  });
  state.cart = clearCart();
  audit("ORDER_SUBMIT", `${orderNo} Table ${table.code} submitted ${formatMoney(total)}`);
  saveState();
  render();
}

function expandCartLines(cartLines) {
  return cartLines.flatMap((line) => {
    const item = productById(line.id);
    const parent = {
      id: item.id,
      qty: line.qty,
      station: item.components?.length ? "COMBO" : item.station,
      nameVi: item.vi,
      nameEn: item.en,
      price: item.price,
      billQty: line.qty,
      status: "QUEUED",
      isBillable: true,
      isComponent: false,
      parentComboId: ""
    };
    const components = (item.components || []).map((part, index) => ({
      id: `${item.id}-component-${index}`,
      qty: line.qty * part.qty,
      station: part.station,
      nameVi: part.vi,
      nameEn: part.en,
      price: 0,
      billQty: 0,
      status: "QUEUED",
      isBillable: false,
      isComponent: true,
      parentComboId: item.id
    }));
    return [parent, ...components];
  });
}

function serviceRequest(token, type) {
  const table = tables.find((item) => item.token === token) || tables[0];
  state.events.push(createServiceRequestEvent({ table, type }));
  audit("SERVICE_REQUEST", `${type} at table ${table.code}`);
  saveState();
  render();
}

function openCounterOrder(tableCode) {
  activeCashierTable = tableCode;
  localStorage.setItem("deedou_cashier_table", activeCashierTable);
  counterSearch = "";
  localStorage.setItem(COUNTER_SEARCH_KEY, counterSearch);
  counterDraft = { active: true, table: tableCode, items: [], note: "" };
  saveCounterDraft();
  render();
}

function addCounterItem(id) {
  const item = productById(id);
  if (!item.available) return;
  const line = counterDraft.items.find((draftLine) => draftLine.id === id);
  if (line) line.qty = Math.min(20, line.qty + 1);
  else counterDraft.items.push({ id, qty: 1 });
  saveCounterDraft();
  render();
}

function decCounterItem(id) {
  const line = counterDraft.items.find((draftLine) => draftLine.id === id);
  if (!line) return;
  line.qty -= 1;
  counterDraft.items = counterDraft.items.filter((draftLine) => draftLine.qty > 0);
  saveCounterDraft();
  render();
}

function cancelCounterOrder() {
  counterDraft = emptyCounterDraft();
  counterSearch = "";
  localStorage.setItem(COUNTER_SEARCH_KEY, counterSearch);
  saveCounterDraft();
  render();
}

function submitCounterOrder() {
  if (!counterDraft.active || !counterDraft.items.length) return;
  const tableCode = counterDraft.table;
  const orderNo = nextOrderNo();
  const items = expandCartLines(counterDraft.items);
  const total = billableTotal(items);
  state.orders.push({
    id: `D${Date.now().toString().slice(-6)}`,
    orderNo,
    table: tableCode,
    token: "",
    items,
    note: counterDraft.note || (tableCode === "TAKEAWAY" ? "Counter takeaway order" : "Counter order"),
    total,
    paidVnd: 0,
    payments: [],
    channel: tableCode === "TAKEAWAY" ? "TAKEAWAY" : "CASHIER",
    status: "ACCEPTED",
    stationStatus: stationStatusFor(items, "QUEUED"),
    time: new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })
  });
  audit("COUNTER_ORDER_SUBMIT", `${orderNo} ${tableCode} ${formatMoney(total)}`);
  counterDraft = emptyCounterDraft();
  counterSearch = "";
  localStorage.setItem(COUNTER_SEARCH_KEY, counterSearch);
  saveCounterDraft();
  saveState();
  render();
}

function selectCashierTable(tableCode) {
  activeCashierTable = tableCode;
  localStorage.setItem("deedou_cashier_table", tableCode);
  render();
}

function adjustBillQty(orderId, lineIndex, delta) {
  const order = state.orders.find((item) => item.id === orderId);
  const line = order?.items?.[Number(lineIndex)];
  if (!order || !line?.isBillable || ["PAID", "REJECTED", "VOIDED", "REFUNDED"].includes(order.status)) return;
  const oldQty = chargedQty(line);
  const nextQty = clampBillQty(oldQty + delta, line.qty);
  if (nextQty === oldQty) return;
  line.billQty = nextQty;
  recalcOrderTotal(order);
  audit("BILL_QTY_ADJUST", `${order.orderNo} ${line.nameVi}: ${oldQty}/${line.qty} -> ${nextQty}/${line.qty}`);
  saveState();
  render();
}

function orderBalance(order) {
  return Math.max(0, order.total - (order.paidVnd || 0));
}

function appendPayment(order, method, amount, idPrefix = "PAY") {
  order.payments = order.payments || [];
  order.payments.push({
    id: `${idPrefix}${Date.now().toString().slice(-6)}${order.id.slice(-3)}${order.payments.length}`,
    method,
    provider: ["VNPAY", "MOMO", "ZALOPAY"].includes(method) ? method : "MANUAL",
    amountVnd: amount,
    status: "SUCCEEDED",
    paidAt: new Date().toLocaleString("vi-VN")
  });
}

function payableTableOrders(tableCode) {
  return tableOrders(tableCode).filter((order) => orderBalance(order) > 0);
}

function payTable(tableCode, method) {
  const orders = payableTableOrders(tableCode);
  const balance = orders.reduce((sum, order) => sum + orderBalance(order), 0);
  if (!balance) return;
  orders.forEach((order) => {
    const amount = orderBalance(order);
    appendPayment(order, method, amount);
    order.paidVnd = (order.paidVnd || 0) + amount;
    order.status = "PAID";
  });
  audit("TABLE_PAYMENT_SUCCEEDED", `${tableCode} ${method} ${formatMoney(balance)}`);
  saveState();
  render();
}

function splitTableInTwo(tableCode) {
  const orders = payableTableOrders(tableCode);
  const balance = orders.reduce((sum, order) => sum + orderBalance(order), 0);
  if (!balance) return;
  const first = Math.floor(balance / 2);
  const second = balance - first;
  let firstRemaining = first;
  orders.forEach((order) => {
    const amount = orderBalance(order);
    const firstAmount = Math.min(amount, firstRemaining);
    const secondAmount = amount - firstAmount;
    if (firstAmount > 0) {
      appendPayment(order, "SPLIT_CASH", firstAmount);
      order.paidVnd = (order.paidVnd || 0) + firstAmount;
      firstRemaining -= firstAmount;
    }
    if (secondAmount > 0) {
      appendPayment(order, "SPLIT_CASH", secondAmount);
      order.paidVnd = (order.paidVnd || 0) + secondAmount;
    }
    order.status = "PAID";
  });
  audit("TABLE_SPLIT_BILL", `${tableCode} split 2 payments: ${formatMoney(first)} + ${formatMoney(second)}`);
  saveState();
  render();
}

function preBillTable(tableCode) {
  const orders = tableOrders(tableCode);
  if (!orders.length) return;
  const balance = orders.reduce((sum, order) => sum + orderBalance(order), 0);
  audit("TABLE_PRE_BILL", `${tableCode} ${formatMoney(balance)}`);
  saveState();
  render();
}

function voidTable(tableCode) {
  const orders = tableOrders(tableCode);
  if (!orders.length) return;
  const reason = prompt(`Lý do void toàn bộ bill bàn ${tableCode}?`);
  if (!reason) return;
  orders.forEach((order) => {
    order.status = "VOIDED";
    order.voidReason = reason;
    order.items.forEach((item) => item.status = "CANCELLED");
  });
  audit("TABLE_VOID", `${tableCode}: ${reason}`);
  saveState();
  render();
}

function refundTable(tableCode) {
  const orders = tableOrders(tableCode).filter((order) => (order.paidVnd || 0) > 0);
  const paid = orders.reduce((sum, order) => sum + (order.paidVnd || 0), 0);
  if (!paid) return;
  const rawAmount = prompt(`Số tiền refund tối đa ${formatMoney(paid)}`, String(paid));
  const amount = Number(rawAmount || 0);
  if (!amount || amount > paid) return;
  let remaining = amount;
  orders.forEach((order) => {
    if (remaining <= 0) return;
    const refund = Math.min(order.paidVnd || 0, remaining);
    appendPayment(order, "REFUND", -refund, "REF");
    order.paidVnd = (order.paidVnd || 0) - refund;
    order.status = order.paidVnd > 0 ? "PARTIALLY_REFUNDED" : "REFUNDED";
    remaining -= refund;
  });
  audit("TABLE_REFUND", `${tableCode} ${formatMoney(amount)}`);
  saveState();
  render();
}

function payOrder(orderId, method) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order) return;
  const balance = Math.max(0, order.total - (order.paidVnd || 0));
  if (!balance) return;
  order.payments = order.payments || [];
  order.payments.push({
    id: `PAY${Date.now().toString().slice(-6)}`,
    method,
    provider: ["VNPAY", "MOMO", "ZALOPAY"].includes(method) ? method : "MANUAL",
    amountVnd: balance,
    status: "SUCCEEDED",
    paidAt: new Date().toLocaleString("vi-VN")
  });
  order.paidVnd = (order.paidVnd || 0) + balance;
  order.status = "PAID";
  audit("PAYMENT_SUCCEEDED", `${order.orderNo} ${method} ${formatMoney(balance)}`);
  saveState();
  render();
}

function splitOrderInTwo(orderId) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order) return;
  const balance = Math.max(0, order.total - (order.paidVnd || 0));
  if (!balance) return;
  const first = Math.floor(balance / 2);
  const second = balance - first;
  order.payments = order.payments || [];
  [first, second].forEach((amount, index) => {
    order.payments.push({
      id: `PAY${Date.now().toString().slice(-5)}${index}`,
      method: "SPLIT_CASH",
      provider: "MANUAL",
      amountVnd: amount,
      status: "SUCCEEDED",
      paidAt: new Date().toLocaleString("vi-VN")
    });
  });
  order.paidVnd = (order.paidVnd || 0) + balance;
  order.status = "PAID";
  audit("SPLIT_BILL", `${order.orderNo} split 2 payments: ${formatMoney(first)} + ${formatMoney(second)}`);
  saveState();
  render();
}

function preBill(orderId) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order) return;
  audit("PRE_BILL", `${order.orderNo} table ${order.table} ${formatMoney(order.total)}`);
  saveState();
  render();
}

function startVoidOrder(orderId) {
  pendingVoidOrderId = orderId;
  render();
}

function cancelVoidOrder() {
  pendingVoidOrderId = "";
  render();
}

function confirmVoidOrder(orderId) {
  const reasonInput = document.querySelector(`[data-void-reason="${orderId}"]`);
  voidOrder(orderId, reasonInput?.value || "");
}

function voidOrder(orderId, reason = "") {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order) return;
  const voidReason = reason.trim() || "Thu ngân hủy lượt gọi";
  order.status = "VOIDED";
  order.voidReason = voidReason;
  order.items.forEach((item) => item.status = "CANCELLED");
  pendingVoidOrderId = "";
  audit("VOID_BATCH", `${order.orderNo}: ${voidReason}`);
  saveState();
  render();
}

function refundOrder(orderId) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order) return;
  const paid = order.paidVnd || 0;
  const rawAmount = prompt(`Số tiền refund tối đa ${formatMoney(paid)}`, String(paid));
  const amount = Number(rawAmount || 0);
  if (!amount || amount > paid) return;
  order.payments = order.payments || [];
  order.payments.push({
    id: `REF${Date.now().toString().slice(-6)}`,
    method: "REFUND",
    provider: "MANUAL",
    amountVnd: -amount,
    status: "SUCCEEDED",
    paidAt: new Date().toLocaleString("vi-VN")
  });
  order.paidVnd = paid - amount;
  order.status = order.paidVnd > 0 ? "PARTIALLY_REFUNDED" : "REFUNDED";
  audit("REFUND", `${order.orderNo} ${formatMoney(amount)}`);
  saveState();
  render();
}

function updateOrderStatus(orderId, status) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order) return;
  order.status = status;
  if (status === "ACCEPTED") order.stationStatus = stationStatusFor(order.items, "QUEUED");
  if (status === "ACCEPTED") order.items.filter((item) => item.station !== "COMBO").forEach((item) => item.status = "QUEUED");
  if (status === "IN_PREPARATION") {
    Object.keys(order.stationStatus).forEach((station) => {
      if (order.stationStatus[station] === "QUEUED") order.stationStatus[station] = "PREPARING";
    });
    order.items.filter((item) => item.station !== "COMBO" && item.status === "QUEUED").forEach((item) => item.status = "PREPARING");
  }
  if (status === "REJECTED") order.stationStatus = {};
  if (status === "SERVED") order.items.filter((item) => item.station !== "COMBO").forEach((item) => item.status = "SERVED");
  audit("ORDER_STATUS", `${order.orderNo} -> ${status}`);
  saveState();
  render();
}

function updateStationStatus(orderId, stationGroup, status) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order) return;
  const groupStations = stations.filter((station) => station.group === stationGroup).map((station) => station.code);
  groupStations.forEach((station) => {
    if (order.stationStatus[station]) order.stationStatus[station] = status;
  });
  order.items.filter((item) => groupStations.includes(item.station)).forEach((item) => {
    item.status = status;
  });
  if (["ACKNOWLEDGED", "PREPARING"].some((value) => Object.values(order.stationStatus).includes(value))) order.status = "IN_PREPARATION";
  if (Object.values(order.stationStatus).every((value) => value === "READY")) order.status = "READY";
  audit("STATION_STATUS", `${stationGroup} ${order.orderNo} -> ${status}`);
  saveState();
  render();
}

function resetDemoData() {
  if (!confirm("Reset toàn bộ dữ liệu demo, menu và order?")) return;
  products = structuredClone(defaultProducts);
  state = { cart: [], orders: [], events: [], audit: [], sequence: 1 };
  counterDraft = emptyCounterDraft();
  saveCounterDraft();
  saveProducts();
  saveState();
  render();
}

function audit(type, detail) {
  state.audit.push({
    type,
    detail,
    time: new Date().toLocaleString("vi-VN")
  });
  state.audit = state.audit.slice(-120);
}

function tableOrders(tableCode) {
  return state.orders.filter((order) => order.table === tableCode && !["PAID", "REJECTED", "VOIDED", "REFUNDED"].includes(order.status));
}

function zoneNames() {
  return [...new Set(tables.map((table) => table.zone))];
}

function zoneLabel(zone) {
  const labels = {
    Beach: "Bờ biển",
    Indoor: "Trong nhà",
    Camping: "Ngoài sân / Camping",
    Takeaway: "Mang đi"
  };
  return labels[zone] || zone;
}

function matchesCounterSearch(item, query) {
  if (!query) return true;
  const category = categories.find((cat) => cat.id === item.category);
  const haystack = normalizeSearch([
    item.vi,
    item.en,
    item.descVi,
    item.descEn,
    item.station,
    category?.vi,
    category?.en
  ].join(" "));
  return haystack.includes(query);
}

function currentPeriod() {
  const hour = new Date().getHours();
  if (hour < 11) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

function nextOrderNo() {
  const orderNo = `D01-${String(state.sequence || 1).padStart(4, "0")}`;
  state.sequence = (state.sequence || 1) + 1;
  return orderNo;
}

function productById(id) {
  return products.find((item) => item.id === id) || defaultProducts[0];
}

function categoryLabel(id) {
  const category = categories.find((cat) => cat.id === id);
  return category ? category.vi : id;
}

function artSvg(kind) {
  const common = `fill="none" stroke="#17201c" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"`;
  const svgs = {
    cup: `<svg viewBox="0 0 100 100" aria-hidden="true"><path ${common} d="M22 42h46l-5 34H30L22 42Z"/><path ${common} d="M68 49h9c18 0 15 22-2 22h-8"/><path ${common} d="M35 27c-7-9 5-14 0-23M54 27c-7-9 5-14 0-23"/></svg>`,
    glass: `<svg viewBox="0 0 100 100" aria-hidden="true"><path ${common} d="M28 20h44L65 84H35L28 20Z"/><path ${common} d="M36 42h28M42 10h30"/><path ${common} d="M68 10 55 42"/></svg>`,
    plate: `<svg viewBox="0 0 100 100" aria-hidden="true"><ellipse ${common} cx="50" cy="56" rx="34" ry="24"/><path ${common} d="M31 55c12-10 27-10 39 0M20 84h60"/></svg>`,
    dessert: `<svg viewBox="0 0 100 100" aria-hidden="true"><path ${common} d="M24 44h52L66 80H34L24 44Z"/><path ${common} d="M30 44c5-18 35-18 40 0"/><path ${common} d="M50 18v16"/></svg>`,
    grill: `<svg viewBox="0 0 100 100" aria-hidden="true"><path ${common} d="M20 42h60M24 58h52M32 74h36"/><path ${common} d="M30 24c-6-8 6-12 0-20M50 24c-6-8 6-12 0-20M70 24c-6-8 6-12 0-20"/></svg>`,
    pot: `<svg viewBox="0 0 100 100" aria-hidden="true"><path ${common} d="M22 43h56l-6 32H28L22 43Z"/><path ${common} d="M18 43h64M34 28c-6-8 6-12 0-20M55 28c-6-8 6-12 0-20"/></svg>`
  };
  return svgs[kind] || svgs.plate;
}
