import { api } from "./api.js";
import { badge, empty, esc, fmtDate, labelize, modalForm, money, page, setActions, table, toast, todayInput } from "./ui.js";

const methods = [
  { value: "ACH", label: "Bank account (ACH)" },
  { value: "Card", label: "Card" },
  { value: "Check", label: "Check" },
];

export async function showDocument(outlet, id) {
  const document = await api.get(`/api/documents/${id}`);
  outlet.innerHTML = `<article class="paper"><div class="page-actions"><button class="btn btn-ghost" data-action="print">Print</button></div><h1>${esc(document.name)}</h1><p class="muted">${esc(labelize(document.category))} · ${fmtDate(document.created_at)}</p><pre class="doc">${esc(document.content || "This record has no text body.")}</pre></article>`;
  setActions({ print: () => window.print() });
}

export async function showStatement(outlet, id) {
  const { statement, company } = await api.get(`/api/statements/${id}`);
  const detail = statement.detail || {};
  const row = (label, amount, strong = false) => `<tr class="${strong ? "total-row" : ""}"><td>${esc(label)}</td><td>${money(amount)}</td></tr>`;
  const lines = (items) => (items || []).map((item) => row(item.description || "Item", item.amount)).join("");
  outlet.innerHTML = page("Owner statement", `<button class="btn btn-ghost" data-action="print">Print</button>`, `<article class="paper"><header><div><strong>${esc(company.name)}</strong><div class="muted">${esc([company.address, company.city, company.state].filter(Boolean).join(", "))}</div><div class="muted">${esc(company.phone || "")}</div></div><div><strong>Owner statement</strong><div class="muted">Cash basis</div></div></header><h1>${esc(statement.property)}</h1><p class="muted">${esc(statement.address || "")} ${esc(statement.city || "")}</p><p class="muted">${esc(statement.owner)} · ${fmtDate(statement.period_start)} – ${fmtDate(statement.period_end)} · ${esc(detail.ownershipPercent || 100)}% ownership</p><table class="statement-table">${row("Beginning balance", statement.beginning_cents)}${lines(detail.income)}${row("Income", statement.income_cents, true)}${lines(detail.expenses)}${row("Operating expenses", statement.expense_cents, true)}${row("Management fee", statement.management_fee_cents)}${lines(detail.contributions)}${row("Owner contributions", statement.contribution_cents)}${lines(detail.distributions)}${row("Owner distributions", statement.distribution_cents)}${row("Ending balance", statement.ending_balance_cents, true)}</table></article>`);
  setActions({ print: () => window.print() });
}

export async function renderPortal(outlet, parts, user) {
  const pageName = parts[1] || "home";
  if (user.role === "owner") return ownerPortal(outlet, pageName);
  if (user.role === "vendor") return vendorPortal(outlet, pageName, parts[2]);
  return tenantPortal(outlet, pageName);
}

