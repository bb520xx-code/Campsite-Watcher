const $ = id => document.getElementById(id);
let CHECK_MS = (+(() => { try { return localStorage.getItem("interval"); } catch {} })() || 120) * 1000;
const everyText = () => { const s = CHECK_MS / 1000; return s < 60 ? `every ${s} seconds` : s === 60 ? "every minute" : `every ${s / 60} minutes`; };
const NEEDS = ["needElectric", "needRV", "needDrive", "skipGroup"];

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let watches = store.get("watches", {});   // id -> {id,name,parent,cfg,seen:[]}
let known = store.get("known", {});       // id -> {id,name,parent} (campgrounds shown in the list)
let selected = null;                      // campground id on the right
let sites = [];                           // availability for the selected campground
let mode = "any", picked = new Set(), tab = "activity";
let selTypes = new Set(), selLoops = new Set();
let details = {};                         // campsite id -> extra info from recreation.gov
let detailRun = 0;
const DETAIL_KEYS = ["accessible", "pets", "fire", "equip", "rigLen", "drive", "vehicles", "water"];
let log = store.get("log", []);
let timer = null, nextAt = Date.now();

// ---------- dates ----------
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
function nightsList(ci, co) { const out = []; for (let d = ci; d < co; d = addDays(d, 1)) out.push(d); return out; }
function months(list) { return [...new Set(list.map(d => d.slice(0, 7)))]; }

// ---------- config ----------
function readCfg() {
  const cfg = { checkin: $("checkin").value, checkout: $("checkout").value, flex: $("flex").checked,
    nights: Math.max(1, +$("nights").value || 1), groupSize: +$("groupSize").value || 0, mode, picked: [...picked] };
  for (const n of NEEDS) cfg[n] = $(n).checked;
  cfg.types = [...selTypes]; cfg.loops = [...selLoops];
  for (const k of ["accessible", "pets", "fire"]) cfg[k] = $(k).checked;
  cfg.equip = $("equip").value; cfg.drive = $("drive").value; cfg.water = $("water").value;
  cfg.rigLen = +$("rigLen").value || 0; cfg.vehicles = +$("vehicles").value || 0;
  return cfg;
}
function writeCfg(c) {
  $("checkin").value = c.checkin; $("checkout").value = c.checkout; $("flex").checked = c.flex;
  $("nights").value = c.nights; $("groupSize").value = c.groupSize;
  for (const n of NEEDS) $(n).checked = !!c[n];
  mode = c.mode; picked = new Set(c.picked);
  selTypes = new Set(c.types || []); selLoops = new Set(c.loops || []);
  for (const k of ["accessible", "pets", "fire"]) $(k).checked = !!c[k];
  $("equip").value = c.equip || ""; $("drive").value = c.drive || ""; $("water").value = c.water || "";
  $("rigLen").value = c.rigLen || 0; $("vehicles").value = c.vehicles || 0;
  renderChips();
  document.querySelectorAll("[data-mode]").forEach(b => b.classList.toggle("on", b.dataset.mode === mode));
  syncDateUi();
}
function syncDateUi() {
  const c = readCfg();
  $("nightsRow").style.display = c.flex ? "" : "none";
  $("dateNote").textContent = c.flex
    ? `Catches any ${c.nights} night${c.nights > 1 ? "s" : ""} in a row between your dates.`
    : "Catches a site open for every night of your stay.";
}

