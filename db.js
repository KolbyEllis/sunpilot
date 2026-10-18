const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const onLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const dataDir = onLambda ? path.join("/tmp", "sunpilot-data") : path.join(__dirname, "data");
const uploadDir = path.join(dataDir, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "sunpilot.db"));
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");

let savepointId = 0;

function savepoint(fn) {
  const name = `sp_${++savepointId}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw error;
  }
}

function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

function one(sql, ...params) {
  return db.prepare(sql).get(...params);
}

function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

function insertId(result) {
  return Number(result.lastInsertRowid);
}

function add(table, cols) {
  const keys = Object.keys(cols);
  const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
  return insertId(run(sql, ...keys.map((key) => cols[key])));
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isoDate(date = new Date()) {
  const z = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${z(date.getMonth() + 1)}-${z(date.getDate())}`;
}

function today() {
  return isoDate(new Date());
}

function addDays(days, from = new Date()) {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

function monthStart(offset = 0) {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() + offset);
  return isoDate(date);
}

function monthEnd(offset = 0) {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() + offset + 1);
  date.setDate(0);
  return isoDate(date);
}

function nowStamp() {
  const date = new Date();
  const z = (value) => String(value).padStart(2, "0");
  return `${isoDate(date)} ${z(date.getHours())}:${z(date.getMinutes())}:${z(date.getSeconds())}`;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function audit(userId, action, entity, entityId, detail) {
  add("audit_log", {
    user_id: userId || null,
    action,
    entity,
    entity_id: entityId || null,
    detail: detail || "",
    created_at: nowStamp(),
  });
}

function bankId(type) {
  const row = one("SELECT id FROM bank_accounts WHERE account_type = ? ORDER BY id LIMIT 1", type);
  if (!row) throw fail(400, `Add a ${type.replaceAll("_", " ")} bank account first`);
  return row.id;
}

function bumpBank(type, delta) {
  run("UPDATE bank_accounts SET balance_cents = balance_cents + ? WHERE id = ?", delta, bankId(type));
}

function postJournal({ date, memo, propertyId, source, sourceId, lines }) {
  const debit = lines.reduce((sum, line) => sum + (line.debit || 0), 0);
  const credit = lines.reduce((sum, line) => sum + (line.credit || 0), 0);
  if (debit !== credit) throw new Error(`Journal entry is out of balance (${debit} vs ${credit})`);
  return savepoint(() => {
    const entryId = add("journal_entries", {
      entry_date: date,
      memo,
      property_id: propertyId || null,
      source,
      source_id: sourceId || null,
    });
    for (const line of lines) {
      const account = one("SELECT id FROM accounts WHERE code = ?", line.code);
      if (!account) throw new Error(`Unknown account ${line.code}`);
      add("journal_lines", {
        entry_id: entryId,
        account_id: account.id,
        debit_cents: line.debit || 0,
        credit_cents: line.credit || 0,
        property_id: line.propertyId || propertyId || null,
      });
    }
    return entryId;
  });
}

function register(type, { date, description, amount, source, sourceId }) {
  add("bank_register", {
    bank_account_id: bankId(type),
    txn_date: date,
    description,
    amount_cents: amount,
    cleared: 0,
    source,
    source_id: sourceId || null,
  });
}

function leaseContext(leaseId) {
  return one(
    `SELECT l.*, u.property_id, u.name AS unit_name, p.name AS property_name, p.address, p.city, p.state, p.zip
     FROM leases l
     JOIN units u ON u.id = l.unit_id
     JOIN properties p ON p.id = u.property_id
     WHERE l.id = ?`,
    leaseId
  );
}

function postCharge({ leaseId, type, description, amountCents, dueDate, sourceChargeId }) {
  const lease = leaseContext(leaseId);
  if (!lease) throw fail(404, "Lease not found");
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw fail(400, "Enter an amount greater than zero");
  return add("charges", {
    lease_id: leaseId,
    tenant_id: lease.tenant_id,
    property_id: lease.property_id,
    type,
    description,
    amount_cents: amountCents,
    due_date: dueDate,
    status: "open",
    paid_cents: 0,
    source_charge_id: sourceChargeId || null,
  });
}

function applyPayment({ leaseId, amountCents, method, reference, userId, paidAt }) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw fail(400, "Enter a payment amount greater than zero");
  return savepoint(() => {
    const lease = leaseContext(leaseId);
    if (!lease) throw fail(404, "Lease not found");
    const open = all("SELECT * FROM charges WHERE lease_id = ? AND status != 'paid' ORDER BY due_date, id", leaseId);
    const balance = open.reduce((sum, charge) => sum + (charge.amount_cents - charge.paid_cents), 0);
    if (balance <= 0) throw fail(400, "This lease has nothing open to pay");
    if (amountCents > balance) throw fail(400, "That payment is more than the open balance");
    const paidAtValue = paidAt || today();
    const paymentId = add("payments", {
      lease_id: leaseId,
      tenant_id: lease.tenant_id,
      property_id: lease.property_id,
      amount_cents: amountCents,
      method: method || "ACH",
      reference_no: reference || "",
      paid_at: paidAtValue,
      status: "completed",
      created_by: userId || null,
    });
    let left = amountCents;
    const buckets = { rent: 0, late_fee: 0, other: 0, security_deposit: 0 };
    for (const charge of open) {
      if (left <= 0) break;
      const due = charge.amount_cents - charge.paid_cents;
      const take = Math.min(due, left);
      const paid = charge.paid_cents + take;
      run(
        "UPDATE charges SET paid_cents = ?, status = ? WHERE id = ?",
        paid,
        paid >= charge.amount_cents ? "paid" : "partial",
        charge.id
      );
      add("payment_applications", { payment_id: paymentId, charge_id: charge.id, amount_cents: take });
      const key = Object.prototype.hasOwnProperty.call(buckets, charge.type) ? charge.type : "other";
      buckets[key] += take;
      if (charge.type === "security_deposit") {
        run(
          "UPDATE security_deposits SET held_cents = held_cents + ?, status = 'held' WHERE lease_id = ?",
          take,
          leaseId
        );
      }
      left -= take;
    }
    const operating = buckets.rent + buckets.late_fee + buckets.other;
    const lines = [];
    if (operating > 0) lines.push({ code: "1010", debit: operating });
    if (buckets.rent) lines.push({ code: "4000", credit: buckets.rent });
    if (buckets.late_fee) lines.push({ code: "4050", credit: buckets.late_fee });
    if (buckets.other) lines.push({ code: "4100", credit: buckets.other });
    if (buckets.security_deposit) {
      lines.push({ code: "1200", debit: buckets.security_deposit });
      lines.push({ code: "2100", credit: buckets.security_deposit });
    }
    postJournal({
      date: paidAtValue,
      memo: `Tenant payment${reference ? ` ${reference}` : ""}`,
      propertyId: lease.property_id,
      source: "payment",
      sourceId: paymentId,
      lines,
    });
    if (operating > 0) {
      bumpBank("trust", operating);
      register("trust", {
        date: paidAtValue,
        description: `Tenant payment — ${lease.property_name}`,
        amount: operating,
        source: "payment",
        sourceId: paymentId,
      });
    }
    if (buckets.security_deposit) {
      bumpBank("security_deposit", buckets.security_deposit);
      register("security_deposit", {
        date: paidAtValue,
        description: `Security deposit — ${lease.property_name}`,
        amount: buckets.security_deposit,
        source: "deposit",
        sourceId: paymentId,
      });
    }
    const plan = one("SELECT * FROM payment_plans WHERE lease_id = ? AND status = 'active'", leaseId);
    if (plan) {
      const remaining = Math.max(0, plan.remaining_cents - amountCents);
      run(
        "UPDATE payment_plans SET remaining_cents = ?, status = ? WHERE id = ?",
        remaining,
        remaining === 0 ? "completed" : "active",
        plan.id
      );
    }
    audit(userId, "payment.received", "payment", paymentId, String(amountCents));
    return { paymentId, balance: balance - amountCents };
  });
}

function billNeedsApproval(amountCents) {
  const workflow = one("SELECT * FROM workflows WHERE trigger = 'bill' AND active = 1");
  if (!workflow || !workflow.amount_threshold_cents) return false;
  return amountCents >= workflow.amount_threshold_cents;
}

function primaryOwner(propertyId) {
  return one(
    "SELECT owner_id, percent FROM ownerships WHERE property_id = ? ORDER BY percent DESC, id LIMIT 1",
    propertyId
  );
}

