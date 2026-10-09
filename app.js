"use strict";
// 朝刊アプリ: 記事と反応は非公開リポジトリ Waku68/asa-brief-data にある
//   朝まとめ   briefs/<id>.json(毎朝のタスクが書く) + scores/<id>.json(アプリが書く採点)
//   株ミニ講座 lessons/<id>.json(毎朝のタスクが書く) + notes/<id>.json(アプリが書くコメント・質問)
const OWNER = "Waku68", REPO = "asa-brief-data";
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/`;
const AX = ["kiku", "ugokeru", "shoji"], AXN = { kiku: "効く", ugokeru: "動ける", shoji: "初耳" };
const $ = id => document.getElementById(id), form = $("f");

// ---------- local storage (best effort) ----------
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem("asa." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("asa." + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem("asa." + k); } catch (e) {} },
  keys(prefix) { try { return Object.keys(localStorage).filter(k => k.startsWith("asa." + prefix)).map(k => k.slice(4)); } catch (e) { return []; } },
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
async function listDocs(dir) {
  const arr = await gh(dir);
  const items = (arr || []).filter(f => f.type === "file" && f.name.endsWith(".json")).map(f => ({ id: f.name.slice(0, -5), sha: f.sha }));
  items.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  LS.set("list." + dir, items);
  return items;
}
async function getDoc(dir, item) {
  const ck = `doc.${dir}.${item.id}`, c = LS.get(ck);
  if (c && c.sha === item.sha) return c.data;
  try {
    const data = JSON.parse(await gh(`${dir}/${encodeURIComponent(item.id)}.json`, { raw: true }));
    LS.set(ck, { sha: item.sha, data });
    const ks = LS.keys(`doc.${dir}.`).sort(); while (ks.length > 40) LS.del(ks.shift());
    return data;
  } catch (e) { if (c) return c.data; throw e; }
}
async function getFb(dir, id) {
  const j = await gh(`${dir}/${encodeURIComponent(id)}.json`);
  if (!j) return { sha: null, data: null };
  return { sha: j.sha, data: JSON.parse(b64dec(j.content)) };
}
async function putFb(dir, id, data, sha, msg) {
  const body = { message: msg + " " + id, content: b64enc(JSON.stringify(data, null, 2) + "\n") };
  if (sha) body.sha = sha;
  return (await gh(`${dir}/${encodeURIComponent(id)}.json`, { method: "PUT", body })).content.sha;
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
        const j = await r.json(), o = j.originalimage, th = j.thumbnail;
        let src = null;
        if (o && o.width <= 1400) src = o.source;
        else if (th) src = th.source.replace(/\/\d+px-/, "/800px-");
        if (src) out = { src, credit: `Wikipedia「${j.title || t.title}」の写真` };
      }
    } else {
      const r = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(t.title)}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=800&format=json&origin=*`);
      if (r.ok) {
        const j = await r.json(), p = Object.values(j.query?.pages || {})[0], ii = p?.imageinfo?.[0];
        if (ii) {
          const em = ii.extmetadata || {};
          out = { src: ii.thumburl || ii.url, credit: "写真: " + [stripTags(em.Artist?.value), stripTags(em.LicenseShortName?.value)].filter(Boolean).join(" / ") };
        }
      }
    }
  } catch (e) { return null; }
  LS.set("img." + href, out ? { ...out, t: Date.now() } : { src: null, t: Date.now() });
  return out;
}
function enhancePhotos(root) {
  for (const a of root.querySelectorAll(".md a[href]")) {
    const li = a.closest("li"), host = li || a.parentElement;
    if (!/^写真/.test(host.textContent.trim()) || !wikiTarget(a.href)) continue;
    resolvePhoto(a.href).then(p => {
      if (!p || !host.isConnected) return;
      const fig = document.createElement("figure"); fig.className = "photo";
      const img = document.createElement("img"); img.loading = "lazy"; img.decoding = "async"; img.src = p.src; img.alt = a.textContent.trim();
      img.onerror = () => fig.remove();
      const cap = document.createElement("figcaption"), link = document.createElement("a");
      link.href = a.href; link.target = "_blank"; link.rel = "noopener"; link.textContent = "元のページ";
      cap.append(a.textContent.trim() + " · " + p.credit + " · ", link); fig.append(img, cap);
      host.replaceChildren(fig); if (li) li.classList.add("has-fig");
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
    host.replaceChildren(box, cap); if (li) li.classList.add("has-fig");
    if (!mapObserver) mapObserver = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { mapObserver.unobserve(e.target); drawMap(e.target); } }, { rootMargin: "200px" });
    mapObserver.observe(box);
  }
}
function drawMap(box) {
  const { lat, lon, z, label } = box.dataset;
  const map = L.map(box, { scrollWheelZoom: false }).setView([+lat, +lon], +z);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(map);
  L.marker([+lat, +lon]).addTo(map).bindTooltip(label, { permanent: true, direction: "top", offset: [0, -36] });
}

