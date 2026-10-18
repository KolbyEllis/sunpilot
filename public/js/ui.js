export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

export function money(cents) {
  return (Number(cents || 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function todayInput() {
  const date = new Date();
  const z = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${z(date.getMonth() + 1)}-${z(date.getDate())}`;
}

export function fmtDate(value) {
  if (!value) return "—";
  const [date, time] = String(value).split(" ");
  const [year, month, day] = date.split("-");
  if (!year || !month || !day) return String(value);
  const shown = `${Number(month)}/${Number(day)}/${year}`;
  return time ? `${shown} ${time.slice(0, 5)}` : shown;
}

export function labelize(value) {
  const text = String(value || "").replace(/[_-]+/g, " ");
  return text ? text.replace(/\b\w/g, (char) => char.toUpperCase()) : "—";
}

export function badge(status) {
  const slug = String(status || "none").toLowerCase().replace(/[\s_]+/g, "-");
  return `<span class="badge badge-${esc(slug)}">${esc(labelize(status))}</span>`;
}

export function link(hash, text) {
  return `<button class="link" data-go="${esc(hash)}">${esc(text)}</button>`;
}

let actions = {};
let permanent = {};

export function setPermanentActions(map) {
  permanent = { ...permanent, ...map };
}

export function setActions(map) {
  actions = { ...permanent, ...(map || {}) };
}

export function handleClick(event) {
  const go = event.target.closest("[data-go]");
  if (go && go.closest("#app")) {
    event.preventDefault();
    const hash = go.dataset.go.startsWith("#") ? go.dataset.go : `#${go.dataset.go}`;
    if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
    else location.hash = hash;
    return;
  }
  const action = event.target.closest("[data-action]");
  if (!action || !action.closest("#app") || !actions[action.dataset.action]) return;
  event.preventDefault();
  Promise.resolve(actions[action.dataset.action](action, event)).catch((error) => toast(error.message, "error"));
}

export function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.closest("#app")) return;
  const name = form.dataset.action;
  if (!name || !actions[name]) return;
  event.preventDefault();
  Promise.resolve(actions[name](form, event)).catch((error) => toast(error.message, "error"));
}

export function handleChange(event) {
  const el = event.target.closest("[data-change]");
  if (!el || !el.closest("#app") || !actions[el.dataset.change]) return;
  Promise.resolve(actions[el.dataset.change](el, event)).catch((error) => toast(error.message, "error"));
}

export function toast(message, kind = "ok") {
  const node = document.createElement("div");
  node.className = `toast toast-${kind}`;
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3400);
}

export function page(title, actionsHtml, body, note = "") {
  return `<div class="page-head"><div><h1>${esc(title)}</h1>${note ? `<p class="lede">${note}</p>` : ""}</div><div class="page-actions">${actionsHtml || ""}</div></div>${body}`;
}

export function tabBar(items, active) {
  return `<div class="tabs">${items.map(([href, label]) => `<button class="tab ${href === active ? "active" : ""}" data-go="${esc(href)}">${esc(label)}</button>`).join("")}</div>`;
}

export function empty(message) {
  return `<div class="empty">${esc(message)}</div>`;
}

export function table(headers, body) {
  const blank = `<tr><td colspan="${headers.length}">Nothing here yet.</td></tr>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr></thead><tbody>${body || blank}</tbody></table></div>`;
}

export function options(rows, valueKey, labelFn, placeholder) {
  const items = rows.map((row) => ({ value: row[valueKey], label: labelFn(row) }));
  return placeholder ? [{ value: "", label: placeholder }, ...items] : items;
}

export function downloadCsv(filename, rows) {
  if (!rows.length) {
    toast("Nothing to export", "error");
    return;
  }
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")].concat(rows.map((row) => headers.map((key) => `"${String(row[key] ?? "").replaceAll('"', '""')}"`).join(",")));
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function fieldHtml(field) {
  if (field.type === "select") {
    const choices = (field.options || []).map((option) => `<option value="${esc(option.value)}" ${String(option.value) === String(field.value ?? "") ? "selected" : ""}>${esc(option.label)}</option>`).join("");
    return `<label>${esc(field.label)}<select name="${esc(field.name)}" ${field.required ? "required" : ""}>${choices}</select></label>`;
  }
  if (field.type === "textarea") {
    return `<label>${esc(field.label)}<textarea name="${esc(field.name)}" rows="${field.rows || 4}">${esc(field.value || "")}</textarea></label>`;
  }
  if (field.type === "checkbox") {
    return `<label class="check"><input type="checkbox" name="${esc(field.name)}" ${field.value ? "checked" : ""}/> ${esc(field.label)}</label>`;
  }
  if (field.type === "note") return `<p class="field-note">${esc(field.label)}</p>`;
  const extras = [
    field.required ? "required" : "",
    field.step ? `step="${esc(field.step)}"` : "",
    field.min != null ? `min="${esc(field.min)}"` : "",
    field.placeholder ? `placeholder="${esc(field.placeholder)}"` : "",
  ].filter(Boolean).join(" ");
  return `<label>${esc(field.label)}<input type="${esc(field.type || "text")}" name="${esc(field.name)}" value="${esc(field.value || "")}" ${extras}/></label>`;
}

export function modalForm({ title, fields, submitLabel = "Save", onSubmit }) {
  const wrap = document.createElement("div");
  wrap.className = "modal-back";
  wrap.innerHTML = `<form class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header><div class="modal-body">${fields.map(fieldHtml).join("")}</div><footer><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">${esc(submitLabel)}</button></footer></form>`;
  const close = () => wrap.remove();
  wrap.addEventListener("click", (event) => {
    if (event.target === wrap || event.target.closest("[data-close]")) close();
  });
  wrap.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("[type=submit]");
    const data = Object.fromEntries(new FormData(form));
    for (const [key, value] of Object.entries(data)) if (value instanceof File) delete data[key];
    const file = form.querySelector('input[type="file"]')?.files?.[0];
    if (file) data.photoDataUrl = await readFile(file);
    button.disabled = true;
    try {
      await onSubmit(data);
      close();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
    }
  });
  document.body.appendChild(wrap);
  wrap.querySelector("input, select, textarea")?.focus();
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read that photo"));
    reader.readAsDataURL(file);
  });
}

export function logo(compact = false) {
  return `<span class="logo ${compact ? "logo-compact" : ""}"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="6" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M16 2v4M16 26v4M2 16h4M26 16h4M6.2 6.2l2.8 2.8M23 23l2.8 2.8M25.8 6.2 23 9M9 23l-2.8 2.8"/></g></svg><span>sunpilot</span></span>`;
}
