const path = require("path");
const crypto = require("crypto");
const { createApp, json, staticFiles } = require("./httpapp");
const db = require("./db");

db.init();

const app = createApp();
const publicDir = path.join(__dirname, "public");
app.use(json());
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const STAFF = new Set(["admin", "manager", "leasing", "accounting", "maintenance"]);

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  const part = raw.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : "";
}

function publicUser(user) {
  if (!user) return null;
  const { password_hash, ...rest } = user;
  return rest;
}

app.use((req, _res, next) => {
  const token = readCookie(req, "sid");
  if (token) {
    req.user = db.one(
      "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1",
      token
    );
  }
  next();
});

function route(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) console.error(error);
      res.status(status).json({ error: error.message || "Something went wrong" });
    }
  };
}

function signIn(req) {
  if (!req.user) throw db.fail(401, "Sign in required");
}

function staffOnly(req) {
  signIn(req);
  if (!STAFF.has(req.user.role)) throw db.fail(403, "Property manager access required");
}

function permit(req, permission) {
  staffOnly(req);
  const allowed = db.one(
    "SELECT allowed FROM role_permissions WHERE role = ? AND permission = ?",
    req.user.role,
    permission
  );
  if (!allowed || !allowed.allowed) throw db.fail(403, "You do not have permission for that");
}

function str(value) {
  return String(value ?? "").trim();
}

function required(value, label) {
  const text = str(value);
  if (!text) throw db.fail(400, `${label} is required`);
  return text;
}

function int(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function dollars(value) {
  const number = Number(String(value ?? "").replace(/[$,]/g, ""));
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100);
}

function recordId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw db.fail(404, "That record was not found");
  return id;
}