// ---------- views ----------
// 朝まとめ:各セクションの下で3軸を採点 + 分量 + ひとこと
const briefView = {
  dir: "briefs", fb: "scores", msg: "採点", title: "朝の情報まとめ", empty: "まとめ",
  help: "各セクションを読んだら、すぐ下の数字をタップ。タップした時点で保存される。同じ数字をもう一度タップで取り消し。効く=進路・研究に直結/動ける=次の一手や試し方がある/初耳=知らなかった。",
  lead(d) {
    let h = "";
    if (d.top) h += `<span class="k">今日の一番</span><div class="md">${md(d.top)}</div>`;
    if (d.changes) h += `<span class="k">今回の変更点</span><div class="md">${md(d.changes)}</div>`;
    return h;
  },
  section(k, s) {
    let h = `<div class="md">${md(s.md)}</div><div class="rate" role="group" aria-label="${esc(s.title || k)}の採点"><div class="cap">このセクションの採点</div>`;
    for (const a of AX) {
      h += `<div class="row" role="radiogroup" aria-label="${AXN[a]}"><span class="lab">${AXN[a]}</span><div class="seg">`;
      for (let n = 1; n <= 5; n++) h += `<input type="radio" id="${k}-${a}-${n}" name="${k}-${a}" value="${n}"><label for="${k}-${a}-${n}">${n}</label>`;
      h += `</div></div>`;
    }
    return h + `</div>`;
  },
  tail: `<section class="card"><h2>全体の分量</h2><div class="seg three"><input type="radio" id="vol-0" name="volume" value="多すぎ"><label for="vol-0">多すぎ</label><input type="radio" id="vol-1" name="volume" value="ちょうど"><label for="vol-1">ちょうど</label><input type="radio" id="vol-2" name="volume" value="足りない"><label for="vol-2">足りない</label></div></section>
    <section class="card"><h2>ひとこと(任意)</h2><textarea id="note" placeholder="例:編入の話をもっと/この話を明日深掘りして"></textarea></section>`,
  collect(keys, extra, doc) {
    const sections = { ...extra };
    for (const s of keys) { sections[s] = {}; for (const a of AX) { const c = form.querySelector(`input[name="${s}-${a}"]:checked`); sections[s][a] = c ? Number(c.value) : 0; } }
    const v = form.querySelector('input[name="volume"]:checked');
    return { date: doc.date, round: Number(doc.round) || 1, sections, volume: v ? v.value : "", note: $("note").value };
  },
  apply(keys, d) {
    const extra = {};
    for (const i of form.querySelectorAll("input[type=radio]")) i.checked = false;
    if (d) {
      for (const [k, v] of Object.entries(d.sections || {})) if (!keys.includes(k)) extra[k] = v;
      for (const s of keys) for (const a of AX) { const n = d.sections?.[s]?.[a]; if (n) { const i = $(`${s}-${a}-${n}`); if (i) i.checked = true; } }
      if (d.volume) for (const i of form.querySelectorAll('input[name="volume"]')) if (i.value === d.volume) i.checked = true;
    }
    $("note").value = d?.note || "";
    return extra;
  },
  statusLoaded: d => d ? "採点済みの点数を表示中" : "まだ未採点",
};
// 株ミニ講座:各セクションの下にコメント・質問 + 全体へのひとこと。答えは次の講座で届く
const kabuView = {
  dir: "lessons", fb: "notes", msg: "コメント", title: "株ミニ講座", empty: "講座",
  help: "各セクションの下にコメントや質問を書くと、その場で保存されて、次の日の講座の最初で答えが届きます。",
  lead: d => d.top ? `<div class="md">${md(d.top)}</div>` : "",
  section(k, s) {
    const body = s.fold
      ? `<details class="fold"><summary>${esc(s.foldLabel || "開いて見る")}</summary><div class="md">${md(s.md)}</div></details>`
      : `<div class="md">${md(s.md)}</div>`;
    return body + `<div class="ask"><label for="t-${k}">このセクションへのコメント・質問</label>
      <textarea id="t-${k}" placeholder="わからなかった所、もっと知りたい所など"></textarea>
      <div id="qa-${k}" style="display:grid;gap:8px"></div></div>`;
  },
  tail: `<section class="card"><h2>全体へのひとこと(任意)</h2><textarea id="general" placeholder="例:もっと計算例がほしい/次は○○を先にやってほしい"></textarea></section>`,
  collect(keys, extra, doc) {
    const sections = {};
    for (const [k, v] of Object.entries(extra)) sections[k] = v;
    for (const k of keys) { const t = $("t-" + k); sections[k] = { ...(extra[k] || {}), text: t ? t.value : "" }; }
    return { key: doc.key, date: doc.date, sections, general: $("general").value };
  },
  apply(keys, d) {
    const extra = {};
    for (const [k, v] of Object.entries(d?.sections || {})) extra[k] = v;  // 過去の「その場の質問」(asks)も残す
    for (const k of keys) {
      const t = $("t-" + k); if (t) t.value = d?.sections?.[k]?.text || "";
      const q = $("qa-" + k);
      if (q) q.innerHTML = (d?.sections?.[k]?.asks || []).map(x => `<div class="qa"><div class="q">Q. ${esc(x.q)}</div><div class="a md">${md(x.a)}</div></div>`).join("");
    }
    $("general").value = d?.general || "";
    return extra;
  },
  statusLoaded: d => d ? "書いたコメントを表示中" : "コメントはまだありません",
};
const VIEWS = { brief: briefView, kabu: kabuView };

