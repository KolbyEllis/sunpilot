import { api } from "./api.js";
import { esc, handleChange, handleClick, handleSubmit, logo, setActions, setPermanentActions, toast } from "./ui.js";
import { renderStaff } from "./staff.js";
import { renderPortal, showDocument, showStatement } from "./portals.js";

const state = { user: null, permissions: [], company: null };
let portalMode = "staff";

const demos = [
  ["Manager", "kolby@sunseekerrentals.com", "sunseeker", "staff"],
  ["Resident", "jordan@sunseekerrentals.com", "sunseeker", "tenant"],
  ["Owner", "maria@sunseekerrentals.com", "sunseeker", "owner"],
  ["Vendor", "vendor@desertair.example", "sunseeker", "vendor"],
];

function homeFor(user) {
  return ["tenant", "owner", "vendor"].includes(user.role) ? "#/portal" : "#/dashboard";
}

function parseHash() {
  const raw = (location.hash || "#/dashboard").replace(/^#/, "");
  const [path, query] = raw.split("?");
  return { parts: path.split("/").filter(Boolean), query: new URLSearchParams(query || "") };
}

function icon(path) {
  return `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${path}</svg>`;
}

function staffShell(parts) {
  const active = parts[0] === "leases" || parts[0] === "statements" ? "leasing" : (parts[0] || "dashboard");
  const perms = state.permissions || [];
  const items = [
    ["dashboard", "Dashboard", "<rect x='4' y='4' width='7' height='7'/><rect x='13' y='4' width='7' height='7'/><rect x='4' y='13' width='7' height='7'/><rect x='13' y='13' width='7' height='7'/>"],
    ["calendar", "Calendar", "<rect x='4' y='5' width='16' height='15' rx='2'/><path d='M8 3v4M16 3v4M4 10h16'/>"],
    ["leasing", "Leasing", "<path d='M7 11V8a5 5 0 0 1 10 0v3'/><rect x='5' y='11' width='14' height='9' rx='2'/>"],
    ["properties", "Properties", "<path d='M4 11 12 4l8 7'/><path d='M6 10v9h12v-9'/>"],
    ["people", "People", "<circle cx='9' cy='9' r='3'/><circle cx='16' cy='10' r='2'/><path d='M4 19c1-3 3-4 5-4s4 1 5 4M14 19c.4-1.6 1.4-2.5 3-2.5 1.4 0 2.4.8 3 2.5'/>"],
  ];
  if (perms.includes("accounting.view")) items.push(["accounting", "Accounting", "<path d='M6 19V5M10 19V9M14 19V7M18 19V11'/>"]);
  if (perms.includes("maintenance.view")) items.push(["maintenance", "Maintenance", "<path d='M14 7a4 4 0 0 0-5 5L4 17l3 3 5-5a4 4 0 0 0 5-5l-3 3-2-2z'/>"]);
  if (perms.includes("reports.view")) items.push(["reporting", "Reporting", "<path d='M5 19V10M10 19V5M15 19v-7M20 19V8'/>"]);
  items.push(["communication", "Communication", "<path d='M5 6h14v9H8l-3 3z'/>"]);
  items.push(["news", "What's New", "<path d='M12 3v3M5 8l2 2M19 8l-2 2M12 8a5 5 0 0 1 0 10H7l-1 3 4-3h2'/>"]);
  const nav = items.map(([id, label, svg]) => `<button class="${active === id ? "active" : ""}" data-go="#/${id === "people" ? "people/tenants" : id === "accounting" ? "accounting/charges" : id === "reporting" ? "reporting" : id}">${icon(svg)}${esc(label)}</button>`).join("");
  const settings = perms.includes("admin.edit") ? `<button class="${active === "settings" ? "active" : ""}" data-go="#/settings/company">${icon("<circle cx='12' cy='12' r='3'/><path d='M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4'/>")}Settings</button>` : "";
  return `<div class="app"><header class="topbar"><button class="menu-btn" data-action="toggle-nav" aria-label="Menu">Menu</button>${logo(true)}<div class="search"><input id="global-search" placeholder="Search properties, people, work orders" autocomplete="off"/><div id="search-results"></div></div><div class="who"><span class="avatar">${esc(state.user.name.slice(0, 1))}</span><span>${esc(state.user.name)}</span><button class="btn btn-ghost" data-action="logout">Log out</button></div></header><div class="frame"><nav class="nav">${nav}<div class="spacer"></div>${settings}<div class="company-mark">${esc(state.company?.name || "SunSeeker Rentals")}</div></nav><main id="outlet"></main></div></div>`;
}

function portalShell(parts) {
  const role = state.user.role;
  const current = parts[1] ? `#/portal/${parts[1]}` : "#/portal";
  if (role === "tenant") {
    const links = [["#/portal", "Home"], ["#/portal/pay", "Pay"], ["#/portal/maintenance", "Repairs"], ["#/portal/messages", "Texts"], ["#/portal/documents", "Lease"]];
    return `<div class="app resident-app"><header class="portal-top">${logo(true)}<div class="who"><span>${esc(state.user.name)}</span><button class="btn btn-ghost" data-action="logout">Log out</button></div></header><main id="outlet"></main><nav class="portal-nav dock">${links.map(([href, label]) => `<button class="${current === href ? "active" : ""}" data-go="${href}">${esc(label)}</button>`).join("")}</nav></div>`;
  }
  const links = role === "owner"
    ? [["#/portal", "Home"], ["#/portal/statements", "Statements"], ["#/portal/funds", "Add funds"], ["#/portal/approvals", "Approvals"], ["#/portal/documents", "Documents"]]
    : [["#/portal", "Work orders"], ["#/portal/invoices", "Invoices"], ["#/portal/profile", "Insurance & license"]];
  return `<div class="app"><header class="portal-top">${logo(true)}<strong>${esc(state.company?.name || "SunSeeker Rentals")}</strong><div class="who"><span>${esc(state.user.name)}</span><button class="btn btn-ghost" data-action="logout">Log out</button></div></header><nav class="portal-nav">${links.map(([href, label]) => `<button class="${current === href ? "active" : ""}" data-go="${href}">${esc(label)}</button>`).join("")}</nav><main id="outlet"></main></div>`;
}

async function renderApp() {
  const { parts, query } = parseHash();
  const portalUser = ["tenant", "owner", "vendor"].includes(state.user.role);
  if (portalUser && !["portal", "documents", "statements"].includes(parts[0])) {
    location.hash = "#/portal";
    return;
  }
  if (!portalUser && parts[0] === "portal") {
    location.hash = "#/dashboard";
    return;
  }
  document.getElementById("app").innerHTML = portalUser ? portalShell(parts) : staffShell(parts);
  const outlet = document.getElementById("outlet");
  outlet.innerHTML = `<div class="loading">Loading…</div>`;
  try {
    if (parts[0] === "documents") await showDocument(outlet, parts[1]);
    else if (parts[0] === "statements") await showStatement(outlet, parts[1]);
    else if (portalUser) await renderPortal(outlet, parts, state.user);
    else await renderStaff(outlet, parts, query, state.user, state.permissions || []);
  } catch (error) {
    if (error.status === 401) {
      state.user = null;
      showLogin();
      return;
    }
    outlet.innerHTML = `<div class="error-banner">${esc(error.message)}</div>`;
    toast(error.message, "error");
  }
}

function showLogin(mode = "login") {
  const titles = { staff: "Log in to your account", tenant: "Resident portal", owner: "Owner portal", vendor: "Vendor portal" };
  const company = state.company?.name || "SunSeeker Rentals";
  const form = mode === "forgot"
    ? `<h1>Reset a password</h1><form data-action="forgot"><label>Email<input name="email" type="email" required/></label><button class="btn btn-primary" type="submit">Request reset</button></form><button class="trouble" data-action="back-login">Back to log in</button>`
    : `<h1>${esc(titles[portalMode] || titles.staff)}</h1><form data-action="login"><label>Email<input name="email" type="email" autocomplete="username" required/></label><label>Password<input name="password" type="password" autocomplete="current-password" required/></label><button class="forgot" type="button" data-action="show-forgot">Forgot password?</button><button class="btn btn-primary" type="submit">Log in</button></form><div class="portal-switch">Trying to log in as a resident or owner?</div><div class="portal-actions"><button class="btn btn-ghost" data-action="portal" data-portal="tenant">Resident Portal</button><button class="btn btn-ghost" data-action="portal" data-portal="owner">Owner Portal</button></div><button class="trouble" data-action="trouble">Having trouble logging in?</button><button class="trouble" data-action="portal" data-portal="vendor">Vendor sign in</button>${portalMode !== "staff" ? `<button class="trouble" data-action="portal" data-portal="staff">Property manager sign in</button>` : ""}<div class="demos"><p>Demo company for ${esc(company)}. Password for every sample login is sunseeker. Change these in Settings before real use.</p><div class="chips">${demos.map(([label, email, password, portal]) => `<button class="chip" data-action="demo" data-email="${esc(email)}" data-password="${esc(password)}" data-portal="${portal}">${esc(label)}</button>`).join("")}</div></div>`;
  document.getElementById("app").innerHTML = `<div class="login-page"><div class="login-card">${logo()}<p id="login-help"></p>${form}</div></div>`;
  setActions({
    login: async (form) => {
      const data = Object.fromEntries(new FormData(form));
      const result = await api.post("/api/login", { ...data, portal: portalMode });
      state.user = result.user;
      state.permissions = result.permissions || [];
      const me = await api.get("/api/me");
      state.company = me.company;
      location.hash = homeFor(result.user);
      await renderApp();
    },
    "show-forgot": () => showLogin("forgot"),
    "back-login": () => showLogin("login"),
    forgot: async (form) => {
      const data = Object.fromEntries(new FormData(form));
      const result = await api.post("/api/forgot-password", data);
      toast(result.message);
      showLogin("login");
    },
    portal: (el) => {
      portalMode = el.dataset.portal;
      showLogin("login");
    },
    demo: (el) => {
      portalMode = el.dataset.portal;
      showLogin("login");
      document.querySelector("[name=email]").value = el.dataset.email;
      document.querySelector("[name=password]").value = el.dataset.password;
    },
    trouble: async () => {
      const info = state.company || (await api.get("/api/public")).company;
      state.company = info;
      const help = document.getElementById("login-help");
      if (help) help.innerHTML = `<div class="help-box">Call ${esc(info?.name || "your property manager")} at ${esc(info?.phone || "(480) 555-0199")} or email ${esc(info?.email || "hello@sunseekerrentals.com")}. A manager can reset a password from Settings.</div>`;
    },
    logout: logout,
    "toggle-nav": () => document.querySelector(".app")?.classList.toggle("nav-open"),
  });
}

async function logout() {
  await api.post("/api/logout");
  state.user = null;
  portalMode = "staff";
  showLogin();
}

let searchTimer;
function bindOnce() {
  document.addEventListener("click", handleClick);
  document.addEventListener("submit", handleSubmit);
  document.addEventListener("change", handleChange);
  document.addEventListener("input", (event) => {
    if (event.target.id !== "global-search") return;
    clearTimeout(searchTimer);
    const value = event.target.value.trim();
    searchTimer = setTimeout(() => runSearch(value), 200);
  });
  window.addEventListener("hashchange", () => {
    if (state.user) renderApp();
  });
}

async function runSearch(value) {
  const box = document.getElementById("search-results");
  if (!box) return;
  if (value.length < 2) {
    box.innerHTML = "";
    return;
  }
  const results = await api.get(`/api/search?q=${encodeURIComponent(value)}`);
  box.innerHTML = results.length
    ? `<div class="search-results">${results.map((result) => `<button data-go="${esc(result.href)}">${esc(result.label)}<small>${esc(result.kind)}</small></button>`).join("")}</div>`
    : `<div class="search-results"><button>No matches</button></div>`;
}

async function boot() {
  bindOnce();
  setPermanentActions({
    logout,
    "toggle-nav": () => document.querySelector(".app")?.classList.toggle("nav-open"),
  });
  try {
    state.company = (await api.get("/api/public")).company;
  } catch {
    state.company = null;
  }
  try {
    const me = await api.get("/api/me");
    state.user = me.user;
    state.permissions = me.permissions || [];
    state.company = me.company;
    if (!location.hash) location.hash = homeFor(me.user);
    else await renderApp();
  } catch {
    showLogin();
  }
}

boot();
