export function renderCustomerServiceActions(copy) {
  return `
    <div class="split-actions">
      <button class="ghost" data-service="CALL_STAFF">${copy.call}</button>
      <button class="ghost" data-service="REQUEST_BILL">${copy.bill}</button>
    </div>
  `;
}

export function createServiceRequestEvent({ table, type, tableSessionId = "", now = new Date(), generateId } = {}) {
  const timestamp = new Date(now);
  const id = typeof generateId === "function"
    ? generateId({ table, type, tableSessionId, now })
    : `E${timestamp.getTime().toString().slice(-6)}`;
  const event = {
    id,
    type,
    table: table.code,
    done: false,
    time: timestamp.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })
  };
  if (table.zone) event.zone = table.zone;
  if (tableSessionId) event.tableSessionId = tableSessionId;
  return {
    ...event
  };
}
