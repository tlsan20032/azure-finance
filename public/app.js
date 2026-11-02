// Shared helpers for the signed-in pages.
async function api(method, url, body) {
  const res = await fetch(url, {
    method, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/login.html"; throw new Error("Signed out."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

const money = (n) => new Intl.NumberFormat("en-SG", { style: "currency", currency: "SGD" }).format(n);

function cell(text) { const c = document.createElement("td"); c.textContent = text ?? ""; return c; }
function button(label, onClick, cls) {
  const b = document.createElement("button");
  b.textContent = label; b.className = cls || "small"; b.type = "button"; b.onclick = onClick;
  return b;
}

async function renderNav(activePath) {
  const me = await api("GET", "/api/me");
  const bar = document.getElementById("nav");
  bar.className = "bar";
  const links = document.createElement("nav");
  const pages = [["/", "Home"], ["/invoices.html", "Invoices"], ["/clients.html", "Clients"], ["/products.html", "Products & services"]];
  if (me.role === "admin") pages.push(["/settings.html", "Settings"]);
  for (const [href, label] of pages) {
    const a = document.createElement("a");
    a.href = href; a.textContent = label;
    if (href === activePath) a.className = "active";
    links.append(a);
  }
  const who = document.createElement("span");
  who.className = "muted"; who.textContent = `${me.displayName} (${me.role})  `;
  who.append(button("Sign out", async () => { await api("POST", "/api/logout"); location.href = "/login.html"; }, "link"));
  bar.append(links, who);
  return me;
}

const dateOnly = (v) => (v ? String(v).slice(0, 10) : "");
const dmy = (v) => dateOnly(v).split("-").reverse().join("/");
const todayIso = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const moneyIn = (n, cur) => new Intl.NumberFormat("en-SG", { style: "currency", currency: cur || "SGD" }).format(n || 0);