function createBill({ vendorId, propertyId, amountCents, dueDate, memo, category, workOrderId, userId }) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw fail(400, "Enter a bill amount greater than zero");
  return savepoint(() => {
    const needs = billNeedsApproval(amountCents);
    const id = add("bills", {
      vendor_id: vendorId,
      property_id: propertyId,
      amount_cents: amountCents,
      due_date: dueDate || today(),
      memo: memo || "",
      category: category || "repairs",
      status: needs ? "pending_approval" : "approved",
      work_order_id: workOrderId || null,
      created_at: nowStamp(),
    });
    if (needs) {
      add("approvals", {
        kind: "bill",
        entity: "bill",
        entity_id: id,
        owner_id: null,
        property_id: propertyId,
        amount_cents: amountCents,
        status: "pending",
        notes: memo || "",
        created_at: nowStamp(),
      });
    }
    audit(userId, "bill.created", "bill", id, String(amountCents));
    return { id, status: needs ? "pending_approval" : "approved" };
  });
}

function payBill(billId, userId, paidAt) {
  return savepoint(() => {
    const bill = one("SELECT * FROM bills WHERE id = ?", billId);
    if (!bill) throw fail(404, "Bill not found");
    if (bill.status === "paid") throw fail(400, "That bill is already paid");
    if (bill.status !== "approved") throw fail(400, "Approve the bill before paying it");
    const account = bill.category === "utilities" ? "5100" : "5000";
    const paidDate = paidAt || today();
    run("UPDATE bills SET status = 'paid', paid_at = ? WHERE id = ?", paidDate, billId);
    postJournal({
      date: paidDate,
      memo: bill.memo || "Vendor bill",
      propertyId: bill.property_id,
      source: "bill",
      sourceId: billId,
      lines: [
        { code: account, debit: bill.amount_cents },
        { code: "1010", credit: bill.amount_cents },
      ],
    });
    bumpBank("trust", -bill.amount_cents);
    register("trust", {
      date: paidDate,
      description: bill.memo || "Vendor bill",
      amount: -bill.amount_cents,
      source: "bill",
      sourceId: billId,
    });
    audit(userId, "bill.paid", "bill", billId, String(bill.amount_cents));
    return { id: billId };
  });
}

function decideApproval(approvalId, status, userId) {
  if (status !== "approved" && status !== "denied") throw fail(400, "Choose approved or denied");
  return savepoint(() => {
    const approval = one("SELECT * FROM approvals WHERE id = ?", approvalId);
    if (!approval) throw fail(404, "Approval not found");
    if (approval.status !== "pending") throw fail(400, "That request is already decided");
    run("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?", status, nowStamp(), approvalId);
    if (approval.entity === "bill") {
      run(
        "UPDATE bills SET status = ? WHERE id = ?",
        status === "approved" ? "approved" : "rejected",
        approval.entity_id
      );
    }
    if (approval.entity === "work_order") {
      run(
        "UPDATE work_orders SET approved = ?, status = ? WHERE id = ?",
        status === "approved" ? 1 : 0,
        status === "approved" ? "approved" : "estimate",
        approval.entity_id
      );
    }
    if (approval.entity === "purchase_order") {
      run(
        "UPDATE purchase_orders SET status = ? WHERE id = ?",
        status === "approved" ? "approved" : "rejected",
        approval.entity_id
      );
    }
    audit(userId, `approval.${status}`, approval.entity, approval.entity_id, "");
    return { id: approvalId, status };
  });
}

function addContribution({ ownerId, propertyId, amountCents, method, memo, userId, contributedAt }) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw fail(400, "Enter an amount greater than zero");
  const owns = one("SELECT id FROM ownerships WHERE owner_id = ? AND property_id = ?", ownerId, propertyId);
  if (!owns) throw fail(400, "That owner is not on this property");
  return savepoint(() => {
    const date = contributedAt || today();
    const id = add("owner_contributions", {
      owner_id: ownerId,
      property_id: propertyId,
      amount_cents: amountCents,
      method: method || "ACH",
      memo: memo || "Owner funds",
      contributed_at: date,
    });
    postJournal({
      date,
      memo: memo || "Owner contribution",
      propertyId,
      source: "contribution",
      sourceId: id,
      lines: [
        { code: "1010", debit: amountCents },
        { code: "3200", credit: amountCents },
      ],
    });
    bumpBank("trust", amountCents);
    register("trust", {
      date,
      description: memo || "Owner contribution",
      amount: amountCents,
      source: "contribution",
      sourceId: id,
    });
    audit(userId, "owner.contribution", "owner_contribution", id, String(amountCents));
    return { id };
  });
}

function addDistribution({ ownerId, propertyId, amountCents, memo, userId, distributedAt }) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw fail(400, "Enter an amount greater than zero");
  const owns = one("SELECT id FROM ownerships WHERE owner_id = ? AND property_id = ?", ownerId, propertyId);
  if (!owns) throw fail(400, "That owner is not on this property");
  return savepoint(() => {
    const date = distributedAt || today();
    const id = add("owner_distributions", {
      owner_id: ownerId,
      property_id: propertyId,
      amount_cents: amountCents,
      memo: memo || "Owner distribution",
      distributed_at: date,
    });
    postJournal({
      date,
      memo: memo || "Owner distribution",
      propertyId,
      source: "distribution",
      sourceId: id,
      lines: [
        { code: "3300", debit: amountCents },
        { code: "1010", credit: amountCents },
      ],
    });
    bumpBank("trust", -amountCents);
    register("trust", {
      date,
      description: memo || "Owner distribution",
      amount: -amountCents,
      source: "distribution",
      sourceId: id,
    });
    audit(userId, "owner.distribution", "owner_distribution", id, String(amountCents));
    return { id };
  });
}

function share(amount, percent) {
  return Math.round((amount * percent) / 100);
}

function sumApplications(propertyId, start, end, depositMode) {
  const depositSql = depositMode === "only" ? "AND c.type = 'security_deposit'" : "AND c.type != 'security_deposit'";
  const typeSql = depositMode === "rent" ? "AND c.type = 'rent'" : depositSql;
  return one(
    `SELECT COALESCE(SUM(pa.amount_cents), 0) AS amount
     FROM payment_applications pa
     JOIN payments p ON p.id = pa.payment_id
     JOIN charges c ON c.id = pa.charge_id
     WHERE p.property_id = ? AND p.status = 'completed' AND p.paid_at >= ? AND p.paid_at <= ? ${typeSql}`,
    propertyId,
    start,
    end
  ).amount;
}

function sumBills(propertyId, start, end) {
  return one(
    `SELECT COALESCE(SUM(amount_cents), 0) AS amount
     FROM bills WHERE property_id = ? AND status = 'paid' AND paid_at >= ? AND paid_at <= ?`,
    propertyId,
    start,
    end
  ).amount;
}

function sumOwnerMoney(table, dateColumn, ownerId, propertyId, start, end) {
  return one(
    `SELECT COALESCE(SUM(amount_cents), 0) AS amount
     FROM ${table} WHERE owner_id = ? AND property_id = ? AND ${dateColumn} >= ? AND ${dateColumn} <= ?`,
    ownerId,
    propertyId,
    start,
    end
  ).amount;
}

function feesBefore(propertyId, start) {
  return one(
    `SELECT COALESCE(SUM(jl.debit_cents), 0) AS amount
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.entry_id
     JOIN accounts a ON a.id = jl.account_id
     WHERE a.code = '5200' AND jl.property_id = ? AND je.entry_date < ?`,
    propertyId,
    start
  ).amount;
}

function ensureManagementFee(propertyId, start, end, userId) {
  const memo = `Management fee ${start} to ${end}`;
  const existing = one(
    "SELECT id FROM journal_entries WHERE source = 'management_fee' AND property_id = ? AND memo = ?",
    propertyId,
    memo
  );
  const agreement = one(
    "SELECT management_fee_percent AS percent FROM management_agreements WHERE property_id = ? AND status = 'active' ORDER BY id DESC",
    propertyId
  );
  const percent = agreement ? agreement.percent : 0;
  const rent = sumApplications(propertyId, start, end, "rent");
  const fee = Math.round((rent * percent) / 100);
  if (existing || fee <= 0) return fee;
  postJournal({
    date: end,
    memo,
    propertyId,
    source: "management_fee",
    sourceId: propertyId,
    lines: [
      { code: "5200", debit: fee },
      { code: "1010", credit: fee },
      { code: "1050", debit: fee },
      { code: "4900", credit: fee },
    ],
  });
  bumpBank("trust", -fee);
  bumpBank("operating", fee);
  register("trust", { date: end, description: memo, amount: -fee, source: "management_fee", sourceId: propertyId });
  register("operating", { date: end, description: memo, amount: fee, source: "management_fee", sourceId: propertyId });
  audit(userId, "fee.posted", "property", propertyId, String(fee));
  return fee;
}

function cashBefore(ownerId, propertyId, start, percent) {
  const income = sumApplications(propertyId, "1900-01-01", addDays(-1, new Date(`${start}T00:00:00`)), "exclude");
  const expenses = sumBills(propertyId, "1900-01-01", addDays(-1, new Date(`${start}T00:00:00`)));
  const contributions = sumOwnerMoney("owner_contributions", "contributed_at", ownerId, propertyId, "1900-01-01", addDays(-1, new Date(`${start}T00:00:00`)));
  const distributions = sumOwnerMoney("owner_distributions", "distributed_at", ownerId, propertyId, "1900-01-01", addDays(-1, new Date(`${start}T00:00:00`)));
  const fees = feesBefore(propertyId, start);
  return share(income - expenses - fees, percent) + contributions - distributions;
}