// ---------- site rules ----------
function eligible(s, c) {
  const t = (s.type || "").toUpperCase();
  if (c.needElectric && (!t.includes("ELECTRIC") || t.includes("NONELECTRIC"))) return false;
  if (c.needRV && !t.includes("RV")) return false;
  if (c.needDrive && /WALK|BOAT|HIKE|BIKE|PADDLE|CANOE/.test(t)) return false;
  if (c.skipGroup && t.includes("GROUP")) return false;
  if (c.groupSize && s.max < c.groupSize) return false;
  if (c.mode === "pick" && !c.picked.includes(s.id)) return false;
  if (c.types?.length && !c.types.includes(s.type)) return false;
  if (c.loops?.length && !c.loops.includes(s.loop)) return false;
  return true;
}
const hasDetailFilters = c => !!(c.accessible || c.pets || c.fire || c.equip || c.rigLen || c.drive || c.vehicles || c.water);
// Site details we haven't loaded yet count as a pass, so a filter never hides a possible opening.
function detailOk(s, c) {
  const d = details[s.id];
  if (!d) return true;
  if (c.accessible && !d.acc) return false;
  if (c.pets && (!d.pets || /^(no|none)/i.test(d.pets))) return false;
  if (c.fire && d.fire && !/^y/i.test(d.fire)) return false;
  if (c.water === "has" && !d.wa) return false;
  if (c.water === "hookup" && !d.wh) return false;
  if (c.water === "none" && d.wa) return false;
  if (c.drive && d.drive && d.drive.toLowerCase() !== c.drive.toLowerCase()) return false;
  if (c.vehicles && d.vehicles && d.vehicles < c.vehicles) return false;
  const eq = c.equip ? d.eq.find(e => e.n === c.equip) : null;
  if (c.equip && d.eq.length && !eq) return false;
  if (c.rigLen) {
    const cap = eq && eq.max ? eq.max : d.maxVeh;
    if (cap && cap < c.rigLen) return false;
  }
  return true;
}
async function loadDetails(ids) {
  const need = ids.filter(id => !details[id]);
  for (let i = 0; i < need.length; i += 60) {
    Object.assign(details, await api(`/api/details?ids=${need.slice(i, i + 60).join(",")}`));
  }
}
async function findMatches(list, c) {
  let found = matches(list, c);
  if (found.length && hasDetailFilters(c)) {
    await loadDetails(found.map(m => m.site.id));
    found = found.filter(m => detailOk(m.site, c));
  }
  return found;
}
function matches(list, c) {
  const nights = nightsList(c.checkin, c.checkout);
  if (!nights.length) return [];
  const need = c.flex ? Math.min(c.nights, nights.length) : nights.length;
  const out = [];
  for (const s of list) {
    if (!eligible(s, c)) continue;
    let run = 0;
    for (let i = 0; i < nights.length; i++) {
      run = s.days[nights[i]] === "Available" ? run + 1 : 0;
      if (run >= need) { out.push({ site: s, start: nights[i - need + 1], end: addDays(nights[i], 1) }); break; }
    }
  }
  return out;
}

// ---------- recreation.gov ----------
async function api(path) {
  const r = await fetch(path);
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || r.status);
  return d;
}
async function fetchSites(id, c) {
  const by = {};
  for (const m of months(nightsList(c.checkin, c.checkout))) {
    const d = await api(`/api/availability?id=${id}&month=${m}`);
    for (const [cid, s] of Object.entries(d.campsites || {})) {
      const row = by[cid] ||= { id: cid, site: s.site, loop: s.loop, type: s.campsite_type, max: s.max_num_people || 0, days: {} };
      for (const [k, v] of Object.entries(s.availabilities)) row.days[k.slice(0, 10)] = v;
    }
  }
  return Object.values(by).sort((a, b) => a.loop.localeCompare(b.loop) || a.site.localeCompare(b.site, undefined, { numeric: true }));
}

