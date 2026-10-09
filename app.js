"use strict";
// 朝刊アプリ: 記事と採点は非公開リポジトリ Waku68/asa-brief-data にある
//   briefs/<id>.json  … 毎朝のタスクが書く
//   scores/<id>.json  … このアプリが書く(採点)
const OWNER = "Waku68", REPO = "asa-brief-data";
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/`;
const AX = ["kiku", "ugokeru", "shoji"], AXN = { kiku: "効く", ugokeru: "動ける", shoji: "初耳" };
const $ = id => document.getElementById(id), form = $("f");

// ---------- local storage (best effort) ----------
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem("asa." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("asa." + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem("asa." + k); } catch (e) {} },
};
let token = LS.get("token", "");

// ---------- GitHub ----------
function b64enc(s) { const b = new TextEncoder().encode(s); let t = ""; for (let i = 0; i < b.length; i += 0x8000) t += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(t); }
function b64dec(s) { return new TextDecoder().decode(Uint8Array.from(atob(String(s).replace(/\s/g, "")), c => c.charCodeAt(0))); }
async function gh(path, opt = {}) {
  const res = await fetch(API + path, {
    method: opt.method || "GET", cache: "no-store",
    headers: { Authorization: "Bearer " + token, Accept: opt.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(opt.body ? { "Content-Type": "application/json" } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
  return opt.raw ? res.text() : res.json();
}
async function listBriefs() {
  const arr = await gh("briefs");
  const items = (arr || []).filter(f => f.type === "file" && f.name.endsWith(".json")).map(f => ({ id: f.name.slice(0, -5), sha: f.sha }));
  items.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  LS.set("list", items);
  return items;
}
async function getBrief(item) {
  const c = LS.get("brief." + item.id);
  if (c && c.sha === item.sha) return c.data;
  try {
    const txt = await gh("briefs/" + encodeURIComponent(item.id) + ".json", { raw: true });
    const data = JSON.parse(txt);
    LS.set("brief." + item.id, { sha: item.sha, data });
    pruneCache();
    return data;
  } catch (e) { if (c) return c.data; throw e; }
}
function pruneCache() {
  try {
    const keys = Object.keys(localStorage).filter(k => k.startsWith("asa.brief.")).sort();
    while (keys.length > 40) localStorage.removeItem(keys.shift());
  } catch (e) {}
}
async function getScore(id) {
  const j = await gh("scores/" + encodeURIComponent(id) + ".json");
  if (!j) return { sha: null, data: null };
  return { sha: j.sha, data: JSON.parse(b64dec(j.content)) };
}
async function putScore(id, data, sha) {
  const body = { message: "採点 " + id, content: b64enc(JSON.stringify(data, null, 2) + "\n") };
  if (sha) body.sha = sha;
  const j = await gh("scores/" + encodeURIComponent(id) + ".json", { method: "PUT", body });
  return j.content.sha;
}

// ---------- markdown ----------
if (window.DOMPurify) DOMPurify.addHook("afterSanitizeAttributes", n => { if (n.tagName === "A" && n.getAttribute("href")) { n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener"); } });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function md(s) {
  s = String(s || "");
  if (!(window.marked && window.DOMPurify)) return '<p style="white-space:pre-wrap">' + esc(s) + "</p>";
  // geo:緯度,経度 のリンクは地図にする(サニタイザはgeo:を落とすので先に印を付ける)
  let html = marked.parse(s, { gfm: true, breaks: false });
  html = html.replace(/<a href="geo:([^"]+)"[^>]*>/g, (m, g) => `<a class="geo" data-geo="${g}">`);
  return DOMPurify.sanitize(html);
}

// ---------- photos (Wikipedia / Wikimedia Commons) ----------
function wikiTarget(href) {
  let m = href.match(/^https?:\/\/([a-z-]+)\.(?:m\.)?wikipedia\.org\/wiki\/([^#?]+)/i);
  if (m) return { kind: "wp", lang: m[1], title: decodeURIComponent(m[2]) };
  m = href.match(/^https?:\/\/commons\.(?:m\.)?wikimedia\.org\/wiki\/(File:[^#?]+)/i);
  if (m) return { kind: "file", title: decodeURIComponent(m[1]) };
  return null;
}
const stripTags = s => { const d = document.createElement("div"); d.innerHTML = DOMPurify.sanitize(String(s || "")); return d.textContent.trim(); };
async function resolvePhoto(href) {
  const c = LS.get("img." + href);
  if (c && (c.src || Date.now() - c.t < 864e5)) return c.src ? c : null;
  const t = wikiTarget(href);
  let out = null;
  try {
    if (t.kind === "wp") {
      const r = await fetch(`https://${t.lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.title)}`);
      if (r.ok) {
        const j = await r.json();
        const o = j.originalimage, th = j.thumbnail;
        let src = null;
        if (o && o.width <= 1400) src = o.source;
        else if (th) src = th.source.replace(/\/\d+px-/, "/800px-");
        if (src) out = { src, credit: `Wikipedia「${j.title || t.title}」の写真` };
      }
    } else {
      const u = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(t.title)}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=800&format=json&origin=*`;
      const r = await fetch(u);
      if (r.ok) {
        const j = await r.json();
        const p = Object.values(j.query?.pages || {})[0];
        const ii = p?.imageinfo?.[0];
        if (ii) {
          const em = ii.extmetadata || {};
          const who = stripTags(em.Artist?.value), lic = stripTags(em.LicenseShortName?.value);
          out = { src: ii.thumburl || ii.url, credit: "写真: " + [who, lic].filter(Boolean).join(" / ") };
        }
      }
    }
  } catch (e) { return null; }
  LS.set("img." + href, out ? { ...out, t: Date.now() } : { src: null, t: Date.now() });
  return out;
}
function enhancePhotos(root) {
  for (const a of root.querySelectorAll("a[href]")) {
    const li = a.closest("li");
    const line = (li || a.parentElement).textContent.trim();
    if (!/^写真/.test(line) || !wikiTarget(a.href)) continue;
    const host = li || a.parentElement;
    resolvePhoto(a.href).then(p => {
      if (!p || !host.isConnected) return;
      const fig = document.createElement("figure"); fig.className = "photo";
      const img = document.createElement("img"); img.loading = "lazy"; img.decoding = "async"; img.src = p.src; img.alt = a.textContent.trim();
      img.onerror = () => fig.remove();
      const cap = document.createElement("figcaption");
      cap.append(a.textContent.trim() + " · " + p.credit + " · ");
      const link = document.createElement("a"); link.href = a.href; link.target = "_blank"; link.rel = "noopener"; link.textContent = "元のページ";
      cap.append(link); fig.append(img, cap);
      host.replaceChildren(fig);
      if (li) li.classList.add("has-fig");
    });
  }
}

// ---------- maps (OpenStreetMap) ----------
let mapObserver = null;
function enhanceMaps(root) {
  if (!window.L) return;
  L.Icon.Default.imagePath = "vendor/images/";
  for (const a of root.querySelectorAll("a.geo[data-geo]")) {
    const m = a.dataset.geo.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:.*?[?&]z=(\d+))?/);
    if (!m) continue;
    const lat = +m[1], lon = +m[2], z = m[3] ? Math.min(18, Math.max(2, +m[3])) : 6, label = a.textContent.trim();
    const li = a.closest("li"), host = li || a.parentElement;
    const box = document.createElement("div"); box.className = "map"; box.setAttribute("role", "img"); box.setAttribute("aria-label", "地図:" + label);
    Object.assign(box.dataset, { lat, lon, z, label });
    const cap = document.createElement("div"); cap.className = "mapcap";
    const ext = document.createElement("a"); ext.href = `https://maps.apple.com/?ll=${lat},${lon}&q=${encodeURIComponent(label)}&z=${z}`; ext.target = "_blank"; ext.rel = "noopener"; ext.textContent = "マップで開く";
    cap.append("地図:" + label + " · ", ext);
    host.replaceChildren(box, cap);
    if (li) li.classList.add("has-fig");
    if (!mapObserver) mapObserver = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { mapObserver.unobserve(e.target); drawMap(e.target); } }, { rootMargin: "200px" });
    mapObserver.observe(box);
  }
}
function drawMap(box) {
  const { lat, lon, z, label } = box.dataset;
  const map = L.map(box, { scrollWheelZoom: false, attributionControl: true }).setView([+lat, +lon], +z);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(map);
  L.marker([+lat, +lon]).addTo(map).bindTooltip(label, { permanent: true, direction: "top", offset: [0, -36] });
}