function generateStatement({ ownerId, propertyId, periodStart, periodEnd, userId }) {
  if (!periodStart || !periodEnd || periodEnd < periodStart) throw fail(400, "Choose a valid statement period");
  const ownership = one("SELECT percent FROM ownerships WHERE owner_id = ? AND property_id = ?", ownerId, propertyId);
  if (!ownership) throw fail(400, "That owner is not on this property");
  const duplicate = one(
    "SELECT id FROM owner_statements WHERE owner_id = ? AND property_id = ? AND period_start = ? AND period_end = ?",
    ownerId,
    propertyId,
    periodStart,
    periodEnd
  );
  if (duplicate) throw fail(400, "A statement for that owner and period already exists");
  return savepoint(() => {
    const feeTotal = ensureManagementFee(propertyId, periodStart, periodEnd, userId);
    const percent = ownership.percent;
    const incomeRows = all(
      `SELECT c.description, c.type, pa.amount_cents
       FROM payment_applications pa
       JOIN payments p ON p.id = pa.payment_id
       JOIN charges c ON c.id = pa.charge_id
       WHERE p.property_id = ? AND p.status = 'completed' AND c.type != 'security_deposit'
         AND p.paid_at >= ? AND p.paid_at <= ?
       ORDER BY p.paid_at, pa.id`,
      propertyId,
      periodStart,
      periodEnd
    );
    const expenseRows = all(
      `SELECT memo, amount_cents, category FROM bills
       WHERE property_id = ? AND status = 'paid' AND paid_at >= ? AND paid_at <= ?`,
      propertyId,
      periodStart,
      periodEnd
    );
    const contributionRows = all(
      `SELECT memo, amount_cents, contributed_at FROM owner_contributions
       WHERE owner_id = ? AND property_id = ? AND contributed_at >= ? AND contributed_at <= ?`,
      ownerId,
      propertyId,
      periodStart,
      periodEnd
    );
    const distributionRows = all(
      `SELECT memo, amount_cents, distributed_at FROM owner_distributions
       WHERE owner_id = ? AND property_id = ? AND distributed_at >= ? AND distributed_at <= ?`,
      ownerId,
      propertyId,
      periodStart,
      periodEnd
    );
    const income = incomeRows.reduce((sum, row) => sum + row.amount_cents, 0);
    const expenses = expenseRows.reduce((sum, row) => sum + row.amount_cents, 0);
    const contributions = contributionRows.reduce((sum, row) => sum + row.amount_cents, 0);
    const distributions = distributionRows.reduce((sum, row) => sum + row.amount_cents, 0);
    const incomeShare = share(income, percent);
    const expenseShare = share(expenses, percent);
    const feeShare = share(feeTotal, percent);
    const beginning = cashBefore(ownerId, propertyId, periodStart, percent);
    const ending = beginning + incomeShare + contributions - expenseShare - feeShare - distributions;
    const detail = {
      basis: "cash",
      ownershipPercent: percent,
      income: incomeRows.map((row) => ({ description: row.description, amount: share(row.amount_cents, percent) })),
      expenses: expenseRows.map((row) => ({ description: row.memo || row.category, amount: share(row.amount_cents, percent) })),
      contributions: contributionRows.map((row) => ({ description: row.memo, amount: row.amount_cents })),
      distributions: distributionRows.map((row) => ({ description: row.memo, amount: row.amount_cents })),
    };
    const id = add("owner_statements", {
      owner_id: ownerId,
      property_id: propertyId,
      period_start: periodStart,
      period_end: periodEnd,
      beginning_cents: beginning,
      income_cents: incomeShare,
      expense_cents: expenseShare,
      management_fee_cents: feeShare,
      contribution_cents: contributions,
      distribution_cents: distributions,
      ending_balance_cents: ending,
      detail: JSON.stringify(detail),
      created_at: nowStamp(),
    });
    audit(userId, "statement.generated", "owner_statement", id, `${periodStart} ${periodEnd}`);
    return { id };
  });
}

function postLateFees(userId) {
  const rule = one("SELECT * FROM late_fee_rules ORDER BY id LIMIT 1");
  if (!rule) throw fail(400, "Add a late fee rule first");
  const charges = all(
    "SELECT * FROM charges WHERE type = 'rent' AND status != 'paid' AND due_date <= ?",
    addDays(-rule.grace_days)
  );
  let created = 0;
  for (const charge of charges) {
    const existing = one("SELECT id FROM charges WHERE source_charge_id = ? AND type = 'late_fee'", charge.id);
    if (existing) continue;
    const unpaid = charge.amount_cents - charge.paid_cents;
    const fee = rule.fee_type === "percent" ? Math.round((unpaid * rule.percent) / 100) : rule.amount_cents;
    if (fee <= 0) continue;
    postCharge({
      leaseId: charge.lease_id,
      type: "late_fee",
      description: `Late fee for rent due ${charge.due_date}`,
      amountCents: fee,
      dueDate: today(),
      sourceChargeId: charge.id,
    });
    created += 1;
  }
  audit(userId, "late_fees.posted", "charge", null, String(created));
  return { created };
}

function postMonthlyRent(month, userId) {
  if (!/^\d{4}-\d{2}$/.test(month || "")) throw fail(400, "Choose a month");
  const due = `${month}-01`;
  const leases = all("SELECT * FROM leases WHERE status IN ('active', 'notice')");
  let created = 0;
  for (const lease of leases) {
    if (lease.start_date > due) continue;
    const existing = one("SELECT id FROM charges WHERE lease_id = ? AND type = 'rent' AND due_date = ?", lease.id, due);
    if (existing) continue;
    postCharge({
      leaseId: lease.id,
      type: "rent",
      description: `Rent ${month}`,
      amountCents: lease.rent_cents,
      dueDate: due,
    });
    created += 1;
  }
  audit(userId, "rent.posted", "charge", null, `${month}:${created}`);
  return { created };
}

function runAutopay(userId) {
  const leases = all("SELECT * FROM leases WHERE autopay = 1 AND status = 'active'");
  let count = 0;
  for (const lease of leases) {
    const balance = one(
      "SELECT COALESCE(SUM(amount_cents - paid_cents), 0) AS amount FROM charges WHERE lease_id = ? AND status != 'paid'",
      lease.id
    ).amount;
    if (balance <= 0) continue;
    applyPayment({
      leaseId: lease.id,
      amountCents: balance,
      method: lease.autopay_method || "ACH",
      reference: "Autopay",
      userId,
    });
    count += 1;
  }
  audit(userId, "autopay.run", "payment", null, String(count));
  return { count };
}

function notifyUsers(userIds, title, body, href) {
  for (const userId of userIds) {
    add("notifications", {
      user_id: userId,
      audience: "",
      title,
      body,
      href: href || "",
      created_at: nowStamp(),
      read: 0,
    });
  }
}

function notifyStaff(title, body, href) {
  const staff = all(
    "SELECT id FROM users WHERE role IN ('admin', 'manager', 'leasing', 'accounting', 'maintenance') AND active = 1"
  );
  notifyUsers(staff.map((user) => user.id), title, body, href);
}

function createUser({ email, password, name, role, phone, ownerId, tenantId, vendorId }) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) throw fail(400, "Enter a valid email");
  if (!password || String(password).length < 8) throw fail(400, "Password must be at least 8 characters");
  const existing = one("SELECT id FROM users WHERE email = ?", normalized);
  if (existing) throw fail(400, "A user with that email already exists");
  return add("users", {
    email: normalized,
    password_hash: hashPassword(password),
    name: name || normalized,
    role,
    phone: phone || "",
    owner_id: ownerId || null,
    tenant_id: tenantId || null,
    vendor_id: vendorId || null,
    active: 1,
    created_at: nowStamp(),
  });
}