// ---------- rendering ----------
const cls = v => ({ Available: "s-avail", Reserved: "s-booked", NYR: "s-nyr", Open: "s-walk" }[v] || "s-na");
function renderGrid() {
  const c = readCfg();
  const nights = nightsList(c.checkin, c.checkout);
  const f = $("siteFilter").value.trim().toLowerCase();
  let rows = sites.filter(s => !f || `${s.site} ${s.loop} ${s.type}`.toLowerCase().includes(f));
  if ($("fitOnly").checked) rows = rows.filter(s => eligible(s, { ...c, mode: "any" }) && detailOk(s, c));
  if ($("openNight").checked) rows = rows.filter(s => nights.some(n => s.days[n] === "Available"));
  if ($("openFirst").checked) {
    const open = s => nights.some(n => s.days[n] === "Available") ? 0 : 1;
    rows = [...rows].sort((a, b) => open(a) - open(b));
  }
  const head = nights.map(n => { const d = parse(n);
    return `<th class="d"><b>${d.toLocaleString("en", { month: "short" }).toUpperCase()}</b>${d.toLocaleString("en", { weekday: "short" })}<br>${d.getDate()}</th>`; }).join("");
  $("grid").tHead.innerHTML = `<tr><th></th><th>Site</th><th>Loop</th><th>Type</th>${head}</tr>`;
  $("grid").tBodies[0].innerHTML = rows.slice(0, 400).map(s =>
    `<tr><td><input type="checkbox" data-pick="${s.id}" ${picked.has(s.id) ? "checked" : ""}></td><td>${s.site}</td><td>${s.loop}</td>` +
    `<td>${s.type.toLowerCase().replace(/\b\w/g, m => m.toUpperCase())}</td>` +
    nights.map(n => `<td class="c"><span class="cell ${cls(s.days[n])}" title="${s.days[n] || "No info"}"></span></td>`).join("") + `</tr>`).join("")
    || `<tr><td class="muted pad" colspan="9">No sites to show.</td></tr>`;
}
function renderChips() {
  const count = key => sites.reduce((m, s) => (m[s[key]] = (m[s[key]] || 0) + 1, m), {});
  const draw = (el, counts, sel, label) => {
    const names = [...new Set([...Object.keys(counts), ...sel])].sort();
    el.innerHTML = names.length > (label === "loop" ? 1 : 0)
      ? names.map(n => `<button type="button" class="chip ${sel.has(n) ? "on" : ""}" data-${label}="${n}">${n.toLowerCase().replace(/\b\w/g, m => m.toUpperCase()).replace(/\bRv\b/, "RV")} <small>${counts[n] ?? 0}</small></button>`).join("")
      : label === "loop" ? "" : `<span class="muted small">Pick a campground to see its site types.</span>`;
  };
  draw($("typeChips"), count("type"), selTypes, "type");
  draw($("loopChips"), count("loop"), selLoops, "loop");
  $("loopLabel").style.display = $("loopChips").innerHTML ? "" : "none";
}
async function ensureDetails() {
  const c = readCfg(), run = ++detailRun;
  if (!hasDetailFilters(c) || !sites.length) { $("detailNote").textContent = ""; return; }
  const total = sites.length;
  $("detailNote").textContent = "Loading site details from recreation.gov…";
  try {
    for (let i = 0; i < total && run === detailRun; i += 60) {
      await loadDetails(sites.slice(i, i + 60).map(s => s.id));
      renderGrid();
      $("detailNote").textContent = `Loading site details… ${Math.min(i + 60, total)}/${total}`;
    }
    if (run === detailRun) $("detailNote").textContent = "";
  } catch (e) { $("detailNote").textContent = `Couldn't load site details: ${e.message}`; }
}
function renderWatch() {
  const ids = Object.keys(known);
  $("watchList").innerHTML = ids.length ? ids.map(id => {
    const k = known[id];
    return `<div class="watch ${id === selected ? "sel" : ""} ${watches[id] ? "live" : ""}" data-id="${id}"><div><b>${k.name}</b><small>${k.parent || ""}</small></div><button data-rm="${id}" title="Remove">✕</button></div>`;
  }).join("") : `<div class="muted pad">Nothing yet. Search above.</div>`;
  const on = selected && watches[selected];
  $("startBtn").disabled = !selected;
  $("startBtn").textContent = on ? "■ Stop Watching" : "🔭 Start Watching";
  $("startBtn").classList.toggle("on", !!on);
  $("startNote").textContent = selected
    ? `Ready: checks ${known[selected].name} ${everyText()}. You'll get a notification, a sound and the booking page as soon as a site opens. Keep this tab open.`
    : "Pick a campground first.";
}
function renderPill() {
  const w = selected && watches[selected], pill = $("statusPill");
  if (!w) { pill.className = "pill"; pill.textContent = selected ? "Not watching yet" : ""; return; }
  const left = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
  pill.className = "pill live";
  pill.textContent = `● Watching · next check in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}
setInterval(renderPill, 1000);
function renderLog() {
  const items = log.filter(l => tab === "activity" || l.found);
  $("log").innerHTML = items.length
    ? items.slice(-100).reverse().map(l => `<div>${new Date(l.t).toLocaleTimeString()} — ${l.html}</div>`).join("")
    : "Nothing yet. Checks and alerts will show up here.";
}
function addLog(html, found = false) {
  log.push({ t: Date.now(), html, found }); log = log.slice(-300); store.set("log", log); renderLog();
}

// ---------- selecting / loading ----------
async function select(id) {
  selected = id;
  const k = known[id];
  $("welcome").hidden = true; $("content").hidden = false;
  $("cgName").textContent = k.name;
  $("cgSub").textContent = (k.parent ? k.parent + " · " : "") + (watches[id] ? "Watching. You'll be alerted when a site opens." : "Alerts for any open site here.");
  $("sugg").style.display = k.parent ? "" : "none";
  $("nearby").textContent = `Check other campgrounds in ${k.parent}`;
  $("suggBody").textContent = "Find open campsites at other campgrounds in this park, for your dates and needs.";
  if (watches[id]) writeCfg(watches[id].cfg);
  renderWatch();
  await refresh();
}
async function refresh() {
  if (!selected) return;
  try { sites = await fetchSites(selected, readCfg()); renderChips(); renderGrid(); ensureDetails(); }
  catch (e) { addLog(`Couldn't load ${known[selected].name}: ${e.message}`); }
}