async function tenantPortal(outlet, pageName) {
  const data = await api.get("/api/portal/tenant");
  const refresh = () => tenantPortal(outlet, pageName);
  if (!data.lease) {
    outlet.innerHTML = page("Resident portal", "", empty("No lease is linked to this login yet."));
    setActions({});
    return;
  }
  if (pageName === "pay") {
    outlet.innerHTML = page("Pay rent", "", `<div class="card"><p class="muted">Amount due</p><div class="balance">${money(data.balance)}</div><p class="muted">${esc(data.lease.property_name)} · Unit ${esc(data.lease.unit_name)}</p>${data.plan ? `<p>Payment plan: ${money(data.plan.installment_cents)} ${esc(data.plan.frequency)}, ${money(data.plan.remaining_cents)} remaining.</p>` : ""}</div><div class="card"><form class="stack" data-action="pay"><label>Amount<input name="amount" type="number" min="0.01" step="0.01" value="${(data.balance / 100).toFixed(2)}" required/></label><label>Method<select name="method">${methods.map((method) => `<option value="${method.value}">${esc(method.label)}</option>`).join("")}</select></label><p class="field-note">SunPilot records the payment on your ledger. A card or bank processor is connected later by the property manager.</p><button class="btn btn-primary" type="submit" ${data.balance <= 0 ? "disabled" : ""}>Submit payment</button></form></div><div class="card"><h2>Autopay</h2><form class="stack" data-action="autopay"><label class="check"><input type="checkbox" name="enabled" ${data.lease.autopay ? "checked" : ""}/> Pay the full open balance automatically</label><label>Method<select name="method"><option ${data.lease.autopay_method === "Card" ? "selected" : ""}>Card</option><option ${data.lease.autopay_method !== "Card" ? "selected" : ""}>ACH</option></select></label><button class="btn btn-ghost" type="submit">Save autopay</button></form></div>${table(["Date", "Description", "Due", "Paid", "Status"], data.charges.map((charge) => `<tr><td>${fmtDate(charge.due_date)}</td><td>${esc(charge.description)}</td><td>${money(charge.amount_cents)}</td><td>${money(charge.paid_cents)}</td><td>${badge(charge.status)}</td></tr>`).join(""))}`);
  } else if (pageName === "maintenance") {
    outlet.innerHTML = page("Maintenance", "", `<div class="card"><form class="stack" data-action="request"><label>What needs attention<input name="title" required/></label><label>Category<select name="category">${["Plumbing", "HVAC", "Appliance", "Electrical", "Pest", "Other"].map((item) => `<option>${esc(item)}</option>`).join("")}</select></label><label>Priority<select name="priority"><option value="low">Low</option><option value="normal" selected>Normal</option><option value="urgent">Urgent</option></select></label><label>Details<textarea name="description"></textarea></label><label>Photo<input type="file" accept="image/*"/></label><button class="btn btn-primary" type="submit">Submit request</button></form></div>${table(["Request", "Status", "Opened"], data.workOrders.map((order) => `<tr><td>${esc(order.title)}${order.photo_url ? `<img class="photo" src="${esc(order.photo_url)}" alt=""/>` : ""}</td><td>${badge(order.status)}</td><td>${fmtDate(order.created_at)}</td></tr>`).join(""))}`);
  } else if (pageName === "documents") {
    outlet.innerHTML = page("Documents", "", table(["Name", "Type", "Added"], data.documents.map((doc) => `<tr><td><button class="link" data-go="#/documents/${doc.id}">${esc(doc.name)}</button></td><td>${esc(labelize(doc.category))}</td><td>${fmtDate(doc.created_at)}</td></tr>`).join("")));
  } else if (pageName === "messages") {
    const thread = [...data.messages].reverse();
    outlet.innerHTML = page("Texts", "", `<div class="thread">${thread.map((message) => `<article class="bubble ${message.subject === "Text from resident" ? "mine" : ""}"><p>${esc(message.body)}</p><small>${esc(message.channel === "sms" || message.channel === "text" ? "Text" : labelize(message.channel))} · ${fmtDate(message.created_at)}</small></article>`).join("") || empty("Texts with Sunseeker show up here.")}</div><form class="card stack" data-action="reply"><label>Reply<textarea name="body" required placeholder="Send a text to the office"></textarea></label><button class="btn btn-primary" type="submit">Send text</button></form>`);
  } else {
    outlet.innerHTML = page(`Hello, ${data.tenant.first_name}`, "", `<div class="card pay-hero"><p class="muted">Balance due</p><div class="balance">${money(data.balance)}</div><p>${esc(data.lease.property_name)} · Unit ${esc(data.lease.unit_name)}</p><button class="btn btn-primary" data-go="#/portal/pay">${data.balance > 0 ? "Pay rent" : "Payment history"}</button></div><div class="card"><p>Rent ${money(data.lease.rent_cents)} · due through ${fmtDate(data.lease.end_date)}</p><p>${badge(data.lease.status)} ${data.lease.autopay ? badge("autopay") : ""}</p></div><div class="card"><h2>Open repairs</h2>${data.workOrders.length ? data.workOrders.slice(0, 5).map((order) => `<p>${esc(order.title)} ${badge(order.status)}</p>`).join("") : `<p class="muted">No open requests.</p>`}<button class="btn btn-ghost" data-go="#/portal/maintenance">New request</button></div><div class="card"><h2>Keep SunPilot on your phone</h2><p>Add it to your Home Screen. The iPhone app can go through TestFlight when Sunseeker publishes it, and Android uses this same app.</p><p class="muted">On iPhone: Share, then Add to Home Screen.</p><button class="btn btn-ghost" data-action="install">Install app</button></div>`);
  }
  setActions({
    pay: async (form) => {
      const body = Object.fromEntries(new FormData(form));
      await api.post("/api/portal/tenant/payments", body);
      toast("Payment recorded");
      await refresh();
    },
    autopay: async (form) => {
      const body = Object.fromEntries(new FormData(form));
      await api.post("/api/portal/tenant/autopay", { enabled: Boolean(body.enabled), method: body.method });
      toast("Autopay saved");
      await refresh();
    },
    reply: async (form) => {
      const body = Object.fromEntries(new FormData(form));
      await api.post("/api/portal/tenant/messages", body);
      toast("Text sent");
      form.reset();
      await refresh();
    },
    install: async () => {
      if (window.sunpilotInstall) {
        window.sunpilotInstall.prompt();
        return;
      }
      toast("On iPhone, use Share and then Add to Home Screen.");
    },
    request: async (form) => {
      const body = Object.fromEntries(new FormData(form));
      const file = form.querySelector('input[type="file"]')?.files?.[0];
      if (file) {
        body.photoDataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("Could not read that photo"));
          reader.readAsDataURL(file);
        });
      }
      await api.post("/api/portal/tenant/work-orders", body);
      toast("Request sent to SunSeeker");
      form.reset();
      await refresh();
    },
  });
}