function moveIn(body, userId) {
  return savepoint(() => {
    const unit = one("SELECT * FROM units WHERE id = ?", body.unitId);
    if (!unit) throw fail(404, "Unit not found");
    const blocking = one(
      "SELECT id FROM leases WHERE unit_id = ? AND status IN ('active', 'notice')",
      unit.id
    );
    if (blocking) throw fail(400, "That unit already has a current lease");
    const tenantId = add("tenants", {
      first_name: body.firstName,
      last_name: body.lastName,
      email: body.email || "",
      phone: body.phone || "",
      birth_date: body.birthDate || "",
      emergency_contact: body.emergencyContact || "",
      notes: "",
    });
    if (body.createLogin) {
      createUser({
        email: body.email,
        password: body.password || "sunseeker",
        name: `${body.firstName} ${body.lastName}`,
        role: "tenant",
        phone: body.phone,
        tenantId,
      });
    }
    const status = body.startDate > today() ? "future" : "active";
    const leaseId = add("leases", {
      unit_id: unit.id,
      tenant_id: tenantId,
      start_date: body.startDate,
      end_date: body.endDate,
      rent_cents: body.rentCents,
      deposit_cents: body.depositCents,
      status,
      due_day: 1,
      autopay: 0,
      autopay_method: "ACH",
    });
    add("security_deposits", {
      lease_id: leaseId,
      amount_cents: body.depositCents,
      held_cents: 0,
      status: "due",
    });
    if (body.depositCents > 0) {
      postCharge({
        leaseId,
        type: "security_deposit",
        description: "Security deposit",
        amountCents: body.depositCents,
        dueDate: body.startDate,
      });
    }
    postCharge({
      leaseId,
      type: "rent",
      description: `Rent ${body.startDate.slice(0, 7)}`,
      amountCents: body.rentCents,
      dueDate: body.startDate,
    });
    add("move_checklists", {
      lease_id: leaseId,
      kind: "in",
      status: "open",
      items: JSON.stringify([
        { label: "Lease signed", done: false },
        { label: "Keys and access devices handed over", done: false },
        { label: "Move-in photos taken", done: false },
        { label: "Utilities confirmed", done: false },
      ]),
      notes: "",
    });
    run("UPDATE units SET status = ? WHERE id = ?", status === "active" ? "occupied" : "vacant", unit.id);
    run("UPDATE listings SET status = 'leased' WHERE unit_id = ? AND status = 'active'", unit.id);
    audit(userId, "lease.move_in", "lease", leaseId, "");
    return { leaseId, tenantId };
  });
}

function moveOut(body, userId) {
  return savepoint(() => {
    const lease = leaseContext(body.leaseId);
    if (!lease) throw fail(404, "Lease not found");
    const deposit = one("SELECT * FROM security_deposits WHERE lease_id = ?", lease.id);
    const refund = body.refundCents || 0;
    if (deposit && refund > deposit.held_cents) throw fail(400, "Refund is larger than the deposit being held");
    run("UPDATE leases SET status = 'ended', end_date = ? WHERE id = ?", body.moveOutDate, lease.id);
    run("UPDATE units SET status = 'vacant' WHERE id = ?", lease.unit_id);
    if (deposit && refund > 0) {
      run(
        "UPDATE security_deposits SET held_cents = held_cents - ?, status = 'refunded' WHERE id = ?",
        refund,
        deposit.id
      );
      postJournal({
        date: body.moveOutDate,
        memo: "Security deposit refund",
        propertyId: lease.property_id,
        source: "deposit_refund",
        sourceId: lease.id,
        lines: [
          { code: "2100", debit: refund },
          { code: "1200", credit: refund },
        ],
      });
      bumpBank("security_deposit", -refund);
      register("security_deposit", {
        date: body.moveOutDate,
        description: "Security deposit refund",
        amount: -refund,
        source: "deposit_refund",
        sourceId: lease.id,
      });
    } else if (deposit) {
      run("UPDATE security_deposits SET status = 'closed' WHERE id = ?", deposit.id);
    }
    add("move_checklists", {
      lease_id: lease.id,
      kind: "out",
      status: "open",
      items: JSON.stringify([
        { label: "Keys returned", done: false },
        { label: "Move-out photos taken", done: false },
        { label: "Deposit disposition recorded", done: refund >= 0 },
      ]),
      notes: body.notes || "",
    });
    audit(userId, "lease.move_out", "lease", lease.id, body.notes || "");
    return { leaseId: lease.id };
  });
}