// ---------- state & rendering ----------
let items = [], idx = -1, brief = null, keys = [], titles = {}, extra = {}, lastChecked = {};
let scoreSha = null, timer = null, pending = null, writing = Promise.resolve(), loadSeq = 0;

function setStatus(t, cls) { const e = $("status"); e.textContent = t; e.className = cls || ""; }
function label(b, id) { if (!b) return id || ""; const r = Number(b.round) || 1; return b.date + (r > 1 ? `(${r}本目)` : ""); }
function rateHTML(k) {
  let h = `<div class="rate" role="group" aria-label="${esc(titles[k])}の採点"><div class="cap">このセクションの採点</div>`;
  for (const a of AX) {
    h += `<div class="row" role="radiogroup" aria-label="${AXN[a]}"><span class="lab">${AXN[a]}</span><div class="seg">`;
    for (let n = 1; n <= 5; n++) h += `<input type="radio" id="${k}-${a}-${n}" name="${k}-${a}" value="${n}"><label for="${k}-${a}-${n}">${n}</label>`;
    h += `</div></div>`;
  }
  return h + `</div>`;
}
function render() {
  const body = $("body");
  $("prev").disabled = idx <= 0; $("next").disabled = idx < 0 || idx >= items.length - 1;
  if (!brief) {
    $("which").textContent = items.length ? "" : "まだありません";
    body.innerHTML = `<div class="empty">まだまとめが届いていません。毎朝5時ごろ、ここに今日の分が届きます。</div>`;
    $("tail").hidden = true; return;
  }
  $("which").textContent = label(brief);
  const S = brief.sections || {};
  keys = (Array.isArray(brief.order) && brief.order.length ? brief.order : Object.keys(S)).filter(k => S[k]);
  titles = {}; for (const k of keys) titles[k] = S[k].title || k;
  let h = "";
  if (brief.top || brief.changes) {
    h += `<div class="lead">`;
    if (brief.top) h += `<span class="k">今日の一番</span><div class="md">${md(brief.top)}</div>`;
    if (brief.changes) h += `<span class="k">今回の変更点</span><div class="md">${md(brief.changes)}</div>`;
    h += `</div>`;
  }
  for (const k of keys) h += `<article id="${esc(k)}"><h2>${esc(titles[k])}</h2><div class="md">${md(S[k].md)}</div>${rateHTML(k)}</article>`;
  body.innerHTML = h; $("tail").hidden = false;
  enhancePhotos(body); enhanceMaps(body);
}
function collect() {
  const sections = { ...extra };
  for (const s of keys) { sections[s] = {}; for (const a of AX) { const c = form.querySelector(`input[name="${s}-${a}"]:checked`); sections[s][a] = c ? Number(c.value) : 0; } }
  const v = form.querySelector('input[name="volume"]:checked');
  return { sections, volume: v ? v.value : "", note: $("note").value };
}
function apply(d) {
  for (const i of form.querySelectorAll("input[type=radio]")) i.checked = false;
  extra = {};
  if (d) {
    for (const [k, v] of Object.entries(d.sections || {})) if (!keys.includes(k)) extra[k] = v;
    for (const s of keys) for (const a of AX) { const n = d.sections?.[s]?.[a]; if (n) { const i = $(`${s}-${a}-${n}`); if (i) i.checked = true; } }
    if (d.volume) for (const i of form.querySelectorAll('input[name="volume"]')) if (i.value === d.volume) i.checked = true;
  }
  $("note").value = d?.note || "";
  lastChecked = {}; for (const i of form.querySelectorAll("input[type=radio]:checked")) lastChecked[i.name] = i.id;
}

