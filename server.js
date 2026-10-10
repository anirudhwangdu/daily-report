import express from "express";
import { google } from "googleapis";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 3000;
const SHEET_ID = process.env.SHEET_ID;
const LOCATIONS = ["Alleppey", "Bangalore"];

const TABS = {
  DailyReports: ["Date", "Location", "Inflow total", "Outflow total", "Net", "Submitted at (IST)", "Submitted by"],
  DailyReportLines: ["Date", "Location", "Type", "Description", "Qty", "Rate", "Amount", "Submitted by"],
  OfflineEnquiries: ["Logged at (IST)", "Location", "Name", "Phone", "People", "Interested in", "Source", "Status", "Follow-up date", "Notes", "Logged by"],
};
const STATUSES = ["New", "Follow up", "Booked", "Not interested"];
const SOURCES = ["Walk-in", "Phone call", "Referral", "Other"];

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
    const c = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const jwt = new google.auth.JWT({
      email: c.client_email,
      key: c.private_key.replace(/\\n/g, "\n"),
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
  res.json({ user: req.user.name, location: req.user.location, locations: LOCATIONS, statuses: STATUSES, sources: SOURCES }));

app.post("/api/report", async (req, res) => {
  try {
    const b = req.body || {};
    const location = pickLocation(req, b.location);
    if (!isDate(b.date)) throw new Error("Invalid date");
    const inflow = (b.inflow || []).map((r) => ({ d: txt(r.d, 100), q: num(r.q), r: num(r.r) })).filter((r) => r.q * r.r > 0);
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
      ...inflow.map((r) => [b.date, location, "Inflow", r.d, r.q, r.r, r.q * r.r, req.user.name]),
      ...outflow.map((r) => [b.date, location, "Outflow", r.d, "", "", r.a, req.user.name]),
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
    const name = txt(b.name, 80), phone = txt(b.phone, 20);
    if (!name && !phone) throw new Error("Invalid: add a name or phone number");
    if (phone && !/^[+\d][\d\s-]{6,17}$/.test(phone)) throw new Error("Invalid phone number");
    const status = STATUSES.includes(b.status) ? b.status : "New";
    const source = SOURCES.includes(b.source) ? b.source : "Walk-in";
    const follow = b.followUp && isDate(b.followUp) ? b.followUp : "";
    await ensureTabs();
    await append("OfflineEnquiries", [[
      nowIST(), location, name, phone, num(b.people || 1), txt(b.interest, 100), source, status, follow, txt(b.notes, 500), req.user.name,
    ]]);
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
    const got = await sheets().spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "OfflineEnquiries!A2:K" });
    const rows = (got.data.values || [])
      .filter((r) => !location || r[1] === location)
      .slice(-15).reverse()
      .map((r) => ({ at: r[0], name: r[2], phone: r[3], people: r[4], interest: r[5], status: r[7], followUp: r[8] }));
    res.json({ rows });
  } catch (e) {
    console.error("list failed:", e.message);
    res.status(500).json({ error: "Could not read the sheet." });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => console.log(`skysail-ops on :${PORT}`));
