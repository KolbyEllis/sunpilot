import { api } from "./api.js";
import { badge, downloadCsv, empty, esc, fmtDate, labelize, link, modalForm, money, options, page, setActions, tabBar, table, toast, todayInput } from "./ui.js";

let reload = async () => {};
let pageData = {};
const methods = [{ value: "ACH", label: "Bank account (ACH)" }, { value: "Card", label: "Card" }, { value: "Check", label: "Check" }, { value: "Cash", label: "Cash" }];
const stages = ["inquiry", "showing", "application", "approved", "denied", "leased", "lost"];

function can(permissions, key) {
  return permissions.includes(key);
}
function button(label, action, kind = "primary", extra = "") {
  return `<button class="btn btn-${kind}" data-action="${esc(action)}" ${extra}>${esc(label)}</button>`;
}
async function lookups() {
  return api.get("/api/lookups");
}
function leaseLabel(lease) {
  return `${lease.property} ${lease.unit} · ${lease.first_name} ${lease.last_name}`;
}
function listingChannels(row) {
  return [
    row.syndicate_website ? "Website" : "",
    row.syndicate_zillow ? "Zillow" : "",
    row.syndicate_trulia ? "Trulia" : "",
    row.syndicate_realtor ? "Realtor.com" : "",
    row.syndicate_apartments ? "Apartments.com" : "",
  ].filter(Boolean).join(", ") || "Not queued";
}

function openProperty(existing) {
  modalForm({
    title: existing ? "Edit property" : "New property",
    fields: [
      { label: "Name", name: "name", required: true, value: existing?.name },
      { label: "Street address", name: "address", required: true, value: existing?.address },
      { label: "City", name: "city", value: existing?.city },
      { label: "State", name: "state", value: existing?.state || "AZ" },
      { label: "ZIP", name: "zip", value: existing?.zip },
      { label: "Type", name: "propertyType", type: "select", value: existing?.property_type || "single_family", options: [{ value: "single_family", label: "Single family" }, { value: "multi", label: "Multi family" }, { value: "condo", label: "Condo" }] },
      { label: "Year built", name: "yearBuilt", type: "number", value: existing?.year_built || "" },
      { label: "Utilities", name: "utilities", value: existing?.utilities },
      { label: "Amenities", name: "amenities", value: existing?.amenities },
      { label: "Photo URL", name: "photoUrl", value: existing?.photo_url },
      { label: "Notes", name: "notes", type: "textarea", value: existing?.notes },
    ],
    onSubmit: async (data) => {
      if (existing) {
        await api.patch(`/api/properties/${existing.id}`, data);
        toast("Property saved");
        await reload();
      } else {
        const result = await api.post("/api/properties", data);
        toast("Property added");
        location.hash = `#/properties/${result.id}`;
      }
    },
  });
}

async function openUnit(propertyId, existing) {
  modalForm({
    title: existing ? "Edit unit" : "Add unit",
    fields: [
      { label: "Unit", name: "name", required: true, value: existing?.name },
      { label: "Beds", name: "beds", type: "number", step: "0.5", value: existing?.beds ?? 1 },
      { label: "Baths", name: "baths", type: "number", step: "0.5", value: existing?.baths ?? 1 },
      { label: "Sq ft", name: "sqft", type: "number", value: existing?.sqft || "" },
      { label: "Market rent", name: "marketRent", type: "number", step: "0.01", value: existing ? (existing.market_rent_cents / 100).toFixed(2) : "" },
      { label: "Status", name: "status", type: "select", value: existing?.status || "vacant", options: ["vacant", "occupied", "notice", "model"].map((value) => ({ value, label: labelize(value) })) },
      { label: "Amenities", name: "amenities", value: existing?.amenities },
    ],
    onSubmit: async (data) => {
      if (existing) await api.patch(`/api/units/${existing.id}`, data);
      else await api.post("/api/units", { ...data, propertyId });
      toast("Unit saved");
      await reload();
    },
  });
}

function personFields(kind, existing) {
  if (kind === "owners") {
    return [
      { label: "Name", name: "name", required: true, value: existing?.name },
      { label: "Email", name: "email", type: "email", value: existing?.email },
      { label: "Phone", name: "phone", value: existing?.phone },
      { label: "Address", name: "address", value: existing?.address },
      { label: "Tax ID last 4", name: "taxIdLast4", value: existing?.tax_id_last4 },
      { label: "Payment method", name: "paymentMethod", type: "select", value: existing?.payment_method || "ACH", options: methods },
      { label: "Notes", name: "notes", type: "textarea", value: existing?.notes },
    ];
  }
  if (kind === "vendors") {
    return [
      { label: "Name", name: "name", required: true, value: existing?.name },
      { label: "Trade", name: "trade", value: existing?.trade },
      { label: "Email", name: "email", type: "email", value: existing?.email },
      { label: "Phone", name: "phone", value: existing?.phone },
      { label: "Address", name: "address", value: existing?.address },
      { label: "Insurance carrier", name: "insuranceCarrier", value: existing?.insurance_carrier },
      { label: "Insurance expires", name: "insuranceExpires", type: "date", value: existing?.insurance_expires },
      { label: "License number", name: "licenseNumber", value: existing?.license_number },
      { label: "License expires", name: "licenseExpires", type: "date", value: existing?.license_expires },
      { label: "Notes", name: "notes", type: "textarea", value: existing?.notes },
    ];
  }
  return [
    { label: "First name", name: "firstName", required: true, value: existing?.first_name },
    { label: "Last name", name: "lastName", required: true, value: existing?.last_name },
    { label: "Email", name: "email", type: "email", value: existing?.email },
    { label: "Phone", name: "phone", value: existing?.phone },
    { label: "Birthday", name: "birthDate", type: "date", value: existing?.birth_date },
    { label: "Emergency contact", name: "emergencyContact", value: existing?.emergency_contact },
    { label: "Notes", name: "notes", type: "textarea", value: existing?.notes },
  ];
}

function openPerson(kind, existing) {
  const path = kind === "owners" ? "owners" : kind === "vendors" ? "vendors" : "tenants";
  const fields = personFields(kind, existing);
  if (!existing) fields.push({ label: "Create a portal login with password sunseeker", name: "createLogin", type: "checkbox" });
  modalForm({
    title: existing ? "Edit" : `New ${path.slice(0, -1)}`,
    fields,
    onSubmit: async (data) => {
      if (existing) await api.patch(`/api/${path}/${existing.id}`, data);
      else {
        const result = await api.post(`/api/${path}`, data);
        location.hash = `#/people/${path}/${result.id}`;
      }
      toast("Saved");
      if (existing) await reload();
    },
  });
}

async function openMoveIn() {
  const data = await lookups();
  modalForm({
    title: "Move in a resident",
    fields: [
      { label: "Unit", name: "unitId", type: "select", required: true, options: options(data.units, "id", (unit) => `${unit.property_name} · ${unit.name} (${unit.status})`) },
      { label: "First name", name: "firstName", required: true },
      { label: "Last name", name: "lastName", required: true },
      { label: "Email", name: "email", type: "email" },
      { label: "Phone", name: "phone" },
      { label: "Start", name: "startDate", type: "date", required: true, value: todayInput() },
      { label: "End", name: "endDate", type: "date", required: true },
      { label: "Rent", name: "rent", type: "number", step: "0.01", required: true },
      { label: "Security deposit", name: "deposit", type: "number", step: "0.01", required: true },
      { label: "Create a resident portal login", name: "createLogin", type: "checkbox", value: true },
    ],
    submitLabel: "Create lease",
    onSubmit: async (data) => {
      const result = await api.post("/api/move-in", data);
      toast("Lease created");
      location.hash = `#/leases/${result.leaseId}`;
    },
  });
}

async function openMoveOut(leaseId) {
  modalForm({
    title: "Move out",
    fields: [
      { label: "Move-out date", name: "moveOutDate", type: "date", required: true, value: todayInput() },
      { label: "Deposit refund", name: "refund", type: "number", step: "0.01", value: "0" },
      { label: "Notes and deductions", name: "notes", type: "textarea" },
    ],
    onSubmit: async (data) => {
      await api.post("/api/move-out", { ...data, leaseId });
      toast("Move-out recorded");
      await reload();
    },
  });
}

async function openPayment(leaseId) {
  const data = await lookups();
  modalForm({
    title: "Receive payment",
    fields: [
      { label: "Lease", name: "leaseId", type: "select", required: true, value: leaseId || "", options: options(data.leases, "id", leaseLabel) },
      { label: "Amount", name: "amount", type: "number", step: "0.01", min: "0.01", required: true },
      { label: "Method", name: "method", type: "select", options: methods },
      { label: "Date", name: "paidAt", type: "date", value: todayInput() },
      { label: "Reference", name: "reference" },
      { type: "note", label: "Posts to the trust ledger. Connect a processor in Settings before taking live card payments." },
    ],
    onSubmit: async (data) => {
      await api.post("/api/payments", data);
      toast("Payment recorded");
      await reload();
    },
  });
}

async function openCharge(leaseId) {
  const data = await lookups();
  modalForm({
    title: "Post a charge",
    fields: [
      { label: "Lease", name: "leaseId", type: "select", required: true, value: leaseId || "", options: options(data.leases, "id", leaseLabel) },
      { label: "Type", name: "type", type: "select", options: ["rent", "late_fee", "utility", "nsf", "other", "security_deposit"].map((value) => ({ value, label: labelize(value) })) },
      { label: "Description", name: "description", required: true },
      { label: "Amount", name: "amount", type: "number", step: "0.01", required: true },
      { label: "Due date", name: "dueDate", type: "date", required: true, value: todayInput() },
    ],
    onSubmit: async (data) => {
      await api.post("/api/charges", data);
      toast("Charge posted");
      await reload();
    },
  });
}

async function openBill() {
  const data = await lookups();
  modalForm({
    title: "Enter bill",
    fields: [
      { label: "Vendor", name: "vendorId", type: "select", required: true, options: options(data.vendors, "id", (vendor) => vendor.name) },
      { label: "Property", name: "propertyId", type: "select", required: true, options: options(data.properties, "id", (property) => property.name) },
      { label: "Amount", name: "amount", type: "number", step: "0.01", required: true },
      { label: "Due date", name: "dueDate", type: "date", value: todayInput() },
      { label: "Category", name: "category", type: "select", options: [{ value: "repairs", label: "Repairs" }, { value: "utilities", label: "Utilities" }] },
      { label: "Memo", name: "memo", required: true },
      { type: "note", label: "Bills at or above the approval workflow amount wait for approval before they can be paid." },
    ],
    onSubmit: async (data) => {
      await api.post("/api/bills", data);
      toast("Bill entered");
      await reload();
    },
  });
}

async function openContribution() {
  const data = await lookups();
  modalForm({
    title: "Owner funds",
    fields: [
      { label: "Owner", name: "ownerId", type: "select", required: true, options: options(data.owners, "id", (owner) => owner.name) },
      { label: "Property", name: "propertyId", type: "select", required: true, options: options(data.properties, "id", (property) => property.name) },
      { label: "Amount", name: "amount", type: "number", step: "0.01", required: true },
      { label: "Method", name: "method", type: "select", options: methods },
      { label: "Memo", name: "memo", value: "Owner funds" },
    ],
    onSubmit: async (data) => {
      await api.post("/api/contributions", data);
      toast("Owner funds recorded");
      await reload();
    },
  });
}

async function openWorkOrder() {
  const data = await lookups();
  modalForm({
    title: "New work order",
    fields: [
      { label: "Property", name: "propertyId", type: "select", required: true, options: options(data.properties, "id", (property) => property.name) },
      { label: "Unit", name: "unitId", type: "select", options: options(data.units, "id", (unit) => `${unit.property_name} · ${unit.name}`, "No specific unit") },
      { label: "Resident", name: "tenantId", type: "select", options: options(data.tenants, "id", (tenant) => `${tenant.first_name} ${tenant.last_name}`, "No resident") },
      { label: "Vendor", name: "vendorId", type: "select", options: options(data.vendors, "id", (vendor) => vendor.name, "Unassigned") },
      { label: "Title", name: "title", required: true },
      { label: "Category", name: "category", type: "select", options: ["Plumbing", "HVAC", "Appliance", "Electrical", "Pest", "Other"].map((value) => ({ value, label: value })) },
      { label: "Priority", name: "priority", type: "select", value: "normal", options: ["low", "normal", "urgent"].map((value) => ({ value, label: labelize(value) })) },
      { label: "Estimate", name: "estimate", type: "number", step: "0.01" },
      { label: "Scheduled", name: "scheduledAt", placeholder: "YYYY-MM-DD HH:MM" },
      { label: "Description", name: "description", type: "textarea" },
      { label: "Photo", name: "photo", type: "file" },
    ],
    onSubmit: async (data) => {
      const result = await api.post("/api/work-orders", data);
      toast("Work order created");
      location.hash = `#/maintenance/${result.id}`;
    },
  });
}

