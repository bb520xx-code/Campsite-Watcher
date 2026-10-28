// Zero-dependency server: serves the UI and proxies recreation.gov
// (recreation.gov blocks browser cross-origin calls, so the browser talks to us).
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const sleep = ms => new Promise(r => setTimeout(r, ms));
// recreation.gov answers 429 when asked too fast; wait and retry instead of failing.
async function rec(pathAndQuery) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch("https://www.recreation.gov" + pathAndQuery, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (r.ok) return r.json();
    if (r.status === 429 && attempt < 6) {
      await sleep((+r.headers.get("retry-after") || 0) * 1000 || 700 * attempt);
      continue;
    }
    throw new Error(r.status === 429 ? "recreation.gov is rate-limiting requests, try again in a minute" : `recreation.gov returned ${r.status}`);
  }
}

// Per-campsite details (pets, ADA, equipment, vehicle length...). Rarely change, so cache them.
const detailCache = new Map();
function normalize(c) {
  const attr = Object.fromEntries((c.attributes || []).map(a => [a.attribute_name, a.attribute_value]));
  const sd = c.site_details_map || {}, ed = c.equipment_details_map || {};
  // wh = water hookup at the site; wa = any water listed for the site (hookup, spigot, drinking water)
  const waterHookup = /^y/i.test(sd.water_hookup?.attribute_value || "") || (c.amenities || []).some(a => /water hookup/i.test(a.attribute_name));
  return {
    acc: !!c.is_accessible,
    pets: attr["Pets Allowed"] || "",
    maxVeh: +attr["Max Vehicle Length"] || 0,
    vehicles: +attr["Max Num of Vehicles"] || 0,
    drive: attr["Driveway Entry"] || ed.driveway_entry?.attribute_value || "",
    fire: sd.campfire_allowed?.attribute_value || "",
    eq: (c.permitted_equipment || []).filter(e => !e.is_deactivated).map(e => ({ n: e.equipment_name, max: e.max_length || 0 })),
    checkin: attr["Checkin Time"] || "", checkout: attr["Checkout Time"] || "",
    wh: waterHookup, wa: waterHookup || (c.amenities || []).some(a => /drinking water|water spigot|water \(seasonal\)/i.test(a.attribute_name)),
  };
}
async function detail(id) {
  if (detailCache.has(id)) return detailCache.get(id);
  const d = normalize((await rec(`/api/camps/campsites/${id}`)).campsite);
  detailCache.set(id, d);
  return d;
}
async function details(ids) {
  const out = {}, queue = [...ids];
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) { const id = queue.shift(); try { out[id] = await detail(id); } catch {} }
  }));
  return out;
}

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

async function handleApi(url, res) {
  const q = url.searchParams;
  if (url.pathname === "/api/search") {
    const text = (q.get("q") || "").trim();
    const link = text.match(/recreation\.gov\/camping\/campgrounds\/(\d+)/);
    const id = link ? link[1] : /^\d+$/.test(text) ? text : null;
    if (id) {
      const d = (await rec(`/api/camps/campgrounds/${id}`)).campground;
      return json(res, 200, [{ id, name: d.facility_name, parent: d.parent_name || "", state: d.addresses?.[0]?.state_code || "" }]);
    }
    const d = await rec(`/api/search?q=${encodeURIComponent(text)}&entity_type=campground&size=12`);
    const out = (d.results || [])
      .filter(r => r.entity_type === "campground")
      .map(r => ({ id: r.entity_id, name: r.name, parent: r.parent_name || "", state: r.state_code || "" }));
    return json(res, 200, out);
  }
  if (url.pathname === "/api/campground") {
    const id = q.get("id");
    if (!/^\d+$/.test(id || "")) return json(res, 400, { error: "bad id" });
    const d = (await rec(`/api/camps/campgrounds/${id}`)).campground;
    return json(res, 200, {
      id, name: d.facility_name, parent: d.parent_name || "",
      rules: d.campground_rules_map || null,
      booking: d.campsite_booking_window_days ?? null,
    });
  }
  if (url.pathname === "/api/availability") {
    const id = q.get("id"), month = q.get("month"); // month = YYYY-MM
    if (!/^\d+$/.test(id || "") || !/^\d{4}-\d{2}$/.test(month || "")) return json(res, 400, { error: "bad params" });
    const d = await rec(`/api/camps/availability/campground/${id}/month?start_date=${encodeURIComponent(month + "-01T00:00:00.000Z")}`);
    return json(res, 200, d);
  }
  if (url.pathname === "/api/details") {
    const ids = (q.get("ids") || "").split(",").filter(x => /^\d+$/.test(x)).slice(0, 400);
    return json(res, 200, await details(ids));
  }
  json(res, 404, { error: "not found" });
}

// Phone alerts: relay to ntfy.sh, which pushes to the ntfy app on your phone.
async function handleNotify(req, res) {
  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > 10000) return json(res, 413, { error: "too large" }); }
  const { topic, title, message, click } = JSON.parse(body || "{}");
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(topic || "")) return json(res, 400, { error: "Topic must be 6-64 letters, numbers, - or _" });
  const r = await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, title: String(title || "Campground Bot").slice(0, 200), message: String(message || "").slice(0, 1000),
      click: /^https:\/\/www\.recreation\.gov\//.test(click || "") ? click : undefined, priority: 5, tags: ["tent"] }),
  });
  if (!r.ok) throw new Error(`ntfy.sh returned ${r.status}`);
  json(res, 200, { ok: true });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/notify" && req.method === "POST") {
    try { await handleNotify(req, res); } catch (e) { json(res, 502, { error: e.message }); }
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    try { await handleApi(url, res); } catch (e) { json(res, 502, { error: e.message }); }
    return;
  }
  const file = path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Campground Bot running at http://localhost:${PORT}`));