// ---------- state & rendering ----------
let viewName = VIEWS[LS.get("view")] ? LS.get("view") : "brief", V = VIEWS[viewName];
let items = [], idx = -1, doc = null, keys = [], extra = {}, lastChecked = {};
let fbSha = null, timer = null, pending = null, writing = Promise.resolve(), loadSeq = 0;

function setStatus(t, cls) { const e = $("status"); e.textContent = t; e.className = cls || ""; }
function label(d) { if (!d) return ""; const r = Number(d.round) || 1; return d.date + (r > 1 ? `(${r}本目)` : ""); }
function setTabs() {
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.view === viewName));
  $("help").textContent = V.help; $("title").textContent = V.title; $("foot").hidden = viewName !== "kabu";
}
function render() {
  const body = $("body");
  $("prev").disabled = idx <= 0; $("next").disabled = idx < 0 || idx >= items.length - 1;
  if (!doc) {
    $("which").textContent = items.length ? "" : "まだありません";
    body.innerHTML = `<div class="empty">まだ${V.empty}が届いていません。毎朝5時ごろ、ここに今日の分が届きます。</div>`;
    $("tail").hidden = true; return;
  }
  $("which").textContent = label(doc);
  const S = doc.sections || {};
  keys = (Array.isArray(doc.order) && doc.order.length ? doc.order : Object.keys(S)).filter(k => S[k] && /^[\w-]+$/.test(k));
  let h = "";
  const lead = V.lead(doc); if (lead) h += `<div class="lead">${lead}</div>`;
  for (const k of keys) h += `<article id="${k}"><h2>${esc(S[k].title || k)}</h2>${V.section(k, S[k])}</article>`;
  body.innerHTML = h; $("tail").innerHTML = V.tail; $("tail").hidden = false;
  enhancePhotos(body); enhanceMaps(body);
}
function applyFb(d) {
  extra = V.apply(keys, d);
  lastChecked = {}; for (const i of form.querySelectorAll("input[type=radio]:checked")) lastChecked[i.name] = i.id;
}

// ---------- saving feedback ----------
const pendKey = (dir, id) => `pending.${dir}.${id}`;
function save() {
  if (!doc) return;
  const { fb, msg } = V, id = doc.key;
  const data = { ...V.collect(keys, extra, doc), updatedAt: new Date().toISOString() };
  LS.set(pendKey(fb, id), data);           // 圏外でも消えないよう先に端末に置く
  clearTimeout(timer); setStatus("保存中…");
  pending = () => write(fb, msg, id, data); timer = setTimeout(flush, 600);
}
function flush() { clearTimeout(timer); if (!pending) return writing; const j = pending; pending = null; writing = writing.then(j); return writing; }
const isCur = (fb, id) => V.fb === fb && doc && doc.key === id;
async function write(fb, msg, id, data, retried) {
  try {
    const sha = await putFb(fb, id, data, isCur(fb, id) ? fbSha : (await getFb(fb, id)).sha, msg);
    if (isCur(fb, id)) fbSha = sha;
    const p = LS.get(pendKey(fb, id)); if (p && p.updatedAt === data.updatedAt) LS.del(pendKey(fb, id));
    if (!pending) setStatus("保存しました", "ok");
  } catch (e) {
    if (!retried && (e.status === 409 || e.status === 422)) {  // 別の端末が先に保存していた
      const s = await getFb(fb, id).catch(() => null);
      if (s && isCur(fb, id)) fbSha = s.sha;
      return write(fb, msg, id, data, true);
    }
    if (e.status === 401 || e.status === 403) setStatus("保存できません。設定のトークンを確認してください", "warn");
    else setStatus("圏外のため端末に保存しました。つながったら送ります", "warn");
  }
}
async function flushPendingAll() {
  for (const k of LS.keys("pending.")) {
    const [, fb, ...rest] = k.split("."), id = rest.join("."), data = LS.get(k);
    if (!data || !["scores", "notes"].includes(fb)) continue;
    const msg = fb === "scores" ? "採点" : "コメント";
    try { const s = await getFb(fb, id); const sha = await putFb(fb, id, data, s.sha, msg); if (isCur(fb, id)) fbSha = sha; LS.del(k); } catch (e) { return; }
  }
}