// ---------- phone alerts (ntfy.sh) ----------
const newTopic = () => "campbot-" + [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(36).padStart(2, "0")).join("").slice(0, 14);
let phone = store.get("phone", { on: false, topic: newTopic() });
const savePhone = () => store.set("phone", phone);
async function pushPhone(title, message, click) {
  if (!phone.on) return;
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(phone.topic)) return addLog("Phone alert not sent: the topic must be 6-64 letters, numbers, - or _.");
  try {
    // Straight from your browser to ntfy.sh, so no server of ours ever sees your topic.
    const r = await fetch("https://ntfy.sh/", { method: "POST", body: JSON.stringify({ topic: phone.topic, title, message, priority: 5, tags: ["tent"], click }) });
    if (!r.ok) throw new Error(`ntfy.sh returned ${r.status}`);
  } catch (e) { addLog(`Phone alert failed: ${e.message}`); }
}
function renderPhone() {
  $("phoneOn").checked = phone.on; $("topic").value = phone.topic;
  $("phoneNote").textContent = phone.on
    ? "Phone alerts on. Anyone who knows your topic name could read your alerts, so keep it private."
    : "Turn on to get a push notification on your phone the moment a site opens.";
}

// ---------- watching ----------
function beep() {
  try { const a = new AudioContext(), o = a.createOscillator(); o.connect(a.destination); o.frequency.value = 880; o.start(); o.stop(a.currentTime + .4); } catch {}
}
async function checkOne(w) {
  try {
    const list = await fetchSites(w.id, w.cfg);
    w.last = Date.now();
    const found = await findMatches(list, w.cfg);
    const fresh = found.filter(m => !w.seen.includes(`${m.site.id}|${m.start}`));
    w.seen = found.map(m => `${m.site.id}|${m.start}`);
    store.set("watches", watches);
    const url = `https://www.recreation.gov/camping/campgrounds/${w.id}`;
    if (fresh.length) {
      const first = fresh[0];
      const msg = `${w.name}: site ${first.site.site} open ${first.start} → ${first.end}` + (fresh.length > 1 ? ` (+${fresh.length - 1} more)` : "");
      addLog(`🎉 ${msg} — <a href="${url}" target="_blank">Book now</a>`, true);
      beep();
      try { new Notification("Campsite open!", { body: msg }); } catch {}
      pushPhone("Campsite open!", msg, url);
      window.open(url, "_blank");
    } else addLog(`Checked ${w.name}: ${found.length ? "still open, already alerted" : "nothing open"}.`);
    if (w.id === selected) { sites = list; renderChips(); renderGrid(); }
  } catch (e) { addLog(`Check failed for ${w.name}: ${e.message}`); }
}
const checkAll = () => Object.values(watches).forEach(checkOne);
function ensureTimer() {
  if (Object.keys(watches).length && !timer) {
    nextAt = Date.now() + CHECK_MS;
    timer = setInterval(() => { nextAt = Date.now() + CHECK_MS; checkAll(); }, CHECK_MS);
  }
  if (!Object.keys(watches).length && timer) { clearInterval(timer); timer = null; }
}