// ---------- saving scores ----------
function save() {
  if (!brief) return;
  const id = brief.key || items[idx].id, date = brief.date, r = Number(brief.round) || 1;
  const data = { date, round: r, ...collect(), updatedAt: new Date().toISOString() };
  LS.set("pending." + id, data);           // 圏外でも消えないよう先に端末に置く
  clearTimeout(timer); setStatus("保存中…");
  pending = () => write(id, data); timer = setTimeout(flush, 600);
}
function flush() { clearTimeout(timer); if (!pending) return writing; const j = pending; pending = null; writing = writing.then(j); return writing; }
async function write(id, data, retried) {
  try {
    const sha = await putScore(id, data, id === curId() ? scoreSha : (await getScore(id)).sha);
    if (id === curId()) scoreSha = sha;
    const p = LS.get("pending." + id); if (p && p.updatedAt === data.updatedAt) LS.del("pending." + id);
    if (!pending) setStatus("保存しました", "ok");
  } catch (e) {
    if (!retried && (e.status === 409 || e.status === 422)) {  // 別の端末が先に保存していた
      const s = await getScore(id).catch(() => null);
      if (s && id === curId()) scoreSha = s.sha;
      return write(id, data, true);
    }
    if (e.status === 401 || e.status === 403) setStatus("保存できません。設定のトークンを確認してください", "warn");
    else setStatus("圏外のため端末に保存しました。つながったら送ります", "warn");
  }
}
const curId = () => (brief && (brief.key || items[idx]?.id)) || null;
async function flushPendingAll() {
  let keys2 = [];
  try { keys2 = Object.keys(localStorage).filter(k => k.startsWith("asa.pending.")); } catch (e) {}
  for (const k of keys2) {
    const id = k.slice("asa.pending.".length), data = LS.get(k.slice(4));
    if (!data) continue;
    try { const s = await getScore(id); const sha = await putScore(id, data, s.sha); if (id === curId()) scoreSha = sha; LS.del(k.slice(4)); } catch (e) { return; }
  }
}

