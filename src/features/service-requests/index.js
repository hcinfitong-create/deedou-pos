export function renderCustomerServiceActions(copy) {
  return `
    <div class="split-actions">
      <button class="ghost" data-service="CALL_STAFF">${copy.call}</button>
      <button class="ghost" data-service="REQUEST_BILL">${copy.bill}</button>
    </div>
  `;
}

export function createServiceRequestEvent({ table, type }) {
  return {
    id: `E${Date.now().toString().slice(-6)}`,
    type,
    table: table.code,
    done: false,
    time: new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })
  };
}