let syncTimer;
function syncWatch() {
  if (!(selected && watches[selected])) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {   // wait for rapid changes (e.g. stepper clicks) to settle
    const w = selected && watches[selected];
    if (!w) return;
    w.cfg = readCfg(); w.seen = [];
    store.set("watches", watches);
    addLog(`Updated what ${w.name} is watching for.`);
    checkOne(w);
  }, 700);
}

// ---------- events ----------
let searchSeq = 0;
async function doSearch(q) {
  q = q.trim();
  if (!q) { $("results").innerHTML = ""; return; }
  const seq = ++searchSeq;
  $("results").innerHTML = `<div class="muted pad">Searching…</div>`;
  try {
    const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (seq !== searchSeq) return;
    $("results").innerHTML = res.length
      ? res.map(r => `<div class="hit" data-hit='${JSON.stringify(r).replace(/'/g, "&#39;")}'><b>${r.name}</b><small>${r.parent} ${r.state}</small></div>`).join("")
      : `<div class="muted pad">No campgrounds found. Try a park name like “Yosemite”.</div>`;
  } catch (err) { if (seq === searchSeq) $("results").innerHTML = `<div class="muted pad">Search failed: ${err.message}</div>`; }
}
let searchTimer;
$("searchForm").onsubmit = e => { e.preventDefault(); clearTimeout(searchTimer); doSearch($("q").value); };
$("q").oninput = () => { clearTimeout(searchTimer); if ($("q").value.trim().length >= 3) searchTimer = setTimeout(() => doSearch($("q").value), 450); };
document.querySelectorAll("[data-park]").forEach(b => b.onclick = () => { $("q").value = b.dataset.park; doSearch(b.dataset.park); $("q").focus(); });

// date presets and +/- steppers
function nextFriday(offset) {
  const d = parse(iso(new Date())); d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7) + offset); return iso(d);
}
document.querySelectorAll("[data-preset]").forEach(b => b.onclick = () => {
  const fri = nextFriday(+b.dataset.preset);
  $("checkin").value = fri; $("checkout").value = addDays(fri, 2);
  $("checkout").dispatchEvent(new Event("change"));
});
document.querySelectorAll("[data-step]").forEach(b => b.onclick = () => {
  const [id, n] = b.dataset.step.split(":"), el = $(id);
  el.value = Math.min(+el.max || 999, Math.max(+el.min || 0, (+el.value || 0) + +n));
  el.dispatchEvent(new Event("change"));
});