async function ownerPortal(outlet, pageName) {
  const data = await api.get("/api/portal/owner");
  const refresh = () => ownerPortal(outlet, pageName);
  const propertyOptions = data.properties.map((property) => `<option value="${property.id}">${esc(property.name)} (${property.percent}%)</option>`).join("");
  if (pageName === "statements") {
    outlet.innerHTML = page("Statements", "", table(["Period", "Property", "Ending balance", ""], data.statements.map((statement) => `<tr><td>${fmtDate(statement.period_start)} – ${fmtDate(statement.period_end)}</td><td>${esc(statement.property)}</td><td>${money(statement.ending_balance_cents)}</td><td><button class="link" data-go="#/statements/${statement.id}">View</button></td></tr>`).join("")));
  } else if (pageName === "funds") {
    outlet.innerHTML = page("Add funds", "", `<div class="card"><p class="lede">Send money into a property for repairs, reserves, or a shortage. It posts to that property's trust cash.</p><form class="stack" data-action="funds"><label>Property<select name="propertyId" required>${propertyOptions}</select></label><label>Amount<input name="amount" type="number" min="0.01" step="0.01" required/></label><label>Method<select name="method">${methods.map((method) => `<option value="${method.value}">${esc(method.label)}</option>`).join("")}</select></label><label>Memo<input name="memo" value="Owner funds"/></label><button class="btn btn-primary" type="submit">Add funds</button></form></div>${table(["Date", "Property", "Amount", "Memo"], data.contributions.map((item) => `<tr><td>${fmtDate(item.contributed_at)}</td><td>${esc(data.properties.find((property) => property.id === item.property_id)?.name || "")}</td><td>${money(item.amount_cents)}</td><td>${esc(item.memo)}</td></tr>`).join(""))}`);
  } else if (pageName === "approvals") {
    outlet.innerHTML = page("Approvals", "", table(["Property", "Request", "Amount", "Status", ""], data.approvals.map((item) => `<tr><td>${esc(item.property || "")}</td><td>${esc(item.notes || item.kind)}</td><td>${money(item.amount_cents)}</td><td>${badge(item.status)}</td><td>${item.status === "pending" ? `<button class="btn btn-primary" data-action="decide" data-id="${item.id}" data-status="approved">Approve</button> <button class="btn btn-ghost" data-action="decide" data-id="${item.id}" data-status="denied">Deny</button>` : ""}</td></tr>`).join("")));
  } else if (pageName === "documents") {
    outlet.innerHTML = page("Documents", "", table(["Name", "Added"], data.documents.map((doc) => `<tr><td><button class="link" data-go="#/documents/${doc.id}">${esc(doc.name)}</button></td><td>${fmtDate(doc.created_at)}</td></tr>`).join("")));
  } else {
    const occupied = Object.fromEntries(data.occupancy.map((row) => [row.property_id, row]));
    outlet.innerHTML = page(`Hello, ${data.owner.name.split(" ")[0]}`, "", `<div class="grid-2">${data.properties.map((property) => `<article class="card"><h2>${esc(property.name)}</h2><p class="muted">${esc(property.address)}</p><p>${property.percent}% ownership</p><p>${occupied[property.id] ? `${occupied[property.id].occupied} of ${occupied[property.id].units} units occupied` : ""}</p></article>`).join("")}</div><div class="card"><h2>Latest statements</h2>${data.statements.slice(0, 4).map((statement) => `<p><button class="link" data-go="#/statements/${statement.id}">${esc(statement.property)} · ${fmtDate(statement.period_end)}</button> ${money(statement.ending_balance_cents)}</p>`).join("") || `<p class="muted">No statements yet.</p>`}</div><div class="card"><h2>Work on your properties</h2>${data.workOrders.slice(0, 6).map((order) => `<p>${esc(order.property)} · ${esc(order.title)} ${badge(order.status)}</p>`).join("") || `<p class="muted">No work orders.</p>`}</div>`);
  }
  setActions({
    funds: async (form) => {
      await api.post("/api/portal/owner/contributions", Object.fromEntries(new FormData(form)));
      toast("Funds added to the property");
      await refresh();
    },
    decide: async (el) => {
      await api.post(`/api/approvals/${el.dataset.id}/decide`, { status: el.dataset.status });
      toast(el.dataset.status === "approved" ? "Approved" : "Denied");
      await refresh();
    },
  });
}