function saveDataUrl(dataUrl) {
  if (!dataUrl) return "";
  const match = String(dataUrl).match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw fail(400, "Upload a PNG, JPG, or WebP photo");
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > 5_000_000) throw fail(400, "Photo must be 5 MB or smaller");
  const ext = match[1] === "jpeg" ? "jpg" : match[1];
  const name = `${crypto.randomBytes(8).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(uploadDir, name), buffer);
  return `/uploads/${name}`;
}

function permissionsFor(role) {
  return all("SELECT permission FROM role_permissions WHERE role = ? AND allowed = 1 ORDER BY permission", role).map(
    (row) => row.permission
  );
}

const schema = [
  `CREATE TABLE IF NOT EXISTS company (
    id INTEGER PRIMARY KEY,
    name TEXT, legal_name TEXT, phone TEXT, email TEXT, address TEXT, city TEXT, state TEXT, zip TEXT, timezone TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS bank_accounts (
    id INTEGER PRIMARY KEY,
    name TEXT, bank_name TEXT, account_type TEXT, last4 TEXT, balance_cents INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE, name TEXT, type TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS fee_schedule (
    id INTEGER PRIMARY KEY,
    name TEXT, fee_type TEXT, amount_cents INTEGER DEFAULT 0, percent REAL DEFAULT 0, notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS late_fee_rules (
    id INTEGER PRIMARY KEY,
    name TEXT, grace_days INTEGER, fee_type TEXT, amount_cents INTEGER DEFAULT 0, percent REAL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS owners (
    id INTEGER PRIMARY KEY,
    name TEXT, email TEXT, phone TEXT, address TEXT, tax_id_last4 TEXT, payment_method TEXT, notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS properties (
    id INTEGER PRIMARY KEY,
    name TEXT, address TEXT, city TEXT, state TEXT, zip TEXT, property_type TEXT,
    year_built INTEGER, photo_url TEXT, utilities TEXT, amenities TEXT, notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS units (
    id INTEGER PRIMARY KEY,
    property_id INTEGER NOT NULL REFERENCES properties(id),
    name TEXT, beds REAL, baths REAL, sqft INTEGER, market_rent_cents INTEGER, status TEXT, amenities TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ownerships (
    id INTEGER PRIMARY KEY,
    property_id INTEGER NOT NULL REFERENCES properties(id),
    owner_id INTEGER NOT NULL REFERENCES owners(id),
    percent REAL NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS management_agreements (
    id INTEGER PRIMARY KEY,
    property_id INTEGER NOT NULL REFERENCES properties(id),
    owner_id INTEGER NOT NULL REFERENCES owners(id),
    start_date TEXT, end_date TEXT, management_fee_percent REAL, leasing_fee_percent REAL,
    renewal_fee_cents INTEGER, reserve_cents INTEGER, repair_approval_threshold_cents INTEGER, status TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS vendors (
    id INTEGER PRIMARY KEY,
    name TEXT, trade TEXT, email TEXT, phone TEXT, address TEXT,
    insurance_carrier TEXT, insurance_expires TEXT, license_number TEXT, license_expires TEXT, notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY,
    first_name TEXT, last_name TEXT, email TEXT, phone TEXT, birth_date TEXT, emergency_contact TEXT, notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    phone TEXT,
    owner_id INTEGER,
    tenant_id INTEGER,
    vendor_id INTEGER,
    active INTEGER DEFAULT 1,
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS role_permissions (
    role TEXT, permission TEXT, allowed INTEGER DEFAULT 0, PRIMARY KEY (role, permission)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER, action TEXT, entity TEXT, entity_id INTEGER, detail TEXT, created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY,
    user_id INTEGER, email TEXT, status TEXT, created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    entity TEXT, entity_id INTEGER, body TEXT, user_id INTEGER, created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS custom_fields (
    id INTEGER PRIMARY KEY,
    entity TEXT, label TEXT, field_type TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS custom_field_values (
    id INTEGER PRIMARY KEY,
    field_id INTEGER NOT NULL REFERENCES custom_fields(id),
    entity_id INTEGER, value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS leases (
    id INTEGER PRIMARY KEY,
    unit_id INTEGER NOT NULL REFERENCES units(id),
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    start_date TEXT, end_date TEXT, rent_cents INTEGER, deposit_cents INTEGER,
    status TEXT, due_day INTEGER DEFAULT 1, autopay INTEGER DEFAULT 0, autopay_method TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS charges (
    id INTEGER PRIMARY KEY,
    lease_id INTEGER NOT NULL, tenant_id INTEGER, property_id INTEGER,
    type TEXT, description TEXT, amount_cents INTEGER, due_date TEXT,
    status TEXT, paid_cents INTEGER DEFAULT 0, source_charge_id INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY,
    lease_id INTEGER NOT NULL, tenant_id INTEGER, property_id INTEGER,
    amount_cents INTEGER, method TEXT, reference_no TEXT, paid_at TEXT, status TEXT, created_by INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS payment_applications (
    id INTEGER PRIMARY KEY,
    payment_id INTEGER NOT NULL, charge_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS payment_plans (
    id INTEGER PRIMARY KEY,
    lease_id INTEGER NOT NULL, total_cents INTEGER, installment_cents INTEGER,
    frequency TEXT, start_date TEXT, remaining_cents INTEGER, status TEXT, notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS security_deposits (
    id INTEGER PRIMARY KEY,
    lease_id INTEGER NOT NULL, amount_cents INTEGER, held_cents INTEGER DEFAULT 0, status TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY,
    unit_id INTEGER NOT NULL, headline TEXT, description TEXT, rent_cents INTEGER, available_date TEXT,
    status TEXT, syndicate_website INTEGER DEFAULT 1, syndicate_zillow INTEGER DEFAULT 0, syndicate_apartments INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS prospects (
    id INTEGER PRIMARY KEY,
    name TEXT, email TEXT, phone TEXT, unit_id INTEGER, source TEXT, stage TEXT, notes TEXT, created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS showings (
    id INTEGER PRIMARY KEY,
    prospect_id INTEGER, unit_id INTEGER, showing_type TEXT, scheduled_at TEXT, status TEXT, notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY,
    prospect_id INTEGER, unit_id INTEGER, status TEXT, submitted_at TEXT, income_cents INTEGER, occupants INTEGER, notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS screenings (
    id INTEGER PRIMARY KEY,
    application_id INTEGER, status TEXT, credit_score INTEGER, criminal TEXT, eviction TEXT, decision TEXT, notes TEXT, completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY,
    name TEXT, kind TEXT, subject TEXT, body TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS esign_packets (
    id INTEGER PRIMARY KEY,
    lease_id INTEGER, template_id INTEGER, title TEXT, status TEXT, sent_at TEXT, signed_at TEXT, body TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS renewals (
    id INTEGER PRIMARY KEY,
    lease_id INTEGER NOT NULL, offered_rent_cents INTEGER, new_end_date TEXT, status TEXT, notes TEXT, created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS communications (
    id INTEGER PRIMARY KEY,
    channel TEXT, subject TEXT, body TEXT, tenant_id INTEGER, owner_id INTEGER, vendor_id INTEGER,
    user_id INTEGER, created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    name TEXT, category TEXT, owner_id INTEGER, tenant_id INTEGER, property_id INTEGER, vendor_id INTEGER,
    content TEXT, url TEXT, created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS work_orders (
    id INTEGER PRIMARY KEY,
    property_id INTEGER, unit_id INTEGER, tenant_id INTEGER, vendor_id INTEGER,
    title TEXT, description TEXT, priority TEXT, status TEXT, category TEXT,
    created_at TEXT, scheduled_at TEXT, completed_at TEXT, estimate_cents INTEGER, approved INTEGER DEFAULT 0, photo_url TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS maintenance_schedules (
    id INTEGER PRIMARY KEY,
    property_id INTEGER, vendor_id INTEGER, title TEXT, frequency TEXT, next_date TEXT, notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS move_checklists (
    id INTEGER PRIMARY KEY,
    lease_id INTEGER, kind TEXT, status TEXT, items TEXT, notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS inspections (
    id INTEGER PRIMARY KEY,
    unit_id INTEGER, lease_id INTEGER, kind TEXT, inspected_at TEXT, notes TEXT, photo_url TEXT, user_id INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY,
    vendor_id INTEGER, property_id INTEGER, amount_cents INTEGER, due_date TEXT, memo TEXT,
    category TEXT, status TEXT, work_order_id INTEGER, created_at TEXT, paid_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY,
    vendor_id INTEGER, property_id INTEGER, amount_cents INTEGER, memo TEXT, status TEXT, created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY,
    kind TEXT, entity TEXT, entity_id INTEGER, owner_id INTEGER, property_id INTEGER,
    amount_cents INTEGER, status TEXT, notes TEXT, created_at TEXT, decided_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS owner_contributions (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER, property_id INTEGER, amount_cents INTEGER, method TEXT, memo TEXT, contributed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS owner_distributions (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER, property_id INTEGER, amount_cents INTEGER, memo TEXT, distributed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS owner_statements (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER, property_id INTEGER, period_start TEXT, period_end TEXT,
    beginning_cents INTEGER, income_cents INTEGER, expense_cents INTEGER, management_fee_cents INTEGER,
    contribution_cents INTEGER, distribution_cents INTEGER, ending_balance_cents INTEGER, detail TEXT, created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS journal_entries (
    id INTEGER PRIMARY KEY,
    entry_date TEXT, memo TEXT, property_id INTEGER, source TEXT, source_id INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS journal_lines (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    debit_cents INTEGER DEFAULT 0, credit_cents INTEGER DEFAULT 0, property_id INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS bank_register (
    id INTEGER PRIMARY KEY,
    bank_account_id INTEGER NOT NULL, txn_date TEXT, description TEXT, amount_cents INTEGER,
    cleared INTEGER DEFAULT 0, source TEXT, source_id INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS reconciliations (
    id INTEGER PRIMARY KEY,
    bank_account_id INTEGER, statement_date TEXT, statement_balance_cents INTEGER, cleared_cents INTEGER, difference_cents INTEGER, status TEXT, notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS tax_1099s (
    id INTEGER PRIMARY KEY,
    vendor_id INTEGER, tax_year INTEGER, amount_cents INTEGER, status TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY,
    name TEXT, trigger TEXT, amount_threshold_cents INTEGER, days_before INTEGER, active INTEGER DEFAULT 1, notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER, audience TEXT, title TEXT, body TEXT, href TEXT, created_at TEXT, read INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS integrations (
    id INTEGER PRIMARY KEY,
    name TEXT, category TEXT, status TEXT, notes TEXT, config TEXT
  )`,
];

function createSchema() {
  for (const statement of schema) db.exec(statement);
}

function ensureColumn(table, name, definition) {
  const columns = all(`PRAGMA table_info(${table})`).map((column) => column.name);
  if (columns.includes(name)) return false;
  run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  return true;
}

function ensureExtras() {
  const extras = [
    ["Trulia", "marketing", "Queues listings for Trulia with the Zillow Group feed."],
    ["Realtor.com", "marketing", "Queues listings for Realtor.com."],
    ["Texting", "sms", "Twilio delivers the texts you send from SunPilot."],
  ];
  for (const [name, category, notes] of extras) {
    if (!one("SELECT id FROM integrations WHERE name = ?", name)) {
      add("integrations", { name, category, status: "not_connected", notes, config: "" });
    }
  }
}

function grant(role, permissions) {
  const allowed = new Set(permissions);
  const allPermissions = [
    "portfolio.view", "portfolio.edit",
    "leasing.view", "leasing.edit",
    "people.view", "people.edit",
    "accounting.view", "accounting.edit",
    "maintenance.view", "maintenance.edit",
    "reports.view", "communication.send", "admin.edit",
  ];
  for (const permission of allPermissions) {
    add("role_permissions", { role, permission, allowed: allowed.has(permission) ? 1 : 0 });
  }
}

function seedLease({ unitId, tenantId, start, end, rent, deposit, status, autopay }) {
  const leaseId = add("leases", {
    unit_id: unitId,
    tenant_id: tenantId,
    start_date: start,
    end_date: end,
    rent_cents: rent,
    deposit_cents: deposit,
    status,
    due_day: 1,
    autopay: autopay ? 1 : 0,
    autopay_method: "ACH",
  });
  add("security_deposits", { lease_id: leaseId, amount_cents: deposit, held_cents: 0, status: "due" });
  if (deposit > 0) {
    postCharge({ leaseId, type: "security_deposit", description: "Security deposit", amountCents: deposit, dueDate: start });
    applyPayment({ leaseId, amountCents: deposit, method: "ACH", reference: "Deposit", paidAt: start });
  }
  return leaseId;
}

function seedRent(leaseId, monthOffset, amount, payAmount) {
  const due = monthStart(monthOffset);
  postCharge({
    leaseId,
    type: "rent",
    description: `Rent ${due.slice(0, 7)}`,
    amountCents: amount,
    dueDate: due,
  });
  if (payAmount > 0) {
    applyPayment({
      leaseId,
      amountCents: payAmount,
      method: "ACH",
      reference: "Rent",
      paidAt: due,
    });
  }
}

function seed() {
  add("company", {
    name: "SunSeeker Rentals & Property Management",
    legal_name: "SunSeeker Rentals LLC",
    phone: "(480) 555-0199",
    email: "hello@sunseekerrentals.com",
    address: "1000 N Sunseeker Way, Suite 200",
    city: "Phoenix",
    state: "AZ",
    zip: "85001",
    timezone: "America/Phoenix",
  });
  const accountRows = [
    ["1010", "Trust cash", "asset"],
    ["1050", "Company operating cash", "asset"],
    ["1200", "Security deposit cash", "asset"],
    ["2100", "Security deposits held", "liability"],
    ["3200", "Owner contributions", "equity"],
    ["3300", "Owner distributions", "equity"],
    ["4000", "Rent income", "income"],
    ["4050", "Late fee income", "income"],
    ["4100", "Other income", "income"],
    ["4900", "Management fee income", "income"],
    ["5000", "Repairs and maintenance", "expense"],
    ["5100", "Utilities", "expense"],
    ["5200", "Management fees", "expense"],
  ];
  for (const [code, name, type] of accountRows) add("accounts", { code, name, type });
  add("bank_accounts", { name: "Trust account", bank_name: "Desert Valley Bank", account_type: "trust", last4: "4412", balance_cents: 0 });
  add("bank_accounts", { name: "Security deposits", bank_name: "Desert Valley Bank", account_type: "security_deposit", last4: "2290", balance_cents: 0 });
  add("bank_accounts", { name: "Company operating", bank_name: "Desert Valley Bank", account_type: "operating", last4: "7781", balance_cents: 0 });
  add("fee_schedule", { name: "Management fee", fee_type: "management", amount_cents: 0, percent: 8, notes: "Percent of rent collected" });
  add("fee_schedule", { name: "Leasing fee", fee_type: "leasing", amount_cents: 0, percent: 50, notes: "Percent of first month's rent" });
  add("fee_schedule", { name: "Renewal fee", fee_type: "renewal", amount_cents: 20000, percent: 0, notes: "" });
  add("fee_schedule", { name: "NSF fee", fee_type: "nsf", amount_cents: 3500, percent: 0, notes: "" });
  add("late_fee_rules", { name: "Standard", grace_days: 5, fee_type: "flat", amount_cents: 5000, percent: 0 });
  add("workflows", { name: "Bill approval", trigger: "bill", amount_threshold_cents: 25000, days_before: 0, active: 1, notes: "Bills at or above $250 wait for a manager before they can be paid." });
  add("workflows", { name: "Owner repair approval", trigger: "estimate", amount_threshold_cents: 0, days_before: 0, active: 1, notes: "Estimates at or above the property's repair threshold go to the owner." });
  add("workflows", { name: "Renewal window", trigger: "renewal", amount_threshold_cents: 0, days_before: 60, active: 1, notes: "Leases ending inside this window show up for renewal." });
  const integrationRows = [
    ["Tenant screening", "screening"],
    ["Rent payments", "payments"],
    ["Zillow", "marketing"],
    ["Trulia", "marketing"],
    ["Realtor.com", "marketing"],
    ["Apartments.com", "marketing"],
    ["Texting", "sms"],
    ["Renter insurance", "insurance"],
    ["Utility billing", "utilities"],
  ];
  for (const [name, category] of integrationRows) {
    add("integrations", { name, category, status: "not_connected", notes: "Saved here when you are ready to connect a provider.", config: "" });
  }
  add("templates", {
    name: "Residential lease draft",
    kind: "lease",
    subject: "Lease for {{property_address}}",
    body: "LEASE DRAFT\n\n{{company_name}} leases {{property_address}}, unit {{unit}}, to {{tenant_name}}.\nTerm: {{start_date}} through {{end_date}}.\nMonthly rent: {{rent}}, due on day {{due_day}}.\nSecurity deposit: {{deposit}}.\n\nThis is a starting draft. Have an attorney review it before anyone signs.",
  });
  add("templates", {
    name: "Renewal offer",
    kind: "email",
    subject: "Renewal offer for {{property_address}}",
    body: "Hello {{tenant_name}},\n\nYour lease at {{property_address}} ends on {{end_date}}. We can offer a renewal at {{offered_rent}} through {{new_end_date}}.\n\nReply to this message if you want to renew.\n\n{{company_name}}",
  });
  add("templates", {
    name: "Late rent reminder",
    kind: "notice",
    subject: "Rent past due",
    body: "{{today}}\n\n{{tenant_name}}\n{{property_address}}, unit {{unit}}\n\nOur records show {{balance}} still open. Please pay through your resident portal or call {{company_name}} at {{company_phone}}.\n\nThis is a reminder draft, not a statutory notice.",
  });
  add("templates", {
    name: "Notice to pay or quit (draft)",
    kind: "notice",
    subject: "Notice to pay or quit",
    body: "{{today}}\n\nTo: {{tenant_name}}\nPremises: {{property_address}}, unit {{unit}}\n\nRent of {{balance}} is unpaid. Pay that amount or vacate the premises.\n\nDRAFT ONLY. Confirm the form, timing, and delivery rules with your attorney before this is served.",
  });
  add("templates", {
    name: "Maintenance update",
    kind: "text",
    subject: "",
    body: "SunSeeker update: {{subject}}. Reply here if you need to add photos or access notes.",
  });
  const everyone = [
    "portfolio.view", "portfolio.edit", "leasing.view", "leasing.edit", "people.view", "people.edit",
    "accounting.view", "accounting.edit", "maintenance.view", "maintenance.edit", "reports.view",
    "communication.send", "admin.edit",
  ];
  grant("admin", everyone);
  grant("manager", everyone);
  grant("leasing", ["portfolio.view", "leasing.view", "leasing.edit", "people.view", "people.edit", "maintenance.view", "reports.view", "communication.send"]);
  grant("accounting", ["portfolio.view", "people.view", "accounting.view", "accounting.edit", "reports.view", "communication.send"]);
  grant("maintenance", ["portfolio.view", "people.view", "maintenance.view", "maintenance.edit", "reports.view"]);

  const maria = add("owners", { name: "Maria Alvarez", email: "maria@sunseekerrentals.com", phone: "(480) 555-0114", address: "88 E Orangewood Ave, Phoenix, AZ", tax_id_last4: "4421", payment_method: "ACH", notes: "Prefers statements by the 10th." });
  const james = add("owners", { name: "James Okonkwo", email: "james.okonkwo@example.com", phone: "(602) 555-0172", address: "410 W Fillmore St, Phoenix, AZ", tax_id_last4: "8830", payment_method: "Check", notes: "" });

  const palm = add("properties", { name: "Palm Lane House", address: "1842 E Palm Lane", city: "Phoenix", state: "AZ", zip: "85006", property_type: "single_family", year_built: 1978, photo_url: "", utilities: "Tenant pays electric and gas. Owner pays water.", amenities: "Yard, covered parking, washer and dryer", notes: "Back gate sticks in summer." });
  const camel = add("properties", { name: "Camelback Duplex", address: "903 W Camelback Road", city: "Phoenix", state: "AZ", zip: "85013", property_type: "multi", year_built: 1964, photo_url: "", utilities: "Tenant pays all utilities.", amenities: "Assigned parking", notes: "" });
  const twelfth = add("properties", { name: "12th Street Fourplex", address: "4550 N 12th Street", city: "Phoenix", state: "AZ", zip: "85014", property_type: "multi", year_built: 1986, photo_url: "", utilities: "Water and trash included.", amenities: "Pool, laundry room", notes: "Pool service is monthly." });
  const dobson = add("properties", { name: "Dobson Condo", address: "221 S Dobson Road", city: "Mesa", state: "AZ", zip: "85202", property_type: "condo", year_built: 2004, photo_url: "", utilities: "HOA covers water and trash.", amenities: "Community pool", notes: "HOA quiet hours start at 10 p.m." });

  const palmUnit = add("units", { property_id: palm, name: "Main", beds: 3, baths: 2, sqft: 1460, market_rent_cents: 185000, status: "occupied", amenities: "Fireplace" });
  const camelA = add("units", { property_id: camel, name: "A", beds: 2, baths: 1, sqft: 860, market_rent_cents: 142500, status: "occupied", amenities: "Parking A-12" });
  const camelB = add("units", { property_id: camel, name: "B", beds: 2, baths: 1, sqft: 840, market_rent_cents: 139500, status: "vacant", amenities: "Parking B-4" });
  const u1 = add("units", { property_id: twelfth, name: "1", beds: 1, baths: 1, sqft: 620, market_rent_cents: 115000, status: "vacant", amenities: "" });
  const u2 = add("units", { property_id: twelfth, name: "2", beds: 2, baths: 1, sqft: 780, market_rent_cents: 127500, status: "occupied", amenities: "" });
  const u3 = add("units", { property_id: twelfth, name: "3", beds: 2, baths: 1, sqft: 790, market_rent_cents: 130000, status: "occupied", amenities: "" });
  const u4 = add("units", { property_id: twelfth, name: "4", beds: 1, baths: 1, sqft: 610, market_rent_cents: 117500, status: "vacant", amenities: "" });
  const dobsonUnit = add("units", { property_id: dobson, name: "104", beds: 2, baths: 2, sqft: 1020, market_rent_cents: 164000, status: "notice", amenities: "Balcony" });

  add("ownerships", { property_id: palm, owner_id: maria, percent: 100 });
  add("ownerships", { property_id: camel, owner_id: maria, percent: 50 });
  add("ownerships", { property_id: camel, owner_id: james, percent: 50 });
  add("ownerships", { property_id: twelfth, owner_id: james, percent: 100 });
  add("ownerships", { property_id: dobson, owner_id: maria, percent: 100 });

  const agreementEnd = addDays(500);
  add("management_agreements", { property_id: palm, owner_id: maria, start_date: addDays(-900), end_date: agreementEnd, management_fee_percent: 8, leasing_fee_percent: 50, renewal_fee_cents: 20000, reserve_cents: 30000, repair_approval_threshold_cents: 30000, status: "active" });
  add("management_agreements", { property_id: camel, owner_id: maria, start_date: addDays(-700), end_date: agreementEnd, management_fee_percent: 8, leasing_fee_percent: 50, renewal_fee_cents: 20000, reserve_cents: 25000, repair_approval_threshold_cents: 40000, status: "active" });
  add("management_agreements", { property_id: twelfth, owner_id: james, start_date: addDays(-700), end_date: agreementEnd, management_fee_percent: 8, leasing_fee_percent: 50, renewal_fee_cents: 20000, reserve_cents: 40000, repair_approval_threshold_cents: 50000, status: "active" });
  add("management_agreements", { property_id: dobson, owner_id: maria, start_date: addDays(-500), end_date: agreementEnd, management_fee_percent: 8, leasing_fee_percent: 50, renewal_fee_cents: 20000, reserve_cents: 20000, repair_approval_threshold_cents: 30000, status: "active" });

  const desert = add("vendors", { name: "Desert Air HVAC", trade: "HVAC", email: "vendor@desertair.example", phone: "(602) 555-0166", address: "900 E Buckeye Rd, Phoenix, AZ", insurance_carrier: "Canyon Mutual", insurance_expires: addDays(40), license_number: "ROC-318822", license_expires: addDays(200), notes: "24 hour emergency line." });
  const valley = add("vendors", { name: "Valley Plumbing Co", trade: "Plumbing", email: "dispatch@valleyplumbing.example", phone: "(480) 555-0133", address: "55 S Mesa Dr, Mesa, AZ", insurance_carrier: "Saguaro Insurance", insurance_expires: addDays(12), license_number: "ROC-220194", license_expires: addDays(90), notes: "Insurance expires soon." });
  const locks = add("vendors", { name: "Copper Key Locksmith", trade: "Locksmith", email: "keys@copperkey.example", phone: "(623) 555-0188", address: "12 N Central Ave, Phoenix, AZ", insurance_carrier: "Ridge Insurance", insurance_expires: addDays(120), license_number: "LCK-441", license_expires: addDays(300), notes: "" });

  const jordan = add("tenants", { first_name: "Jordan", last_name: "Lee", email: "jordan@sunseekerrentals.com", phone: "(480) 555-0108", birth_date: "1994-04-02", emergency_contact: "Sam Lee (480) 555-0109", notes: "Works nights. Text before entry." });
  const priya = add("tenants", { first_name: "Priya", last_name: "Shah", email: "priya.shah@example.com", phone: "(602) 555-0144", birth_date: "1991-11-19", emergency_contact: "Asha Shah", notes: "" });
  const chris = add("tenants", { first_name: "Chris", last_name: "Nguyen", email: "chris.nguyen@example.com", phone: "(480) 555-0120", birth_date: "1988-01-09", emergency_contact: "Kim Nguyen", notes: "" });
  const elenaBirth = addDays(5);
  const elena = add("tenants", { first_name: "Elena", last_name: "Vasquez", email: "elena.vasquez@example.com", phone: "(520) 555-0161", birth_date: `1996-${elenaBirth.slice(5)}`, emergency_contact: "Luis Vasquez", notes: "" });
  const avery = add("tenants", { first_name: "Avery", last_name: "Brooks", email: "avery.brooks@example.com", phone: "(480) 555-0190", birth_date: "1990-07-22", emergency_contact: "Noah Brooks", notes: "Moving out this month." });
  const sam = add("tenants", { first_name: "Sam", last_name: "Rivera", email: "sam.rivera@example.com", phone: "(602) 555-0111", birth_date: "1998-03-14", emergency_contact: "Remy Rivera", notes: "Move-in next week." });

  const kolby = createUser({ email: "kolby@sunseekerrentals.com", password: "sunseeker", name: "Kolby Ellis", role: "admin", phone: "(480) 555-0100" });
  createUser({ email: "leasing@sunseekerrentals.com", password: "sunseeker", name: "Leah Nguyen", role: "leasing", phone: "(480) 555-0102" });
  createUser({ email: "maria@sunseekerrentals.com", password: "sunseeker", name: "Maria Alvarez", role: "owner", phone: "(480) 555-0114", ownerId: maria });
  createUser({ email: "jordan@sunseekerrentals.com", password: "sunseeker", name: "Jordan Lee", role: "tenant", phone: "(480) 555-0108", tenantId: jordan });
  createUser({ email: "vendor@desertair.example", password: "sunseeker", name: "Alex Romero", role: "vendor", phone: "(602) 555-0166", vendorId: desert });

  const jordanLease = seedLease({ unitId: palmUnit, tenantId: jordan, start: addDays(-400), end: addDays(180), rent: 185000, deposit: 185000, status: "active" });
  const priyaLease = seedLease({ unitId: camelA, tenantId: priya, start: addDays(-200), end: addDays(36), rent: 142500, deposit: 142500, status: "active", autopay: true });
  const chrisLease = seedLease({ unitId: u2, tenantId: chris, start: addDays(-100), end: addDays(220), rent: 127500, deposit: 127500, status: "active" });
  const elenaLease = seedLease({ unitId: u3, tenantId: elena, start: addDays(-800), end: addDays(90), rent: 130000, deposit: 130000, status: "active", autopay: true });
  const averyLease = seedLease({ unitId: dobsonUnit, tenantId: avery, start: addDays(-300), end: addDays(14), rent: 164000, deposit: 164000, status: "notice" });
  const samLease = seedLease({ unitId: camelB, tenantId: sam, start: addDays(6), end: addDays(371), rent: 139500, deposit: 139500, status: "future" });
  run("UPDATE units SET status = 'vacant' WHERE id = ?", camelB);

  for (const [leaseId, rent] of [[jordanLease, 185000], [priyaLease, 142500], [chrisLease, 127500], [elenaLease, 130000], [averyLease, 164000]]) {
    seedRent(leaseId, -1, rent, rent);
  }
  seedRent(jordanLease, 0, 185000, 90000);
  seedRent(priyaLease, 0, 142500, 142500);
  seedRent(chrisLease, 0, 127500, 0);
  seedRent(elenaLease, 0, 130000, 130000);
  seedRent(averyLease, 0, 164000, 0);
  postCharge({ leaseId: samLease, type: "rent", description: `Rent ${addDays(6).slice(0, 7)}`, amountCents: 139500, dueDate: addDays(6) });

  add("payment_plans", { lease_id: averyLease, total_cents: 164000, installment_cents: 40000, frequency: "weekly", start_date: today(), remaining_cents: 164000, status: "active", notes: "Catch up before move-out." });
  add("move_checklists", {
    lease_id: jordanLease, kind: "in", status: "complete",
    items: JSON.stringify([
      { label: "Lease signed", done: true },
      { label: "Keys and access devices handed over", done: true },
      { label: "Move-in photos taken", done: true },
      { label: "Utilities confirmed", done: true },
    ]),
    notes: "",
  });
  add("move_checklists", {
    lease_id: samLease, kind: "in", status: "open",
    items: JSON.stringify([
      { label: "Lease signed", done: false },
      { label: "Keys and access devices handed over", done: false },
      { label: "Move-in photos taken", done: false },
      { label: "Utilities confirmed", done: false },
    ]),
    notes: "Keys are in the office lockbox.",
  });

  add("listings", { unit_id: u1, headline: "Bright 1 bed near the light rail", description: "Upstairs unit with pool access and a laundry room on site.", rent_cents: 115000, available_date: addDays(10), status: "active", syndicate_website: 1, syndicate_zillow: 1, syndicate_trulia: 1, syndicate_realtor: 1, syndicate_apartments: 1 });
  add("listings", { unit_id: u4, headline: "Quiet garden 1 bed", description: "Ground-floor unit. Water and trash are included.", rent_cents: 117500, available_date: today(), status: "active", syndicate_website: 1, syndicate_zillow: 1, syndicate_trulia: 1, syndicate_realtor: 1, syndicate_apartments: 0 });
  add("listings", { unit_id: camelB, headline: "Camelback duplex, unit B", description: "Two bedrooms with assigned parking.", rent_cents: 139500, available_date: addDays(6), status: "leased", syndicate_website: 1, syndicate_zillow: 0, syndicate_apartments: 0 });

  const taylor = add("prospects", { name: "Taylor Brooks", email: "taylor.brooks@example.com", phone: "(480) 555-0177", unit_id: u1, source: "Zillow", stage: "showing", notes: "Wants a tour after work.", created_at: nowStamp() });
  const morgan = add("prospects", { name: "Morgan Hale", email: "morgan.hale@example.com", phone: "(602) 555-0181", unit_id: u4, source: "Website", stage: "showing", notes: "Missed the first appointment.", created_at: nowStamp() });
  const samProspect = add("prospects", { name: "Sam Rivera", email: "sam.rivera@example.com", phone: "(602) 555-0111", unit_id: camelB, source: "Apartments.com", stage: "approved", notes: "Approved. Move-in is scheduled.", created_at: nowStamp() });
  add("prospects", { name: "Riley Chen", email: "riley.chen@example.com", phone: "(480) 555-0128", unit_id: u1, source: "Phone", stage: "lost", notes: "Chose another community.", created_at: nowStamp() });
  add("showings", { prospect_id: taylor, unit_id: u1, showing_type: "agent", scheduled_at: `${addDays(3)} 17:30`, status: "scheduled", notes: "" });
  add("showings", { prospect_id: morgan, unit_id: u4, showing_type: "self_guided", scheduled_at: `${addDays(-1)} 15:00`, status: "scheduled", notes: "Lockbox code was not used." });
  add("showings", { prospect_id: samProspect, unit_id: camelB, showing_type: "agent", scheduled_at: `${addDays(-12)} 11:00`, status: "completed", notes: "" });
  const applicationId = add("applications", { prospect_id: samProspect, unit_id: camelB, status: "approved", submitted_at: addDays(-9), income_cents: 620000, occupants: 1, notes: "Income documented with two pay stubs." });
  add("screenings", { application_id: applicationId, status: "complete", credit_score: 710, criminal: "clear", eviction: "clear", decision: "approve", notes: "Recorded by staff. A screening provider is not connected yet.", completed_at: addDays(-8) });
  const leaseTemplate = one("SELECT id, body FROM templates WHERE kind = 'lease'");
  add("esign_packets", { lease_id: jordanLease, template_id: leaseTemplate.id, title: "Lease — Jordan Lee", status: "signed", sent_at: addDays(-400), signed_at: addDays(-399), body: "Signed residential lease draft for Palm Lane." });
  add("esign_packets", { lease_id: samLease, template_id: leaseTemplate.id, title: "Lease — Sam Rivera", status: "sent", sent_at: addDays(-1), signed_at: "", body: "Lease draft sent for signature. Signature tracking only, until an e-sign provider is connected." });
  add("renewals", { lease_id: priyaLease, offered_rent_cents: 147500, new_end_date: addDays(401), status: "offered", notes: "Offered a 12 month renewal.", created_at: nowStamp() });

  add("communications", { channel: "text", subject: "Maintenance entry", body: "Prefers a text before anyone enters for non-emergency work.", tenant_id: jordan, owner_id: null, vendor_id: null, user_id: kolby, created_at: nowStamp() });
  add("documents", { name: "Lease summary — Jordan Lee", category: "lease", owner_id: null, tenant_id: jordan, property_id: palm, vendor_id: null, content: "Signed lease for 1842 E Palm Lane. Rent $1,850. Deposit held in the security deposit account.", url: "", created_at: addDays(-399) });
  add("documents", { name: "Management agreement — Palm Lane", category: "owner", owner_id: maria, tenant_id: null, property_id: palm, vendor_id: null, content: "Management fee 8% of rent collected. Repair approval threshold $300. Reserve $300.", url: "", created_at: addDays(-900) });

  const hvacOrder = add("work_orders", { property_id: twelfth, unit_id: u2, tenant_id: chris, vendor_id: desert, title: "AC not cooling", description: "Unit blows warm air after 2 p.m.", priority: "urgent", status: "pending_approval", category: "HVAC", created_at: nowStamp(), scheduled_at: `${addDays(2)} 09:00`, completed_at: "", estimate_cents: 65000, approved: 0, photo_url: "" });
  add("approvals", { kind: "estimate", entity: "work_order", entity_id: hvacOrder, owner_id: james, property_id: twelfth, amount_cents: 65000, status: "pending", notes: "Estimate is above the $500 repair threshold.", created_at: nowStamp() });
  add("work_orders", { property_id: palm, unit_id: palmUnit, tenant_id: jordan, vendor_id: null, title: "Dishwasher leaking", description: "Water pools under the dishwasher after a cycle.", priority: "normal", status: "new", category: "Appliance", created_at: nowStamp(), scheduled_at: "", completed_at: "", estimate_cents: 0, approved: 0, photo_url: "" });
  add("work_orders", { property_id: dobson, unit_id: dobsonUnit, tenant_id: avery, vendor_id: valley, title: "Kitchen drain slow", description: "Cleared once already this year.", priority: "low", status: "scheduled", category: "Plumbing", created_at: addDays(-5), scheduled_at: `${addDays(-2)} 13:00`, completed_at: "", estimate_cents: 18000, approved: 1, photo_url: "" });
  add("maintenance_schedules", { property_id: palm, vendor_id: desert, title: "HVAC filter change", frequency: "quarterly", next_date: addDays(20), notes: "Owner supplies filters." });
  add("maintenance_schedules", { property_id: twelfth, vendor_id: null, title: "Pool service", frequency: "monthly", next_date: addDays(8), notes: "Vendor invoice usually arrives the next day." });

  const paidBill = add("bills", { vendor_id: valley, property_id: dobson, amount_cents: 18000, due_date: monthStart(-1), memo: "Kitchen drain clearing", category: "repairs", status: "approved", work_order_id: null, created_at: monthStart(-1), paid_at: "" });
  payBill(paidBill, kolby, monthStart(-1));
  createBill({ vendorId: desert, propertyId: twelfth, amountCents: 32000, dueDate: addDays(7), memo: "Capacitor and contactor", category: "repairs", userId: kolby });
  createBill({ vendorId: locks, propertyId: palm, amountCents: 9500, dueDate: addDays(4), memo: "Rekey after vendor visit", category: "repairs", userId: kolby });
  const poId = add("purchase_orders", { vendor_id: desert, property_id: camel, amount_cents: 41000, memo: "Condenser fan motor", status: "pending_approval", created_at: nowStamp() });
  add("approvals", { kind: "purchase_order", entity: "purchase_order", entity_id: poId, owner_id: null, property_id: camel, amount_cents: 41000, status: "pending", notes: "Condenser fan motor", created_at: nowStamp() });

  add("inspections", { unit_id: palmUnit, lease_id: jordanLease, kind: "move_in", inspected_at: addDays(-399), notes: "Walls and appliances recorded in good condition.", photo_url: "", user_id: kolby });
  const gate = add("custom_fields", { entity: "property", label: "Gate code", field_type: "text" });
  const parking = add("custom_fields", { entity: "unit", label: "Parking space", field_type: "text" });
  add("custom_field_values", { field_id: gate, entity_id: palm, value: "1942" });
  add("custom_field_values", { field_id: parking, entity_id: camelA, value: "A-12" });
  add("notes", { entity: "property", entity_id: palm, body: "Back gate sticks when it is hot. Vendor has the spare key.", user_id: kolby, created_at: nowStamp() });

  generateStatement({ ownerId: maria, propertyId: palm, periodStart: monthStart(-1), periodEnd: monthEnd(-1), userId: kolby });
  generateStatement({ ownerId: maria, propertyId: dobson, periodStart: monthStart(-1), periodEnd: monthEnd(-1), userId: kolby });
  generateStatement({ ownerId: james, propertyId: twelfth, periodStart: monthStart(-1), periodEnd: monthEnd(-1), userId: kolby });

  notifyStaff("New service request", "Dishwasher leaking at Palm Lane House.", "#/maintenance");
  notifyUsers([one("SELECT id FROM users WHERE email = ?", "maria@sunseekerrentals.com").id], "September statement is ready", "Palm Lane House and Dobson Condo statements are in your portal.", "#/portal/statements");
}

function init() {
  createSchema();
  const addedTrulia = ensureColumn("listings", "syndicate_trulia", "INTEGER DEFAULT 0");
  ensureColumn("listings", "syndicate_realtor", "INTEGER DEFAULT 0");
  if (addedTrulia) run("UPDATE listings SET syndicate_trulia = syndicate_zillow, syndicate_realtor = syndicate_zillow");
  const count = Number(one("SELECT COUNT(*) AS n FROM users").n);
  if (count === 0) {
    try {
      savepoint(() => seed());
    } catch (error) {
      console.error("SunPilot could not load the starter company.");
      throw error;
    }
  }
  ensureExtras();
}

module.exports = {
  db,
  uploadDir,
  all,
  one,
  run,
  add,
  fail,
  today,
  addDays,
  monthStart,
  monthEnd,
  nowStamp,
  hashPassword,
  verifyPassword,
  audit,
  postCharge,
  applyPayment,
  createBill,
  payBill,
  decideApproval,
  addContribution,
  addDistribution,
  generateStatement,
  postLateFees,
  postMonthlyRent,
  runAutopay,
  notifyStaff,
  notifyUsers,
  createUser,
  moveIn,
  moveOut,
  saveDataUrl,
  permissionsFor,
  primaryOwner,
  leaseContext,
  init,
};