$("results").onclick = e => {
  const el = e.target.closest("[data-hit]"); if (!el) return;
  const r = JSON.parse(el.dataset.hit);
  known[r.id] = { id: r.id, name: r.name, parent: r.parent };
  store.set("known", known); $("results").innerHTML = ""; $("q").value = "";
  select(r.id);
};
$("watchList").onclick = e => {
  const rm = e.target.closest("[data-rm]");
  if (rm) {
    const id = rm.dataset.rm; delete known[id]; delete watches[id];
    store.set("known", known); store.set("watches", watches); ensureTimer();
    if (selected === id) { selected = null; sites = []; $("welcome").hidden = false; $("content").hidden = true; renderGrid(); }
    return renderWatch();
  }
  const w = e.target.closest("[data-id]"); if (w) select(w.dataset.id);
};
$("startBtn").onclick = async () => {
  if (!selected) return;
  if (watches[selected]) { delete watches[selected]; addLog(`Stopped watching ${known[selected].name}.`); }
  else {
    const c = readCfg();
    if (c.checkout <= c.checkin) return alert("Check-out must be after check-in.");
    if (c.mode === "pick" && !c.picked.length) return alert("Tick the sites you want in the grid, or switch to “Any site”.");
    try { await Notification.requestPermission(); } catch {}
    watches[selected] = { ...known[selected], cfg: c, seen: [] };
    addLog(`Started watching ${known[selected].name} (${c.checkin} → ${c.checkout}).`);
    checkOne(watches[selected]);
  }
  store.set("watches", watches); ensureTimer(); renderWatch(); renderPill();
};
// ---------- suggestions: other campgrounds in the same park ----------
const esc = t => String(t).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const fmtDay = d => parse(d).toLocaleDateString("en", { month: "short", day: "numeric" });
let suggMap = {};
function suggCards(rs) {
  const rank = r => r.hit ? (r.hit.shift === 0 ? 0 : 1) : r.error ? 3 : 2;
  const sorted = [...rs].sort((a, b) => rank(a) - rank(b) || (b.hit?.found.length || 0) - (a.hit?.found.length || 0));
  return `<div class="scards">` + sorted.map(r => {
    suggMap[r.id] = r;
    const h = r.hit;
    const text = h
      ? `${h.found.length} site${h.found.length > 1 ? "s" : ""} open ${fmtDay(h.cc.checkin)} – ${fmtDay(h.cc.checkout)}` +
        (h.shift ? ` · ${Math.abs(h.shift)} day${Math.abs(h.shift) > 1 ? "s" : ""} ${h.shift < 0 ? "earlier" : "later"}` : " · your dates")
      : r.error ? "Couldn't check right now" : "Nothing open within 3 days of your dates";
    return `<div class="scard ${h ? "hit-now" : ""}"><div><b>${esc(r.name)}</b><small>${esc(text)}</small></div>
      <div class="sact"><button type="button" class="btn soft" data-watch="${r.id}">Watch</button>
      <a class="btn soft" target="_blank" href="https://www.recreation.gov/camping/campgrounds/${r.id}">Book</a></div></div>`;
  }).join("") + `</div>`;
}
async function scanSiblings() {
  const k = known[selected]; if (!k?.parent) return;
  const c0 = readCfg(), myId = selected, body = $("suggBody"), btn = $("nearby");
  if (c0.checkout <= c0.checkin) { body.textContent = "Pick check-in and check-out dates first."; return; }
  btn.disabled = true; body.textContent = `Looking up campgrounds in ${k.parent}…`;
  try {
    const all = await api(`/api/search?q=${encodeURIComponent(k.parent)}&size=40`);
    const sibs = all.filter(r => r.parent === k.parent && r.id !== myId);
    if (!sibs.length) { body.textContent = "No other campgrounds found in this park."; return; }
    // The picked sites / types / loops belong to the current campground, so leave them out here.
    const c = { ...c0, mode: "any", types: [], loops: [], picked: [] };
    const done = [];
    for (let i = 0; i < sibs.length; i++) {
      if (selected !== myId) return;                         // user moved to another campground
      body.innerHTML = `<div>Checking ${i + 1} of ${sibs.length}: ${esc(sibs[i].name)}…</div>` + suggCards(done);
      const s = sibs[i];
      try {
        const list = await fetchSites(s.id, { checkin: addDays(c.checkin, -3), checkout: addDays(c.checkout, 3) });
        let hit = null;
        for (const shift of [0, -1, 1, -2, 2, -3, 3]) {      // your dates first, then up to 3 days either side
          const cc = { ...c, checkin: addDays(c.checkin, shift), checkout: addDays(c.checkout, shift) };
          const found = await findMatches(list, cc);
          if (found.length) { hit = { shift, cc, found }; break; }
        }
        done.push({ ...s, hit });
      } catch (e) { done.push({ ...s, error: e.message }); }
    }
    const open = done.filter(r => r.hit).length;
    body.innerHTML = `<div>${open ? `${open} of ${done.length} other campgrounds have something open.` : `Nothing open at the ${done.length} other campgrounds for your dates, or within 3 days of them, right now.`}</div>` + suggCards(done);
  } catch (e) { body.textContent = `Couldn't check other campgrounds: ${e.message}`; }
  finally { btn.disabled = false; }
}
$("nearby").onclick = scanSiblings;
$("suggBody").onclick = e => {
  const id = e.target.closest("[data-watch]")?.dataset.watch; if (!id) return;
  const r = suggMap[id];
  known[id] = { id, name: r.name, parent: r.parent };
  store.set("known", known); select(id);
};
$("refreshBtn").onclick = () => selected && (watches[selected] ? checkOne(watches[selected]) : refresh());
$("bookBtn").onclick = () => selected && window.open(`https://www.recreation.gov/camping/campgrounds/${selected}`, "_blank");
$("grid").onchange = e => {
  const id = e.target.dataset.pick; if (!id) return;
  e.target.checked ? picked.add(id) : picked.delete(id);
  syncWatch();
};
document.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => {
  mode = b.dataset.mode;
  syncWatch();
  document.querySelectorAll("[data-mode]").forEach(x => x.classList.toggle("on", x === b));
});
document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => {
  tab = b.dataset.tab;
  document.querySelectorAll("[data-tab]").forEach(x => x.classList.toggle("on", x === b)); renderLog();
});
["checkin", "checkout", "nights"].forEach(id => $(id).onchange = () => {
  syncDateUi();
  if ($("checkout").value <= $("checkin").value) $("checkout").value = addDays($("checkin").value, 1);
  refresh().then(syncWatch);
});
const onFilterChange = () => { syncDateUi(); renderGrid(); ensureDetails(); syncWatch(); };
["flex", "groupSize", ...NEEDS, ...DETAIL_KEYS].forEach(id => $(id).onchange = onFilterChange);
$("more").addEventListener("click", e => {
  const chip = e.target.closest(".chip"); if (!chip) return;
  const [set, val] = chip.dataset.type != null ? [selTypes, chip.dataset.type] : [selLoops, chip.dataset.loop];
  set.has(val) ? set.delete(val) : set.add(val);
  renderChips(); onFilterChange();
});
["siteFilter", "openNight", "openFirst", "fitOnly"].forEach(id => $(id).oninput = renderGrid);