// ---------- navigation ----------
async function show(i) {
  await flush();
  const seq = ++loadSeq; idx = i; brief = null; scoreSha = null;
  const it = items[i];
  if (!it) { render(); return; }
  setStatus("読み込み中…");
  try { brief = await getBrief(it); } catch (e) { if (seq === loadSeq) { setStatus("記事を読み込めませんでした", "warn"); render(); } return; }
  if (seq !== loadSeq) return;
  if (!brief.key) brief.key = it.id;
  render(); apply(null);
  try { history.replaceState(null, "", "#" + it.id); } catch (e) {}
  const local = LS.get("pending." + it.id);
  try {
    const s = await getScore(it.id); if (seq !== loadSeq) return;
    scoreSha = s.sha;
    const d = local && (!s.data || (local.updatedAt || "") > (s.data.updatedAt || "")) ? local : s.data;
    apply(d);
    if (local && d === local) save(); else setStatus(s.data ? "採点済みの点数を表示中" : "まだ未採点");
  } catch (e) {
    if (seq !== loadSeq) return;
    apply(local || null);
    setStatus(local ? "端末に保存した点数を表示中(未送信)" : "点数を読み込めませんでした(圏外?)", "warn");
  }
}
async function loadList(keepCurrent) {
  const btn = $("reload"); btn.classList.add("spin");
  try {
    const cur = items[idx]?.id, wasLast = idx >= 0 && idx === items.length - 1;
    try { items = await listBriefs(); }
    catch (e) {
      if (e.status === 401 || e.status === 403) { openSettings("トークンが使えませんでした。もう一度作って貼り付けてください。"); setStatus("トークンを確認してください", "warn"); return; }
      items = LS.get("list", []); setStatus("圏外のため、保存済みの記事を表示中", "warn");
    }
    let i;
    if (keepCurrent && cur) i = items.findIndex(x => x.id === cur);
    else { const want = decodeURIComponent((location.hash || "").slice(1)); i = items.findIndex(x => x.id === want); }
    if (i < 0 || (keepCurrent && wasLast)) i = items.length - 1;
    await show(i);
    flushPendingAll();
  } finally { btn.classList.remove("spin"); }
}

// ---------- settings ----------
function openSettings(msg) { $("settings").hidden = false; $("tokenMsg").textContent = msg || ""; $("token").value = ""; $("closeSettings").hidden = !token; }
$("gear").onclick = () => { $("settings").hidden ? openSettings() : ($("settings").hidden = true); };
$("closeSettings").onclick = () => { $("settings").hidden = true; };
$("saveToken").onclick = async () => {
  const t = $("token").value.trim();
  if (!t) { $("tokenMsg").textContent = "トークンを貼り付けてください。"; return; }
  const old = token; token = t; $("tokenMsg").textContent = "確認中…";
  try { await listBriefs(); LS.set("token", t); $("settings").hidden = true; await loadList(false); }
  catch (e) { token = old; $("tokenMsg").textContent = e.status === 401 || e.status === 403 || e.status === 404 ? "このトークンでは asa-brief-data を読めませんでした。手順3と4を確認してください。" : "通信できませんでした。電波を確認してもう一度。"; }
};

// ---------- events ----------
form.addEventListener("click", e => {
  const lab = e.target.closest("label"); if (!lab) return;
  const inp = $(lab.htmlFor); if (!inp || inp.type !== "radio") return;
  if (lastChecked[inp.name] === inp.id) { e.preventDefault(); inp.checked = false; delete lastChecked[inp.name]; save(); }
});
form.addEventListener("change", e => { const i = e.target; if (i.type === "radio") lastChecked[i.name] = i.id; save(); });
$("note").addEventListener("input", save);
$("prev").onclick = () => { if (idx > 0) show(idx - 1); };
$("next").onclick = () => { if (idx < items.length - 1) show(idx + 1); };
$("reload").onclick = () => token ? loadList(true) : openSettings();
window.addEventListener("online", () => { flush(); flushPendingAll(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
  else if (token && Date.now() - (window._lastList || 0) > 30 * 60e3) { window._lastList = Date.now(); loadList(true); }
});

// ---------- start ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
try { navigator.storage?.persist?.(); } catch (e) {}
if (!token) { openSettings(); setStatus("はじめにトークンを設定してください"); $("body").innerHTML = `<div class="empty">設定が終わると、今日のまとめがここに出ます。</div>`; $("which").textContent = ""; }
else { window._lastList = Date.now(); loadList(false); }