function moneyText(cents) {
  return (Number(cents || 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function renderTemplate(body, vars) {
  return String(body || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => (vars[key] == null ? "" : String(vars[key])));
}

function setSession(res, userId) {
  const token = crypto.randomBytes(24).toString("hex");
  db.add("sessions", { token, user_id: userId, created_at: db.nowStamp() });
  res.setHeader("Set-Cookie", `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600`);
}

function patchRow(table, id, changes) {
  const keys = Object.keys(changes);
  if (!keys.length) return;
  db.run(`UPDATE ${table} SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`, ...keys.map((key) => changes[key]), id);
}

function monthBounds(month) {
  const [year, mon] = month.split("-").map(Number);
  const last = new Date(year, mon, 0).getDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
}

function leaseBalance(leaseId) {
  return db.one(
    "SELECT COALESCE(SUM(amount_cents - paid_cents), 0) AS amount FROM charges WHERE lease_id = ? AND status != 'paid'",
    leaseId
  ).amount;
}

function currentLease(tenantId) {
  return db.one(
    `SELECT l.*, u.name AS unit_name, u.property_id, p.name AS property_name, p.address, p.city, p.state, p.zip
     FROM leases l
     JOIN units u ON u.id = l.unit_id
     JOIN properties p ON p.id = u.property_id
     WHERE l.tenant_id = ? AND l.status IN ('active', 'notice', 'future')
     ORDER BY CASE l.status WHEN 'active' THEN 0 WHEN 'notice' THEN 1 ELSE 2 END, l.id DESC
     LIMIT 1`,
    tenantId
  );
}

function mergeFields(lease, extra = {}) {
  const company = db.one("SELECT * FROM company WHERE id = 1");
  const tenant = lease ? db.one("SELECT * FROM tenants WHERE id = ?", lease.tenant_id) : null;
  return {
    company_name: company.name,
    company_phone: company.phone,
    tenant_name: tenant ? `${tenant.first_name} ${tenant.last_name}` : "",
    property_address: lease ? `${lease.address}, ${lease.city}` : "",
    unit: lease ? lease.unit_name : "",
    balance: lease ? moneyText(leaseBalance(lease.id)) : "",
    rent: lease ? moneyText(lease.rent_cents) : "",
    deposit: lease ? moneyText(lease.deposit_cents) : "",
    start_date: lease ? lease.start_date : "",
    end_date: lease ? lease.end_date : "",
    due_day: lease ? String(lease.due_day || 1) : "1",
    today: db.today(),
    ...extra,
  };
}

function assertOwnerProperty(user, propertyId) {
  const row = db.one("SELECT id FROM ownerships WHERE owner_id = ? AND property_id = ?", user.owner_id, propertyId);
  if (!row) throw db.fail(403, "That property is not in your portfolio");
}

app.get("/api/public", route((_req, res) => {
  res.json({ company: db.one("SELECT name, phone, email FROM company WHERE id = 1") });
}));

app.post("/api/login", route((req, res) => {
  const email = str(req.body.email).toLowerCase();
  const password = String(req.body.password || "");
  const portal = str(req.body.portal || "staff");
  const user = db.one("SELECT * FROM users WHERE email = ?", email);
  if (!user || !user.active || !db.verifyPassword(password, user.password_hash)) {
    throw db.fail(401, "Email or password is incorrect");
  }
  if (portal === "owner" && user.role !== "owner") throw db.fail(403, "That login is not an owner account");
  if (portal === "tenant" && user.role !== "tenant") throw db.fail(403, "That login is not a resident account");
  if (portal === "vendor" && user.role !== "vendor") throw db.fail(403, "That login is not a vendor account");
  setSession(res, user.id);
  db.audit(user.id, "user.login", "user", user.id, portal);
  res.json({ user: publicUser(user), permissions: db.permissionsFor(user.role) });
}));

app.post("/api/logout", route((req, res) => {
  const token = readCookie(req, "sid");
  if (token) db.run("DELETE FROM sessions WHERE token = ?", token);
  res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
}));

app.get("/api/me", route((req, res) => {
  signIn(req);
  res.json({
    user: publicUser(req.user),
    permissions: db.permissionsFor(req.user.role),
    company: db.one("SELECT name, legal_name, phone, email FROM company WHERE id = 1"),
  });
}));

app.post("/api/forgot-password", route((req, res) => {
  const email = str(req.body.email).toLowerCase();
  const user = db.one("SELECT id FROM users WHERE email = ?", email);
  if (user) {
    db.add("password_resets", { user_id: user.id, email, status: "open", created_at: db.nowStamp() });
  }
  res.json({ ok: true, message: "If that email has an account, a property manager can reset the password from Settings." });
}));

app.get("/api/password-resets", route((req, res) => {
  permit(req, "admin.edit");
  res.json(db.all(
    `SELECT r.*, u.name, u.email AS user_email FROM password_resets r
     LEFT JOIN users u ON u.id = r.user_id WHERE r.status = 'open' ORDER BY r.id DESC`
  ));
}));

app.post("/api/users/:id/reset-password", route((req, res) => {
  permit(req, "admin.edit");
  const id = recordId(req.params.id);
  const password = required(req.body.password, "Password");
  if (password.length < 8) throw db.fail(400, "Password must be at least 8 characters");
  db.run("UPDATE users SET password_hash = ? WHERE id = ?", db.hashPassword(password), id);
  db.run("UPDATE password_resets SET status = 'completed' WHERE user_id = ? AND status = 'open'", id);
  db.audit(req.user.id, "user.password_reset", "user", id, "");
  res.json({ ok: true });
}));

app.get("/api/dashboard", route((req, res) => {
  staffOnly(req);
  const propertyId = Number(req.query.propertyId) || 0;
  const propertySql = propertyId ? "AND p.id = ?" : "";
  const params = propertyId ? [propertyId] : [];
  const today = db.today();
  const soon = db.addDays(30);
  const week = db.addDays(7);
  const moveIns = db.all(
    `SELECT l.id, l.start_date, l.status, t.first_name, t.last_name, u.name AS unit, p.name AS property
     FROM leases l JOIN tenants t ON t.id = l.tenant_id JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
     WHERE l.status IN ('future', 'active') AND l.start_date >= ? AND l.start_date <= ? ${propertySql}
     ORDER BY l.start_date`,
    db.addDays(-3), soon, ...params
  );
  const moveOuts = db.all(
    `SELECT l.id, l.end_date, l.status, t.first_name, t.last_name, u.name AS unit, p.name AS property
     FROM leases l JOIN tenants t ON t.id = l.tenant_id JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
     WHERE l.status IN ('notice', 'active') AND l.end_date <= ? AND l.end_date >= ? ${propertySql}
     ORDER BY l.end_date`,
    soon, db.addDays(-3), ...params
  );
  const payments = db.all(
    `SELECT p.id, p.amount_cents, p.method, p.paid_at, t.first_name, t.last_name, pr.name AS property
     FROM payments p JOIN tenants t ON t.id = p.tenant_id JOIN properties pr ON pr.id = p.property_id
     WHERE p.status = 'completed' ${propertyId ? "AND p.property_id = ?" : ""}
     ORDER BY p.paid_at DESC, p.id DESC LIMIT 8`,
    ...params
  );
  const activities = [];
  const showings = db.all(
    `SELECT s.scheduled_at, s.status, pr.name AS who, p.id AS property_id
     FROM showings s LEFT JOIN prospects pr ON pr.id = s.prospect_id
     LEFT JOIN units u ON u.id = s.unit_id LEFT JOIN properties p ON p.id = u.property_id
     WHERE s.status = 'scheduled'`
  );
  const work = db.all(
    `SELECT scheduled_at, title, status, property_id FROM work_orders
     WHERE status NOT IN ('completed', 'cancelled') AND scheduled_at != ''`
  );
  const bills = db.all("SELECT due_date, memo, status, property_id FROM bills WHERE status NOT IN ('paid', 'rejected')");
  for (const item of [...showings.map((row) => ({ ...row, label: `Showing · ${row.who || "Prospect"}` })), ...work.map((row) => ({ ...row, label: row.title, scheduled_at: row.scheduled_at })), ...bills.map((row) => ({ ...row, label: row.memo || "Bill", scheduled_at: row.due_date }))]) {
    if (propertyId && item.property_id !== propertyId) continue;
    const date = String(item.scheduled_at || "").slice(0, 10);
    if (!date) continue;
    if (date < today) activities.push({ ...item, bucket: "overdue", date });
    else if (date <= week) activities.push({ ...item, bucket: "due", date });
  }
  const feed = db.all(
    "SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 12",
    req.user.id
  );
  const birthdays = db.all("SELECT first_name, last_name, birth_date FROM tenants WHERE birth_date != ''").flatMap((tenant) => {
    const month = Number(tenant.birth_date.slice(5, 7));
    const day = Number(tenant.birth_date.slice(8, 10));
    if (!month || !day) return [];
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let next = new Date(now.getFullYear(), month - 1, day);
    if (next < start) next = new Date(now.getFullYear() + 1, month - 1, day);
    const delta = Math.round((next - start) / 86400000);
    if (delta < 0 || delta > 7) return [];
    return [{ title: `${tenant.first_name} ${tenant.last_name}'s birthday is in ${delta} day${delta === 1 ? "" : "s"}`, body: tenant.birth_date, href: "#/people/tenants" }];
  });
  const insurance = db.all(
    "SELECT name, insurance_expires FROM vendors WHERE insurance_expires != '' AND insurance_expires <= ?",
    db.addDays(30)
  ).map((vendor) => ({ title: `${vendor.name} insurance expires ${vendor.insurance_expires}`, body: "Update the certificate in the vendor record.", href: "#/people/vendors" }));
  res.json({
    properties: db.all("SELECT id, name FROM properties ORDER BY name"),
    moveIns,
    moveOuts,
    payments,
    activitiesDue: activities.filter((item) => item.bucket === "due").length,
    activitiesOverdue: activities.filter((item) => item.bucket === "overdue").length,
    billsPending: db.one("SELECT COUNT(*) AS n FROM bills WHERE status = 'pending_approval'").n,
    purchaseOrdersPending: db.one("SELECT COUNT(*) AS n FROM purchase_orders WHERE status = 'pending_approval'").n,
    feed,
    reminders: [...birthdays, ...insurance],
  });
}));

app.get("/api/search", route((req, res) => {
  staffOnly(req);
  const term = `%${str(req.query.q)}%`;
  if (str(req.query.q).length < 2) return res.json([]);
  const results = [
    ...db.all("SELECT id, name AS label, 'Property' AS kind, '#/properties/' || id AS href FROM properties WHERE name LIKE ? OR address LIKE ? LIMIT 6", term, term),
    ...db.all("SELECT id, first_name || ' ' || last_name AS label, 'Resident' AS kind, '#/people/tenants/' || id AS href FROM tenants WHERE first_name || ' ' || last_name LIKE ? OR email LIKE ? LIMIT 6", term, term),
    ...db.all("SELECT id, name AS label, 'Owner' AS kind, '#/people/owners/' || id AS href FROM owners WHERE name LIKE ? OR email LIKE ? LIMIT 6", term, term),
    ...db.all("SELECT id, name AS label, 'Vendor' AS kind, '#/people/vendors/' || id AS href FROM vendors WHERE name LIKE ? LIMIT 6", term),
    ...db.all("SELECT id, title AS label, 'Work order' AS kind, '#/maintenance/' || id AS href FROM work_orders WHERE title LIKE ? LIMIT 6", term),
  ];
  res.json(results);
}));

app.get("/api/calendar", route((req, res) => {
  staffOnly(req);
  const month = /^\d{4}-\d{2}$/.test(str(req.query.month)) ? str(req.query.month) : db.today().slice(0, 7);
  const { start, end } = monthBounds(month);
  const events = [];
  const between = (value) => {
    const date = String(value || "").slice(0, 10);
    return date >= start && date <= end ? date : "";
  };
  for (const row of db.all("SELECT l.start_date, l.end_date, t.first_name, t.last_name, p.name AS property FROM leases l JOIN tenants t ON t.id = l.tenant_id JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id WHERE l.status != 'ended'")) {
    const moveIn = between(row.start_date);
    const moveOut = between(row.end_date);
    if (moveIn) events.push({ date: moveIn, kind: "move-in", title: `Move in · ${row.first_name} ${row.last_name}`, href: "#/leasing" });
    if (moveOut) events.push({ date: moveOut, kind: "move-out", title: `Lease ends · ${row.first_name} ${row.last_name}`, href: "#/leasing" });
  }
  for (const row of db.all("SELECT s.scheduled_at, s.showing_type, pr.name FROM showings s LEFT JOIN prospects pr ON pr.id = s.prospect_id")) {
    const date = between(row.scheduled_at);
    if (date) events.push({ date, kind: "showing", title: `${row.showing_type || "Showing"} · ${row.name || "Prospect"}`, href: "#/leasing" });
  }
  for (const row of db.all("SELECT id, title, scheduled_at FROM work_orders WHERE scheduled_at != ''")) {
    const date = between(row.scheduled_at);
    if (date) events.push({ date, kind: "work", title: row.title, href: `#/maintenance/${row.id}` });
  }
  for (const row of db.all("SELECT title, next_date FROM maintenance_schedules")) {
    const date = between(row.next_date);
    if (date) events.push({ date, kind: "recurring", title: row.title, href: "#/maintenance" });
  }
  for (const row of db.all("SELECT memo, due_date FROM bills WHERE status NOT IN ('paid', 'rejected')")) {
    const date = between(row.due_date);
    if (date) events.push({ date, kind: "bill", title: row.memo || "Bill due", href: "#/accounting" });
  }
  res.json({ month, events });
}));

app.get("/api/notifications", route((req, res) => {
  signIn(req);
  res.json(db.all("SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30", req.user.id));
}));

app.post("/api/notifications/:id/read", route((req, res) => {
  signIn(req);
  db.run("UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?", recordId(req.params.id), req.user.id);
  res.json({ ok: true });
}));

app.get("/api/lookups", route((req, res) => {
  staffOnly(req);
  res.json({
    properties: db.all("SELECT id, name FROM properties ORDER BY name"),
    units: db.all("SELECT u.id, u.name, u.property_id, u.status, p.name AS property_name FROM units u JOIN properties p ON p.id = u.property_id ORDER BY p.name, u.name"),
    owners: db.all("SELECT id, name FROM owners ORDER BY name"),
    tenants: db.all("SELECT id, first_name, last_name, email, phone FROM tenants ORDER BY last_name, first_name"),
    vendors: db.all("SELECT id, name, trade FROM vendors ORDER BY name"),
    leases: db.all(
      `SELECT l.id, l.status, l.rent_cents, t.first_name, t.last_name, u.name AS unit, p.name AS property
       FROM leases l JOIN tenants t ON t.id = l.tenant_id JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
       WHERE l.status IN ('active', 'notice', 'future') ORDER BY p.name, u.name`
    ),
    accounts: db.all("SELECT code, name, type FROM accounts ORDER BY code"),
  });
}));

app.get("/api/properties", route((req, res) => {
  staffOnly(req);
  res.json(db.all(
    `SELECT p.*,
      (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id) AS unit_count,
      (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id AND u.status = 'occupied') AS occupied_count,
      (SELECT GROUP_CONCAT(o.name || ' ' || ow.percent || '%', ', ') FROM ownerships ow JOIN owners o ON o.id = ow.owner_id WHERE ow.property_id = p.id) AS owner_summary
     FROM properties p ORDER BY p.name`
  ));
}));

app.post("/api/properties", route((req, res) => {
  permit(req, "portfolio.edit");
  const id = db.add("properties", {
    name: required(req.body.name, "Property name"),
    address: required(req.body.address, "Address"),
    city: str(req.body.city),
    state: str(req.body.state || "AZ"),
    zip: str(req.body.zip),
    property_type: str(req.body.propertyType || "single_family"),
    year_built: req.body.yearBuilt ? int(req.body.yearBuilt) : null,
    photo_url: str(req.body.photoUrl),
    utilities: str(req.body.utilities),
    amenities: str(req.body.amenities),
    notes: str(req.body.notes),
  });
  db.audit(req.user.id, "property.created", "property", id, req.body.name);
  res.json({ id });
}));

app.get("/api/properties/:id", route((req, res) => {
  staffOnly(req);
  const id = recordId(req.params.id);
  const property = db.one("SELECT * FROM properties WHERE id = ?", id);
  if (!property) throw db.fail(404, "Property not found");
  const units = db.all("SELECT * FROM units WHERE property_id = ? ORDER BY name", id);
  res.json({
    property,
    units,
    owners: db.all("SELECT ow.*, o.name, o.email, o.phone FROM ownerships ow JOIN owners o ON o.id = ow.owner_id WHERE ow.property_id = ?", id),
    agreement: db.one("SELECT * FROM management_agreements WHERE property_id = ? AND status = 'active' ORDER BY id DESC", id),
    notes: db.all("SELECT n.*, u.name AS author FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.entity = 'property' AND n.entity_id = ? ORDER BY n.id DESC", id),
    fields: db.all(
      `SELECT f.id, f.label, f.field_type, v.value FROM custom_fields f
       LEFT JOIN custom_field_values v ON v.field_id = f.id AND v.entity_id = ?
       WHERE f.entity = 'property' ORDER BY f.label`,
      id
    ),
    workOrders: db.all("SELECT id, title, status, priority, created_at FROM work_orders WHERE property_id = ? ORDER BY id DESC LIMIT 8", id),
    leases: db.all(
      `SELECT l.*, t.first_name, t.last_name, u.name AS unit FROM leases l
       JOIN tenants t ON t.id = l.tenant_id JOIN units u ON u.id = l.unit_id
       WHERE u.property_id = ? ORDER BY l.start_date DESC`,
      id
    ),
  });
}));

app.patch("/api/properties/:id", route((req, res) => {
  permit(req, "portfolio.edit");
  const id = recordId(req.params.id);
  patchRow("properties", id, {
    name: required(req.body.name, "Property name"),
    address: required(req.body.address, "Address"),
    city: str(req.body.city),
    state: str(req.body.state),
    zip: str(req.body.zip),
    property_type: str(req.body.propertyType),
    year_built: req.body.yearBuilt ? int(req.body.yearBuilt) : null,
    photo_url: str(req.body.photoUrl),
    utilities: str(req.body.utilities),
    amenities: str(req.body.amenities),
    notes: str(req.body.notes),
  });
  db.audit(req.user.id, "property.updated", "property", id, "");
  res.json({ id });
}));

app.post("/api/units", route((req, res) => {
  permit(req, "portfolio.edit");
  const propertyId = recordId(req.body.propertyId);
  const id = db.add("units", {
    property_id: propertyId,
    name: required(req.body.name, "Unit name"),
    beds: Number(req.body.beds) || 0,
    baths: Number(req.body.baths) || 0,
    sqft: int(req.body.sqft),
    market_rent_cents: dollars(req.body.marketRent),
    status: str(req.body.status || "vacant"),
    amenities: str(req.body.amenities),
  });
  db.audit(req.user.id, "unit.created", "unit", id, "");
  res.json({ id });
}));

app.patch("/api/units/:id", route((req, res) => {
  permit(req, "portfolio.edit");
  const id = recordId(req.params.id);
  patchRow("units", id, {
    name: required(req.body.name, "Unit name"),
    beds: Number(req.body.beds) || 0,
    baths: Number(req.body.baths) || 0,
    sqft: int(req.body.sqft),
    market_rent_cents: dollars(req.body.marketRent),
    status: str(req.body.status || "vacant"),
    amenities: str(req.body.amenities),
  });
  res.json({ id });
}));

app.post("/api/ownerships", route((req, res) => {
  permit(req, "portfolio.edit");
  const propertyId = recordId(req.body.propertyId);
  const ownerId = recordId(req.body.ownerId);
  const percent = Number(req.body.percent);
  if (!(percent > 0) || percent > 100) throw db.fail(400, "Enter an ownership percent from 1 to 100");
  const current = db.one("SELECT COALESCE(SUM(percent), 0) AS total FROM ownerships WHERE property_id = ?", propertyId).total;
  if (current + percent > 100.001) throw db.fail(400, "Ownership on this property would go over 100%");
  const id = db.add("ownerships", { property_id: propertyId, owner_id: ownerId, percent });
  res.json({ id });
}));

app.get("/api/notes", route((req, res) => {
  staffOnly(req);
  res.json(db.all(
    "SELECT n.*, u.name AS author FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE entity = ? AND entity_id = ? ORDER BY n.id DESC",
    str(req.query.entity),
    Number(req.query.id) || 0
  ));
}));

app.post("/api/notes", route((req, res) => {
  staffOnly(req);
  const id = db.add("notes", {
    entity: required(req.body.entity, "Record"),
    entity_id: recordId(req.body.entityId),
    body: required(req.body.body, "Note"),
    user_id: req.user.id,
    created_at: db.nowStamp(),
  });
  res.json({ id });
}));

app.get("/api/custom-fields", route((req, res) => {
  staffOnly(req);
  const entity = str(req.query.entity);
  res.json(entity ? db.all("SELECT * FROM custom_fields WHERE entity = ? ORDER BY label", entity) : db.all("SELECT * FROM custom_fields ORDER BY entity, label"));
}));

app.post("/api/custom-fields", route((req, res) => {
  permit(req, "admin.edit");
  const id = db.add("custom_fields", {
    entity: required(req.body.entity, "Record type"),
    label: required(req.body.label, "Label"),
    field_type: str(req.body.fieldType || "text"),
  });
  res.json({ id });
}));

app.delete("/api/custom-fields/:id", route((req, res) => {
  permit(req, "admin.edit");
  const id = recordId(req.params.id);
  db.run("DELETE FROM custom_field_values WHERE field_id = ?", id);
  db.run("DELETE FROM custom_fields WHERE id = ?", id);
  res.json({ ok: true });
}));

app.put("/api/custom-field-values", route((req, res) => {
  permit(req, "portfolio.edit");
  const fieldId = recordId(req.body.fieldId);
  const entityId = recordId(req.body.entityId);
  const existing = db.one("SELECT id FROM custom_field_values WHERE field_id = ? AND entity_id = ?", fieldId, entityId);
  if (existing) db.run("UPDATE custom_field_values SET value = ? WHERE id = ?", str(req.body.value), existing.id);
  else db.add("custom_field_values", { field_id: fieldId, entity_id: entityId, value: str(req.body.value) });
  res.json({ ok: true });
}));

app.get("/api/tenants", route((req, res) => {
  staffOnly(req);
  res.json(db.all(
    `SELECT t.*, l.id AS lease_id, l.status AS lease_status, l.rent_cents, p.name AS property, u.name AS unit,
      (SELECT COALESCE(SUM(c.amount_cents - c.paid_cents), 0) FROM charges c WHERE c.lease_id = l.id AND c.status != 'paid') AS balance_cents
     FROM tenants t
     LEFT JOIN leases l ON l.id = (
       SELECT id FROM leases WHERE tenant_id = t.id AND status IN ('active', 'notice', 'future')
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'notice' THEN 1 ELSE 2 END, id DESC LIMIT 1
     )
     LEFT JOIN units u ON u.id = l.unit_id
     LEFT JOIN properties p ON p.id = u.property_id
     ORDER BY t.last_name, t.first_name`
  ));
}));

app.post("/api/tenants", route((req, res) => {
  permit(req, "people.edit");
  const id = db.add("tenants", {
    first_name: required(req.body.firstName, "First name"),
    last_name: required(req.body.lastName, "Last name"),
    email: str(req.body.email),
    phone: str(req.body.phone),
    birth_date: str(req.body.birthDate),
    emergency_contact: str(req.body.emergencyContact),
    notes: str(req.body.notes),
  });
  if (req.body.createLogin) {
    db.createUser({
      email: req.body.email,
      password: req.body.password || "sunseeker",
      name: `${req.body.firstName} ${req.body.lastName}`,
      role: "tenant",
      phone: req.body.phone,
      tenantId: id,
    });
  }
  db.audit(req.user.id, "tenant.created", "tenant", id, "");
  res.json({ id });
}));

app.get("/api/tenants/:id", route((req, res) => {
  staffOnly(req);
  const id = recordId(req.params.id);
  const tenant = db.one("SELECT * FROM tenants WHERE id = ?", id);
  if (!tenant) throw db.fail(404, "Resident not found");
  const leases = db.all(
    `SELECT l.*, u.name AS unit, p.name AS property, p.address,
      (SELECT COALESCE(SUM(amount_cents - paid_cents), 0) FROM charges c WHERE c.lease_id = l.id AND c.status != 'paid') AS balance_cents
     FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
     WHERE l.tenant_id = ? ORDER BY l.start_date DESC`,
    id
  );
  res.json({
    tenant,
    leases,
    communications: db.all("SELECT * FROM communications WHERE tenant_id = ? ORDER BY id DESC", id),
    documents: db.all("SELECT id, name, category, created_at FROM documents WHERE tenant_id = ? ORDER BY id DESC", id),
    workOrders: db.all("SELECT id, title, status, priority, created_at FROM work_orders WHERE tenant_id = ? ORDER BY id DESC", id),
    login: db.one("SELECT id, email, active FROM users WHERE tenant_id = ?", id),
  });
}));

app.patch("/api/tenants/:id", route((req, res) => {
  permit(req, "people.edit");
  const id = recordId(req.params.id);
  patchRow("tenants", id, {
    first_name: required(req.body.firstName, "First name"),
    last_name: required(req.body.lastName, "Last name"),
    email: str(req.body.email),
    phone: str(req.body.phone),
    birth_date: str(req.body.birthDate),
    emergency_contact: str(req.body.emergencyContact),
    notes: str(req.body.notes),
  });
  res.json({ id });
}));

app.get("/api/owners", route((req, res) => {
  staffOnly(req);
  res.json(db.all(
    `SELECT o.*,
      (SELECT GROUP_CONCAT(p.name, ', ') FROM ownerships ow JOIN properties p ON p.id = ow.property_id WHERE ow.owner_id = o.id) AS properties
     FROM owners o ORDER BY o.name`
  ));
}));

app.post("/api/owners", route((req, res) => {
  permit(req, "people.edit");
  const id = db.add("owners", {
    name: required(req.body.name, "Name"),
    email: str(req.body.email),
    phone: str(req.body.phone),
    address: str(req.body.address),
    tax_id_last4: str(req.body.taxIdLast4),
    payment_method: str(req.body.paymentMethod || "ACH"),
    notes: str(req.body.notes),
  });
  if (req.body.createLogin) {
    db.createUser({ email: req.body.email, password: req.body.password || "sunseeker", name: req.body.name, role: "owner", phone: req.body.phone, ownerId: id });
  }
  db.audit(req.user.id, "owner.created", "owner", id, "");
  res.json({ id });
}));

app.get("/api/owners/:id", route((req, res) => {
  staffOnly(req);
  const id = recordId(req.params.id);
  const owner = db.one("SELECT * FROM owners WHERE id = ?", id);
  if (!owner) throw db.fail(404, "Owner not found");
  res.json({
    owner,
    properties: db.all("SELECT p.*, ow.percent FROM ownerships ow JOIN properties p ON p.id = ow.property_id WHERE ow.owner_id = ?", id),
    statements: db.all("SELECT id, property_id, period_start, period_end, ending_balance_cents FROM owner_statements WHERE owner_id = ? ORDER BY period_end DESC", id),
    documents: db.all("SELECT id, name, category, created_at FROM documents WHERE owner_id = ? ORDER BY id DESC", id),
    login: db.one("SELECT id, email, active FROM users WHERE owner_id = ?", id),
  });
}));

app.patch("/api/owners/:id", route((req, res) => {
  permit(req, "people.edit");
  const id = recordId(req.params.id);
  patchRow("owners", id, {
    name: required(req.body.name, "Name"),
    email: str(req.body.email),
    phone: str(req.body.phone),
    address: str(req.body.address),
    tax_id_last4: str(req.body.taxIdLast4),
    payment_method: str(req.body.paymentMethod || "ACH"),
    notes: str(req.body.notes),
  });
  res.json({ id });
}));

app.get("/api/vendors", route((req, res) => {
  staffOnly(req);
  res.json(db.all("SELECT * FROM vendors ORDER BY name"));
}));

app.post("/api/vendors", route((req, res) => {
  permit(req, "people.edit");
  const id = db.add("vendors", {
    name: required(req.body.name, "Vendor name"),
    trade: str(req.body.trade),
    email: str(req.body.email),
    phone: str(req.body.phone),
    address: str(req.body.address),
    insurance_carrier: str(req.body.insuranceCarrier),
    insurance_expires: str(req.body.insuranceExpires),
    license_number: str(req.body.licenseNumber),
    license_expires: str(req.body.licenseExpires),
    notes: str(req.body.notes),
  });
  if (req.body.createLogin) {
    db.createUser({ email: req.body.email, password: req.body.password || "sunseeker", name: req.body.name, role: "vendor", phone: req.body.phone, vendorId: id });
  }
  db.audit(req.user.id, "vendor.created", "vendor", id, "");
  res.json({ id });
}));

app.get("/api/vendors/:id", route((req, res) => {
  staffOnly(req);
  const id = recordId(req.params.id);
  const vendor = db.one("SELECT * FROM vendors WHERE id = ?", id);
  if (!vendor) throw db.fail(404, "Vendor not found");
  res.json({
    vendor,
    workOrders: db.all("SELECT id, title, status, priority, scheduled_at FROM work_orders WHERE vendor_id = ? ORDER BY id DESC", id),
    bills: db.all("SELECT id, memo, amount_cents, status, due_date FROM bills WHERE vendor_id = ? ORDER BY id DESC", id),
    login: db.one("SELECT id, email, active FROM users WHERE vendor_id = ?", id),
  });
}));

app.patch("/api/vendors/:id", route((req, res) => {
  permit(req, "people.edit");
  const id = recordId(req.params.id);
  patchRow("vendors", id, {
    name: required(req.body.name, "Vendor name"),
    trade: str(req.body.trade),
    email: str(req.body.email),
    phone: str(req.body.phone),
    address: str(req.body.address),
    insurance_carrier: str(req.body.insuranceCarrier),
    insurance_expires: str(req.body.insuranceExpires),
    license_number: str(req.body.licenseNumber),
    license_expires: str(req.body.licenseExpires),
    notes: str(req.body.notes),
  });
  res.json({ id });
}));

app.get("/api/prospects", route((req, res) => {
  staffOnly(req);
  res.json(db.all(
    `SELECT pr.*, u.name AS unit, p.name AS property FROM prospects pr
     LEFT JOIN units u ON u.id = pr.unit_id LEFT JOIN properties p ON p.id = u.property_id
     ORDER BY pr.id DESC`
  ));
}));

app.post("/api/prospects", route((req, res) => {
  permit(req, "leasing.edit");
  const id = db.add("prospects", {
    name: required(req.body.name, "Name"),
    email: str(req.body.email),
    phone: str(req.body.phone),
    unit_id: Number(req.body.unitId) || null,
    source: str(req.body.source),
    stage: str(req.body.stage || "inquiry"),
    notes: str(req.body.notes),
    created_at: db.nowStamp(),
  });
  res.json({ id });
}));

app.patch("/api/prospects/:id", route((req, res) => {
  permit(req, "leasing.edit");
  const id = recordId(req.params.id);
  const current = db.one("SELECT * FROM prospects WHERE id = ?", id);
  if (!current) throw db.fail(404, "Prospect not found");
  patchRow("prospects", id, {
    name: str(req.body.name || current.name),
    email: req.body.email == null ? current.email : str(req.body.email),
    phone: req.body.phone == null ? current.phone : str(req.body.phone),
    unit_id: req.body.unitId == null ? current.unit_id : Number(req.body.unitId) || null,
    source: req.body.source == null ? current.source : str(req.body.source),
    stage: str(req.body.stage || current.stage),
    notes: req.body.notes == null ? current.notes : str(req.body.notes),
  });
  res.json({ id });
}));

app.get("/api/showings", route((req, res) => {
  staffOnly(req);
  res.json(db.all(
    `SELECT s.*, pr.name AS prospect, u.name AS unit, p.name AS property
     FROM showings s LEFT JOIN prospects pr ON pr.id = s.prospect_id
     LEFT JOIN units u ON u.id = s.unit_id LEFT JOIN properties p ON p.id = u.property_id
     ORDER BY s.scheduled_at DESC`
  ));
}));

app.post("/api/showings", route((req, res) => {
  permit(req, "leasing.edit");
  const id = db.add("showings", {
    prospect_id: Number(req.body.prospectId) || null,
    unit_id: Number(req.body.unitId) || null,
    showing_type: str(req.body.showingType || "agent"),
    scheduled_at: required(req.body.scheduledAt, "Date and time"),
    status: str(req.body.status || "scheduled"),
    notes: str(req.body.notes),
  });
  res.json({ id });
}));

app.patch("/api/showings/:id", route((req, res) => {
  permit(req, "leasing.edit");
  db.run("UPDATE showings SET status = ?, notes = ? WHERE id = ?", str(req.body.status), str(req.body.notes), recordId(req.params.id));
  res.json({ ok: true });
}));

app.get("/api/applications", route((req, res) => {
  staffOnly(req);
  res.json(db.all(
    `SELECT a.*, pr.name AS prospect, pr.email, u.name AS unit, p.name AS property, s.decision, s.credit_score, s.criminal, s.eviction
     FROM applications a LEFT JOIN prospects pr ON pr.id = a.prospect_id
     LEFT JOIN units u ON u.id = a.unit_id LEFT JOIN properties p ON p.id = u.property_id
     LEFT JOIN screenings s ON s.id = (SELECT id FROM screenings WHERE application_id = a.id ORDER BY id DESC LIMIT 1)
     ORDER BY a.id DESC`
  ));
}));

app.post("/api/applications", route((req, res) => {
  permit(req, "leasing.edit");
  const prospectId = recordId(req.body.prospectId);
  const id = db.add("applications", {
    prospect_id: prospectId,
    unit_id: Number(req.body.unitId) || null,
    status: "submitted",
    submitted_at: db.today(),
    income_cents: dollars(req.body.income),
    occupants: int(req.body.occupants) || 1,
    notes: str(req.body.notes),
  });
  db.run("UPDATE prospects SET stage = 'application' WHERE id = ?", prospectId);
  res.json({ id });
}));

app.patch("/api/applications/:id", route((req, res) => {
  permit(req, "leasing.edit");
  const id = recordId(req.params.id);
  const status = required(req.body.status, "Status");
  db.run("UPDATE applications SET status = ?, notes = ? WHERE id = ?", status, str(req.body.notes), id);
  const application = db.one("SELECT prospect_id FROM applications WHERE id = ?", id);
  if (application && ["approved", "denied", "screening"].includes(status)) {
    db.run("UPDATE prospects SET stage = ? WHERE id = ?", status === "screening" ? "application" : status, application.prospect_id);
  }
  res.json({ id });
}));

app.post("/api/screenings", route((req, res) => {
  permit(req, "leasing.edit");
  const applicationId = recordId(req.body.applicationId);
  const existing = db.one("SELECT id FROM screenings WHERE application_id = ?", applicationId);
  if (existing) return res.json({ id: existing.id, already: true });
  const id = db.add("screenings", {
    application_id: applicationId,
    status: "complete",
    credit_score: 710,
    criminal: "clear",
    eviction: "clear",
    decision: "review",
    notes: "Sample bureau report. Live credit, nationwide criminal, and eviction results come from your screening provider under the Fair Credit Reporting Act.",
    completed_at: db.today(),
  });
  db.run("UPDATE applications SET status = 'screening' WHERE id = ? AND status IN ('submitted', 'screening')", applicationId);
  res.json({ id });
}));

app.get("/api/listings/feed", route((req, res) => {
  staffOnly(req);
  const listings = db.all(
    `SELECT l.*, u.name AS unit, u.beds, u.baths, p.name AS property, p.address, p.city, p.state, p.zip
     FROM listings l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
     WHERE l.status = 'active'`
  ).map((listing) => ({
    listingId: listing.id,
    headline: listing.headline,
    description: listing.description,
    rent: listing.rent_cents / 100,
    available: listing.available_date,
    property: listing.property,
    address: [listing.address, listing.city, listing.state, listing.zip].filter(Boolean).join(", "),
    unit: listing.unit,
    beds: listing.beds,
    baths: listing.baths,
    channels: [
      listing.syndicate_website ? "website" : "",
      listing.syndicate_zillow ? "zillow" : "",
      listing.syndicate_trulia ? "trulia" : "",
      listing.syndicate_realtor ? "realtor" : "",
      listing.syndicate_apartments ? "apartments" : "",
    ].filter(Boolean),
  }));
  res.json({ generatedAt: new Date().toISOString(), network: "SunPilot listing feed", listings });
}));

app.get("/api/listings", route((req, res) => {
  staffOnly(req);
  res.json(db.all(
    `SELECT l.*, u.name AS unit, u.status AS unit_status, p.name AS property, p.address
     FROM listings l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
     ORDER BY l.id DESC`
  ));
}));

app.post("/api/listings", route((req, res) => {
  permit(req, "leasing.edit");
  const id = db.add("listings", {
    unit_id: recordId(req.body.unitId),
    headline: required(req.body.headline, "Headline"),
    description: str(req.body.description),
    rent_cents: dollars(req.body.rent),
    available_date: str(req.body.availableDate || db.today()),
    status: "active",
    syndicate_website: req.body.syndicateWebsite ? 1 : 0,
    syndicate_zillow: req.body.syndicateZillow ? 1 : 0,
    syndicate_trulia: req.body.syndicateTrulia ? 1 : 0,
    syndicate_realtor: req.body.syndicateRealtor ? 1 : 0,
    syndicate_apartments: req.body.syndicateApartments ? 1 : 0,
  });
  res.json({ id });
}));

app.patch("/api/listings/:id", route((req, res) => {
  permit(req, "leasing.edit");
  const id = recordId(req.params.id);
  patchRow("listings", id, {
    headline: required(req.body.headline, "Headline"),
    description: str(req.body.description),
    rent_cents: dollars(req.body.rent),
    available_date: str(req.body.availableDate),
    status: str(req.body.status || "active"),
    syndicate_website: req.body.syndicateWebsite ? 1 : 0,
    syndicate_zillow: req.body.syndicateZillow ? 1 : 0,
    syndicate_trulia: req.body.syndicateTrulia ? 1 : 0,
    syndicate_realtor: req.body.syndicateRealtor ? 1 : 0,
    syndicate_apartments: req.body.syndicateApartments ? 1 : 0,
  });
  res.json({ id });
}));

app.get("/api/leases", route((req, res) => {
  staffOnly(req);
  res.json(db.all(
    `SELECT l.*, t.first_name, t.last_name, u.name AS unit, p.name AS property,
      (SELECT COALESCE(SUM(amount_cents - paid_cents), 0) FROM charges c WHERE c.lease_id = l.id AND c.status != 'paid') AS balance_cents
     FROM leases l JOIN tenants t ON t.id = l.tenant_id JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
     ORDER BY l.end_date`
  ));
}));

app.get("/api/leases/:id", route((req, res) => {
  staffOnly(req);
  const id = recordId(req.params.id);
  const lease = db.leaseContext(id);
  if (!lease) throw db.fail(404, "Lease not found");
  const tenant = db.one("SELECT * FROM tenants WHERE id = ?", lease.tenant_id);
  res.json({
    lease,
    tenant,
    balance: leaseBalance(id),
    charges: db.all("SELECT * FROM charges WHERE lease_id = ? ORDER BY due_date, id", id),
    payments: db.all("SELECT * FROM payments WHERE lease_id = ? ORDER BY paid_at DESC, id DESC", id),
    plan: db.one("SELECT * FROM payment_plans WHERE lease_id = ? ORDER BY id DESC", id),
    deposit: db.one("SELECT * FROM security_deposits WHERE lease_id = ?", id),
    checklists: db.all("SELECT * FROM move_checklists WHERE lease_id = ?", id),
    packets: db.all("SELECT * FROM esign_packets WHERE lease_id = ? ORDER BY id DESC", id),
    renewals: db.all("SELECT * FROM renewals WHERE lease_id = ? ORDER BY id DESC", id),
    documents: db.all("SELECT id, name, category, created_at FROM documents WHERE tenant_id = ? ORDER BY id DESC", lease.tenant_id),
  });
}));

app.patch("/api/leases/:id", route((req, res) => {
  permit(req, "leasing.edit");
  const id = recordId(req.params.id);
  patchRow("leases", id, {
    start_date: required(req.body.startDate, "Start date"),
    end_date: required(req.body.endDate, "End date"),
    rent_cents: dollars(req.body.rent),
    deposit_cents: dollars(req.body.deposit),
    status: str(req.body.status),
    due_day: int(req.body.dueDay) || 1,
    autopay: req.body.autopay ? 1 : 0,
    autopay_method: str(req.body.autopayMethod || "ACH"),
  });
  res.json({ id });
}));

app.post("/api/leases/:id/activate", route((req, res) => {
  permit(req, "leasing.edit");
  const lease = db.leaseContext(recordId(req.params.id));
  if (!lease) throw db.fail(404, "Lease not found");
  db.run("UPDATE leases SET status = 'active' WHERE id = ?", lease.id);
  db.run("UPDATE units SET status = 'occupied' WHERE id = ?", lease.unit_id);
  db.audit(req.user.id, "lease.activated", "lease", lease.id, "");
  res.json({ id: lease.id });
}));

app.post("/api/leases/:id/document", route((req, res) => {
  permit(req, "leasing.edit");
  const lease = db.leaseContext(recordId(req.params.id));
  if (!lease) throw db.fail(404, "Lease not found");
  const template = db.one("SELECT * FROM templates WHERE id = ?", Number(req.body.templateId) || 0) || db.one("SELECT * FROM templates WHERE kind = 'lease' ORDER BY id LIMIT 1");
  if (!template) throw db.fail(400, "Add a lease template first");
  const body = renderTemplate(template.body, mergeFields(lease));
  const documentId = db.add("documents", {
    name: template.name,
    category: "lease",
    tenant_id: lease.tenant_id,
    property_id: lease.property_id,
    owner_id: null,
    vendor_id: null,
    content: body,
    url: "",
    created_at: db.nowStamp(),
  });
  const packetId = db.add("esign_packets", {
    lease_id: lease.id,
    template_id: template.id,
    title: template.name,
    status: "draft",
    sent_at: "",
    signed_at: "",
    body,
  });
  res.json({ documentId, packetId });
}));

app.post("/api/leases/:id/esign", route((req, res) => {
  permit(req, "leasing.edit");
  const leaseId = recordId(req.params.id);
  const packet = db.one("SELECT * FROM esign_packets WHERE lease_id = ? ORDER BY id DESC", leaseId);
  if (!packet) throw db.fail(400, "Prepare a lease document first");
  const status = required(req.body.status, "Status");
  const sentAt = status === "sent" || status === "viewed" || status === "signed" ? packet.sent_at || db.today() : packet.sent_at;
  const signedAt = status === "signed" ? db.today() : packet.signed_at;
  db.run("UPDATE esign_packets SET status = ?, sent_at = ?, signed_at = ? WHERE id = ?", status, sentAt, signedAt, packet.id);
  res.json({ id: packet.id, status });
}));

app.post("/api/move-in", route((req, res) => {
  permit(req, "leasing.edit");
  const result = db.moveIn({
    unitId: recordId(req.body.unitId),
    firstName: required(req.body.firstName, "First name"),
    lastName: required(req.body.lastName, "Last name"),
    email: str(req.body.email),
    phone: str(req.body.phone),
    birthDate: str(req.body.birthDate),
    startDate: required(req.body.startDate, "Start date"),
    endDate: required(req.body.endDate, "End date"),
    rentCents: dollars(req.body.rent),
    depositCents: dollars(req.body.deposit),
    createLogin: Boolean(req.body.createLogin),
    password: str(req.body.password),
  }, req.user.id);
  res.json(result);
}));

app.post("/api/move-out", route((req, res) => {
  permit(req, "leasing.edit");
  res.json(db.moveOut({
    leaseId: recordId(req.body.leaseId),
    moveOutDate: required(req.body.moveOutDate, "Move-out date"),
    refundCents: dollars(req.body.refund),
    notes: str(req.body.notes),
  }, req.user.id));
}));

app.patch("/api/checklists/:id", route((req, res) => {
  permit(req, "leasing.edit");
  const id = recordId(req.params.id);
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const done = items.length > 0 && items.every((item) => item.done);
  db.run("UPDATE move_checklists SET items = ?, status = ?, notes = ? WHERE id = ?", JSON.stringify(items), done ? "complete" : "open", str(req.body.notes), id);
  res.json({ id });
}));

app.get("/api/inspections", route((req, res) => {
  staffOnly(req);
  res.json(db.all(
    `SELECT i.*, u.name AS unit, p.name AS property FROM inspections i
     LEFT JOIN units u ON u.id = i.unit_id LEFT JOIN properties p ON p.id = u.property_id
     ORDER BY i.inspected_at DESC, i.id DESC`
  ));
}));

app.post("/api/inspections", route((req, res) => {
  permit(req, "maintenance.edit");
  const photo = req.body.photoDataUrl ? db.saveDataUrl(req.body.photoDataUrl) : "";
  const id = db.add("inspections", {
    unit_id: recordId(req.body.unitId),
    lease_id: Number(req.body.leaseId) || null,
    kind: str(req.body.kind || "routine"),
    inspected_at: str(req.body.inspectedAt || db.today()),
    notes: str(req.body.notes),
    photo_url: photo,
    user_id: req.user.id,
  });
  res.json({ id });
}));

app.get("/api/renewals", route((req, res) => {
  staffOnly(req);
  res.json(db.all(
    `SELECT r.*, t.first_name, t.last_name, l.end_date, l.rent_cents, p.name AS property, u.name AS unit
     FROM renewals r JOIN leases l ON l.id = r.lease_id JOIN tenants t ON t.id = l.tenant_id
     JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
     ORDER BY r.id DESC`
  ));
}));

app.post("/api/renewals", route((req, res) => {
  permit(req, "leasing.edit");
  const id = db.add("renewals", {
    lease_id: recordId(req.body.leaseId),
    offered_rent_cents: dollars(req.body.offeredRent),
    new_end_date: required(req.body.newEndDate, "New end date"),
    status: "offered",
    notes: str(req.body.notes),
    created_at: db.nowStamp(),
  });
  res.json({ id });
}));

app.patch("/api/renewals/:id", route((req, res) => {
  permit(req, "leasing.edit");
  const id = recordId(req.params.id);
  const status = required(req.body.status, "Status");
  db.run("UPDATE renewals SET status = ? WHERE id = ?", status, id);
  if (status === "accepted") {
    const renewal = db.one("SELECT * FROM renewals WHERE id = ?", id);
    db.run("UPDATE leases SET rent_cents = ?, end_date = ?, status = 'active' WHERE id = ?", renewal.offered_rent_cents, renewal.new_end_date, renewal.lease_id);
  }
  res.json({ id });
}));

app.get("/api/templates", route((req, res) => {
  staffOnly(req);
  res.json(db.all("SELECT * FROM templates ORDER BY kind, name"));
}));

app.post("/api/templates", route((req, res) => {
  permit(req, "admin.edit");
  const id = db.add("templates", {
    name: required(req.body.name, "Name"),
    kind: str(req.body.kind || "email"),
    subject: str(req.body.subject),
    body: required(req.body.body, "Body"),
  });
  res.json({ id });
}));

app.patch("/api/templates/:id", route((req, res) => {
  permit(req, "admin.edit");
  const id = recordId(req.params.id);
  patchRow("templates", id, {
    name: required(req.body.name, "Name"),
    kind: str(req.body.kind),
    subject: str(req.body.subject),
    body: required(req.body.body, "Body"),
  });
  res.json({ id });
}));

app.post("/api/letters", route((req, res) => {
  permit(req, "communication.send");
  const template = db.one("SELECT * FROM templates WHERE id = ?", recordId(req.body.templateId));
  if (!template) throw db.fail(404, "Template not found");
  const lease = db.leaseContext(recordId(req.body.leaseId));
  if (!lease) throw db.fail(404, "Lease not found");
  const body = renderTemplate(template.body, mergeFields(lease, {
    offered_rent: moneyText(dollars(req.body.offeredRent)),
    new_end_date: str(req.body.newEndDate),
  }));
  const documentId = db.add("documents", {
    name: template.name,
    category: template.kind,
    tenant_id: lease.tenant_id,
    property_id: lease.property_id,
    owner_id: null,
    vendor_id: null,
    content: body,
    url: "",
    created_at: db.nowStamp(),
  });
  db.add("communications", {
    channel: template.kind === "text" ? "text" : "email",
    subject: renderTemplate(template.subject || template.name, mergeFields(lease)),
    body,
    tenant_id: lease.tenant_id,
    owner_id: null,
    vendor_id: null,
    user_id: req.user.id,
    created_at: db.nowStamp(),
  });
  db.audit(req.user.id, "letter.sent", "document", documentId, template.name);
  res.json({ documentId });
}));

app.get("/api/charges", route((req, res) => {
  permit(req, "accounting.view");
  const leaseId = Number(req.query.leaseId) || 0;
  res.json(leaseId
    ? db.all("SELECT * FROM charges WHERE lease_id = ? ORDER BY due_date DESC", leaseId)
    : db.all(
      `SELECT c.*, t.first_name, t.last_name, p.name AS property FROM charges c
       LEFT JOIN tenants t ON t.id = c.tenant_id LEFT JOIN properties p ON p.id = c.property_id
       ORDER BY c.due_date DESC, c.id DESC LIMIT 200`
    ));
}));

app.post("/api/charges", route((req, res) => {
  permit(req, "accounting.edit");
  const id = db.postCharge({
    leaseId: recordId(req.body.leaseId),
    type: str(req.body.type || "other"),
    description: required(req.body.description, "Description"),
    amountCents: dollars(req.body.amount),
    dueDate: required(req.body.dueDate, "Due date"),
  });
  db.audit(req.user.id, "charge.created", "charge", id, req.body.description);
  res.json({ id });
}));

app.post("/api/payments", route((req, res) => {
  permit(req, "accounting.edit");
  res.json(db.applyPayment({
    leaseId: recordId(req.body.leaseId),
    amountCents: dollars(req.body.amount),
    method: str(req.body.method || "ACH"),
    reference: str(req.body.reference),
    userId: req.user.id,
    paidAt: str(req.body.paidAt || db.today()),
  }));
}));

app.get("/api/payments", route((req, res) => {
  permit(req, "accounting.view");
  res.json(db.all(
    `SELECT p.*, t.first_name, t.last_name, pr.name AS property FROM payments p
     LEFT JOIN tenants t ON t.id = p.tenant_id LEFT JOIN properties pr ON pr.id = p.property_id
     ORDER BY p.paid_at DESC, p.id DESC LIMIT 200`
  ));
}));

app.get("/api/payment-plans", route((req, res) => {
  permit(req, "accounting.view");
  res.json(db.all(
    `SELECT pp.*, t.first_name, t.last_name, p.name AS property FROM payment_plans pp
     JOIN leases l ON l.id = pp.lease_id JOIN tenants t ON t.id = l.tenant_id
     JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
     ORDER BY pp.id DESC`
  ));
}));

app.post("/api/payment-plans", route((req, res) => {
  permit(req, "accounting.edit");
  const leaseId = recordId(req.body.leaseId);
  const total = dollars(req.body.total);
  const id = db.add("payment_plans", {
    lease_id: leaseId,
    total_cents: total,
    installment_cents: dollars(req.body.installment),
    frequency: str(req.body.frequency || "monthly"),
    start_date: str(req.body.startDate || db.today()),
    remaining_cents: total,
    status: "active",
    notes: str(req.body.notes),
  });
  res.json({ id });
}));

app.post("/api/late-fees/run", route((req, res) => {
  permit(req, "accounting.edit");
  res.json(db.postLateFees(req.user.id));
}));

app.post("/api/rent/post-month", route((req, res) => {
  permit(req, "accounting.edit");
  res.json(db.postMonthlyRent(str(req.body.month || db.today().slice(0, 7)), req.user.id));
}));

app.post("/api/autopay/run", route((req, res) => {
  permit(req, "accounting.edit");
  res.json(db.runAutopay(req.user.id));
}));

app.get("/api/bills", route((req, res) => {
  permit(req, "accounting.view");
  res.json(db.all(
    `SELECT b.*, v.name AS vendor, p.name AS property FROM bills b
     LEFT JOIN vendors v ON v.id = b.vendor_id LEFT JOIN properties p ON p.id = b.property_id
     ORDER BY b.id DESC`
  ));
}));

app.post("/api/bills", route((req, res) => {
  permit(req, "accounting.edit");
  res.json(db.createBill({
    vendorId: recordId(req.body.vendorId),
    propertyId: recordId(req.body.propertyId),
    amountCents: dollars(req.body.amount),
    dueDate: str(req.body.dueDate || db.today()),
    memo: required(req.body.memo, "Memo"),
    category: str(req.body.category || "repairs"),
    workOrderId: Number(req.body.workOrderId) || null,
    userId: req.user.id,
  }));
}));

app.post("/api/bills/:id/pay", route((req, res) => {
  permit(req, "accounting.edit");
  res.json(db.payBill(recordId(req.params.id), req.user.id, str(req.body.paidAt || "")));
}));

app.post("/api/bills/:id/decide", route((req, res) => {
  permit(req, "accounting.edit");
  const billId = recordId(req.params.id);
  const approval = db.one("SELECT * FROM approvals WHERE entity = 'bill' AND entity_id = ? AND status = 'pending'", billId);
  if (approval) return res.json(db.decideApproval(approval.id, req.body.status === "rejected" ? "denied" : "approved", req.user.id));
  const status = req.body.status === "rejected" ? "rejected" : "approved";
  db.run("UPDATE bills SET status = ? WHERE id = ? AND status = 'pending_approval'", status, billId);
  res.json({ id: billId, status });
}));

app.get("/api/purchase-orders", route((req, res) => {
  permit(req, "accounting.view");
  res.json(db.all(
    `SELECT po.*, v.name AS vendor, p.name AS property FROM purchase_orders po
     LEFT JOIN vendors v ON v.id = po.vendor_id LEFT JOIN properties p ON p.id = po.property_id
     ORDER BY po.id DESC`
  ));
}));

app.post("/api/purchase-orders", route((req, res) => {
  permit(req, "accounting.edit");
  const amount = dollars(req.body.amount);
  const workflow = db.one("SELECT amount_threshold_cents FROM workflows WHERE trigger = 'bill' AND active = 1");
  const needs = workflow && amount >= workflow.amount_threshold_cents;
  const id = db.add("purchase_orders", {
    vendor_id: recordId(req.body.vendorId),
    property_id: recordId(req.body.propertyId),
    amount_cents: amount,
    memo: required(req.body.memo, "Memo"),
    status: needs ? "pending_approval" : "approved",
    created_at: db.nowStamp(),
  });
  if (needs) {
    db.add("approvals", {
      kind: "purchase_order", entity: "purchase_order", entity_id: id, owner_id: null,
      property_id: recordId(req.body.propertyId), amount_cents: amount, status: "pending",
      notes: req.body.memo, created_at: db.nowStamp(),
    });
  }
  res.json({ id });
}));

app.post("/api/purchase-orders/:id/decide", route((req, res) => {
  permit(req, "accounting.edit");
  const id = recordId(req.params.id);
  const approval = db.one("SELECT id FROM approvals WHERE entity = 'purchase_order' AND entity_id = ? AND status = 'pending'", id);
  if (!approval) throw db.fail(400, "That purchase order is not waiting for approval");
  res.json(db.decideApproval(approval.id, req.body.status === "rejected" ? "denied" : "approved", req.user.id));
}));

app.post("/api/purchase-orders/:id/convert", route((req, res) => {
  permit(req, "accounting.edit");
  const po = db.one("SELECT * FROM purchase_orders WHERE id = ?", recordId(req.params.id));
  if (!po) throw db.fail(404, "Purchase order not found");
  if (po.status !== "approved") throw db.fail(400, "Approve the purchase order before turning it into a bill");
  const bill = db.createBill({
    vendorId: po.vendor_id,
    propertyId: po.property_id,
    amountCents: po.amount_cents,
    dueDate: db.today(),
    memo: po.memo,
    category: "repairs",
    userId: req.user.id,
  });
  db.run("UPDATE purchase_orders SET status = 'billed' WHERE id = ?", po.id);
  res.json(bill);
}));

app.get("/api/ledger", route((req, res) => {
  permit(req, "accounting.view");
  res.json(db.all(
    `SELECT je.entry_date, je.memo, je.source, a.code, a.name AS account, a.type, jl.debit_cents, jl.credit_cents, p.name AS property
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.entry_id
     JOIN accounts a ON a.id = jl.account_id
     LEFT JOIN properties p ON p.id = jl.property_id
     ORDER BY je.entry_date, je.id, jl.id LIMIT 400`
  ));
}));

app.post("/api/journal", route((req, res) => {
  permit(req, "accounting.edit");
  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  if (lines.length < 2) throw db.fail(400, "A journal entry needs at least two lines");
  const entryId = db.postJournal({
    date: required(req.body.date, "Date"),
    memo: required(req.body.memo, "Memo"),
    propertyId: Number(req.body.propertyId) || null,
    source: "manual",
    sourceId: null,
    lines: lines.map((line) => ({ code: str(line.code), debit: dollars(line.debit), credit: dollars(line.credit) })),
  });
  db.audit(req.user.id, "journal.posted", "journal_entry", entryId, req.body.memo);
  res.json({ id: entryId });
}));

app.get("/api/bank-accounts", route((req, res) => {
  staffOnly(req);
  res.json(db.all("SELECT * FROM bank_accounts ORDER BY id"));
}));

app.post("/api/bank-accounts", route((req, res) => {
  permit(req, "admin.edit");
  const id = db.add("bank_accounts", {
    name: required(req.body.name, "Name"),
    bank_name: str(req.body.bankName),
    account_type: str(req.body.accountType || "trust"),
    last4: str(req.body.last4),
    balance_cents: 0,
  });
  res.json({ id });
}));

app.patch("/api/bank-accounts/:id", route((req, res) => {
  permit(req, "admin.edit");
  const id = recordId(req.params.id);
  patchRow("bank_accounts", id, {
    name: required(req.body.name, "Name"),
    bank_name: str(req.body.bankName),
    account_type: str(req.body.accountType),
    last4: str(req.body.last4),
  });
  res.json({ id });
}));

app.get("/api/bank-register", route((req, res) => {
  permit(req, "accounting.view");
  const bankAccountId = Number(req.query.bankAccountId) || 0;
  res.json(bankAccountId
    ? db.all("SELECT * FROM bank_register WHERE bank_account_id = ? ORDER BY txn_date, id", bankAccountId)
    : db.all("SELECT br.*, ba.name AS account FROM bank_register br JOIN bank_accounts ba ON ba.id = br.bank_account_id ORDER BY br.txn_date DESC, br.id DESC LIMIT 300"));
}));

app.patch("/api/bank-register/:id", route((req, res) => {
  permit(req, "accounting.edit");
  db.run("UPDATE bank_register SET cleared = ? WHERE id = ?", req.body.cleared ? 1 : 0, recordId(req.params.id));
  res.json({ ok: true });
}));

app.get("/api/reconciliations", route((req, res) => {
  permit(req, "accounting.view");
  res.json(db.all("SELECT r.*, ba.name AS account FROM reconciliations r JOIN bank_accounts ba ON ba.id = r.bank_account_id ORDER BY r.id DESC"));
}));

app.post("/api/reconciliations", route((req, res) => {
  permit(req, "accounting.edit");
  const bankAccountId = recordId(req.body.bankAccountId);
  const statement = dollars(req.body.statementBalance);
  const cleared = db.one("SELECT COALESCE(SUM(amount_cents), 0) AS amount FROM bank_register WHERE bank_account_id = ? AND cleared = 1", bankAccountId).amount;
  const difference = statement - cleared;
  const id = db.add("reconciliations", {
    bank_account_id: bankAccountId,
    statement_date: required(req.body.statementDate, "Statement date"),
    statement_balance_cents: statement,
    cleared_cents: cleared,
    difference_cents: difference,
    status: difference === 0 ? "reconciled" : "open",
    notes: str(req.body.notes),
  });
  res.json({ id, difference });
}));

app.post("/api/tax-1099s/refresh", route((req, res) => {
  permit(req, "accounting.edit");
  const year = int(req.body.year) || new Date().getFullYear();
  const rows = db.all(
    `SELECT vendor_id, COALESCE(SUM(amount_cents), 0) AS amount FROM bills
     WHERE status = 'paid' AND paid_at >= ? AND paid_at <= ? GROUP BY vendor_id`,
    `${year}-01-01`,
    `${year}-12-31`
  );
  for (const row of rows) {
    const existing = db.one("SELECT * FROM tax_1099s WHERE vendor_id = ? AND tax_year = ?", row.vendor_id, year);
    if (!existing) db.add("tax_1099s", { vendor_id: row.vendor_id, tax_year: year, amount_cents: row.amount, status: "draft" });
    else if (existing.status !== "filed") db.run("UPDATE tax_1099s SET amount_cents = ? WHERE id = ?", row.amount, existing.id);
  }
  res.json(db.all(
    `SELECT t.*, v.name AS vendor FROM tax_1099s t JOIN vendors v ON v.id = t.vendor_id WHERE t.tax_year = ? ORDER BY v.name`,
    year
  ));
}));

app.get("/api/tax-1099s", route((req, res) => {
  permit(req, "accounting.view");
  const year = int(req.query.year) || new Date().getFullYear();
  res.json(db.all(
    `SELECT t.*, v.name AS vendor FROM tax_1099s t JOIN vendors v ON v.id = t.vendor_id WHERE t.tax_year = ? ORDER BY v.name`,
    year
  ));
}));

app.patch("/api/tax-1099s/:id", route((req, res) => {
  permit(req, "accounting.edit");
  db.run("UPDATE tax_1099s SET status = ? WHERE id = ?", str(req.body.status || "ready"), recordId(req.params.id));
  res.json({ ok: true });
}));

app.get("/api/distributions", route((req, res) => {
  permit(req, "accounting.view");
  res.json(db.all(
    `SELECT d.*, o.name AS owner, p.name AS property FROM owner_distributions d
     JOIN owners o ON o.id = d.owner_id JOIN properties p ON p.id = d.property_id ORDER BY d.distributed_at DESC`
  ));
}));

app.post("/api/distributions", route((req, res) => {
  permit(req, "accounting.edit");
  res.json(db.addDistribution({
    ownerId: recordId(req.body.ownerId),
    propertyId: recordId(req.body.propertyId),
    amountCents: dollars(req.body.amount),
    memo: str(req.body.memo || "Owner distribution"),
    userId: req.user.id,
  }));
}));

app.get("/api/contributions", route((req, res) => {
  permit(req, "accounting.view");
  res.json(db.all(
    `SELECT c.*, o.name AS owner, p.name AS property FROM owner_contributions c
     JOIN owners o ON o.id = c.owner_id JOIN properties p ON p.id = c.property_id ORDER BY c.contributed_at DESC`
  ));
}));

app.post("/api/contributions", route((req, res) => {
  permit(req, "accounting.edit");
  res.json(db.addContribution({
    ownerId: recordId(req.body.ownerId),
    propertyId: recordId(req.body.propertyId),
    amountCents: dollars(req.body.amount),
    method: str(req.body.method || "ACH"),
    memo: str(req.body.memo || "Owner funds"),
    userId: req.user.id,
  }));
}));

app.get("/api/statements", route((req, res) => {
  signIn(req);
  if (req.user.role === "owner") {
    return res.json(db.all(
      `SELECT s.*, p.name AS property, o.name AS owner FROM owner_statements s
       JOIN properties p ON p.id = s.property_id JOIN owners o ON o.id = s.owner_id
       WHERE s.owner_id = ? ORDER BY s.period_end DESC`,
      req.user.owner_id
    ));
  }
  staffOnly(req);
  res.json(db.all(
    `SELECT s.*, p.name AS property, o.name AS owner FROM owner_statements s
     JOIN properties p ON p.id = s.property_id JOIN owners o ON o.id = s.owner_id
     ORDER BY s.period_end DESC, s.id DESC`
  ));
}));

app.get("/api/statements/:id", route((req, res) => {
  signIn(req);
  const statement = db.one(
    `SELECT s.*, p.name AS property, p.address, p.city, p.state, p.zip, o.name AS owner
     FROM owner_statements s JOIN properties p ON p.id = s.property_id JOIN owners o ON o.id = s.owner_id
     WHERE s.id = ?`,
    recordId(req.params.id)
  );
  if (!statement) throw db.fail(404, "Statement not found");
  if (req.user.role === "owner" && statement.owner_id !== req.user.owner_id) throw db.fail(403, "That statement is for another owner");
  if (!STAFF.has(req.user.role) && req.user.role !== "owner") throw db.fail(403, "You cannot view that statement");
  statement.detail = JSON.parse(statement.detail || "{}");
  const company = db.one("SELECT * FROM company WHERE id = 1");
  res.json({ statement, company });
}));

app.post("/api/statements", route((req, res) => {
  permit(req, "accounting.edit");
  res.json(db.generateStatement({
    ownerId: recordId(req.body.ownerId),
    propertyId: recordId(req.body.propertyId),
    periodStart: required(req.body.periodStart, "Start date"),
    periodEnd: required(req.body.periodEnd, "End date"),
    userId: req.user.id,
  }));
}));

app.get("/api/deposits", route((req, res) => {
  permit(req, "accounting.view");
  res.json(db.all(
    `SELECT sd.*, t.first_name, t.last_name, u.name AS unit, p.name AS property
     FROM security_deposits sd JOIN leases l ON l.id = sd.lease_id JOIN tenants t ON t.id = l.tenant_id
     JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id ORDER BY p.name`
  ));
}));

app.get("/api/reports/:name", route((req, res) => {
  permit(req, "reports.view");
  const name = req.params.name;
  const from = str(req.query.from || db.monthStart(0));
  const to = str(req.query.to || db.today());
  if (name === "rent-roll") {
    return res.json(db.all(
      `SELECT p.name AS property, u.name AS unit, u.status, u.market_rent_cents, u.beds, u.baths,
        t.first_name, t.last_name, l.rent_cents, l.start_date, l.end_date, l.status AS lease_status, l.id AS lease_id,
        (SELECT COALESCE(SUM(amount_cents - paid_cents), 0) FROM charges c WHERE c.lease_id = l.id AND c.status != 'paid') AS balance_cents
       FROM units u JOIN properties p ON p.id = u.property_id
       LEFT JOIN leases l ON l.id = (
         SELECT id FROM leases WHERE unit_id = u.id AND status IN ('active', 'notice', 'future')
         ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'notice' THEN 1 ELSE 2 END, id DESC LIMIT 1
       )
       LEFT JOIN tenants t ON t.id = l.tenant_id
       ORDER BY p.name, u.name`
    ));
  }
  if (name === "delinquency") {
    return res.json(db.all(
      `SELECT l.id AS lease_id, t.first_name, t.last_name, t.phone, t.email, p.name AS property, u.name AS unit,
        SUM(c.amount_cents - c.paid_cents) AS balance_cents, MIN(c.due_date) AS oldest_due
       FROM charges c JOIN leases l ON l.id = c.lease_id JOIN tenants t ON t.id = l.tenant_id
       JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
       WHERE c.status != 'paid' AND c.due_date < ?
       GROUP BY l.id ORDER BY oldest_due`,
      db.today()
    ));
  }
  if (name === "vacancy") {
    return res.json(db.all(
      `SELECT p.name AS property, p.address, u.name AS unit, u.beds, u.baths, u.sqft, u.market_rent_cents, u.status
       FROM units u JOIN properties p ON p.id = u.property_id WHERE u.status = 'vacant' ORDER BY p.name, u.name`
    ));
  }
  if (name === "income-statement") {
    const propertyId = Number(req.query.propertyId) || 0;
    const params = propertyId ? [from, to, propertyId] : [from, to];
    const rows = db.all(
      `SELECT a.code, a.name, a.type, SUM(jl.debit_cents) AS debit_cents, SUM(jl.credit_cents) AS credit_cents
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
       WHERE je.entry_date >= ? AND je.entry_date <= ? AND a.type IN ('income', 'expense')
       ${propertyId ? "AND jl.property_id = ?" : ""}
       GROUP BY a.id ORDER BY a.code`,
      ...params
    ).map((row) => ({
      ...row,
      amount_cents: row.type === "income" ? row.credit_cents - row.debit_cents : row.debit_cents - row.credit_cents,
    }));
    return res.json({ from, to, rows });
  }
  if (name === "cash-flow") {
    return res.json({
      from,
      to,
      rows: db.all(
        `SELECT ba.name, ba.account_type,
          COALESCE(SUM(CASE WHEN br.amount_cents > 0 THEN br.amount_cents ELSE 0 END), 0) AS inflow_cents,
          COALESCE(SUM(CASE WHEN br.amount_cents < 0 THEN -br.amount_cents ELSE 0 END), 0) AS outflow_cents
         FROM bank_accounts ba LEFT JOIN bank_register br ON br.bank_account_id = ba.id AND br.txn_date >= ? AND br.txn_date <= ?
         GROUP BY ba.id ORDER BY ba.id`,
        from,
        to
      ),
    });
  }
  if (name === "expirations") {
    const month = /^\d{4}-\d{2}$/.test(str(req.query.month)) ? str(req.query.month) : "";
    const range = month ? monthBounds(month) : { start: db.today(), end: db.addDays(60) };
    return res.json(db.all(
      `SELECT l.id AS lease_id, l.end_date, l.rent_cents, l.status, t.first_name, t.last_name, u.name AS unit, p.name AS property
       FROM leases l JOIN tenants t ON t.id = l.tenant_id JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
       WHERE l.status IN ('active', 'notice') AND l.end_date >= ? AND l.end_date <= ? ORDER BY l.end_date`,
      range.start,
      range.end
    ));
  }
  if (name === "ledger") {
    const leaseId = recordId(req.query.leaseId);
    const lease = db.leaseContext(leaseId);
    if (!lease) throw db.fail(404, "Lease not found");
    return res.json({
      lease,
      tenant: db.one("SELECT * FROM tenants WHERE id = ?", lease.tenant_id),
      balance: leaseBalance(leaseId),
      charges: db.all("SELECT * FROM charges WHERE lease_id = ? ORDER BY due_date, id", leaseId),
      payments: db.all("SELECT * FROM payments WHERE lease_id = ? ORDER BY paid_at, id", leaseId),
    });
  }
  throw db.fail(404, "That report is not in SunPilot");
}));

function syncEstimateApproval(workOrder) {
  const workflow = db.one("SELECT * FROM workflows WHERE trigger = 'estimate' AND active = 1");
  if (!workflow || !workOrder.estimate_cents) return;
  const agreement = db.one(
    "SELECT repair_approval_threshold_cents AS threshold FROM management_agreements WHERE property_id = ? AND status = 'active' ORDER BY id DESC",
    workOrder.property_id
  );
  const threshold = agreement ? agreement.threshold : 0;
  if (workOrder.estimate_cents < threshold) return;
  const existing = db.one("SELECT id FROM approvals WHERE entity = 'work_order' AND entity_id = ? AND status = 'pending'", workOrder.id);
  if (existing) return;
  const owner = db.primaryOwner(workOrder.property_id);
  db.add("approvals", {
    kind: "estimate",
    entity: "work_order",
    entity_id: workOrder.id,
    owner_id: owner ? owner.owner_id : null,
    property_id: workOrder.property_id,
    amount_cents: workOrder.estimate_cents,
    status: "pending",
    notes: workOrder.title,
    created_at: db.nowStamp(),
  });
  db.run("UPDATE work_orders SET status = 'pending_approval', approved = 0 WHERE id = ?", workOrder.id);
  if (owner) {
    const ownerUser = db.one("SELECT id FROM users WHERE owner_id = ? AND active = 1", owner.owner_id);
    if (ownerUser) db.notifyUsers([ownerUser.id], "Repair approval needed", workOrder.title, "#/portal/approvals");
  }
}

app.get("/api/work-orders", route((req, res) => {
  staffOnly(req);
  res.json(db.all(
    `SELECT w.*, p.name AS property, u.name AS unit, t.first_name, t.last_name, v.name AS vendor
     FROM work_orders w LEFT JOIN properties p ON p.id = w.property_id LEFT JOIN units u ON u.id = w.unit_id
     LEFT JOIN tenants t ON t.id = w.tenant_id LEFT JOIN vendors v ON v.id = w.vendor_id
     ORDER BY w.id DESC`
  ));
}));

app.post("/api/work-orders", route((req, res) => {
  permit(req, "maintenance.edit");
  const photo = req.body.photoDataUrl ? db.saveDataUrl(req.body.photoDataUrl) : "";
  const id = db.add("work_orders", {
    property_id: recordId(req.body.propertyId),
    unit_id: Number(req.body.unitId) || null,
    tenant_id: Number(req.body.tenantId) || null,
    vendor_id: Number(req.body.vendorId) || null,
    title: required(req.body.title, "Title"),
    description: str(req.body.description),
    priority: str(req.body.priority || "normal"),
    status: Number(req.body.vendorId) ? "assigned" : "new",
    category: str(req.body.category || "Other"),
    created_at: db.nowStamp(),
    scheduled_at: str(req.body.scheduledAt),
    completed_at: "",
    estimate_cents: dollars(req.body.estimate),
    approved: 0,
    photo_url: photo,
  });
  const created = db.one("SELECT * FROM work_orders WHERE id = ?", id);
  if (created.estimate_cents) syncEstimateApproval(created);
  db.audit(req.user.id, "work_order.created", "work_order", id, req.body.title);
  res.json({ id });
}));

app.get("/api/work-orders/:id", route((req, res) => {
  staffOnly(req);
  const id = recordId(req.params.id);
  const workOrder = db.one(
    `SELECT w.*, p.name AS property, u.name AS unit, t.first_name, t.last_name, v.name AS vendor
     FROM work_orders w LEFT JOIN properties p ON p.id = w.property_id LEFT JOIN units u ON u.id = w.unit_id
     LEFT JOIN tenants t ON t.id = w.tenant_id LEFT JOIN vendors v ON v.id = w.vendor_id WHERE w.id = ?`,
    id
  );
  if (!workOrder) throw db.fail(404, "Work order not found");
  res.json({
    workOrder,
    notes: db.all("SELECT n.*, u.name AS author FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.entity = 'work_order' AND n.entity_id = ? ORDER BY n.id", id),
    approvals: db.all("SELECT * FROM approvals WHERE entity = 'work_order' AND entity_id = ? ORDER BY id DESC", id),
  });
}));

app.patch("/api/work-orders/:id", route((req, res) => {
  permit(req, "maintenance.edit");
  const id = recordId(req.params.id);
  const current = db.one("SELECT * FROM work_orders WHERE id = ?", id);
  if (!current) throw db.fail(404, "Work order not found");
  const status = str(req.body.status || current.status);
  patchRow("work_orders", id, {
    vendor_id: req.body.vendorId === "" ? null : Number(req.body.vendorId || current.vendor_id) || null,
    title: str(req.body.title || current.title),
    description: str(req.body.description ?? current.description),
    priority: str(req.body.priority || current.priority),
    status,
    category: str(req.body.category || current.category),
    scheduled_at: str(req.body.scheduledAt ?? current.scheduled_at),
    completed_at: status === "completed" ? db.today() : current.completed_at,
    estimate_cents: req.body.estimate == null || req.body.estimate === "" ? current.estimate_cents : dollars(req.body.estimate),
  });
  if (req.body.note) {
    db.add("notes", { entity: "work_order", entity_id: id, body: str(req.body.note), user_id: req.user.id, created_at: db.nowStamp() });
  }
  syncEstimateApproval(db.one("SELECT * FROM work_orders WHERE id = ?", id));
  res.json({ id });
}));

app.get("/api/schedules", route((req, res) => {
  staffOnly(req);
  res.json(db.all(
    `SELECT s.*, p.name AS property, v.name AS vendor FROM maintenance_schedules s
     LEFT JOIN properties p ON p.id = s.property_id LEFT JOIN vendors v ON v.id = s.vendor_id ORDER BY s.next_date`
  ));
}));

app.post("/api/schedules", route((req, res) => {
  permit(req, "maintenance.edit");
  const id = db.add("maintenance_schedules", {
    property_id: recordId(req.body.propertyId),
    vendor_id: Number(req.body.vendorId) || null,
    title: required(req.body.title, "Title"),
    frequency: str(req.body.frequency || "monthly"),
    next_date: required(req.body.nextDate, "Next date"),
    notes: str(req.body.notes),
  });
  res.json({ id });
}));

app.patch("/api/schedules/:id", route((req, res) => {
  permit(req, "maintenance.edit");
  const id = recordId(req.params.id);
  patchRow("maintenance_schedules", id, {
    title: required(req.body.title, "Title"),
    frequency: str(req.body.frequency),
    next_date: required(req.body.nextDate, "Next date"),
    notes: str(req.body.notes),
    vendor_id: Number(req.body.vendorId) || null,
  });
  res.json({ id });
}));

app.get("/api/approvals", route((req, res) => {
  signIn(req);
  if (req.user.role === "owner") {
    return res.json(db.all(
      `SELECT a.*, p.name AS property FROM approvals a LEFT JOIN properties p ON p.id = a.property_id
       WHERE a.owner_id = ? ORDER BY a.id DESC`,
      req.user.owner_id
    ));
  }
  staffOnly(req);
  res.json(db.all(
    `SELECT a.*, p.name AS property, o.name AS owner FROM approvals a
     LEFT JOIN properties p ON p.id = a.property_id LEFT JOIN owners o ON o.id = a.owner_id
     ORDER BY a.id DESC`
  ));
}));

app.post("/api/approvals/:id/decide", route((req, res) => {
  signIn(req);
  const approval = db.one("SELECT * FROM approvals WHERE id = ?", recordId(req.params.id));
  if (!approval) throw db.fail(404, "Approval not found");
  if (req.user.role === "owner") {
    if (approval.owner_id !== req.user.owner_id) throw db.fail(403, "That approval belongs to another owner");
  } else {
    permit(req, "maintenance.edit");
  }
  res.json(db.decideApproval(approval.id, req.body.status === "denied" ? "denied" : "approved", req.user.id));
}));

app.get("/api/communications", route((req, res) => {
  staffOnly(req);
  res.json(db.all("SELECT * FROM communications ORDER BY id DESC LIMIT 200"));
}));

app.post("/api/communications", route((req, res) => {
  permit(req, "communication.send");
  const id = db.add("communications", {
    channel: str(req.body.channel || "email"),
    subject: str(req.body.subject),
    body: required(req.body.body, "Message"),
    tenant_id: Number(req.body.tenantId) || null,
    owner_id: Number(req.body.ownerId) || null,
    vendor_id: Number(req.body.vendorId) || null,
    user_id: req.user.id,
    created_at: db.nowStamp(),
  });
  res.json({ id });
}));

app.post("/api/announcements", route((req, res) => {
  permit(req, "communication.send");
  const audience = required(req.body.audience, "Audience");
  const body = required(req.body.body, "Message");
  const subject = str(req.body.subject || "Announcement");
  const role = audience === "owners" ? "owner" : audience === "vendors" ? "vendor" : "tenant";
  const channel = audience === "tenants" ? "sms" : "announcement";
  const people = audience === "owners"
    ? db.all("SELECT id, name FROM owners")
    : audience === "vendors"
      ? db.all("SELECT id, name FROM vendors")
      : db.all("SELECT id, first_name || ' ' || last_name AS name FROM tenants");
  for (const person of people) {
    db.add("communications", {
      channel,
      subject,
      body,
      tenant_id: audience === "tenants" ? person.id : null,
      owner_id: audience === "owners" ? person.id : null,
      vendor_id: audience === "vendors" ? person.id : null,
      user_id: req.user.id,
      created_at: db.nowStamp(),
    });
  }
  const users = db.all("SELECT id FROM users WHERE role = ? AND active = 1", role);
  db.notifyUsers(users.map((user) => user.id), subject, body, "#/portal/messages");
  res.json({ sent: people.length });
}));

app.get("/api/documents", route((req, res) => {
  signIn(req);
  if (req.user.role === "tenant") return res.json(db.all("SELECT id, name, category, created_at FROM documents WHERE tenant_id = ? ORDER BY id DESC", req.user.tenant_id));
  if (req.user.role === "owner") return res.json(db.all("SELECT id, name, category, created_at FROM documents WHERE owner_id = ? ORDER BY id DESC", req.user.owner_id));
  if (req.user.role === "vendor") return res.json(db.all("SELECT id, name, category, created_at FROM documents WHERE vendor_id = ? ORDER BY id DESC", req.user.vendor_id));
  staffOnly(req);
  const tenantId = Number(req.query.tenantId) || 0;
  const ownerId = Number(req.query.ownerId) || 0;
  if (tenantId) return res.json(db.all("SELECT * FROM documents WHERE tenant_id = ? ORDER BY id DESC", tenantId));
  if (ownerId) return res.json(db.all("SELECT * FROM documents WHERE owner_id = ? ORDER BY id DESC", ownerId));
  res.json(db.all("SELECT id, name, category, created_at, tenant_id, owner_id, property_id FROM documents ORDER BY id DESC LIMIT 200"));
}));

app.get("/api/documents/:id", route((req, res) => {
  signIn(req);
  const document = db.one("SELECT * FROM documents WHERE id = ?", recordId(req.params.id));
  if (!document) throw db.fail(404, "Document not found");
  if (req.user.role === "tenant" && document.tenant_id !== req.user.tenant_id) throw db.fail(403, "That document is not yours");
  if (req.user.role === "owner" && document.owner_id !== req.user.owner_id) throw db.fail(403, "That document is not yours");
  if (req.user.role === "vendor" && document.vendor_id !== req.user.vendor_id) throw db.fail(403, "That document is not yours");
  if (!STAFF.has(req.user.role) && !["tenant", "owner", "vendor"].includes(req.user.role)) throw db.fail(403, "You cannot view that document");
  res.json(document);
}));

app.post("/api/documents", route((req, res) => {
  staffOnly(req);
  const id = db.add("documents", {
    name: required(req.body.name, "Name"),
    category: str(req.body.category || "file"),
    tenant_id: Number(req.body.tenantId) || null,
    owner_id: Number(req.body.ownerId) || null,
    property_id: Number(req.body.propertyId) || null,
    vendor_id: Number(req.body.vendorId) || null,
    content: str(req.body.content),
    url: str(req.body.url),
    created_at: db.nowStamp(),
  });
  res.json({ id });
}));

app.get("/api/company", route((req, res) => {
  staffOnly(req);
  res.json(db.one("SELECT * FROM company WHERE id = 1"));
}));

app.patch("/api/company", route((req, res) => {
  permit(req, "admin.edit");
  patchRow("company", 1, {
    name: required(req.body.name, "Company name"),
    legal_name: str(req.body.legalName),
    phone: str(req.body.phone),
    email: str(req.body.email),
    address: str(req.body.address),
    city: str(req.body.city),
    state: str(req.body.state),
    zip: str(req.body.zip),
    timezone: str(req.body.timezone || "America/Phoenix"),
  });
  res.json({ ok: true });
}));

app.get("/api/fees", route((req, res) => {
  staffOnly(req);
  res.json(db.all("SELECT * FROM fee_schedule ORDER BY id"));
}));

app.post("/api/fees", route((req, res) => {
  permit(req, "admin.edit");
  const id = db.add("fee_schedule", {
    name: required(req.body.name, "Name"),
    fee_type: str(req.body.feeType || "other"),
    amount_cents: dollars(req.body.amount),
    percent: Number(req.body.percent) || 0,
    notes: str(req.body.notes),
  });
  res.json({ id });
}));

app.patch("/api/fees/:id", route((req, res) => {
  permit(req, "admin.edit");
  patchRow("fee_schedule", recordId(req.params.id), {
    name: required(req.body.name, "Name"),
    fee_type: str(req.body.feeType),
    amount_cents: dollars(req.body.amount),
    percent: Number(req.body.percent) || 0,
    notes: str(req.body.notes),
  });
  res.json({ ok: true });
}));

app.get("/api/late-fee-rules", route((req, res) => {
  staffOnly(req);
  res.json(db.all("SELECT * FROM late_fee_rules ORDER BY id"));
}));

app.post("/api/late-fee-rules", route((req, res) => {
  permit(req, "admin.edit");
  const id = db.add("late_fee_rules", {
    name: required(req.body.name, "Name"),
    grace_days: int(req.body.graceDays),
    fee_type: str(req.body.feeType || "flat"),
    amount_cents: dollars(req.body.amount),
    percent: Number(req.body.percent) || 0,
  });
  res.json({ id });
}));

app.patch("/api/late-fee-rules/:id", route((req, res) => {
  permit(req, "admin.edit");
  patchRow("late_fee_rules", recordId(req.params.id), {
    name: required(req.body.name, "Name"),
    grace_days: int(req.body.graceDays),
    fee_type: str(req.body.feeType || "flat"),
    amount_cents: dollars(req.body.amount),
    percent: Number(req.body.percent) || 0,
  });
  res.json({ ok: true });
}));

app.get("/api/agreements", route((req, res) => {
  staffOnly(req);
  res.json(db.all(
    `SELECT a.*, p.name AS property, o.name AS owner FROM management_agreements a
     JOIN properties p ON p.id = a.property_id JOIN owners o ON o.id = a.owner_id ORDER BY p.name`
  ));
}));

app.post("/api/agreements", route((req, res) => {
  permit(req, "admin.edit");
  const id = db.add("management_agreements", {
    property_id: recordId(req.body.propertyId),
    owner_id: recordId(req.body.ownerId),
    start_date: required(req.body.startDate, "Start date"),
    end_date: str(req.body.endDate),
    management_fee_percent: Number(req.body.managementFeePercent) || 0,
    leasing_fee_percent: Number(req.body.leasingFeePercent) || 0,
    renewal_fee_cents: dollars(req.body.renewalFee),
    reserve_cents: dollars(req.body.reserve),
    repair_approval_threshold_cents: dollars(req.body.repairThreshold),
    status: "active",
  });
  res.json({ id });
}));

app.patch("/api/agreements/:id", route((req, res) => {
  permit(req, "admin.edit");
  patchRow("management_agreements", recordId(req.params.id), {
    start_date: required(req.body.startDate, "Start date"),
    end_date: str(req.body.endDate),
    management_fee_percent: Number(req.body.managementFeePercent) || 0,
    leasing_fee_percent: Number(req.body.leasingFeePercent) || 0,
    renewal_fee_cents: dollars(req.body.renewalFee),
    reserve_cents: dollars(req.body.reserve),
    repair_approval_threshold_cents: dollars(req.body.repairThreshold),
    status: str(req.body.status || "active"),
  });
  res.json({ ok: true });
}));

app.get("/api/users", route((req, res) => {
  permit(req, "admin.edit");
  res.json(db.all("SELECT id, email, name, role, phone, active, owner_id, tenant_id, vendor_id, created_at FROM users ORDER BY name"));
}));

app.post("/api/users", route((req, res) => {
  permit(req, "admin.edit");
  const id = db.createUser({
    email: req.body.email,
    password: req.body.password,
    name: required(req.body.name, "Name"),
    role: required(req.body.role, "Role"),
    phone: req.body.phone,
    ownerId: Number(req.body.ownerId) || null,
    tenantId: Number(req.body.tenantId) || null,
    vendorId: Number(req.body.vendorId) || null,
  });
  db.audit(req.user.id, "user.created", "user", id, req.body.role);
  res.json({ id });
}));

app.patch("/api/users/:id", route((req, res) => {
  permit(req, "admin.edit");
  const id = recordId(req.params.id);
  if (id === req.user.id && req.body.active === false) throw db.fail(400, "You cannot deactivate your own login");
  patchRow("users", id, {
    name: required(req.body.name, "Name"),
    role: required(req.body.role, "Role"),
    phone: str(req.body.phone),
    active: req.body.active ? 1 : 0,
  });
  res.json({ id });
}));

app.get("/api/permissions", route((req, res) => {
  permit(req, "admin.edit");
  res.json(db.all("SELECT * FROM role_permissions ORDER BY role, permission"));
}));

app.put("/api/permissions", route((req, res) => {
  permit(req, "admin.edit");
  const role = required(req.body.role, "Role");
  const permission = required(req.body.permission, "Permission");
  if (role === "admin" && permission === "admin.edit" && !req.body.allowed) {
    throw db.fail(400, "The admin role keeps settings access");
  }
  db.run("UPDATE role_permissions SET allowed = ? WHERE role = ? AND permission = ?", req.body.allowed ? 1 : 0, role, permission);
  db.audit(req.user.id, "permission.updated", "role", null, `${role} ${permission}`);
  res.json({ ok: true });
}));

app.get("/api/audit", route((req, res) => {
  permit(req, "admin.edit");
  res.json(db.all(
    `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300`
  ));
}));

app.get("/api/workflows", route((req, res) => {
  staffOnly(req);
  res.json(db.all("SELECT * FROM workflows ORDER BY id"));
}));

app.post("/api/workflows", route((req, res) => {
  permit(req, "admin.edit");
  const id = db.add("workflows", {
    name: required(req.body.name, "Name"),
    trigger: str(req.body.trigger || "bill"),
    amount_threshold_cents: dollars(req.body.amount),
    days_before: int(req.body.daysBefore),
    active: 1,
    notes: str(req.body.notes),
  });
  res.json({ id });
}));

app.patch("/api/workflows/:id", route((req, res) => {
  permit(req, "admin.edit");
  patchRow("workflows", recordId(req.params.id), {
    name: required(req.body.name, "Name"),
    trigger: str(req.body.trigger),
    amount_threshold_cents: dollars(req.body.amount),
    days_before: int(req.body.daysBefore),
    active: req.body.active ? 1 : 0,
    notes: str(req.body.notes),
  });
  res.json({ ok: true });
}));

app.get("/api/integrations", route((req, res) => {
  staffOnly(req);
  res.json(db.all("SELECT id, name, category, status, notes FROM integrations ORDER BY category, name"));
}));

app.patch("/api/integrations/:id", route((req, res) => {
  permit(req, "admin.edit");
  const id = recordId(req.params.id);
  const config = str(req.body.config);
  patchRow("integrations", id, {
    status: config ? "configured" : "not_connected",
    notes: config ? "Key saved on this computer. Live sync is not turned on yet." : str(req.body.notes),
    config,
  });
  res.json({ id });
}));

app.get("/api/portal/tenant", route((req, res) => {
  signIn(req);
  if (req.user.role !== "tenant") throw db.fail(403, "Resident access required");
  const tenant = db.one("SELECT * FROM tenants WHERE id = ?", req.user.tenant_id);
  const lease = currentLease(req.user.tenant_id);
  if (!lease) return res.json({ tenant, lease: null, balance: 0, charges: [], payments: [], workOrders: [], documents: [], messages: [] });
  res.json({
    tenant,
    lease,
    balance: leaseBalance(lease.id),
    charges: db.all("SELECT * FROM charges WHERE lease_id = ? ORDER BY due_date DESC", lease.id),
    payments: db.all("SELECT * FROM payments WHERE lease_id = ? ORDER BY paid_at DESC", lease.id),
    plan: db.one("SELECT * FROM payment_plans WHERE lease_id = ? AND status = 'active'", lease.id),
    workOrders: db.all("SELECT * FROM work_orders WHERE tenant_id = ? ORDER BY id DESC", tenant.id),
    documents: db.all("SELECT id, name, category, created_at FROM documents WHERE tenant_id = ?", tenant.id),
    messages: db.all("SELECT * FROM communications WHERE tenant_id = ? ORDER BY id DESC", tenant.id),
  });
}));

app.post("/api/portal/tenant/messages", route((req, res) => {
  signIn(req);
  if (req.user.role !== "tenant") throw db.fail(403, "Resident access required");
  const body = required(req.body.body, "Message");
  const id = db.add("communications", {
    channel: "sms",
    subject: "Text from resident",
    body,
    tenant_id: req.user.tenant_id,
    user_id: req.user.id,
    created_at: db.nowStamp(),
  });
  db.notifyStaff("Resident text", `${req.user.name}: ${body}`, "#/communication/texts");
  res.json({ id });
}));

app.post("/api/portal/tenant/payments", route((req, res) => {
  signIn(req);
  if (req.user.role !== "tenant") throw db.fail(403, "Resident access required");
  const lease = currentLease(req.user.tenant_id);
  if (!lease) throw db.fail(400, "No active lease is on this account");
  const result = db.applyPayment({
    leaseId: lease.id,
    amountCents: dollars(req.body.amount),
    method: str(req.body.method || "ACH"),
    reference: "Resident portal",
    userId: req.user.id,
  });
  db.notifyStaff("Rent payment", `${req.user.name} submitted ${moneyText(dollars(req.body.amount))}`, "#/accounting");
  res.json(result);
}));

app.post("/api/portal/tenant/work-orders", route((req, res) => {
  signIn(req);
  if (req.user.role !== "tenant") throw db.fail(403, "Resident access required");
  const lease = currentLease(req.user.tenant_id);
  if (!lease) throw db.fail(400, "No active lease is on this account");
  const photo = req.body.photoDataUrl ? db.saveDataUrl(req.body.photoDataUrl) : "";
  const id = db.add("work_orders", {
    property_id: lease.property_id,
    unit_id: lease.unit_id,
    tenant_id: req.user.tenant_id,
    vendor_id: null,
    title: required(req.body.title, "What needs attention"),
    description: str(req.body.description),
    priority: str(req.body.priority || "normal"),
    status: "new",
    category: str(req.body.category || "Other"),
    created_at: db.nowStamp(),
    scheduled_at: "",
    completed_at: "",
    estimate_cents: 0,
    approved: 0,
    photo_url: photo,
  });
  db.notifyStaff("New maintenance request", `${req.user.name}: ${req.body.title}`, `#/maintenance/${id}`);
  res.json({ id });
}));

app.post("/api/portal/tenant/autopay", route((req, res) => {
  signIn(req);
  if (req.user.role !== "tenant") throw db.fail(403, "Resident access required");
  const lease = currentLease(req.user.tenant_id);
  if (!lease) throw db.fail(400, "No active lease is on this account");
  db.run("UPDATE leases SET autopay = ?, autopay_method = ? WHERE id = ?", req.body.enabled ? 1 : 0, str(req.body.method || "ACH"), lease.id);
  res.json({ ok: true });
}));

app.get("/api/portal/owner", route((req, res) => {
  signIn(req);
  if (req.user.role !== "owner") throw db.fail(403, "Owner access required");
  const owner = db.one("SELECT * FROM owners WHERE id = ?", req.user.owner_id);
  const properties = db.all(
    `SELECT p.*, ow.percent FROM ownerships ow JOIN properties p ON p.id = ow.property_id WHERE ow.owner_id = ? ORDER BY p.name`,
    req.user.owner_id
  );
  const propertyIds = properties.map((property) => property.id);
  const occupancy = propertyIds.length
    ? db.all(
      `SELECT property_id, COUNT(*) AS units,
        SUM(CASE WHEN status = 'occupied' THEN 1 ELSE 0 END) AS occupied
       FROM units WHERE property_id IN (${propertyIds.map(() => "?").join(",")}) GROUP BY property_id`,
      ...propertyIds
    )
    : [];
  res.json({
    owner,
    properties,
    occupancy,
    statements: db.all(
      `SELECT s.id, s.period_start, s.period_end, s.ending_balance_cents, p.name AS property
       FROM owner_statements s JOIN properties p ON p.id = s.property_id WHERE s.owner_id = ? ORDER BY s.period_end DESC`,
      req.user.owner_id
    ),
    approvals: db.all(
      `SELECT a.*, p.name AS property FROM approvals a LEFT JOIN properties p ON p.id = a.property_id
       WHERE a.owner_id = ? ORDER BY a.id DESC`,
      req.user.owner_id
    ),
    contributions: db.all("SELECT * FROM owner_contributions WHERE owner_id = ? ORDER BY contributed_at DESC", req.user.owner_id),
    documents: db.all("SELECT id, name, category, created_at FROM documents WHERE owner_id = ?", req.user.owner_id),
    workOrders: propertyIds.length
      ? db.all(
        `SELECT w.id, w.title, w.status, w.priority, p.name AS property FROM work_orders w
         JOIN properties p ON p.id = w.property_id WHERE w.property_id IN (${propertyIds.map(() => "?").join(",")})
         ORDER BY w.id DESC LIMIT 20`,
        ...propertyIds
      )
      : [],
  });
}));

app.post("/api/portal/owner/contributions", route((req, res) => {
  signIn(req);
  if (req.user.role !== "owner") throw db.fail(403, "Owner access required");
  const propertyId = recordId(req.body.propertyId);
  assertOwnerProperty(req.user, propertyId);
  const result = db.addContribution({
    ownerId: req.user.owner_id,
    propertyId,
    amountCents: dollars(req.body.amount),
    method: str(req.body.method || "ACH"),
    memo: str(req.body.memo || "Owner funds"),
    userId: req.user.id,
  });
  db.notifyStaff("Owner funds received", `${req.user.name} added ${moneyText(dollars(req.body.amount))}`, "#/accounting");
  res.json(result);
}));

app.get("/api/portal/vendor", route((req, res) => {
  signIn(req);
  if (req.user.role !== "vendor") throw db.fail(403, "Vendor access required");
  const vendor = db.one("SELECT * FROM vendors WHERE id = ?", req.user.vendor_id);
  res.json({
    vendor,
    workOrders: db.all(
      `SELECT w.*, p.name AS property, p.address, u.name AS unit FROM work_orders w
       LEFT JOIN properties p ON p.id = w.property_id LEFT JOIN units u ON u.id = w.unit_id
       WHERE w.vendor_id = ? ORDER BY w.id DESC`,
      req.user.vendor_id
    ),
    bills: db.all("SELECT * FROM bills WHERE vendor_id = ? ORDER BY id DESC", req.user.vendor_id),
  });
}));

app.patch("/api/portal/vendor/work-orders/:id", route((req, res) => {
  signIn(req);
  if (req.user.role !== "vendor") throw db.fail(403, "Vendor access required");
  const id = recordId(req.params.id);
  const workOrder = db.one("SELECT * FROM work_orders WHERE id = ? AND vendor_id = ?", id, req.user.vendor_id);
  if (!workOrder) throw db.fail(404, "Work order not found");
  const status = str(req.body.status || workOrder.status);
  patchRow("work_orders", id, {
    status,
    scheduled_at: str(req.body.scheduledAt || workOrder.scheduled_at),
    completed_at: status === "completed" ? db.today() : workOrder.completed_at,
    estimate_cents: req.body.estimate ? dollars(req.body.estimate) : workOrder.estimate_cents,
  });
  if (req.body.note) db.add("notes", { entity: "work_order", entity_id: id, body: str(req.body.note), user_id: req.user.id, created_at: db.nowStamp() });
  syncEstimateApproval(db.one("SELECT * FROM work_orders WHERE id = ?", id));
  db.notifyStaff("Vendor update", `${req.user.name} updated ${workOrder.title}`, `#/maintenance/${id}`);
  res.json({ id });
}));

app.post("/api/portal/vendor/invoices", route((req, res) => {
  signIn(req);
  if (req.user.role !== "vendor") throw db.fail(403, "Vendor access required");
  const propertyId = recordId(req.body.propertyId);
  const allowed = db.one("SELECT id FROM work_orders WHERE vendor_id = ? AND property_id = ?", req.user.vendor_id, propertyId);
  if (!allowed) throw db.fail(403, "You can invoice properties where you have a work order");
  res.json(db.createBill({
    vendorId: req.user.vendor_id,
    propertyId,
    amountCents: dollars(req.body.amount),
    dueDate: str(req.body.dueDate || db.today()),
    memo: required(req.body.memo, "Invoice memo"),
    category: "repairs",
    workOrderId: Number(req.body.workOrderId) || null,
    userId: req.user.id,
  }));
}));

app.patch("/api/portal/vendor", route((req, res) => {
  signIn(req);
  if (req.user.role !== "vendor") throw db.fail(403, "Vendor access required");
  patchRow("vendors", req.user.vendor_id, {
    phone: str(req.body.phone),
    insurance_carrier: str(req.body.insuranceCarrier),
    insurance_expires: str(req.body.insuranceExpires),
    license_number: str(req.body.licenseNumber),
    license_expires: str(req.body.licenseExpires),
  });
  res.json({ ok: true });
}));

app.use("/uploads", staticFiles(db.uploadDir));
app.use(staticFiles(publicDir));
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
app.get(/.*/, (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => {
  const company = db.one("SELECT name FROM company WHERE id = 1");
  console.log(`${company.name}`);
  console.log(`SunPilot is running at http://localhost:${port}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") console.error(`Port ${port} is already in use.`);
  else console.error(error);
  process.exit(1);
});