function sharedActions() {
  return {
    "new-property": () => openProperty(),
    "move-in": () => openMoveIn(),
    "new-owner": () => openPerson("owners"),
    "new-vendor": () => openPerson("vendors"),
    "new-tenant": () => openPerson("tenants"),
    "new-bill": () => openBill(),
    "receive-payment": () => openPayment(),
    "owner-receipt": () => openContribution(),
    "new-work-order": () => openWorkOrder(),
  };
}

export async function renderStaff(outlet, parts, query, user, permissions) {
  reload = () => renderStaff(outlet, parts, query, user, permissions);
  const [section, a, b] = parts;
  if (!section || section === "dashboard") return dashboard(outlet, query, permissions);
  if (section === "calendar") return calendar(outlet, query);
  if (section === "leasing") return leasing(outlet, a || "pipeline", permissions);
  if (section === "properties") return a ? propertyDetail(outlet, a, permissions) : properties(outlet, permissions);
  if (section === "people") return b ? personDetail(outlet, a, b, permissions) : people(outlet, a || "tenants", permissions);
  if (section === "leases" && a) return leaseDetail(outlet, a, permissions);
  if (section === "accounting") return accounting(outlet, a || "charges", permissions);
  if (section === "maintenance") return a && /^\d+$/.test(a) ? workOrderDetail(outlet, a, permissions) : maintenance(outlet, a || "orders", permissions);
  if (section === "reporting") return reporting(outlet, a || "", query, permissions);
  if (section === "communication") return communication(outlet, a || "history", permissions);
  if (section === "news") return news(outlet);
  if (section === "settings") return settings(outlet, a || "company", permissions);
  outlet.innerHTML = empty("That page is not in SunPilot.");
  setActions({});
}