// ---------- navigation ----------
async function show(i) {
  await flush();
  const seq = ++loadSeq, it = items[i]; idx = i; doc = null; fbSha = null;
  if (!it) { render(); return; }
  setStatus("読み込み中…");
  try { doc = await getDoc(V.dir, it); } catch (e) { if (seq === loadSeq) { setStatus("読み込めませんでした", "warn"); render(); } return; }
  if (seq !== loadSeq) return;
  doc.key = doc.key || it.id;
  render(); applyFb(null);
  try { history.replaceState(null, "", "#" + it.id); } catch (e) {}
  const local = LS.get(pendKey(V.fb, it.id));
  try {
    const s = await getFb(V.fb, it.id); if (seq !== loadSeq) return;
    fbSha = s.sha;
    const d = local && (!s.data || (local.updatedAt || "") > (s.data.updatedAt || "")) ? local : s.data;
    applyFb(d);
    if (local && d === local) save(); else setStatus(V.statusLoaded(s.data));
  } catch (e) {
    if (seq !== loadSeq) return;
    applyFb(local || null);
    setStatus(local ? "端末に保存した内容を表示中(未送信)" : "読み込めませんでした(圏外?)", "warn");
  }
}
async function loadList(keepCurrent) {
  const btn = $("reload"); btn.classList.add("spin");
  try {
    const cur = items[idx]?.id, wasLast = idx >= 0 && idx === items.length - 1;
    try { items = await listDocs(V.dir); }
    catch (e) {
      if (e.status === 401 || e.status === 403) { openSettings("トークンが使えませんでした。もう一度作って貼り付けてください。"); setStatus("トークンを確認してください", "warn"); return; }
      items = LS.get("list." + V.dir, []); setStatus("圏外のため、保存済みの記事を表示中", "warn");
    }
    let i;
    if (keepCurrent && cur) i = items.findIndex(x => x.id === cur);
    else { const want = decodeURIComponent((location.hash || "").slice(1)); i = items.findIndex(x => x.id === want); }
    if (i < 0 || (keepCurrent && wasLast)) i = items.length - 1;
    await show(i);
    flushPendingAll();
  } finally { btn.classList.remove("spin"); }
}
async function switchView(name) {
  if (name === viewName || !VIEWS[name]) return;
  await flush();
  viewName = name; V = VIEWS[name]; LS.set("view", name);
  items = []; idx = -1; doc = null;
  try { history.replaceState(null, "", "#"); } catch (e) {}
  setTabs(); window.scrollTo(0, 0);
  if (token) loadList(false);
}

// ---------- settings ----------
function openSettings(msg) { $("settings").hidden = false; $("tokenMsg").textContent = msg || ""; $("token").value = ""; $("closeSettings").hidden = !token; }
$("gear").onclick = () => { $("settings").hidden ? openSettings() : ($("settings").hidden = true); };
$("closeSettings").onclick = () => { $("settings").hidden = true; };
$("saveToken").onclick = async () => {
  const t = $("token").value.trim();
  if (!t) { $("tokenMsg").textContent = "トークンを貼り付けてください。"; return; }
  const old = token; token = t; $("tokenMsg").textContent = "確認中…";
  try { await listDocs(V.dir); LS.set("token", t); $("settings").hidden = true; await loadList(false); }
  catch (e) { token = old; $("tokenMsg").textContent = e.status === 401 || e.status === 403 || e.status === 404 ? "このトークンでは asa-brief-data を読めませんでした。手順3と4を確認してください。" : "通信できませんでした。電波を確認してもう一度。"; }
};

// ---------- events ----------
form.addEventListener("click", e => {
  const lab = e.target.closest("label"); if (!lab) return;
  const inp = $(lab.htmlFor); if (!inp || inp.type !== "radio") return;
  if (lastChecked[inp.name] === inp.id) { e.preventDefault(); inp.checked = false; delete lastChecked[inp.name]; save(); }
});
form.addEventListener("change", e => { const i = e.target; if (i.type === "radio") { lastChecked[i.name] = i.id; save(); } });
form.addEventListener("input", e => { if (e.target.matches("textarea")) save(); });
for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => switchView(b.dataset.view);
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
setTabs();
if (!token) { openSettings(); setStatus("はじめにトークンを設定してください"); $("body").innerHTML = `<div class="empty">設定が終わると、今日の分がここに出ます。</div>`; $("which").textContent = ""; }
else { window._lastList = Date.now(); loadList(false); }
