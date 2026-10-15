import express from "express";
import { google } from "googleapis";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 3000;
const SHEET_ID = process.env.GOOGLE_SHEET_ID || process.env.SHEET_ID;
const LOCATIONS = ["Alleppey", "Bangalore"];
const PAYMENTS = ["Cash", "UPI"];

const TABS = {
  DailyReports: ["Date", "Location", "Inflow total", "Outflow total", "Net", "Submitted at (IST)", "Submitted by"],
  DailyReportLines: ["Date", "Location", "Type", "Description", "Qty", "Rate", "Amount", "Submitted by", "Payment"],
  WalkInEnquiries: ["Date", "Location", "Name", "Phone", "Package", "Note", "Logged at (IST)", "Logged by"],
};

// ---------- auth: one login per location + admin ----------
// username = alleppey | bangalore | admin, password from env
const USERS = {
  alleppey: { pass: process.env.ALLEPPEY_PASSWORD, location: "Alleppey" },
  bangalore: { pass: process.env.BANGALORE_PASSWORD, location: "Bangalore" },
  admin: { pass: process.env.ADMIN_PASSWORD, location: null },
};
const hash = (s) => crypto.createHash("sha256").update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));

function auth(req, res, next) {
  if (!Object.values(USERS).some((u) => u.pass)) return res.status(503).send("No passwords configured.");
  const [scheme, token] = (req.get("authorization") || "").split(" ");
  if (scheme === "Basic" && token) {
    const raw = Buffer.from(token, "base64").toString();
    const i = raw.indexOf(":");
    const name = raw.slice(0, i).toLowerCase(), pass = raw.slice(i + 1);
    const u = USERS[name];
    if (u && u.pass && same(pass, u.pass)) {
      req.user = { name, location: u.location };
      return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="Sky Sail Ops"').status(401).send("Login required");
}

// ---------- Google Sheets ----------
let client;
function sheets() {
  if (!client) {
    // Same variables as the WhatsApp bot: GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY
    // (falls back to a single GOOGLE_SERVICE_ACCOUNT_JSON if those are not set)
    let email = process.env.GOOGLE_CLIENT_EMAIL, key = process.env.GOOGLE_PRIVATE_KEY;
    if (!email || !key) {
      const c = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      email = c.client_email; key = c.private_key;
    }
    const jwt = new google.auth.JWT({
      email,
      key: key.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    client = google.sheets({ version: "v4", auth: jwt });
  }
  return client;
}
let ready = false;
async function ensureTabs() {
  if (ready) return;
  const api = sheets().spreadsheets;
  const meta = await api.get({ spreadsheetId: SHEET_ID, fields: "sheets.properties.title" });
  const have = meta.data.sheets.map((s) => s.properties.title);
  const need = Object.keys(TABS).filter((t) => !have.includes(t));
  if (need.length) {
    await api.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: need.map((t) => ({ addSheet: { properties: { title: t, gridProperties: { frozenRowCount: 1 } } } })) },
    });
    for (const t of need) {
      await api.values.update({ spreadsheetId: SHEET_ID, range: `${t}!A1`, valueInputOption: "RAW", requestBody: { values: [TABS[t]] } });
    }
  }
  const h = await api.values.get({ spreadsheetId: SHEET_ID, range: "DailyReportLines!I1" });
  if (!((h.data.values || [])[0] || [])[0]) {
    await api.values.update({ spreadsheetId: SHEET_ID, range: "DailyReportLines!I1", valueInputOption: "RAW", requestBody: { values: [["Payment"]] } });
  }
  ready = true;
}
const append = (tab, values) =>
  sheets().spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${tab}!A1`, valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS", requestBody: { values },
  });
const nowIST = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

// ---------- helpers ----------
const num = (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error("Invalid number"); return n; };
const txt = (v, n = 200) => String(v ?? "").trim().slice(0, n);
function pickLocation(req, wanted) {
  if (req.user.location) return req.user.location; // location logins are locked
  if (!LOCATIONS.includes(wanted)) throw new Error("Invalid location");
  return wanted;
}
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

// ---------- routes ----------
app.get("/healthz", (_, res) => res.send("ok"));
app.use(auth);

app.get("/api/me", (req, res) =>
  res.json({ user: req.user.name, location: req.user.location, locations: LOCATIONS }));

app.post("/api/report", async (req, res) => {
  try {
    const b = req.body || {};
    const location = pickLocation(req, b.location);
    if (!isDate(b.date)) throw new Error("Invalid date");
    const inflow = (b.inflow || []).map((r) => ({ d: txt(r.d, 100), q: num(r.q), r: num(r.r), p: PAYMENTS.includes(r.p) ? r.p : "Cash" })).filter((r) => r.q * r.r > 0);
    const outflow = (b.outflow || []).map((r) => ({ d: txt(r.d, 100) || "Expense", a: num(r.a) })).filter((r) => r.a > 0);
    if (!inflow.length && !outflow.length) throw new Error("Report is empty");
    const tin = inflow.reduce((s, r) => s + r.q * r.r, 0);
    const tout = outflow.reduce((s, r) => s + r.a, 0);

    await ensureTabs();
    if (!b.force) {
      const got = await sheets().spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "DailyReports!A2:B" });
      if ((got.data.values || []).some((r) => r[0] === b.date && r[1] === location))
        return res.status(409).json({ error: `A ${location} report for ${b.date} is already in the sheet.` });
    }
    await append("DailyReports", [[b.date, location, tin, tout, tin - tout, nowIST(), req.user.name]]);
    await append("DailyReportLines", [
      ...inflow.map((r) => [b.date, location, "Inflow", r.d, r.q, r.r, r.q * r.r, req.user.name, r.p]),
      ...outflow.map((r) => [b.date, location, "Outflow", r.d, "", "", r.a, req.user.name, ""]),
    ]);
    res.json({ ok: true, net: tin - tout });
  } catch (e) {
    const bad = /^Invalid|empty/.test(e.message);
    if (!bad) console.error("report failed:", e.message);
    res.status(bad ? 400 : 500).json({ error: bad ? e.message : "Could not write to the sheet. Check server logs." });
  }
});

app.post("/api/enquiry", async (req, res) => {
  try {
    const b = req.body || {};
    const location = pickLocation(req, b.location);
    if (!isDate(b.date)) throw new Error("Invalid date");
    const name = txt(b.name, 80), phone = txt(b.phone, 20);
    if (!name && !phone) throw new Error("Invalid: add a name or phone number");
    if (phone && !/^[+\d][\d\s-]{6,17}$/.test(phone)) throw new Error("Invalid phone number");
    await ensureTabs();
    await append("WalkInEnquiries", [[b.date, location, name, phone, txt(b.pkg, 100), txt(b.note, 500), nowIST(), req.user.name]]);
    res.json({ ok: true });
  } catch (e) {
    const bad = /^Invalid/.test(e.message);
    if (!bad) console.error("enquiry failed:", e.message);
    res.status(bad ? 400 : 500).json({ error: bad ? e.message.replace(/^Invalid:? ?/, "Invalid ") : "Could not write to the sheet. Check server logs." });
  }
});

app.get("/api/enquiries", async (req, res) => {
  try {
    const location = req.user.location || (LOCATIONS.includes(req.query.location) ? req.query.location : null);
    await ensureTabs();
    const got = await sheets().spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "WalkInEnquiries!A2:H" });
    const rows = (got.data.values || [])
      .filter((r) => !location || r[1] === location)
      .slice(-15).reverse()
      .map((r) => ({ date: r[0], location: r[1], name: r[2], phone: r[3], pkg: r[4], note: r[5] }));
    res.json({ rows });
  } catch (e) {
    console.error("list failed:", e.message);
    res.status(500).json({ error: "Could not read the sheet." });
  }
});

// ---------- admin summary ----------
app.get("/api/summary", async (req, res) => {
  if (req.user.location) return res.status(403).json({ error: "Admin only" });
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to) || from > to) return res.status(400).json({ error: "Invalid date range" });
  const locs = LOCATIONS.includes(req.query.location) ? [req.query.location] : LOCATIONS;
  try {
    await ensureTabs();
    const g = await sheets().spreadsheets.values.batchGet({
      spreadsheetId: SHEET_ID,
      ranges: ["DailyReports!A2:G", "DailyReportLines!A2:I", "WalkInEnquiries!A2:H"],
    });
    const [rep, lin, enq] = g.data.valueRanges.map((v) => v.values || []);
    const inRange = (d) => d >= from && d <= to;
    const zero = () => Object.fromEntries(locs.map((l) => [l, 0]));

    const totals = Object.fromEntries(locs.map((l) => [l, { inflow: 0, outflow: 0, net: 0, days: 0 }]));
    const dayMap = {}, daySeen = {};
    for (const r of rep) {
      const [date, loc] = r;
      if (!inRange(date) || !totals[loc]) continue;
      const i = Number(r[2]) || 0, o = Number(r[3]) || 0;
      totals[loc].inflow += i; totals[loc].outflow += o; totals[loc].net += i - o;
      (dayMap[date] ||= zero())[loc] += i - o;
      (daySeen[loc] ||= new Set()).add(date);
    }
    locs.forEach((l) => (totals[l].days = daySeen[l] ? daySeen[l].size : 0));
    totals.Combined = {
      inflow: locs.reduce((a, l) => a + totals[l].inflow, 0),
      outflow: locs.reduce((a, l) => a + totals[l].outflow, 0),
      net: locs.reduce((a, l) => a + totals[l].net, 0),
      days: new Set(Object.keys(dayMap)).size,
    };
    const days = Object.entries(dayMap).sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, v]) => ({ date, ...v, total: locs.reduce((a, l) => a + v[l], 0) }));

    const packages = {}, expenses = {}, pay = {};
    for (const r of lin) {
      const [date, loc, type, desc] = r;
      if (!inRange(date) || !locs.includes(loc)) continue;
      const key = String(desc || "").trim().toLowerCase();
      if (type === "Inflow") {
        const p = (packages[key] ||= { desc: String(desc).trim(), qty: zero(), amount: 0 });
        p.qty[loc] += Number(r[4]) || 0; p.amount += Number(r[6]) || 0;
        const k = String(r[8] || "").trim() || "Not recorded";
        (pay[k] ||= zero())[loc] += Number(r[6]) || 0;
      } else if (type === "Outflow") {
        const e = (expenses[key] ||= { desc: String(desc).trim() || "Expense", amount: zero(), total: 0 });
        e.amount[loc] += Number(r[6]) || 0; e.total += Number(r[6]) || 0;
      }
    }

    const payments = ["Cash", "UPI", "Not recorded"].filter((k) => pay[k])
      .map((k) => ({ method: k, amounts: pay[k], total: locs.reduce((a, l) => a + pay[k][l], 0) }));

    const enqMap = {}, enqTotal = zero();
    for (const r of enq) {
      const loc = r[1];
      if (!inRange(r[0]) || !locs.includes(loc)) continue;
      const label = String(r[4] || "").trim() || "Not specified";
      const e = (enqMap[label.toLowerCase()] ||= { pkg: label, counts: zero(), total: 0 });
      e.counts[loc]++; e.total++; enqTotal[loc]++;
    }
    const enquiries = { rows: Object.values(enqMap).sort((a, b) => b.total - a.total), total: enqTotal };

    res.json({
      from, to, locations: locs, totals, days,
      packages: Object.values(packages).sort((a, b) => b.amount - a.amount),
      expenses: Object.values(expenses).sort((a, b) => b.total - a.total),
      enquiries, payments,
    });
  } catch (e) {
    console.error("summary failed:", e.message);
    res.status(500).json({ error: "Could not read the sheet." });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => console.log(`skysail-ops on :${PORT}`));