async function dashboard(outlet, query, permissions) {
  const propertyId = query.get("property") || "";
  const data = await api.get(`/api/dashboard${propertyId ? `?propertyId=${propertyId}` : ""}`);
  const hidden = JSON.parse(localStorage.getItem("sunpilot.widgets") || "{}");
  const fold = (key, title, count, body, open = false) => hidden[key] ? "" : `<details class="fold" ${open ? "open" : ""}><summary>${esc(title)} <span class="muted">${count}</span></summary><div class="fold-body">${body}</div></details>`;
  const moveInRows = data.moveIns.map((row) => `<p>${fmtDate(row.start_date)} · ${link(`#/leases/${row.id}`, `${row.first_name} ${row.last_name}`)} · ${esc(row.property)} ${esc(row.unit)} ${badge(row.status)} ${row.status === "future" && can(permissions, "leasing.edit") ? button("Complete move-in", "activate", "ghost", `data-id="${row.id}"`) : ""}</p>`).join("") || `<p class="muted">No upcoming move-ins.</p>`;
  const moveOutRows = data.moveOuts.map((row) => `<p>${fmtDate(row.end_date)} · ${link(`#/leases/${row.id}`, `${row.first_name} ${row.last_name}`)} · ${esc(row.property)} ${badge(row.status)}</p>`).join("") || `<p class="muted">No upcoming move-outs.</p>`;
  const paymentRows = data.payments.map((row) => `<p>${fmtDate(row.paid_at)} · ${esc(row.first_name)} ${esc(row.last_name)} · ${money(row.amount_cents)} · ${esc(row.method)}</p>`).join("") || `<p class="muted">No payments yet.</p>`;
  const feed = [...data.reminders.map((item) => `<div class="feed-item"><strong>${esc(item.title)}</strong><span>${esc(item.body || "")}</span></div>`), ...data.feed.map((item) => `<div class="feed-item"><strong>${esc(item.title)}</strong><span>${esc(item.body || "")}</span></div>`)].join("") || `<p class="muted">No notifications.</p>`;
  outlet.innerHTML = `<div class="page-head"><div><h1>Dashboard</h1></div><div class="page-actions"><label>View by <select data-change="filter-property"><option value="">All</option>${data.properties.map((property) => `<option value="${property.id}" ${String(property.id) === propertyId ? "selected" : ""}>${esc(property.name)}</option>`).join("")}</select></label>${button("Customize", "customize", "ghost")}</div></div><div class="dash"><div>${fold("moveIns", "Move ins", data.moveIns.length, moveInRows)}${fold("moveOuts", "Move outs", data.moveOuts.length, moveOutRows)}${fold("payments", "Online payments", data.payments.length, paymentRows)}<details class="fold" open><summary>Notifications</summary><div class="fold-body"><div class="card stats"><div class="stat"><strong>${data.activitiesDue}</strong><span>Due in the next 7 days</span></div><div class="stat"><strong>${data.activitiesOverdue}</strong><span>Overdue</span></div></div><div class="card stats"><div class="stat"><strong>${data.billsPending}</strong><span>Bills pending approval</span></div><div class="stat"><strong>${data.purchaseOrdersPending}</strong><span>Purchase orders pending</span></div></div><h2>Notifications feed</h2>${feed}</div></details></div><aside class="card tasks"><h2>Tasks</h2><div class="task-group"><p>Calendar</p><button class="link" data-go="#/calendar">View calendar</button></div><div class="task-group"><p>Property</p><button class="link" data-action="new-property">New property</button></div><div class="task-group"><p>People</p><button class="link" data-action="move-in">Move in resident</button><button class="link" data-action="receive-payment">Resident receipt</button><button class="link" data-action="owner-receipt">Owner receipt</button><button class="link" data-action="new-owner">New owner</button><button class="link" data-action="new-vendor">New vendor</button><button class="link" data-go="#/leasing/renewals">Rent increase</button></div><div class="task-group"><p>Accounting</p><button class="link" data-action="new-bill">Enter bill</button></div><div class="task-group"><p>Reports</p><button class="link" data-go="#/reporting/delinquency">Delinquency</button><button class="link" data-go="#/reporting/ledger">Resident ledger</button><button class="link" data-go="#/reporting/vacancy">Vacancy</button><button class="link" data-go="#/reporting/rent-roll">Rent roll</button><button class="link" data-go="#/reporting/cash-flow">Cash flow</button><button class="link" data-go="#/reporting/expirations">Lease expirations</button></div><div class="task-group"><p>Notices</p><button class="link" data-go="#/communication/letters">Letters</button><button class="link" data-go="#/reporting/delinquency">3-day notice drafts</button></div></aside></div>`;
  setActions({
    ...sharedActions(),
    "filter-property": (el) => { location.hash = el.value ? `#/dashboard?property=${el.value}` : "#/dashboard"; },
    customize: () => modalForm({
      title: "Customize dashboard",
      fields: ["moveIns", "moveOuts", "payments"].map((key) => ({ label: `Show ${labelize(key)}`, name: key, type: "checkbox", value: !hidden[key] })),
      onSubmit: async (data) => {
        localStorage.setItem("sunpilot.widgets", JSON.stringify({ moveIns: !data.moveIns, moveOuts: !data.moveOuts, payments: !data.payments }));
        await reload();
      },
    }),
    activate: async (el) => {
      await api.post(`/api/leases/${el.dataset.id}/activate`, {});
      toast("Move-in completed");
      await reload();
    },
  });
}

function monthCells(month) {
  const [year, mon] = month.split("-").map(Number);
  const first = new Date(year, mon - 1, 1);
  const cursor = new Date(first);
  cursor.setDate(1 - first.getDay());
  const cells = [];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(cursor);
    date.setDate(cursor.getDate() + index);
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    cells.push({ iso, day: date.getDate(), inMonth: date.getMonth() === mon - 1 });
  }
  return cells;
}

async function calendar(outlet, query) {
  const month = query.get("month") || todayInput().slice(0, 7);
  const data = await api.get(`/api/calendar?month=${month}`);
  const [year, mon] = month.split("-").map(Number);
  const prev = new Date(year, mon - 2, 1);
  const next = new Date(year, mon, 1);
  const stamp = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  const today = todayInput();
  const byDay = {};
  for (const event of data.events) (byDay[event.date] ||= []).push(event);
  outlet.innerHTML = page("Calendar", "", `<div class="calendar-head"><button class="btn btn-ghost" data-go="#/calendar?month=${stamp(prev)}">Previous</button><h2>${new Date(year, mon - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" })}</h2><button class="btn btn-ghost" data-go="#/calendar?month=${stamp(next)}">Next</button></div><div class="cal">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => `<div class="cal-dow">${day}</div>`).join("")}${monthCells(month).map((cell) => `<div class="day ${cell.inMonth ? "" : "off"} ${cell.iso === today ? "today" : ""}"><strong>${cell.day}</strong>${(byDay[cell.iso] || []).map((event) => `<button class="event ${esc(event.kind)}" data-go="${esc(event.href)}">${esc(event.title)}</button>`).join("")}</div>`).join("")}</div>`);
  setActions({});
}

async function leasing(outlet, tab, permissions) {
  const tabs = tabBar([["#/leasing/pipeline", "Pipeline"], ["#/leasing/showings", "Showings"], ["#/leasing/applications", "Applications"], ["#/leasing/listings", "Listings"], ["#/leasing/leases", "Leases"], ["#/leasing/renewals", "Renewals"]], `#/leasing/${tab === "pipeline" && !location.hash.includes("/pipeline") && location.hash.endsWith("/leasing") ? "pipeline" : tab}`);
  const active = ["showings", "applications", "listings", "leases", "renewals"].includes(tab) ? tab : "pipeline";
  const edit = can(permissions, "leasing.edit");
  if (active === "pipeline") {
    const prospects = await api.get("/api/prospects");
    outlet.innerHTML = page("Leasing", edit ? button("New guest card", "new-prospect") : "", `${tabs}<div class="board">${stages.map((stage) => `<section class="column"><h3>${esc(labelize(stage))}</h3>${prospects.filter((prospect) => prospect.stage === stage).map((prospect) => `<article class="deal"><strong>${esc(prospect.name)}</strong><div class="muted">${esc(prospect.property || "")} ${esc(prospect.unit || "")}</div><div class="muted">${esc(prospect.source || "")}</div><select data-change="stage" data-id="${prospect.id}">${stages.map((item) => `<option ${item === prospect.stage ? "selected" : ""}>${esc(item)}</option>`).join("")}</select></article>`).join("") || `<p class="muted">Empty</p>`}</section>`).join("")}</div>`);
    setActions({ ...sharedActions(), "new-prospect": () => openProspect(), stage: async (el) => { await api.patch(`/api/prospects/${el.dataset.id}`, { stage: el.value }); toast("Pipeline updated"); } });
    return;
  }
  if (active === "showings") {
    const rows = await api.get("/api/showings");
    outlet.innerHTML = page("Showings", edit ? button("Schedule showing", "new-showing") : "", `${tabs}${table(["When", "Prospect", "Unit", "Type", "Status", ""], rows.map((row) => `<tr><td>${fmtDate(row.scheduled_at)}</td><td>${esc(row.prospect || "")}</td><td>${esc(row.property || "")} ${esc(row.unit || "")}</td><td>${esc(labelize(row.showing_type))}</td><td>${badge(row.status)}</td><td>${edit ? `<button class="link" data-action="showing-status" data-id="${row.id}" data-status="completed">Done</button>` : ""}</td></tr>`).join(""))}`);
    setActions({ "new-showing": () => openShowing(), "showing-status": async (el) => { await api.patch(`/api/showings/${el.dataset.id}`, { status: el.dataset.status, notes: "" }); await reload(); } });
    return;
  }
  if (active === "applications") {
    const rows = await api.get("/api/applications");
    outlet.innerHTML = page("Applications", edit ? button("New application", "new-application") : "", `${tabs}<p class="lede">Order credit, nationwide criminal, and eviction screening from the bureau. SunPilot stores the result. It does not keep a Social Security number.</p>${table(["Prospect", "Unit", "Income", "Status", "Screening", ""], rows.map((row) => `<tr><td>${esc(row.prospect || "")}</td><td>${esc(row.property || "")} ${esc(row.unit || "")}</td><td>${money(row.income_cents)}</td><td>${badge(row.status)}</td><td>${row.credit_score ? `Credit ${row.credit_score} · Criminal ${esc(row.criminal || "")} · Eviction ${esc(row.eviction || "")}` : "Not ordered"}</td><td>${edit ? `<button class="link" data-action="screen" data-id="${row.id}">Order screening</button> <button class="link" data-action="app-status" data-id="${row.id}" data-status="approved">Approve</button> <button class="link" data-action="app-status" data-id="${row.id}" data-status="denied">Deny</button>` : ""}</td></tr>`).join(""))}`);
    setActions({
      "new-application": () => openApplication(),
      screen: async (el) => {
        const result = await api.post("/api/screenings", { applicationId: el.dataset.id });
        toast(result.already ? "Screening is already on file" : "Screening ordered");
        await reload();
      },
      "app-status": async (el) => { await api.patch(`/api/applications/${el.dataset.id}`, { status: el.dataset.status, notes: "" }); toast("Application updated"); await reload(); },
    });
    return;
  }
  if (active === "listings") {
    const rows = await api.get("/api/listings");
    outlet.innerHTML = page("Listings", edit ? button("Market a unit", "new-listing") : "", `${tabs}<p class="lede">Published listings are queued for your website, Zillow, Trulia, Realtor.com, and Apartments.com. The live networks start delivering after they approve the Sunseeker feed.</p>${table(["Listing", "Rent", "Available", "Channels", "Status"], rows.map((row) => `<tr><td>${esc(row.headline)}<div class="muted">${esc(row.property)} · ${esc(row.unit)}</div></td><td>${money(row.rent_cents)}</td><td>${fmtDate(row.available_date)}</td><td>${listingChannels(row)}</td><td>${badge(row.status)}</td></tr>`).join(""))}<div class="page-actions">${button("Preview syndication feed", "show-feed", "ghost")}</div><pre id="listing-feed" class="doc"></pre>`);
    setActions({
      "new-listing": () => openListing(),
      "show-feed": async () => {
        const feed = await api.get("/api/listings/feed");
        document.getElementById("listing-feed").textContent = JSON.stringify(feed, null, 2);
      },
    });
    return;
  }
  if (active === "renewals") {
    const rows = await api.get("/api/renewals");
    outlet.innerHTML = page("Renewals and rent increases", edit ? button("Offer renewal", "new-renewal") : "", `${tabs}${table(["Resident", "Current", "Offered", "New end", "Status", ""], rows.map((row) => `<tr><td>${link(`#/leases/${row.lease_id}`, `${row.first_name} ${row.last_name}`)}<div class="muted">${esc(row.property)}</div></td><td>${money(row.rent_cents)}</td><td>${money(row.offered_rent_cents)}</td><td>${fmtDate(row.new_end_date)}</td><td>${badge(row.status)}</td><td>${edit && row.status === "offered" ? `<button class="link" data-action="renewal" data-id="${row.id}" data-status="accepted">Accept</button> <button class="link" data-action="renewal" data-id="${row.id}" data-status="declined">Decline</button>` : ""}</td></tr>`).join(""))}`);
    setActions({ "new-renewal": () => openRenewal(), renewal: async (el) => { await api.patch(`/api/renewals/${el.dataset.id}`, { status: el.dataset.status }); toast("Renewal updated"); await reload(); } });
    return;
  }
  const rows = await api.get("/api/leases");
  outlet.innerHTML = page("Leases", edit ? button("Move in", "move-in") : "", `${tabs}${table(["Resident", "Property", "Rent", "Term", "Balance", "Status"], rows.map((row) => `<tr><td>${link(`#/leases/${row.id}`, `${row.first_name} ${row.last_name}`)}</td><td>${esc(row.property)} · ${esc(row.unit)}</td><td>${money(row.rent_cents)}</td><td>${fmtDate(row.start_date)} – ${fmtDate(row.end_date)}</td><td>${money(row.balance_cents)}</td><td>${badge(row.status)}</td></tr>`).join(""))}`);
  setActions(sharedActions());
}

async function openProspect() {
  const data = await lookups();
  modalForm({
    title: "Guest card",
    fields: [
      { label: "Name", name: "name", required: true },
      { label: "Email", name: "email", type: "email" },
      { label: "Phone", name: "phone" },
      { label: "Unit of interest", name: "unitId", type: "select", options: options(data.units, "id", (unit) => `${unit.property_name} · ${unit.name}`, "Undecided") },
      { label: "Source", name: "source", type: "select", options: ["Website", "Zillow", "Apartments.com", "Phone", "Walk-in"].map((value) => ({ value, label: value })) },
      { label: "Notes", name: "notes", type: "textarea" },
    ],
    onSubmit: async (data) => { await api.post("/api/prospects", data); toast("Guest card added"); await reload(); },
  });
}
async function openShowing() {
  const [data, prospects] = await Promise.all([lookups(), api.get("/api/prospects")]);
  modalForm({
    title: "Schedule a showing",
    fields: [
      { label: "Prospect", name: "prospectId", type: "select", options: options(prospects, "id", (prospect) => prospect.name) },
      { label: "Unit", name: "unitId", type: "select", options: options(data.units, "id", (unit) => `${unit.property_name} · ${unit.name}`) },
      { label: "Type", name: "showingType", type: "select", options: [{ value: "agent", label: "Agent" }, { value: "self_guided", label: "Self-guided" }, { value: "virtual", label: "Virtual" }] },
      { label: "When", name: "scheduledAt", required: true, placeholder: "YYYY-MM-DD HH:MM" },
    ],
    onSubmit: async (data) => { await api.post("/api/showings", data); toast("Showing scheduled"); await reload(); },
  });
}
async function openApplication() {
  const [data, prospects] = await Promise.all([lookups(), api.get("/api/prospects")]);
  modalForm({
    title: "Rental application",
    fields: [
      { label: "Prospect", name: "prospectId", type: "select", required: true, options: options(prospects, "id", (prospect) => prospect.name) },
      { label: "Unit", name: "unitId", type: "select", options: options(data.units, "id", (unit) => `${unit.property_name} · ${unit.name}`) },
      { label: "Monthly income", name: "income", type: "number", step: "0.01" },
      { label: "Occupants", name: "occupants", type: "number", value: "1" },
      { label: "Notes", name: "notes", type: "textarea" },
    ],
    onSubmit: async (data) => { await api.post("/api/applications", data); toast("Application started"); await reload(); },
  });
}
async function openListing() {
  const data = await lookups();
  modalForm({
    title: "Market a unit",
    fields: [
      { label: "Unit", name: "unitId", type: "select", required: true, options: options(data.units.filter((unit) => unit.status === "vacant"), "id", (unit) => `${unit.property_name} · ${unit.name}`) },
      { label: "Headline", name: "headline", required: true },
      { label: "Description", name: "description", type: "textarea" },
      { label: "Rent", name: "rent", type: "number", step: "0.01", required: true },
      { label: "Available", name: "availableDate", type: "date", value: todayInput() },
      { label: "Company website", name: "syndicateWebsite", type: "checkbox", value: true },
      { label: "Zillow", name: "syndicateZillow", type: "checkbox", value: true },
      { label: "Trulia", name: "syndicateTrulia", type: "checkbox", value: true },
      { label: "Realtor.com", name: "syndicateRealtor", type: "checkbox", value: true },
      { label: "Apartments.com", name: "syndicateApartments", type: "checkbox", value: true },
    ],
    onSubmit: async (data) => { await api.post("/api/listings", data); toast("Listing saved"); await reload(); },
  });
}
async function openRenewal() {
  const data = await lookups();
  modalForm({
    title: "Renewal offer",
    fields: [
      { label: "Lease", name: "leaseId", type: "select", required: true, options: options(data.leases, "id", leaseLabel) },
      { label: "Offered rent", name: "offeredRent", type: "number", step: "0.01", required: true },
      { label: "New end date", name: "newEndDate", type: "date", required: true },
      { label: "Notes", name: "notes", type: "textarea" },
    ],
    onSubmit: async (data) => { await api.post("/api/renewals", data); toast("Offer saved"); await reload(); },
  });
}

async function properties(outlet, permissions) {
  const rows = await api.get("/api/properties");
  outlet.innerHTML = page("Properties", can(permissions, "portfolio.edit") ? button("New property", "new-property") : "", table(["Property", "Units", "Occupied", "Owners"], rows.map((row) => `<tr><td>${link(`#/properties/${row.id}`, row.name)}<div class="muted">${esc(row.address)}, ${esc(row.city)}</div></td><td>${row.unit_count}</td><td>${row.occupied_count}</td><td>${esc(row.owner_summary || "—")}</td></tr>`).join("")));
  setActions(sharedActions());
}

async function propertyDetail(outlet, id, permissions) {
  const data = await api.get(`/api/properties/${id}`);
  const property = data.property;
  const edit = can(permissions, "portfolio.edit");
  outlet.innerHTML = page(property.name, edit ? button("Edit", "edit-property", "ghost") + button("Add unit", "add-unit") : "", `<p class="lede">${esc(property.address)}, ${esc(property.city)} ${esc(property.state)} ${esc(property.zip)}</p><div class="grid-2"><div class="card"><h2>Details</h2><dl class="facts"><div><dt>Type</dt><dd>${esc(labelize(property.property_type))}</dd></div><div><dt>Year</dt><dd>${esc(property.year_built || "—")}</dd></div><div><dt>Utilities</dt><dd>${esc(property.utilities || "—")}</dd></div><div><dt>Amenities</dt><dd>${esc(property.amenities || "—")}</dd></div></dl>${property.notes ? `<p>${esc(property.notes)}</p>` : ""}</div><div class="card"><h2>Ownership</h2>${data.owners.map((owner) => `<p>${link(`#/people/owners/${owner.owner_id}`, owner.name)} · ${owner.percent}%</p>`).join("") || `<p class="muted">No owners yet.</p>`}${edit ? button("Add owner share", "add-owner", "ghost") : ""}${data.agreement ? `<p class="muted">Management fee ${data.agreement.management_fee_percent}% · repair approval ${money(data.agreement.repair_approval_threshold_cents)}</p>` : ""}</div></div><div class="card"><h2>Custom fields</h2>${data.fields.map((field) => `<form class="inline" data-action="save-field"><input type="hidden" name="fieldId" value="${field.id}"/><label>${esc(field.label)}<input name="value" value="${esc(field.value || "")}"/></label><button class="btn btn-ghost">Save</button></form>`).join("") || `<p class="muted">Add fields in Settings.</p>`}</div><h2>Units</h2>${table(["Unit", "Beds", "Market rent", "Status", ""], data.units.map((unit) => `<tr><td>${esc(unit.name)}</td><td>${unit.beds} / ${unit.baths}</td><td>${money(unit.market_rent_cents)}</td><td>${badge(unit.status)}</td><td>${edit ? `<button class="link" data-action="edit-unit" data-id="${unit.id}">Edit</button>` : ""}</td></tr>`).join(""))}<h2>Leases</h2>${table(["Resident", "Unit", "Term", "Status"], data.leases.map((lease) => `<tr><td>${link(`#/leases/${lease.id}`, `${lease.first_name} ${lease.last_name}`)}</td><td>${esc(lease.unit)}</td><td>${fmtDate(lease.start_date)} – ${fmtDate(lease.end_date)}</td><td>${badge(lease.status)}</td></tr>`).join(""))}<h2>Work orders</h2>${data.workOrders.map((order) => `<p>${link(`#/maintenance/${order.id}`, order.title)} ${badge(order.status)}</p>`).join("") || `<p class="muted">None.</p>`}<div class="card"><h2>Notes</h2><form class="stack" data-action="add-note"><textarea name="body" required></textarea><button class="btn btn-ghost">Add note</button></form>${data.notes.map((note) => `<div class="feed-item"><strong>${esc(note.author || "Staff")}</strong><span>${fmtDate(note.created_at)}</span><p>${esc(note.body)}</p></div>`).join("")}</div>`);
  pageData.property = data;
  setActions({
    "edit-property": () => openProperty(property),
    "add-unit": () => openUnit(property.id),
    "edit-unit": (el) => openUnit(property.id, data.units.find((unit) => String(unit.id) === el.dataset.id)),
    "add-owner": async () => {
      const look = await lookups();
      modalForm({
        title: "Ownership share",
        fields: [
          { label: "Owner", name: "ownerId", type: "select", options: options(look.owners, "id", (owner) => owner.name) },
          { label: "Percent", name: "percent", type: "number", step: "0.01", required: true },
        ],
        onSubmit: async (form) => { await api.post("/api/ownerships", { ...form, propertyId: property.id }); toast("Owner added"); await reload(); },
      });
    },
    "save-field": async (form) => {
      const body = Object.fromEntries(new FormData(form));
      await api.put("/api/custom-field-values", { fieldId: body.fieldId, entityId: property.id, value: body.value });
      toast("Field saved");
    },
    "add-note": async (form) => {
      const body = Object.fromEntries(new FormData(form));
      await api.post("/api/notes", { entity: "property", entityId: property.id, body: body.body });
      form.reset();
      await reload();
    },
  });
}

function peopleTabs(active) {
  return tabBar([["#/people/tenants", "Residents"], ["#/people/owners", "Owners"], ["#/people/vendors", "Vendors"]], `#/people/${active}`);
}

async function people(outlet, kind, permissions) {
  const edit = can(permissions, "people.edit");
  if (kind === "owners") {
    const rows = await api.get("/api/owners");
    outlet.innerHTML = page("People", edit ? button("New owner", "new-owner") : "", `${peopleTabs("owners")}${table(["Owner", "Contact", "Properties", "Pays by"], rows.map((row) => `<tr><td>${link(`#/people/owners/${row.id}`, row.name)}</td><td>${esc(row.email || "")}<div class="muted">${esc(row.phone || "")}</div></td><td>${esc(row.properties || "—")}</td><td>${esc(row.payment_method || "")}</td></tr>`).join(""))}`);
  } else if (kind === "vendors") {
    const rows = await api.get("/api/vendors");
    outlet.innerHTML = page("People", edit ? button("New vendor", "new-vendor") : "", `${peopleTabs("vendors")}${table(["Vendor", "Trade", "Insurance", "License"], rows.map((row) => `<tr><td>${link(`#/people/vendors/${row.id}`, row.name)}</td><td>${esc(row.trade || "")}</td><td>${esc(row.insurance_carrier || "—")} <span class="muted">${fmtDate(row.insurance_expires)}</span></td><td>${esc(row.license_number || "—")}</td></tr>`).join(""))}`);
  } else {
    const rows = await api.get("/api/tenants");
    outlet.innerHTML = page("People", edit ? `${button("New resident", "new-tenant", "ghost")}${button("Move in", "move-in")}` : "", `${peopleTabs("tenants")}${table(["Resident", "Home", "Rent", "Balance", "Status"], rows.map((row) => `<tr><td>${link(`#/people/tenants/${row.id}`, `${row.first_name} ${row.last_name}`)}</td><td>${esc(row.property || "—")} ${esc(row.unit || "")}</td><td>${row.rent_cents ? money(row.rent_cents) : "—"}</td><td>${money(row.balance_cents)}</td><td>${row.lease_status ? badge(row.lease_status) : "—"}</td></tr>`).join(""))}`);
  }
  setActions(sharedActions());
}

async function personDetail(outlet, kind, id, permissions) {
  const path = kind === "owners" ? "owners" : kind === "vendors" ? "vendors" : "tenants";
  const data = await api.get(`/api/${path}/${id}`);
  const record = data.tenant || data.owner || data.vendor;
  const name = record.name || `${record.first_name} ${record.last_name}`;
  const edit = can(permissions, "people.edit");
  let body = `<dl class="facts"><div><dt>Email</dt><dd>${esc(record.email || "—")}</dd></div><div><dt>Phone</dt><dd>${esc(record.phone || "—")}</dd></div>${record.birth_date ? `<div><dt>Birthday</dt><dd>${fmtDate(record.birth_date)}</dd></div>` : ""}${record.trade ? `<div><dt>Trade</dt><dd>${esc(record.trade)}</dd></div>` : ""}${record.insurance_expires ? `<div><dt>Insurance expires</dt><dd>${fmtDate(record.insurance_expires)}</dd></div>` : ""}${record.license_number ? `<div><dt>License</dt><dd>${esc(record.license_number)} · ${fmtDate(record.license_expires)}</dd></div>` : ""}</dl>`;
  if (data.leases) body += table(["Property", "Term", "Balance", "Status"], data.leases.map((lease) => `<tr><td>${link(`#/leases/${lease.id}`, `${lease.property} · ${lease.unit}`)}</td><td>${fmtDate(lease.start_date)} – ${fmtDate(lease.end_date)}</td><td>${money(lease.balance_cents)}</td><td>${badge(lease.status)}</td></tr>`).join(""));
  if (data.properties) body += table(["Property", "Share"], data.properties.map((property) => `<tr><td>${link(`#/properties/${property.id}`, property.name)}</td><td>${property.percent}%</td></tr>`).join(""));
  if (data.statements) body += data.statements.map((statement) => `<p>${link(`#/statements/${statement.id}`, `${fmtDate(statement.period_start)} – ${fmtDate(statement.period_end)}`)} ${money(statement.ending_balance_cents)}</p>`).join("");
  if (data.workOrders) body += `<h2>Work orders</h2>` + data.workOrders.map((order) => `<p>${link(`#/maintenance/${order.id}`, order.title)} ${badge(order.status)}</p>`).join("");
  if (data.bills) body += table(["Bill", "Amount", "Status"], data.bills.map((bill) => `<tr><td>${esc(bill.memo)}</td><td>${money(bill.amount_cents)}</td><td>${badge(bill.status)}</td></tr>`).join(""));
  if (data.communications) body += `<h2>Communication</h2>` + (data.communications.map((item) => `<article class="card"><strong>${esc(item.subject || labelize(item.channel))}</strong><p>${esc(item.body)}</p></article>`).join("") || `<p class="muted">No messages yet.</p>`);
  if (data.documents) body += `<h2>Documents</h2>` + data.documents.map((doc) => `<p>${link(`#/documents/${doc.id}`, doc.name)}</p>`).join("");
  const login = data.login ? `<p class="muted">Portal login: ${esc(data.login.email)}</p>` : (can(permissions, "admin.edit") ? button("Create portal login", "make-login", "ghost") : "");
  outlet.innerHTML = page(name, edit ? button("Edit", "edit-person", "ghost") : "", `${peopleTabs(path)}<div class="card">${body}${record.notes ? `<p>${esc(record.notes)}</p>` : ""}${login}</div>`);
  pageData.person = { kind: path, record, data };
  setActions({
    "edit-person": () => openPerson(path, record),
    "make-login": () => modalForm({
      title: "Portal login",
      fields: [{ label: "Temporary password", name: "password", required: true, value: "sunseeker" }],
      onSubmit: async (form) => {
        await api.post("/api/users", {
          name,
          email: record.email,
          password: form.password,
          role: path === "owners" ? "owner" : path === "vendors" ? "vendor" : "tenant",
          ownerId: path === "owners" ? record.id : undefined,
          vendorId: path === "vendors" ? record.id : undefined,
          tenantId: path === "tenants" ? record.id : undefined,
        });
        toast("Portal login created");
        await reload();
      },
    }),
  });
}

async function leaseDetail(outlet, id, permissions) {
  const data = await api.get(`/api/leases/${id}`);
  pageData.lease = data;
  const lease = data.lease;
  const edit = can(permissions, "leasing.edit");
  const moneyEdit = can(permissions, "accounting.edit");
  const checks = data.checklists.map((list) => {
    const items = JSON.parse(list.items || "[]");
    return `<div class="card"><h2>${list.kind === "in" ? "Move-in" : "Move-out"} checklist ${badge(list.status)}</h2>${items.map((item, index) => `<label class="check"><input type="checkbox" data-change="check-item" data-id="${list.id}" data-index="${index}" ${item.done ? "checked" : ""}/> ${esc(item.label)}</label>`).join("")}${list.notes ? `<p>${esc(list.notes)}</p>` : ""}</div>`;
  }).join("");
  outlet.innerHTML = page(`${data.tenant.first_name} ${data.tenant.last_name}`, `${moneyEdit ? button("Receive payment", "pay-lease") + button("Post charge", "charge-lease", "ghost") : ""}${edit ? button("Move out", "move-out-lease", "ghost") : ""}`, `<p class="lede">${link(`#/properties/${lease.property_id}`, lease.property_name)} · Unit ${esc(lease.unit_name)} · ${esc(lease.address)}</p><div class="grid-3"><div class="card"><p class="muted">Balance</p><div class="balance">${money(data.balance)}</div></div><div class="card"><p class="muted">Rent</p><div class="balance">${money(lease.rent_cents)}</div><p>${fmtDate(lease.start_date)} – ${fmtDate(lease.end_date)}</p></div><div class="card"><p class="muted">Deposit held</p><div class="balance">${money(data.deposit?.held_cents || 0)}</div><p>${badge(lease.status)} ${lease.autopay ? badge("autopay") : ""}</p></div></div><div class="page-actions">${edit && lease.status === "future" ? button("Complete move-in", "activate-lease") : ""}${edit ? button("Prepare lease", "prepare-lease", "ghost") : ""}${edit ? button("Mark sent", "esign-sent", "ghost") + button("Mark signed", "esign-signed", "ghost") : ""}${edit ? button("Offer renewal", "renew-lease", "ghost") : ""}</div>${data.packets.map((packet) => `<p>${esc(packet.title)} ${badge(packet.status)}</p>`).join("")}${table(["Due", "Description", "Amount", "Paid", "Status"], data.charges.map((charge) => `<tr><td>${fmtDate(charge.due_date)}</td><td>${esc(charge.description)}</td><td>${money(charge.amount_cents)}</td><td>${money(charge.paid_cents)}</td><td>${badge(charge.status)}</td></tr>`).join(""))}${table(["Date", "Amount", "Method", "Reference"], data.payments.map((payment) => `<tr><td>${fmtDate(payment.paid_at)}</td><td>${money(payment.amount_cents)}</td><td>${esc(payment.method)}</td><td>${esc(payment.reference_no || "")}</td></tr>`).join(""))}${checks}<h2>Documents</h2>${data.documents.map((doc) => `<p>${link(`#/documents/${doc.id}`, doc.name)}</p>`).join("") || `<p class="muted">No documents yet.</p>`}`);
  setActions({
    "pay-lease": () => openPayment(id),
    "charge-lease": () => openCharge(id),
    "move-out-lease": () => openMoveOut(id),
    "activate-lease": async () => { await api.post(`/api/leases/${id}/activate`, {}); toast("Resident moved in"); await reload(); },
    "prepare-lease": async () => { await api.post(`/api/leases/${id}/document`, {}); toast("Draft saved on the resident record"); await reload(); },
    "esign-sent": async () => { await api.post(`/api/leases/${id}/esign`, { status: "sent" }); toast("Marked sent"); await reload(); },
    "esign-signed": async () => { await api.post(`/api/leases/${id}/esign`, { status: "signed" }); toast("Marked signed"); await reload(); },
    "renew-lease": () => openRenewal(),
    "check-item": async (el) => {
      const list = data.checklists.find((item) => String(item.id) === el.dataset.id);
      const items = JSON.parse(list.items || "[]");
      items[Number(el.dataset.index)].done = el.checked;
      await api.patch(`/api/checklists/${list.id}`, { items, notes: list.notes || "" });
    },
  });
}

function accountingTabs(active) {
  return tabBar([["#/accounting/charges", "Receivables"], ["#/accounting/payments", "Payments"], ["#/accounting/bills", "Bills"], ["#/accounting/purchase-orders", "Purchase orders"], ["#/accounting/deposits", "Deposits"], ["#/accounting/ledger", "General ledger"], ["#/accounting/reconciliation", "Reconciliation"], ["#/accounting/distributions", "Distributions"], ["#/accounting/statements", "Statements"], ["#/accounting/tax", "1099s"]], `#/accounting/${active}`);
}

async function accounting(outlet, tab, permissions) {
  const edit = can(permissions, "accounting.edit");
  const tabs = accountingTabs(tab);
  if (tab === "payments") {
    const rows = await api.get("/api/payments");
    outlet.innerHTML = page("Payments", edit ? button("Receive payment", "receive-payment") + button("Run autopay", "run-autopay", "ghost") : "", `${tabs}${table(["Date", "Resident", "Property", "Amount", "Method"], rows.map((row) => `<tr><td>${fmtDate(row.paid_at)}</td><td>${esc(row.first_name || "")} ${esc(row.last_name || "")}</td><td>${esc(row.property || "")}</td><td>${money(row.amount_cents)}</td><td>${esc(row.method)}</td></tr>`).join(""))}`);
    setActions({ ...sharedActions(), "run-autopay": async () => { const result = await api.post("/api/autopay/run", {}); toast(`Autopay recorded ${result.count} payment${result.count === 1 ? "" : "s"}`); await reload(); } });
    return;
  }
  if (tab === "bills") {
    const rows = await api.get("/api/bills");
    outlet.innerHTML = page("Bills", edit ? button("Enter bill", "new-bill") : "", `${tabs}${table(["Vendor", "Property", "Memo", "Amount", "Status", ""], rows.map((row) => `<tr><td>${esc(row.vendor || "")}</td><td>${esc(row.property || "")}</td><td>${esc(row.memo)}</td><td>${money(row.amount_cents)}</td><td>${badge(row.status)}</td><td>${edit && row.status === "pending_approval" ? `<button class="link" data-action="decide-bill" data-id="${row.id}" data-status="approved">Approve</button>` : ""}${edit && row.status === "approved" ? `<button class="link" data-action="pay-bill" data-id="${row.id}">Pay</button>` : ""}</td></tr>`).join(""))}`);
    setActions({ ...sharedActions(), "decide-bill": async (el) => { await api.post(`/api/bills/${el.dataset.id}/decide`, { status: el.dataset.status }); await reload(); }, "pay-bill": async (el) => { await api.post(`/api/bills/${el.dataset.id}/pay`, {}); toast("Paid from trust cash"); await reload(); } });
    return;
  }
  if (tab === "purchase-orders") {
    const rows = await api.get("/api/purchase-orders");
    outlet.innerHTML = page("Purchase orders", edit ? button("New purchase order", "new-po") : "", `${tabs}${table(["Vendor", "Property", "Memo", "Amount", "Status", ""], rows.map((row) => `<tr><td>${esc(row.vendor || "")}</td><td>${esc(row.property || "")}</td><td>${esc(row.memo)}</td><td>${money(row.amount_cents)}</td><td>${badge(row.status)}</td><td>${edit && row.status === "pending_approval" ? `<button class="link" data-action="decide-po" data-id="${row.id}" data-status="approved">Approve</button>` : ""}${edit && row.status === "approved" ? `<button class="link" data-action="convert-po" data-id="${row.id}">Make bill</button>` : ""}</td></tr>`).join(""))}`);
    setActions({
      "new-po": async () => {
        const data = await lookups();
        modalForm({
          title: "Purchase order",
          fields: [
            { label: "Vendor", name: "vendorId", type: "select", options: options(data.vendors, "id", (vendor) => vendor.name) },
            { label: "Property", name: "propertyId", type: "select", options: options(data.properties, "id", (property) => property.name) },
            { label: "Amount", name: "amount", type: "number", step: "0.01", required: true },
            { label: "Memo", name: "memo", required: true },
          ],
          onSubmit: async (form) => { await api.post("/api/purchase-orders", form); toast("Purchase order saved"); await reload(); },
        });
      },
      "decide-po": async (el) => { await api.post(`/api/purchase-orders/${el.dataset.id}/decide`, { status: "approved" }); await reload(); },
      "convert-po": async (el) => { await api.post(`/api/purchase-orders/${el.dataset.id}/convert`, {}); toast("Bill created"); await reload(); },
    });
    return;
  }
  if (tab === "deposits") {
    const rows = await api.get("/api/deposits");
    outlet.innerHTML = page("Security deposits", "", `${tabs}${table(["Resident", "Property", "Charged", "Held", "Status"], rows.map((row) => `<tr><td>${esc(row.first_name)} ${esc(row.last_name)}</td><td>${esc(row.property)} · ${esc(row.unit)}</td><td>${money(row.amount_cents)}</td><td>${money(row.held_cents)}</td><td>${badge(row.status)}</td></tr>`).join(""))}`);
    setActions({});
    return;
  }
  if (tab === "ledger") {
    const rows = await api.get("/api/ledger");
    outlet.innerHTML = page("General ledger", edit ? button("Journal entry", "new-journal") : "", `${tabs}${table(["Date", "Account", "Property", "Memo", "Debit", "Credit"], rows.map((row) => `<tr><td>${fmtDate(row.entry_date)}</td><td>${esc(row.code)} ${esc(row.account)}</td><td>${esc(row.property || "")}</td><td>${esc(row.memo)}</td><td>${row.debit_cents ? money(row.debit_cents) : ""}</td><td>${row.credit_cents ? money(row.credit_cents) : ""}</td></tr>`).join(""))}`);
    setActions({
      "new-journal": async () => {
        const data = await lookups();
        modalForm({
          title: "Journal entry",
          fields: [
            { label: "Date", name: "date", type: "date", value: todayInput(), required: true },
            { label: "Memo", name: "memo", required: true },
            { label: "Property", name: "propertyId", type: "select", options: options(data.properties, "id", (property) => property.name, "Company level") },
            { label: "Line 1 account", name: "code1", type: "select", options: data.accounts.map((account) => ({ value: account.code, label: `${account.code} ${account.name}` })) },
            { label: "Line 1 debit", name: "debit1", type: "number", step: "0.01" },
            { label: "Line 1 credit", name: "credit1", type: "number", step: "0.01" },
            { label: "Line 2 account", name: "code2", type: "select", options: data.accounts.map((account) => ({ value: account.code, label: `${account.code} ${account.name}` })) },
            { label: "Line 2 debit", name: "debit2", type: "number", step: "0.01" },
            { label: "Line 2 credit", name: "credit2", type: "number", step: "0.01" },
          ],
          onSubmit: async (form) => {
            await api.post("/api/journal", { date: form.date, memo: form.memo, propertyId: form.propertyId, lines: [{ code: form.code1, debit: form.debit1, credit: form.credit1 }, { code: form.code2, debit: form.debit2, credit: form.credit2 }] });
            toast("Journal entry posted");
            await reload();
          },
        });
      },
    });
    return;
  }
  if (tab === "reconciliation") {
    const [accounts, register, saved] = await Promise.all([api.get("/api/bank-accounts"), api.get("/api/bank-register"), api.get("/api/reconciliations")]);
    outlet.innerHTML = page("Bank reconciliation", "", `${tabs}<div class="card"><form class="inline" data-action="reconcile"><label>Account<select name="bankAccountId">${accounts.map((account) => `<option value="${account.id}">${esc(account.name)} · ${money(account.balance_cents)}</option>`).join("")}</select></label><label>Statement date<input type="date" name="statementDate" value="${todayInput()}"/></label><label>Statement balance<input type="number" step="0.01" name="statementBalance" required/></label><button class="btn btn-primary">Save reconciliation</button></form><p class="field-note">Mark cleared items, then save. A zero difference means the cleared register matches the statement.</p></div>${table(["Date", "Account", "Description", "Amount", "Cleared"], register.map((row) => `<tr><td>${fmtDate(row.txn_date)}</td><td>${esc(row.account || "")}</td><td>${esc(row.description)}</td><td>${money(row.amount_cents)}</td><td><input type="checkbox" data-change="clear" data-id="${row.id}" ${row.cleared ? "checked" : ""}/></td></tr>`).join(""))}<h2>History</h2>${saved.map((row) => `<p>${esc(row.account)} · ${fmtDate(row.statement_date)} · difference ${money(row.difference_cents)} ${badge(row.status)}</p>`).join("")}`);
    setActions({
      clear: async (el) => { await api.patch(`/api/bank-register/${el.dataset.id}`, { cleared: el.checked }); },
      reconcile: async (form) => {
        const result = await api.post("/api/reconciliations", Object.fromEntries(new FormData(form)));
        toast(result.difference === 0 ? "Reconciled" : `Still off by ${money(result.difference)}`);
        await reload();
      },
    });
    return;
  }
  if (tab === "distributions") {
    const [distributions, contributions] = await Promise.all([api.get("/api/distributions"), api.get("/api/contributions")]);
    outlet.innerHTML = page("Owner funds", edit ? button("Distribution", "new-distribution") + button("Contribution", "owner-receipt", "ghost") : "", `${tabs}<h2>Distributions</h2>${table(["Date", "Owner", "Property", "Amount"], distributions.map((row) => `<tr><td>${fmtDate(row.distributed_at)}</td><td>${esc(row.owner)}</td><td>${esc(row.property)}</td><td>${money(row.amount_cents)}</td></tr>`).join(""))}<h2>Contributions</h2>${table(["Date", "Owner", "Property", "Amount", "Memo"], contributions.map((row) => `<tr><td>${fmtDate(row.contributed_at)}</td><td>${esc(row.owner)}</td><td>${esc(row.property)}</td><td>${money(row.amount_cents)}</td><td>${esc(row.memo)}</td></tr>`).join(""))}`);
    setActions({
      ...sharedActions(),
      "new-distribution": async () => {
        const data = await lookups();
        modalForm({
          title: "Owner distribution",
          fields: [
            { label: "Owner", name: "ownerId", type: "select", options: options(data.owners, "id", (owner) => owner.name) },
            { label: "Property", name: "propertyId", type: "select", options: options(data.properties, "id", (property) => property.name) },
            { label: "Amount", name: "amount", type: "number", step: "0.01", required: true },
            { label: "Memo", name: "memo", value: "Monthly distribution" },
          ],
          onSubmit: async (form) => { await api.post("/api/distributions", form); toast("Distribution paid from trust cash"); await reload(); },
        });
      },
    });
    return;
  }
  if (tab === "statements") {
    const rows = await api.get("/api/statements");
    outlet.innerHTML = page("Owner statements", edit ? button("Generate statement", "new-statement") : "", `${tabs}${table(["Owner", "Property", "Period", "Ending", ""], rows.map((row) => `<tr><td>${esc(row.owner)}</td><td>${esc(row.property)}</td><td>${fmtDate(row.period_start)} – ${fmtDate(row.period_end)}</td><td>${money(row.ending_balance_cents)}</td><td>${link(`#/statements/${row.id}`, "Open")}</td></tr>`).join(""))}`);
    setActions({
      "new-statement": async () => {
        const data = await lookups();
        modalForm({
          title: "Generate owner statement",
          fields: [
            { label: "Owner", name: "ownerId", type: "select", options: options(data.owners, "id", (owner) => owner.name) },
            { label: "Property", name: "propertyId", type: "select", options: options(data.properties, "id", (property) => property.name) },
            { label: "Period start", name: "periodStart", type: "date", required: true },
            { label: "Period end", name: "periodEnd", type: "date", required: true },
            { type: "note", label: "Cash basis. Management fee posts when the statement is generated, using the agreement percent of rent collected." },
          ],
          onSubmit: async (form) => {
            const result = await api.post("/api/statements", form);
            location.hash = `#/statements/${result.id}`;
          },
        });
      },
    });
    return;
  }
  if (tab === "tax") {
    const year = new Date().getFullYear();
    const rows = await api.get(`/api/tax-1099s?year=${year}`);
    outlet.innerHTML = page(`${year} 1099s`, edit ? button("Refresh from paid bills", "refresh-tax") : "", `${tabs}<p class="lede">Totals come from bills paid this year. Mark a row filed after the form is actually submitted.</p>${table(["Vendor", "Amount", "Status", ""], rows.map((row) => `<tr><td>${esc(row.vendor)}</td><td>${money(row.amount_cents)}</td><td>${badge(row.status)}</td><td>${edit ? `<button class="link" data-action="file-tax" data-id="${row.id}">Mark filed</button>` : ""}</td></tr>`).join(""))}`);
    setActions({
      "refresh-tax": async () => { await api.post("/api/tax-1099s/refresh", { year }); toast("1099 totals refreshed"); await reload(); },
      "file-tax": async (el) => { await api.patch(`/api/tax-1099s/${el.dataset.id}`, { status: "filed" }); await reload(); },
    });
    return;
  }
  const [charges, plans] = await Promise.all([api.get("/api/charges"), api.get("/api/payment-plans")]);
  outlet.innerHTML = page("Receivables", edit ? `${button("Post charge", "post-charge", "ghost")}${button("Post this month's rent", "post-rent", "ghost")}${button("Post late fees", "late-fees")}` : "", `${tabs}<p class="lede">Partial payments stay open until the charge is covered. Late fees use the rule in Settings.</p>${table(["Resident", "Description", "Due", "Open", "Status"], charges.filter((row) => row.status !== "paid").map((row) => `<tr><td>${esc(row.first_name || "")} ${esc(row.last_name || "")}</td><td>${esc(row.description)}</td><td>${fmtDate(row.due_date)}</td><td>${money(row.amount_cents - row.paid_cents)}</td><td>${badge(row.status)}</td></tr>`).join(""))}<h2>Payment plans</h2>${table(["Resident", "Installment", "Remaining", "Status"], plans.map((row) => `<tr><td>${esc(row.first_name)} ${esc(row.last_name)}</td><td>${money(row.installment_cents)} ${esc(row.frequency)}</td><td>${money(row.remaining_cents)}</td><td>${badge(row.status)}</td></tr>`).join(""))}${edit ? button("New payment plan", "new-plan", "ghost") : ""}`);
  setActions({
    "post-charge": () => openCharge(),
    "post-rent": async () => { const result = await api.post("/api/rent/post-month", { month: todayInput().slice(0, 7) }); toast(`${result.created} rent charge${result.created === 1 ? "" : "s"} posted`); await reload(); },
    "late-fees": async () => { const result = await api.post("/api/late-fees/run", {}); toast(`${result.created} late fee${result.created === 1 ? "" : "s"} posted`); await reload(); },
    "new-plan": async () => {
      const data = await lookups();
      modalForm({
        title: "Payment plan",
        fields: [
          { label: "Lease", name: "leaseId", type: "select", options: options(data.leases, "id", leaseLabel) },
          { label: "Total", name: "total", type: "number", step: "0.01", required: true },
          { label: "Installment", name: "installment", type: "number", step: "0.01", required: true },
          { label: "Frequency", name: "frequency", type: "select", options: ["weekly", "monthly"].map((value) => ({ value, label: labelize(value) })) },
          { label: "Start", name: "startDate", type: "date", value: todayInput() },
          { label: "Notes", name: "notes", type: "textarea" },
        ],
        onSubmit: async (form) => { await api.post("/api/payment-plans", form); toast("Plan saved"); await reload(); },
      });
    },
  });
}

async function maintenance(outlet, tab, permissions) {
  const tabs = tabBar([["#/maintenance", "Work orders"], ["#/maintenance/recurring", "Recurring"], ["#/maintenance/approvals", "Approvals"], ["#/maintenance/inspections", "Field inspections"]], tab === "orders" ? "#/maintenance" : `#/maintenance/${tab}`);
  const edit = can(permissions, "maintenance.edit");
  if (tab === "recurring") {
    const rows = await api.get("/api/schedules");
    outlet.innerHTML = page("Recurring maintenance", edit ? button("New schedule", "new-schedule") : "", `${tabs}${table(["Task", "Property", "Vendor", "Frequency", "Next"], rows.map((row) => `<tr><td>${esc(row.title)}</td><td>${esc(row.property || "")}</td><td>${esc(row.vendor || "—")}</td><td>${esc(row.frequency)}</td><td>${fmtDate(row.next_date)}</td></tr>`).join(""))}`);
    setActions({
      "new-schedule": async () => {
        const data = await lookups();
        modalForm({
          title: "Recurring maintenance",
          fields: [
            { label: "Property", name: "propertyId", type: "select", options: options(data.properties, "id", (property) => property.name) },
            { label: "Vendor", name: "vendorId", type: "select", options: options(data.vendors, "id", (vendor) => vendor.name, "Unassigned") },
            { label: "Title", name: "title", required: true },
            { label: "Frequency", name: "frequency", type: "select", options: ["weekly", "monthly", "quarterly", "yearly"].map((value) => ({ value, label: labelize(value) })) },
            { label: "Next date", name: "nextDate", type: "date", required: true },
            { label: "Notes", name: "notes", type: "textarea" },
          ],
          onSubmit: async (form) => { await api.post("/api/schedules", form); toast("Schedule saved"); await reload(); },
        });
      },
    });
    return;
  }
  if (tab === "approvals") {
    const rows = await api.get("/api/approvals");
    outlet.innerHTML = page("Approvals", "", `${tabs}${table(["Kind", "Property", "Amount", "Status", ""], rows.map((row) => `<tr><td>${esc(labelize(row.kind))}<div class="muted">${esc(row.notes || "")}</div></td><td>${esc(row.property || "")}</td><td>${money(row.amount_cents)}</td><td>${badge(row.status)}</td><td>${edit && row.status === "pending" ? `<button class="link" data-action="decide" data-id="${row.id}" data-status="approved">Approve</button> <button class="link" data-action="decide" data-id="${row.id}" data-status="denied">Deny</button>` : ""}</td></tr>`).join(""))}`);
    setActions({ decide: async (el) => { await api.post(`/api/approvals/${el.dataset.id}/decide`, { status: el.dataset.status }); await reload(); } });
    return;
  }
  if (tab === "inspections") {
    const rows = await api.get("/api/inspections");
    outlet.innerHTML = page("Field inspections", edit ? button("New inspection", "new-inspection") : "", `${tabs}<p class="lede">Built for a phone on site: pick the unit, add notes, and attach a photo.</p>${rows.map((row) => `<article class="card"><strong>${esc(row.property || "")} · ${esc(row.unit || "")}</strong> ${badge(row.kind)}<p>${fmtDate(row.inspected_at)}</p><p>${esc(row.notes || "")}</p>${row.photo_url ? `<img class="photo" alt="" src="${esc(row.photo_url)}"/>` : ""}</article>`).join("") || empty("No inspections yet.")}`);
    setActions({
      "new-inspection": async () => {
        const data = await lookups();
        modalForm({
          title: "Inspection",
          fields: [
            { label: "Unit", name: "unitId", type: "select", options: options(data.units, "id", (unit) => `${unit.property_name} · ${unit.name}`) },
            { label: "Kind", name: "kind", type: "select", options: ["routine", "move_in", "move_out"].map((value) => ({ value, label: labelize(value) })) },
            { label: "Date", name: "inspectedAt", type: "date", value: todayInput() },
            { label: "Notes", name: "notes", type: "textarea" },
            { label: "Photo", name: "photo", type: "file" },
          ],
          onSubmit: async (form) => { await api.post("/api/inspections", form); toast("Inspection saved"); await reload(); },
        });
      },
    });
    return;
  }
  const rows = await api.get("/api/work-orders");
  outlet.innerHTML = page("Work orders", edit ? button("New work order", "new-work-order") : "", `${tabs}${table(["Request", "Property", "Vendor", "Priority", "Status"], rows.map((row) => `<tr><td>${link(`#/maintenance/${row.id}`, row.title)}</td><td>${esc(row.property || "")} ${esc(row.unit || "")}</td><td>${esc(row.vendor || "—")}</td><td>${badge(row.priority)}</td><td>${badge(row.status)}</td></tr>`).join(""))}`);
  setActions(sharedActions());
}

async function workOrderDetail(outlet, id, permissions) {
  const data = await api.get(`/api/work-orders/${id}`);
  const order = data.workOrder;
  const edit = can(permissions, "maintenance.edit");
  outlet.innerHTML = page(order.title, "", `<div class="card"><p>${link(`#/properties/${order.property_id}`, order.property || "")} ${esc(order.unit || "")}</p><p>${order.first_name ? esc(`${order.first_name} ${order.last_name}`) : ""}</p><p>${badge(order.status)} ${badge(order.priority)} ${esc(order.category || "")}</p><p>${esc(order.description || "")}</p>${order.photo_url ? `<img class="photo" alt="Request photo" src="${esc(order.photo_url)}"/>` : ""}<p>Estimate ${money(order.estimate_cents)} ${order.approved ? badge("approved") : ""}</p><p class="muted">Vendor: ${esc(order.vendor || "Unassigned")}</p></div>${edit ? `<form class="card stack" data-action="save-order"><label>Status<select name="status">${["new", "assigned", "scheduled", "in_progress", "estimate", "pending_approval", "approved", "completed", "cancelled"].map((status) => `<option ${order.status === status ? "selected" : ""} value="${status}">${esc(labelize(status))}</option>`).join("")}</select></label><label>Scheduled<input name="scheduledAt" value="${esc(order.scheduled_at || "")}"/></label><label>Estimate<input name="estimate" type="number" step="0.01" value="${order.estimate_cents ? (order.estimate_cents / 100).toFixed(2) : ""}"/></label><label>Note<textarea name="note"></textarea></label><button class="btn btn-primary">Save</button></form>` : ""}${data.notes.map((note) => `<div class="feed-item"><strong>${esc(note.author || "Note")}</strong><p>${esc(note.body)}</p></div>`).join("")}${data.approvals.map((approval) => `<p>Approval ${badge(approval.status)} · ${money(approval.amount_cents)}</p>`).join("")}`);
  setActions({
    "save-order": async (form) => {
      await api.patch(`/api/work-orders/${id}`, Object.fromEntries(new FormData(form)));
      toast("Work order updated");
      await reload();
    },
  });
}

async function reporting(outlet, name, query, permissions) {
  const cards = [["rent-roll", "Rent roll"], ["delinquency", "Delinquency"], ["vacancy", "Vacancy"], ["income-statement", "Income statement"], ["cash-flow", "Cash flow"], ["expirations", "Lease expirations"], ["ledger", "Resident ledger"]];
  if (!name) {
    outlet.innerHTML = page("Reporting", "", `<div class="grid-3">${cards.map(([id, label]) => `<button class="card" data-go="#/reporting/${id}"><h2>${esc(label)}</h2></button>`).join("")}</div>`);
    setActions({});
    return;
  }
  if (name === "ledger" && !query.get("lease")) {
    const data = await lookups();
    outlet.innerHTML = page("Resident ledger", "", `<form class="card inline" data-action="pick-lease"><label>Lease<select name="leaseId">${options(data.leases, "id", leaseLabel).map((option) => `<option value="${esc(option.value)}">${esc(option.label)}</option>`).join("")}</select></label><button class="btn btn-primary">Open</button></form>`);
    setActions({ "pick-lease": (form) => { location.hash = `#/reporting/ledger?lease=${new FormData(form).get("leaseId")}`; } });
    return;
  }
  const extra = name === "ledger" ? `?leaseId=${query.get("lease")}` : name === "income-statement" || name === "cash-flow" ? `?from=${query.get("from") || todayInput().slice(0, 8)}01&to=${query.get("to") || todayInput()}` : name === "expirations" && query.get("month") ? `?month=${query.get("month")}` : "";
  const report = await api.get(`/api/reports/${name}${extra}`);
  pageData.report = report;
  let body = "";
  if (name === "rent-roll") body = table(["Property", "Unit", "Resident", "Rent", "Balance", "Status"], report.map((row) => `<tr><td>${esc(row.property)}</td><td>${esc(row.unit)}</td><td>${esc(row.first_name || "Vacant")} ${esc(row.last_name || "")}</td><td>${money(row.rent_cents || row.market_rent_cents)}</td><td>${money(row.balance_cents)}</td><td>${badge(row.status)}</td></tr>`).join(""));
  else if (name === "delinquency") body = table(["Resident", "Property", "Oldest due", "Balance", ""], report.map((row) => `<tr><td>${esc(row.first_name)} ${esc(row.last_name)}<div class="muted">${esc(row.phone || "")}</div></td><td>${esc(row.property)} · ${esc(row.unit)}</td><td>${fmtDate(row.oldest_due)}</td><td>${money(row.balance_cents)}</td><td>${can(permissions, "communication.send") ? `<button class="link" data-action="send-notice" data-lease="${row.lease_id}">Send notice</button>` : ""}</td></tr>`).join(""));
  else if (name === "vacancy") body = table(["Property", "Unit", "Beds", "Market rent"], report.map((row) => `<tr><td>${esc(row.property)}<div class="muted">${esc(row.address)}</div></td><td>${esc(row.unit)}</td><td>${row.beds}/${row.baths}</td><td>${money(row.market_rent_cents)}</td></tr>`).join(""));
  else if (name === "income-statement") body = `<form class="inline" data-action="range"><input type="date" name="from" value="${esc(report.from)}"/><input type="date" name="to" value="${esc(report.to)}"/><button class="btn btn-ghost">Update</button></form>${table(["Account", "Type", "Amount"], report.rows.map((row) => `<tr><td>${esc(row.code)} ${esc(row.name)}</td><td>${esc(row.type)}</td><td>${money(row.amount_cents)}</td></tr>`).join(""))}`;
  else if (name === "cash-flow") body = `<form class="inline" data-action="range"><input type="date" name="from" value="${esc(report.from)}"/><input type="date" name="to" value="${esc(report.to)}"/><button class="btn btn-ghost">Update</button></form>${table(["Account", "In", "Out", "Net"], report.rows.map((row) => `<tr><td>${esc(row.name)}</td><td>${money(row.inflow_cents)}</td><td>${money(row.outflow_cents)}</td><td>${money(row.inflow_cents - row.outflow_cents)}</td></tr>`).join(""))}`;
  else if (name === "expirations") body = table(["Resident", "Property", "Ends", "Rent", "Status"], report.map((row) => `<tr><td>${link(`#/leases/${row.lease_id}`, `${row.first_name} ${row.last_name}`)}</td><td>${esc(row.property)} · ${esc(row.unit)}</td><td>${fmtDate(row.end_date)}</td><td>${money(row.rent_cents)}</td><td>${badge(row.status)}</td></tr>`).join(""));
  else if (name === "ledger") body = `<div class="card"><h2>${esc(report.tenant.first_name)} ${esc(report.tenant.last_name)}</h2><p>${esc(report.lease.property_name)} · Unit ${esc(report.lease.unit_name)}</p><p>Balance ${money(report.balance)}</p></div>${table(["Due", "Charge", "Amount", "Paid", "Status"], report.charges.map((row) => `<tr><td>${fmtDate(row.due_date)}</td><td>${esc(row.description)}</td><td>${money(row.amount_cents)}</td><td>${money(row.paid_cents)}</td><td>${badge(row.status)}</td></tr>`).join(""))}${table(["Paid", "Amount", "Method"], report.payments.map((row) => `<tr><td>${fmtDate(row.paid_at)}</td><td>${money(row.amount_cents)}</td><td>${esc(row.method)}</td></tr>`).join(""))}`;
  const exportRows = Array.isArray(report) ? report : report.rows || report.charges || [];
  outlet.innerHTML = page(labelize(name), `<button class="btn btn-ghost" data-action="export">Export CSV</button>`, body);
  setActions({
    export: () => downloadCsv(`${name}.csv`, exportRows),
    range: (form) => {
      const data = Object.fromEntries(new FormData(form));
      location.hash = `#/reporting/${name}?from=${data.from}&to=${data.to}`;
    },
    "send-notice": async (el) => {
      const templates = await api.get("/api/templates");
      const notices = templates.filter((template) => template.kind === "notice");
      modalForm({
        title: "Send a notice",
        fields: [
          { label: "Template", name: "templateId", type: "select", options: notices.map((template) => ({ value: template.id, label: template.name })) },
          { type: "note", label: "These are drafts. Have an attorney confirm a pay-or-quit notice before it is served." },
        ],
        onSubmit: async (form) => {
          const result = await api.post("/api/letters", { templateId: form.templateId, leaseId: el.dataset.lease });
          location.hash = `#/documents/${result.documentId}`;
        },
      });
    },
  });
}

async function communication(outlet, tab, permissions) {
  const tabs = tabBar([["#/communication/history", "History"], ["#/communication/texts", "Texts"], ["#/communication/announce", "Announcement"], ["#/communication/letters", "Letters"]], `#/communication/${tab === "history" ? "history" : tab}`);
  const send = can(permissions, "communication.send");
  if (tab === "texts") {
    const [rows, data] = await Promise.all([api.get("/api/communications"), lookups()]);
    const texts = rows.filter((row) => row.channel === "sms" || row.channel === "text");
    outlet.innerHTML = page("Texts", "", `${tabs}<p class="lede">Texts are saved on the resident. Connect Twilio in Settings when you want them delivered to the phone on file.</p>${send ? `<form class="card stack" data-action="send-text"><label>Resident<select name="tenantId">${options(data.tenants, "id", (tenant) => `${tenant.first_name} ${tenant.last_name}${tenant.phone ? ` · ${tenant.phone}` : ""}`).map((option) => `<option value="${esc(option.value)}">${esc(option.label)}</option>`).join("")}</select></label><label>Message<textarea name="body" required placeholder="Rent is ready to pay in the SunPilot app."></textarea></label><button class="btn btn-primary">Send text</button></form>` : ""}${texts.map((row) => `<article class="card"><strong>${esc(row.subject || "Text")}</strong><p class="muted">${fmtDate(row.created_at)}</p><p>${esc(row.body)}</p></article>`).join("") || empty("No texts yet.")}`);
    setActions({
      "send-text": async (form) => {
        const body = Object.fromEntries(new FormData(form));
        await api.post("/api/communications", { channel: "sms", subject: "Text", tenantId: body.tenantId, body: body.body });
        toast("Text saved");
        form.reset();
        await reload();
      },
    });
    return;
  }
  if (tab === "announce") {
    outlet.innerHTML = page("Announcement", "", `${tabs}<form class="card stack" data-action="announce"><label>Audience<select name="audience"><option value="tenants">Residents</option><option value="owners">Owners</option><option value="vendors">Vendors</option></select></label><label>Subject<input name="subject" required/></label><label>Message<textarea name="body" required></textarea></label>${send ? `<button class="btn btn-primary">Send</button>` : `<p>You can read messages, not send them.</p>`}</form>`);
    setActions({ announce: async (form) => { const result = await api.post("/api/announcements", Object.fromEntries(new FormData(form))); toast(`Sent to ${result.sent}`); form.reset(); } });
    return;
  }
  if (tab === "letters") {
    const [templates, data] = await Promise.all([api.get("/api/templates"), lookups()]);
    outlet.innerHTML = page("Letters and notices", "", `${tabs}<p class="lede">Merge fields include resident, address, balance, rent, and dates. Notice templates are drafts until your attorney signs off.</p><form class="card stack" data-action="letter"><label>Template<select name="templateId">${templates.map((template) => `<option value="${template.id}">${esc(template.name)}</option>`).join("")}</select></label><label>Lease<select name="leaseId">${options(data.leases, "id", leaseLabel).map((option) => `<option value="${esc(option.value)}">${esc(option.label)}</option>`).join("")}</select></label>${send ? `<button class="btn btn-primary">Create letter</button>` : ""}</form>${templates.map((template) => `<article class="card"><h2>${esc(template.name)} ${badge(template.kind)}</h2><pre class="doc">${esc(template.body)}</pre></article>`).join("")}`);
    setActions({ letter: async (form) => { const result = await api.post("/api/letters", Object.fromEntries(new FormData(form))); location.hash = `#/documents/${result.documentId}`; } });
    return;
  }
  const rows = await api.get("/api/communications");
  outlet.innerHTML = page("Communication", send ? button("Log a message", "log-message") : "", `${tabs}${rows.map((row) => `<article class="card"><strong>${esc(row.subject || labelize(row.channel))}</strong><p class="muted">${fmtDate(row.created_at)} · ${esc(row.channel)}</p><p>${esc(row.body)}</p></article>`).join("") || empty("No messages yet.")}`);
  setActions({
    "log-message": async () => {
      const data = await lookups();
      modalForm({
        title: "Log a message",
        fields: [
          { label: "Channel", name: "channel", type: "select", options: [["sms", "Text message"], ["email", "Email"], ["note", "Note"], ["call", "Call"]].map(([value, label]) => ({ value, label })) },
          { label: "Resident", name: "tenantId", type: "select", options: options(data.tenants, "id", (tenant) => `${tenant.first_name} ${tenant.last_name}`, "None") },
          { label: "Owner", name: "ownerId", type: "select", options: options(data.owners, "id", (owner) => owner.name, "None") },
          { label: "Vendor", name: "vendorId", type: "select", options: options(data.vendors, "id", (vendor) => vendor.name, "None") },
          { label: "Subject", name: "subject" },
          { label: "Message", name: "body", type: "textarea", required: true },
        ],
        onSubmit: async (form) => { await api.post("/api/communications", form); toast("Message logged"); await reload(); },
      });
    },
  });
}

function news(outlet) {
  const items = [
    ["Portfolio", "Properties, units, ownership shares, amenities, utilities, notes, and custom fields."],
    ["Leasing", "Guest cards, showings, applications, screening records, listings, lease drafts, signature tracking, renewals, and move-in or move-out."],
    ["Residents", "Portal for rent, autopay, maintenance with photos, documents, and messages."],
    ["Rent", "ACH, card, check, and cash receipts, partial payments, payment plans, monthly rent, and late fees."],
    ["Maintenance", "Work orders, vendor assignment, estimates, owner approvals, recurring schedules, and phone-friendly inspections."],
    ["Accounting", "Trust, operating, and deposit cash, bills, purchase orders, owner funds, statements, reconciliation, 1099 totals, and reports."],
    ["Owners and vendors", "Owners see statements, add funds, and approve repairs. Vendors update work orders and submit invoices."],
    ["Admin", "Roles, audit log, workflows, templates, and integration placeholders."],
  ];
  outlet.innerHTML = page("What's in SunPilot", "", `<div class="card"><p>SunPilot is the operating system for SunSeeker Rentals. Payments, screening, listing syndication, and e-sign are full workflows in this app. Live card settlement, credit reports, Zillow delivery, and legally binding signatures turn on when those providers are connected in Settings.</p></div>${items.map(([title, body]) => `<article class="card"><h2>${esc(title)}</h2><p>${esc(body)}</p></article>`).join("")}`);
  setActions({});
}

function settingsTabs(active) {
  return tabBar([["#/settings/company", "Company"], ["#/settings/banks", "Banks"], ["#/settings/fees", "Fees"], ["#/settings/late", "Late fees"], ["#/settings/agreements", "Agreements"], ["#/settings/users", "Users"], ["#/settings/roles", "Roles"], ["#/settings/workflows", "Workflows"], ["#/settings/fields", "Custom fields"], ["#/settings/integrations", "Integrations"], ["#/settings/resets", "Password resets"], ["#/settings/audit", "Audit log"]], `#/settings/${active}`);
}

async function settings(outlet, tab, permissions) {
  if (!can(permissions, "admin.edit")) {
    outlet.innerHTML = empty("Settings are limited to administrators.");
    setActions({});
    return;
  }
  const tabs = settingsTabs(tab);
  if (tab === "banks") {
    const rows = await api.get("/api/bank-accounts");
    outlet.innerHTML = page("Bank accounts", button("Add account", "add-bank"), `${tabs}${table(["Account", "Bank", "Type", "Last 4", "Book balance"], rows.map((row) => `<tr><td>${esc(row.name)}</td><td>${esc(row.bank_name || "")}</td><td>${esc(labelize(row.account_type))}</td><td>${esc(row.last4 || "")}</td><td>${money(row.balance_cents)}</td></tr>`).join(""))}`);
    setActions({ add: undefined, "add-bank": () => modalForm({ title: "Bank account", fields: [{ label: "Name", name: "name", required: true }, { label: "Bank", name: "bankName" }, { label: "Type", name: "accountType", type: "select", options: ["trust", "security_deposit", "operating"].map((value) => ({ value, label: labelize(value) })) }, { label: "Last 4", name: "last4" }], onSubmit: async (data) => { await api.post("/api/bank-accounts", data); toast("Account added"); await reload(); } }) });
    return;
  }
  if (tab === "fees") {
    const rows = await api.get("/api/fees");
    outlet.innerHTML = page("Fee schedule", button("Add fee", "add-fee"), `${tabs}${table(["Fee", "Type", "Amount", "Percent"], rows.map((row) => `<tr><td>${esc(row.name)}</td><td>${esc(row.fee_type)}</td><td>${money(row.amount_cents)}</td><td>${row.percent || 0}%</td></tr>`).join(""))}`);
    setActions({ "add-fee": () => modalForm({ title: "Fee", fields: [{ label: "Name", name: "name", required: true }, { label: "Type", name: "feeType" }, { label: "Flat amount", name: "amount", type: "number", step: "0.01" }, { label: "Percent", name: "percent", type: "number", step: "0.01" }, { label: "Notes", name: "notes" }], onSubmit: async (data) => { await api.post("/api/fees", data); await reload(); } }) });
    return;
  }
  if (tab === "late") {
    const rows = await api.get("/api/late-fee-rules");
    outlet.innerHTML = page("Late fees", button("Add rule", "add-rule"), `${tabs}${table(["Rule", "Grace days", "Type", "Amount", "Percent"], rows.map((row) => `<tr><td>${esc(row.name)}</td><td>${row.grace_days}</td><td>${esc(row.fee_type)}</td><td>${money(row.amount_cents)}</td><td>${row.percent || 0}%</td></tr>`).join(""))}`);
    setActions({ "add-rule": () => modalForm({ title: "Late fee rule", fields: [{ label: "Name", name: "name", required: true }, { label: "Grace days", name: "graceDays", type: "number", value: "5" }, { label: "Type", name: "feeType", type: "select", options: [{ value: "flat", label: "Flat" }, { value: "percent", label: "Percent of unpaid rent" }] }, { label: "Flat amount", name: "amount", type: "number", step: "0.01" }, { label: "Percent", name: "percent", type: "number", step: "0.01" }], onSubmit: async (data) => { await api.post("/api/late-fee-rules", data); await reload(); } }) });
    return;
  }
  if (tab === "agreements") {
    const rows = await api.get("/api/agreements");
    outlet.innerHTML = page("Management agreements", button("New agreement", "add-agreement"), `${tabs}${table(["Property", "Owner", "Fee", "Leasing fee", "Repair threshold", "Status"], rows.map((row) => `<tr><td>${esc(row.property)}</td><td>${esc(row.owner)}</td><td>${row.management_fee_percent}%</td><td>${row.leasing_fee_percent}%</td><td>${money(row.repair_approval_threshold_cents)}</td><td>${badge(row.status)}</td></tr>`).join(""))}`);
    setActions({
      "add-agreement": async () => {
        const data = await lookups();
        modalForm({
          title: "Management agreement",
          fields: [
            { label: "Property", name: "propertyId", type: "select", options: options(data.properties, "id", (property) => property.name) },
            { label: "Owner", name: "ownerId", type: "select", options: options(data.owners, "id", (owner) => owner.name) },
            { label: "Start", name: "startDate", type: "date", required: true, value: todayInput() },
            { label: "End", name: "endDate", type: "date" },
            { label: "Management fee %", name: "managementFeePercent", type: "number", step: "0.01", value: "8" },
            { label: "Leasing fee %", name: "leasingFeePercent", type: "number", step: "0.01", value: "50" },
            { label: "Renewal fee", name: "renewalFee", type: "number", step: "0.01", value: "200" },
            { label: "Reserve", name: "reserve", type: "number", step: "0.01" },
            { label: "Repair approval threshold", name: "repairThreshold", type: "number", step: "0.01", value: "300" },
          ],
          onSubmit: async (form) => { await api.post("/api/agreements", form); toast("Agreement saved"); await reload(); },
        });
      },
    });
    return;
  }
  if (tab === "users") {
    const rows = await api.get("/api/users");
    outlet.innerHTML = page("Users", button("New user", "add-user"), `${tabs}${table(["Name", "Email", "Role", "Status", ""], rows.map((row) => `<tr><td>${esc(row.name)}</td><td>${esc(row.email)}</td><td>${esc(row.role)}</td><td>${row.active ? badge("active") : badge("ended")}</td><td><button class="link" data-action="reset-user" data-id="${row.id}">Reset password</button> ${row.active ? `<button class="link" data-action="disable-user" data-id="${row.id}" data-name="${esc(row.name)}" data-role="${esc(row.role)}" data-phone="${esc(row.phone || "")}">Deactivate</button>` : ""}</td></tr>`).join(""))}`);
    setActions({
      "add-user": async () => {
        const data = await lookups();
        modalForm({
          title: "User",
          fields: [
            { label: "Name", name: "name", required: true },
            { label: "Email", name: "email", type: "email", required: true },
            { label: "Password", name: "password", required: true, value: "sunseeker" },
            { label: "Role", name: "role", type: "select", options: ["admin", "manager", "leasing", "accounting", "maintenance", "owner", "tenant", "vendor"].map((value) => ({ value, label: labelize(value) })) },
            { label: "Phone", name: "phone" },
            { label: "Link owner", name: "ownerId", type: "select", options: options(data.owners, "id", (owner) => owner.name, "None") },
            { label: "Link resident", name: "tenantId", type: "select", options: options(data.tenants, "id", (tenant) => `${tenant.first_name} ${tenant.last_name}`, "None") },
            { label: "Link vendor", name: "vendorId", type: "select", options: options(data.vendors, "id", (vendor) => vendor.name, "None") },
          ],
          onSubmit: async (form) => { await api.post("/api/users", form); toast("User created"); await reload(); },
        });
      },
      "reset-user": (el) => modalForm({ title: "Reset password", fields: [{ label: "New password", name: "password", required: true }], onSubmit: async (form) => { await api.post(`/api/users/${el.dataset.id}/reset-password`, form); toast("Password updated"); } }),
      "disable-user": async (el) => { await api.patch(`/api/users/${el.dataset.id}`, { name: el.dataset.name, role: el.dataset.role, phone: el.dataset.phone, active: false }); toast("User deactivated"); await reload(); },
    });
    return;
  }
  if (tab === "roles") {
    const rows = await api.get("/api/permissions");
    const roles = [...new Set(rows.map((row) => row.role))];
    outlet.innerHTML = page("Roles", "", `${tabs}${table(["Permission", ...roles], [...new Set(rows.map((row) => row.permission))].map((permission) => `<tr><td>${esc(permission)}</td>${roles.map((role) => { const row = rows.find((item) => item.role === role && item.permission === permission); return `<td><input type="checkbox" data-change="perm" data-role="${esc(role)}" data-permission="${esc(permission)}" ${row?.allowed ? "checked" : ""}/></td>`; }).join("")}</tr>`).join(""))}`);
    setActions({ perm: async (el) => { await api.put("/api/permissions", { role: el.dataset.role, permission: el.dataset.permission, allowed: el.checked }); toast("Permission saved"); } });
    return;
  }
  if (tab === "workflows") {
    const rows = await api.get("/api/workflows");
    outlet.innerHTML = page("Workflows", button("New workflow", "add-workflow"), `${tabs}${rows.map((row) => `<article class="card"><h2>${esc(row.name)} ${row.active ? badge("active") : badge("ended")}</h2><p>${esc(row.notes || "")}</p><p class="muted">${esc(row.trigger)} · threshold ${money(row.amount_threshold_cents)} · ${row.days_before || 0} days</p></article>`).join("")}`);
    setActions({ "add-workflow": () => modalForm({ title: "Workflow", fields: [{ label: "Name", name: "name", required: true }, { label: "Trigger", name: "trigger", type: "select", options: ["bill", "estimate", "renewal"].map((value) => ({ value, label: labelize(value) })) }, { label: "Amount threshold", name: "amount", type: "number", step: "0.01" }, { label: "Days before", name: "daysBefore", type: "number" }, { label: "Notes", name: "notes", type: "textarea" }], onSubmit: async (data) => { await api.post("/api/workflows", data); await reload(); } }) });
    return;
  }
  if (tab === "fields") {
    const rows = await api.get("/api/custom-fields");
    outlet.innerHTML = page("Custom fields", button("Add field", "add-field"), `${tabs}${table(["Record", "Label", "Type", ""], rows.map((row) => `<tr><td>${esc(row.entity)}</td><td>${esc(row.label)}</td><td>${esc(row.field_type)}</td><td><button class="link" data-action="delete-field" data-id="${row.id}">Delete</button></td></tr>`).join(""))}`);
    setActions({
      "add-field": () => modalForm({ title: "Custom field", fields: [{ label: "Record", name: "entity", type: "select", options: ["property", "unit", "tenant", "owner"].map((value) => ({ value, label: labelize(value) })) }, { label: "Label", name: "label", required: true }, { label: "Type", name: "fieldType", value: "text" }], onSubmit: async (data) => { await api.post("/api/custom-fields", data); await reload(); } }),
      "delete-field": async (el) => { await api.del(`/api/custom-fields/${el.dataset.id}`); await reload(); },
    });
    return;
  }
  if (tab === "integrations") {
    const rows = await api.get("/api/integrations");
    outlet.innerHTML = page("Integrations", "", `${tabs}<p class="lede">Save a provider key on this computer when you are ready. SunPilot will not send data to that provider until a live connection is built.</p>${rows.map((row) => `<article class="card"><h2>${esc(row.name)} ${badge(row.status)}</h2><p class="muted">${esc(row.category)} · ${esc(row.notes || "")}</p><button class="btn btn-ghost" data-action="configure" data-id="${row.id}" data-name="${esc(row.name)}">Save key</button></article>`).join("")}`);
    setActions({ configure: (el) => modalForm({ title: el.dataset.name, fields: [{ label: "API key or account id", name: "config" }, { type: "note", label: "Stored only in the local SunPilot database." }], onSubmit: async (data) => { await api.patch(`/api/integrations/${el.dataset.id}`, data); toast("Integration setting saved"); await reload(); } }) });
    return;
  }
  if (tab === "resets") {
    const rows = await api.get("/api/password-resets");
    outlet.innerHTML = page("Password resets", "", `${tabs}${table(["Email", "Requested", ""], rows.map((row) => `<tr><td>${esc(row.user_email || row.email)}</td><td>${fmtDate(row.created_at)}</td><td><button class="link" data-action="reset-user" data-id="${row.user_id}">Set a new password</button></td></tr>`).join("")) || empty("No open reset requests.")}`);
    setActions({ "reset-user": (el) => modalForm({ title: "Reset password", fields: [{ label: "New password", name: "password", required: true }], onSubmit: async (data) => { await api.post(`/api/users/${el.dataset.id}/reset-password`, data); toast("Password updated"); await reload(); } }) });
    return;
  }
  if (tab === "audit") {
    const rows = await api.get("/api/audit");
    outlet.innerHTML = page("Audit log", "", `${tabs}${table(["When", "Who", "Action", "Record", "Detail"], rows.map((row) => `<tr><td>${fmtDate(row.created_at)}</td><td>${esc(row.user_name || "System")}</td><td>${esc(row.action)}</td><td>${esc(row.entity || "")} ${row.entity_id || ""}</td><td>${esc(row.detail || "")}</td></tr>`).join(""))}`);
    setActions({});
    return;
  }
  const company = await api.get("/api/company");
  outlet.innerHTML = page("Company", "", `${tabs}<form class="card stack" data-action="save-company"><label>Name<input name="name" value="${esc(company.name)}"/></label><label>Legal name<input name="legalName" value="${esc(company.legal_name || "")}"/></label><label>Phone<input name="phone" value="${esc(company.phone || "")}"/></label><label>Email<input name="email" value="${esc(company.email || "")}"/></label><label>Address<input name="address" value="${esc(company.address || "")}"/></label><label>City<input name="city" value="${esc(company.city || "")}"/></label><label>State<input name="state" value="${esc(company.state || "")}"/></label><label>ZIP<input name="zip" value="${esc(company.zip || "")}"/></label><label>Timezone<input name="timezone" value="${esc(company.timezone || "")}"/></label><button class="btn btn-primary">Save company</button></form>`);
  setActions({ "save-company": async (form) => { await api.patch("/api/company", Object.fromEntries(new FormData(form))); toast("Company saved"); } });
}