async function vendorPortal(outlet, pageName, workOrderId) {
  const data = await api.get("/api/portal/vendor");
  const refresh = () => vendorPortal(outlet, pageName, workOrderId);
  if (workOrderId) {
    const order = data.workOrders.find((item) => String(item.id) === String(workOrderId));
    if (!order) {
      outlet.innerHTML = empty("That work order is not assigned to you.");
      setActions({});
      return;
    }
    outlet.innerHTML = page(order.title, "", `<div class="card"><p>${esc(order.property || "")} ${esc(order.unit || "")}</p><p class="muted">${esc(order.address || "")}</p><p>${badge(order.status)} ${badge(order.priority)}</p><p>${esc(order.description || "")}</p>${order.photo_url ? `<img class="photo" alt="Request photo" src="${esc(order.photo_url)}"/>` : ""}<p>Estimate ${money(order.estimate_cents)}</p></div><form class="card stack" data-action="update"><label>Status<select name="status">${["new", "assigned", "scheduled", "in_progress", "pending_approval", "completed"].map((status) => `<option value="${status}" ${order.status === status ? "selected" : ""}>${esc(labelize(status))}</option>`).join("")}</select></label><label>Scheduled<input name="scheduledAt" value="${esc(order.scheduled_at || "")}" placeholder="YYYY-MM-DD HH:MM"/></label><label>Estimate<input name="estimate" type="number" step="0.01" value="${order.estimate_cents ? (order.estimate_cents / 100).toFixed(2) : ""}"/></label><label>Note to the office<textarea name="note"></textarea></label><button class="btn btn-primary" type="submit">Update work order</button></form>`);
    setActions({
      update: async (form) => {
        await api.patch(`/api/portal/vendor/work-orders/${order.id}`, Object.fromEntries(new FormData(form)));
        toast("Update sent");
        await refresh();
      },
    });
    return;
  }
  const properties = [];
  for (const order of data.workOrders) {
    if (order.property_id && !properties.some((property) => property.id === order.property_id)) properties.push({ id: order.property_id, name: order.property });
  }
  if (pageName === "invoices") {
    outlet.innerHTML = page("Invoices", "", `<div class="card"><form class="stack" data-action="invoice"><label>Property<select name="propertyId">${properties.map((property) => `<option value="${property.id}">${esc(property.name)}</option>`).join("")}</select></label><label>Amount<input name="amount" type="number" min="0.01" step="0.01" required/></label><label>Memo<input name="memo" required/></label><label>Due date<input name="dueDate" type="date" value="${todayInput()}"/></label><button class="btn btn-primary" type="submit">Submit invoice</button></form></div>${table(["Memo", "Amount", "Status", "Due"], data.bills.map((bill) => `<tr><td>${esc(bill.memo)}</td><td>${money(bill.amount_cents)}</td><td>${badge(bill.status)}</td><td>${fmtDate(bill.due_date)}</td></tr>`).join(""))}`);
  } else if (pageName === "profile") {
    const vendor = data.vendor;
    outlet.innerHTML = page("Insurance and license", "", `<form class="card stack" data-action="profile"><label>Phone<input name="phone" value="${esc(vendor.phone || "")}"/></label><label>Insurance carrier<input name="insuranceCarrier" value="${esc(vendor.insurance_carrier || "")}"/></label><label>Insurance expires<input type="date" name="insuranceExpires" value="${esc(vendor.insurance_expires || "")}"/></label><label>License number<input name="licenseNumber" value="${esc(vendor.license_number || "")}"/></label><label>License expires<input type="date" name="licenseExpires" value="${esc(vendor.license_expires || "")}"/></label><button class="btn btn-primary" type="submit">Save</button></form>`);
  } else {
    outlet.innerHTML = page(data.vendor.name, "", table(["Work order", "Property", "Status", "Scheduled"], data.workOrders.map((order) => `<tr><td><button class="link" data-go="#/portal/work/${order.id}">${esc(order.title)}</button></td><td>${esc(order.property || "")}</td><td>${badge(order.status)}</td><td>${fmtDate(order.scheduled_at)}</td></tr>`).join("")));
  }
  setActions({
    invoice: async (form) => {
      await api.post("/api/portal/vendor/invoices", Object.fromEntries(new FormData(form)));
      toast("Invoice submitted");
      await refresh();
    },
    profile: async (form) => {
      await api.patch("/api/portal/vendor", Object.fromEntries(new FormData(form)));
      toast("Profile saved");
    },
  });
}