$("phoneOn").onchange = () => { phone.on = $("phoneOn").checked; savePhone(); renderPhone(); };
$("topic").onchange = () => { phone.topic = $("topic").value.trim(); savePhone(); };
$("newTopic").onclick = () => { phone.topic = newTopic(); savePhone(); renderPhone(); };
$("testPhone").onclick = async () => {
  const was = phone.on; phone.on = true;
  await pushPhone("Campsite Watcher test", "Phone alerts are working. You'll get a message like this when a site opens.");
  phone.on = was; addLog("Sent a test alert to your phone.");
};

$("interval").onchange = () => {
  CHECK_MS = +$("interval").value * 1000;
  try { localStorage.setItem("interval", $("interval").value); } catch {}
  if (timer) { clearInterval(timer); timer = null; ensureTimer(); }
  renderIntervalText(); renderWatch(); renderPill();
};
function renderIntervalText() {
  document.querySelectorAll(".everyText").forEach(el => el.textContent = everyText());
  $("fastWarn").hidden = CHECK_MS >= 60000;
}

// ---------- init ----------
$("checkin").value = addDays(iso(new Date()), 2);
$("checkout").value = addDays(iso(new Date()), 3);
syncDateUi(); renderWatch(); renderLog(); renderGrid(); renderPhone(); $("interval").value = String(CHECK_MS / 1000); renderIntervalText();
const first = Object.keys(watches)[0] || Object.keys(known)[0];
if (first) select(first);
ensureTimer();
if (Object.keys(watches).length) checkAll();
