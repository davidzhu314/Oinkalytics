// Oinkalytics hub, pen-builder copy (web_lab/, served on its own port). Pens are yours: add, rename, remove.
// Talks only to the API on the same origin (docs/API.md) plus /hub-api/* for demo clips.
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const SVG = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, ...kids) {
  const isSvg = ["svg", "g", "rect", "ellipse", "circle", "path", "text", "line", "animate", "polyline", "defs", "radialGradient", "linearGradient", "stop"].includes(tag);
  const node = isSvg ? document.createElementNS(SVG, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.setAttribute("class", v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
}

// ---------- API ----------
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}
function predict(blob, name, penId) {
  const fd = new FormData();
  fd.append("file", blob, name);
  if (penId) fd.append("pen_id", penId);
  return api("/predict", { method: "POST", body: fd });
}
const clipCache = new Map();
function clipBlob(url) {
  if (!clipCache.has(url)) clipCache.set(url, fetch(url).then((r) => r.blob()));
  return clipCache.get(url);
}
function play(src) {
  const a = new Audio(src);
  return new Promise((resolve) => {
    a.onended = resolve;
    a.onerror = resolve;
    a.play().catch(resolve);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x) => (x >= 0.995 ? ">99%" : `${Math.round(x * 100)}%`);

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 4500);
}

async function health() {
  const h = $("#health");
  try {
    const r = await api("/health");
    h.textContent = r.mode === "real" ? "● Live model" : "● Mock model";
    h.className = "health ok";
    const was = online.chicken;
    try { await api("/hub-api/chicken/health"); online.chicken = true; } catch { online.chicken = false; }
    if (online.chicken && !was) for (const p of pens.values()) syncPen(p); // chicken model (re)connected
    if (Object.values(layout).some((k) => k.includes("chicken"))) h.textContent += online.chicken ? " · 🐔 connected" : " · 🐔 not connected";
  } catch {
    h.textContent = "● API offline";
    h.className = "health bad";
  }
}

// ---------- Verdict rendering (shared by the showcase and "try your own") ----------
const VERDICT = {
  calm: { cls: "calm", label: "✓ Calm", color: "var(--calm)" },
  distressed: { cls: "alert", label: "! Distressed", color: "var(--alert)" },
  unsure: { cls: "unsure", label: "? Not sure", color: "var(--unsure)" },
};

function typewrite(node, text, token) {
  node.textContent = "";
  const cursor = el("span", { class: "cursor" });
  node.append(document.createTextNode(""), cursor);
  let i = 0;
  return new Promise((resolve) => {
    const step = () => {
      if (token.cancelled) return resolve();
      i = Math.min(text.length, i + 2);
      node.firstChild.textContent = text.slice(0, i);
      if (i < text.length) setTimeout(step, 14);
      else { cursor.remove(); resolve(); }
    };
    step();
  });
}

function renderResult(box, p, opts = {}) {
  if (box._token) box._token.cancelled = true;
  const token = (box._token = {});
  const v = VERDICT[p.status];
  const notPig = p.abstain_reason === "not_pig";
  box.replaceChildren();

  const reason = p.status === "unsure" ? (notPig ? "doesn't sound like a pig" : "could go either way") : null;
  box.append(el("div", { class: "verdict" },
    el("span", { class: `badge ${v.cls}`, text: v.label }),
    reason && el("span", { class: "sub small", text: reason }),
    opts.truth && el("span", { class: "sub small", text: `· recording label: ${opts.truth}` })));

  if (!notPig) {
    const conf = p.status === "unsure" ? p.valence.p_distressed : p.valence.confidence;
    box.append(
      el("div", { class: "sub small", text: p.status === "unsure" ? `Chance of distress: ${pct(conf)}` : `${pct(conf)} confident` }),
      el("div", { class: "meter" }, el("i", { style: `width:${Math.round(conf * 100)}%;background:${v.color}` })));
  }

  const explain = el("p", { class: "explain" });
  box.append(
    el("div", { class: "source", text: p.explanation.source === "llm" ? "Written by AI from the measured evidence" : "From the measured evidence" }),
    explain);
  typewrite(explain, p.explanation.text, token);

  if (!notPig) {
    const f = p.features;
    const chips = [
      ["Duration", `${f.duration_s} s`],
      f.f0_mean_hz != null && ["Pitch", `${Math.round(f.f0_mean_hz)} Hz`],
      ["Loudness", `${f.loudness_db} dB`],
      ["Spectral centroid", `${Math.round(f.spectral_centroid_hz).toLocaleString()} Hz`],
    ].filter(Boolean);
    box.append(el("div", { class: "chips" }, chips.map(([k, val]) => el("span", { class: "chip" }, `${k} `, el("b", { text: val })))));

    if (p.similar_calls.length) {
      box.append(el("div", { class: "similar" },
        el("h4", { text: "Most similar calls from other recordings" }),
        p.similar_calls.map((s) => el("div", { class: "sim" },
          el("span", { class: `dot ${s.status}` }),
          el("span", { text: `${s.status} · ${s.context} · ${pct(s.similarity)} similar` }),
          el("button", { class: "btn small", onclick: () => play(s.audio_url), text: "▶" })))));
    }
  }
}

// ---------- Barn ----------
// Pens hold pigs, chickens or both (layout from /hub-api/clips). Each call goes to every model that's
// online ("both listen"); the one that recognises its own animal judges it and counts it in the pen.
const SPECIES = {
  pig: { base: "", emoji: "🐷", noun: "pig", words: { calm: "Calm", distressed: "Distressed" }, risk: "distressed" },
  chicken: { base: "/hub-api/chicken", emoji: "🐔", noun: "chicken", words: { calm: "Healthy", distressed: "Sick" }, risk: "sick" },
};
// Each animal has a mood, set by its pen's mode: Calm = all calm, Stressed = all stressed,
// Mixed = about 40% stressed (at least one of each when there are two or more). The mood decides
// how the animal looks and which kind of held-out call it makes; the badge, border and speech bubbles
// show what the model heard, so a wrong verdict is visible.
const MIXED_SHARE = 0.4; // Mixed = 40% of animals stressed on average (at least one when there are 2+)
const WALK_IN_SHARE = 0.42; // newcomers aim a touch higher so every pen size averages >= 40% (edges clip)
// Every pen can hold pigs and hens. Server pen ids are "L1", "L2", … so this copy never shares pens
// with the main hub on the chicken server; people only ever see the names.
const KINDS = ["pig", "chicken"];
const STORE_KEY = "oinkalytics-lab-pens-v3";
// Unique per pen ever made, so a new pen can't inherit calls or alerts the servers still hold for an old id.
const newPenId = (n) => `L${n}-${Math.random().toString(36).slice(2, 6)}`;
const penNames = {}; // id -> name, kept for removed pens so old texts still read well
const penCreated = {}; // id -> ISO time the pen was made; older alerts for a reused id aren't this pen's
function loadPenList() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s?.pens?.length) return s;
  } catch { /* storage blocked or empty: start fresh */ }
  return { next: 2, pens: [{ id: newPenId(1), name: "Pen 1", mode: "mixed", animals: [], created: new Date().toISOString() }] };
}
let penList = loadPenList();
function savePens() {
  // A disaster is temporary: save the mode the pen had before it.
  const list = [...pens.values()].map((p) => ({ id: p.id, name: p.name, mode: p.disaster ? p.prevMode || "mixed" : p.mode === "mine" ? "mixed" : p.mode,
    animals: p.animals.map((a) => ({ kind: a.kind, mood: a.mood, voice: a.voice?.name })), created: penCreated[p.id] }));
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ next: penList.next, pens: list })); } catch { /* not saved */ }
}
const penLabel = (id) => pens.get(id)?.name || penNames[id] || `Pen ${id}`;

/** Tell every model server about a pen's name, so the iMessage bot's texts and "status" use it. */
function syncPen(pen) {
  const body = JSON.stringify({ name: pen.name });
  for (const sp of Object.keys(SPECIES)) {
    if (!online[sp]) continue;
    api(`${SPECIES[sp].base}/pens/${pen.id}/name`, { method: "POST", headers: { "Content-Type": "application/json" }, body })
      .catch(() => {});
  }
}
function unsyncPen(pen) {
  for (const sp of Object.keys(SPECIES)) {
    if (online[sp]) api(`${SPECIES[sp].base}/pens/${pen.id}/remove`, { method: "POST" }).catch(() => {});
  }
}
const W = 400, H = 230;
const pens = new Map();
let layout = { 1: ["pig"], 2: ["pig", "chicken"], 3: ["chicken"], 4: ["pig", "chicken"] };
let pools = { pig: { calm: [], distressed: [] }, chicken: { calm: [], distressed: [] } };
const online = { pig: true, chicken: false };

function predictAt(sp, blob, name, penId) {
  const fd = new FormData();
  fd.append("file", blob, name);
  if (penId) fd.append("pen_id", penId);
  return api(`${SPECIES[sp].base}/predict`, { method: "POST", body: fd });
}

function pigNode() {
  const flip = el("g", { class: "flip" },
    el("ellipse", { cx: 0, cy: 22, rx: 24, ry: 4, fill: "rgba(60,50,20,.18)" }),
    el("path", { d: "M-25,-4 q-9,-7 -7,1 q2,7 -7,4", fill: "none", stroke: "var(--pig-dark)", "stroke-width": 2.5, "stroke-linecap": "round" }),
    el("rect", { class: "leg leg-a", x: -19, y: 9, width: 6, height: 12, rx: 2 }),
    el("rect", { class: "leg leg-b", x: -9, y: 10, width: 6, height: 11, rx: 2 }),
    el("rect", { class: "leg leg-b", x: 6, y: 10, width: 6, height: 11, rx: 2 }),
    el("rect", { class: "leg leg-a", x: 15, y: 9, width: 6, height: 12, rx: 2 }),
    el("ellipse", { class: "body", cx: 0, cy: 0, rx: 26, ry: 17 }),
    el("circle", { class: "body", cx: 22, cy: -7, r: 12 }),
    el("path", { class: "dark", d: "M14,-17 l4,-10 l6,8 z" }),
    el("ellipse", { class: "dark", cx: 33, cy: -4, rx: 6, ry: 5 }),
    el("circle", { class: "ink", cx: 31.5, cy: -4, r: 1.2 }),
    el("circle", { class: "ink", cx: 34.5, cy: -4, r: 1.2 }),
    el("circle", { class: "ink", cx: 24, cy: -11, r: 1.7 }));
  const emote = el("text", { class: "emote", x: 0, y: -30, fill: "var(--alert)" });
  return { kind: "pig", g: el("g", { class: "pig" }, flip, emote), flip, emote, mouth: [33, -4], bubbleY: -46 };
}

function chickenNode() {
  const head = el("g", { class: "head" },
    el("circle", { class: "feather", cx: 12, cy: -12, r: 7 }),
    el("path", { class: "comb", d: "M7,-18 q0,-6 3,-3 q1,-6 3.5,-2 q2,-5 3.5,0.5 z" }),
    el("path", { class: "beak", d: "M18.5,-13.5 l6.5,2 l-6.5,2.2 z" }),
    el("path", { class: "comb", d: "M17.5,-9 q2,5 -1.5,4.5 q-1,-2 0,-4.5 z" }),
    el("circle", { class: "ink", cx: 14.5, cy: -13.5, r: 1.4 }));
  const flip = el("g", { class: "flip" },
    el("ellipse", { cx: 0, cy: 16, rx: 15, ry: 3, fill: "rgba(60,50,20,.18)" }),
    el("path", { class: "cleg leg-a", d: "M-4,8 L-5,16 M-5,16 l-3,1 M-5,16 l3,1" }),
    el("path", { class: "cleg leg-b", d: "M4,8 L5,16 M5,16 l-3,1 M5,16 l3,1" }),
    el("path", { class: "feather", d: "M-12,-1 q-9,-13 -2,-18 q3,8 9,10 z" }),
    el("ellipse", { class: "feather", cx: 0, cy: 0, rx: 15, ry: 11 }),
    el("path", { class: "wing", d: "M-8,-3 q5,11 14,2 q-6,-6 -14,-2 z" }),
    head);
  const emote = el("text", { class: "emote", x: 0, y: -28, fill: "var(--alert)" });
  return { kind: "chicken", g: el("g", { class: "chicken" }, flip, emote), flip, emote, head, mouth: [24, -11], bubbleY: -40 };
}

function fieldSvg() {
  const posts = [];
  for (let x = 12; x < W; x += 48) posts.push(el("rect", { x: x - 3, y: 22, width: 6, height: 24, rx: 2, fill: "var(--fence)" }));
  return el("svg", { class: "field", viewBox: `0 0 ${W} ${H}`, role: "img" },
    el("rect", { x: 0, y: 0, width: W, height: H, fill: "var(--grass)" }),
    el("ellipse", { cx: 120, cy: 150, rx: 150, ry: 60, fill: "var(--dirt)" }),
    el("ellipse", { cx: 310, cy: 175, rx: 48, ry: 18, fill: "var(--mud)", opacity: .55 }),
    el("rect", { x: 20, y: 200, width: 46, height: 14, rx: 4, fill: "#9c6b3c" }),
    el("rect", { x: 0, y: 27, width: W, height: 5, fill: "var(--fence)" }),
    el("rect", { x: 0, y: 38, width: W, height: 5, fill: "var(--fence)" }),
    posts);
}

// Every pen starts with two animals; "＋ Pig" / "＋ Hen" walk more in, up to MAX_ANIMALS.
const MAX_ANIMALS = 6;
function herd(kinds) {
  return kinds.length > 1 ? ["pig", "chicken"] : [kinds[0], kinds[0]];
}

/** Each animal has one voice: a held-out recording whose true label matches its mood. Clicking it
 *  always plays that recording; a new mood gets a new matching voice. */
function setMood(pen, a, mood, voiceName) {
  const changed = a.mood !== mood;
  a.mood = mood;
  if (changed || !a.voice) {
    const saved = voiceName && pools[a.kind]?.[mood]?.find((c) => c.name === voiceName);
    a.voice = saved ? { name: saved.name, url: saved.url, species: a.kind } : playable(a.kind) ? clipFor(pen, a.kind, mood) : null;
  }
  const what = mood === "distressed" ? (a.kind === "pig" ? "stressed" : "sick") : "calm";
  a.g.setAttribute("aria-label", `A ${what} ${a.kind === "pig" ? "pig" : "hen"} in ${pen.name}. Click to hear its call.`);
}

function addAnimal(pen, kind, walkIn, saved = null) {
  if (pen.animals.length >= MAX_ANIMALS) return toast(`${pen.name} is full (${MAX_ANIMALS} animals).`);
  const i = pen.animals.length;
  const n = kind === "pig" ? pigNode() : chickenNode();
  pen.layer.append(n.g);
  const x = 90 + (i % 3) * 110 + Math.random() * 20, y = 110 + (i % 2) * 50 + Math.random() * 10;
  // A new animal starts just outside the left edge of the field and walks in.
  const a = { ...n, x: walkIn ? -50 : x, y, tx: x, ty: y, rest: walkIn ? 0 : Math.random() * 2, dir: 1,
    bob: Math.random() * 6, peck: Math.random() * 10, entering: walkIn, mood: null, voice: null };
  const name = kind === "pig" ? "pig" : "hen";
  n.g.setAttribute("tabindex", "0");
  n.g.setAttribute("role", "button");
  setMood(pen, a, saved?.mood || moodFor(pen), saved?.voice);
  // React on press, not "click": a click is dropped if the node moves in the DOM between press and release.
  n.g.addEventListener("pointerdown", (e) => { if (e.button === 0) { e.preventDefault(); animalSpeaks(pen, a); } });
  n.g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); animalSpeaks(pen, a); } });
  pen.animals.push(a);
  updateHint(pen);
  updateCounts(pen);
  if (walkIn) { toast(`A new ${name} is walking into ${pen.name}.`); savePens(); }
}

/** "＋" shows how many of that animal are in the pen and stops at MAX_ANIMALS; "−" greys out at zero. */
function updateCounts(pen) {
  for (const b of pen.addBtns) {
    b.disabled = pen.animals.length >= MAX_ANIMALS;
    b.dataset.n = pen.animals.filter((x) => x.kind === b.dataset.kind).length; // count badge
  }
  for (const b of pen.removeBtns || []) b.disabled = !pen.animals.some((x) => x.kind === b.dataset.kind);
}

/** Walk one animal of this kind out of the pen. In Mixed, pick the mood that keeps the pen near its share. */
function removeAnimal(pen, kind) {
  const same = pen.animals.filter((a) => a.kind === kind);
  if (!same.length) return;
  let pool = same;
  if (pen.mode === "mixed") {
    const stressed = pen.animals.filter((a) => a.mood === "distressed").length;
    const over = stressed / pen.animals.length > MIXED_SHARE;
    const pick = same.filter((a) => (a.mood === "distressed") === over);
    if (pick.length) pool = pick;
  }
  const a = pool[Math.floor(Math.random() * pool.length)];
  pen.animals.splice(pen.animals.indexOf(a), 1);
  // It walks off the left edge, then disappears (drawn in its own layer so depth sorting ignores it).
  a.leaving = true; a.rest = 0; a.tx = -60; a.ty = a.y;
  pen.exitLayer.append(a.g);
  a.g.removeAttribute("tabindex"); a.g.style.pointerEvents = "none";
  pen.exiting.push(a);
  updateHint(pen);
  updateCounts(pen);
  savePens();
  toast(`A ${kind === "pig" ? "pig" : "hen"} is walking out of ${pen.name}.`);
}

/** Empty pens say how to start; once there are animals, how to hear one. */
function updateHint(pen) {
  if (!pen.hint) return;
  const empty = !pen.animals.length;
  pen.hint.textContent = empty ? "Empty pen · add a pig or hen below" : "Click an animal to hear it";
  pen.card.classList.toggle("empty", empty);
}

/** A newcomer's mood follows the pen's mode. */
function moodFor(pen) {
  if (pen.mode === "distressed") return "distressed";
  if (pen.mode === "mixed") {
    // Keep the pen near its share: the further below it the pen is, the likelier a stressed newcomer.
    const n = pen.animals.length, stressed = pen.animals.filter((a) => a.mood === "distressed").length;
    const want = (n + 1) * WALK_IN_SHARE - stressed;
    return Math.random() < Math.min(1, Math.max(0, want)) ? "distressed" : "calm";
  }
  return "calm";
}

/** Set every animal's mood from the pen's mode (Mine keeps whatever they had). */
function applyMode(pen) {
  if (pen.mode === "mine") return;
  if (pen.mode !== "mixed") {
    for (const a of pen.animals) setMood(pen, a, pen.mode);
    return;
  }
  const n = pen.animals.length;
  // floor(0.4n), plus one more with the leftover probability: exactly 40% on average for every n.
  const x = n * MIXED_SHARE, k0 = Math.floor(x) + (Math.random() < x - Math.floor(x) ? 1 : 0);
  const k = n >= 2 ? Math.max(1, k0) : k0;
  const order = [...pen.animals].sort(() => Math.random() - 0.5);
  order.forEach((a, i) => setMood(pen, a, i < k ? "distressed" : "calm"));
}

/** Click an animal: it makes a call of its own species and mood, out loud, and the pen's microphone hears it. */
async function animalSpeaks(pen, a) {
  pen.card.classList.add("heard"); // the "click an animal" hint has done its job
  pen.clicked = true;
  if (!playable(a.kind)) return toast(a.kind === "chicken" && !online.chicken ? "The chicken model isn't connected yet." : `No ${a.kind} calls to play.`);
  if (!a.voice) setMood(pen, a, a.mood); // its model just came online
  const clip = a.voice;
  play(clip.url);
  try {
    pen.heard = true;
    const [sp, p] = await judge(await clipBlob(clip.url), clip.name, pen.id);
    if (sp) pen.last[sp] = p;
    speak(pen, sp, p, a.kind, a);
  } catch (e) { toast(`Couldn't check that call: ${e.message}`); }
}

function buildPen(spec) {
  const id = spec.id;
  const kinds = KINDS;
  const svg = fieldSvg();
  const layer = el("g");
  svg.append(layer);
  const animals = [];
  // Compact round icon buttons with a hover/focus tooltip (data-tip); the label is also the aria-label.
  const icon = (glyph, tip, cls = "", tag = "button") => el(tag, { class: `ic ${cls}`, "data-tip": tip, "aria-label": tip, text: glyph });
  const addBtns = kinds.map((k) => {
    const b = icon(k === "pig" ? "＋ 🐷 Pig" : "＋ 🐔 Hen", `Walk a new ${k === "pig" ? "pig" : "hen"} into this pen`, `add ${k}`);
    b.dataset.kind = k;
    b.onclick = () => addAnimal(pen, k, true);
    return b;
  });
  const removeBtns = kinds.map((k) => {
    const b = icon("−", `Walk a ${k === "pig" ? "pig" : "hen"} out of this pen`, `remove ${k}`);
    b.dataset.kind = k;
    b.disabled = true;
    b.onclick = () => removeAnimal(pen, k);
    return b;
  });
  const steppers = kinds.map((k, i) => el("span", { class: "stepper" }, removeBtns[i], addBtns[i]));
  const dBtn = icon("⚠️", "Disaster in this pen", "danger-ic");
  dBtn.setAttribute("aria-haspopup", "true"); dBtn.setAttribute("aria-expanded", "false");
  const dMenu = el("div", { class: "pen-disaster-menu", role: "menu", hidden: true },
    Object.entries(DISASTERS).map(([k, v]) => el("button", { role: "menuitem", "data-d": k, text: v.label })),
    el("button", { role: "menuitem", class: "clear", "data-d": "clear", hidden: true, text: "✓ All clear" }));
  const dWrap = el("span", { class: "pen-disaster" }, dBtn, dMenu);
  const exitLayer = el("g");
  svg.append(exitLayer);

  const badge = el("span", { class: "badge idle", text: "○ Quiet" });
  const summary = el("div", { class: "pen-summary", text: "No calls yet." });
  const mineBtn = el("button", { "aria-pressed": "false", title: "Your own recordings", text: "Mine" });
  const modes = {
    mixed: el("button", { "aria-pressed": "true", title: "Some animals stressed, the rest calm", text: "Mixed" }),
    calm: el("button", { "aria-pressed": "false", title: "Every animal in the pen calm", text: "Calm" }),
    distressed: el("button", { "aria-pressed": "false", title: "Every animal in the pen stressed", text: "Stressed" }),
    mine: mineBtn,
  };
  // Only shown while the barn is running: it un-mutes this pen's automatic stream of calls.
  const listen = icon("🔊", "Hear this pen while the barn runs", "toggle");
  listen.setAttribute("aria-pressed", "false");
  const fileIn = el("input", { type: "file", accept: "audio/*,video/*,.m4a,.mp4,.mov,.caf", multiple: true, hidden: true });
  const clips = icon("📎", "Add your own recordings", "edge", "label");
  clips.append(fileIn);
  const title = el("input", { class: "pen-title", value: spec.name, "aria-label": "Pen name (click to rename)", maxlength: 40 });
  const remove = el("button", { class: "pen-remove", "aria-label": "Remove this pen", title: "Remove this pen", text: "✕" });
  const hint = el("span", { class: "field-hint" });
  const card = el("article", { class: "pen calm" },
    el("div", { class: "pen-head" }, el("div", { class: "pen-name" }, title),
      el("div", { class: "pen-head-right" }, badge, remove)),
    el("div", { class: "field-wrap" }, svg, hint),
    el("div", { class: "pen-foot" },
      summary,
      el("div", { class: "pen-tools" },
        el("div", { class: "seg", role: "group", "aria-label": "What this pen's microphone hears" }, Object.values(modes)),
        el("div", { class: "tools" }, steppers, clips, listen, dWrap))));

  const pen = { id, name: spec.name, kinds, card, svg, layer, exitLayer, dBtn, dMenu, exiting: [], animals, addBtns, removeBtns, hint, badge, summary, modes, mineBtn,
    mode: spec.mode || "mixed", mine: [], mineIdx: 0, listen: false, level: "idle", levels: {}, last: {}, order: {} };
  penNames[id] = pen.name;
  penCreated[id] = spec.created || new Date().toISOString();
  const saved = (spec.animals ?? []).map((x) => (typeof x === "string" ? { kind: x } : x));
  for (const x of saved) addAnimal(pen, x.kind, false, x);
  updateHint(pen);
  for (const [m, b] of Object.entries(modes)) b.setAttribute("aria-pressed", m === pen.mode);
  if (saved.some((x) => !x.mood)) applyMode(pen); // older saves had no moods
  const rename = () => {
    const v = title.value.trim() || pen.name;
    title.value = v;
    if (v !== pen.name) { pen.name = penNames[id] = v; savePens(); syncPen(pen); toast(`Renamed to ${v}.`); }
  };
  title.addEventListener("change", rename);
  title.addEventListener("keydown", (e) => { if (e.key === "Enter") title.blur(); if (e.key === "Escape") { title.value = pen.name; title.blur(); } });
  remove.onclick = () => removePen(pen);
  dBtn.onclick = (e) => {
    e.stopPropagation();
    closeDisasterMenus(dMenu);
    dMenu.hidden = !dMenu.hidden;
    dBtn.setAttribute("aria-expanded", String(!dMenu.hidden));
  };
  for (const b of dMenu.querySelectorAll("button")) b.onclick = (e) => {
    e.stopPropagation();
    dMenu.hidden = true; dBtn.setAttribute("aria-expanded", "false");
    if (b.dataset.d === "clear") stopFx(pen); else startFx(pen, b.dataset.d);
  };
  for (const [m, b] of Object.entries(modes)) b.onclick = () => setMode(pen, m);
  listen.onclick = () => { pen.listen = !pen.listen; listen.setAttribute("aria-pressed", pen.listen); };
  const addFiles = (files) => {
    for (const f of files) pen.mine.push({ file: f, name: f.name, url: URL.createObjectURL(f) });
    mineBtn.textContent = `Mine (${pen.mine.length})`;
    if (pen.mine.length) setMode(pen, "mine");
    toast(`${pen.name} will now hear your ${pen.mine.length} clip${pen.mine.length === 1 ? "" : "s"}.`);
  };
  fileIn.onchange = () => { addFiles(fileIn.files); fileIn.value = ""; };
  card.addEventListener("dragover", (e) => { e.preventDefault(); card.classList.add("dragover"); });
  card.addEventListener("dragleave", () => card.classList.remove("dragover"));
  card.addEventListener("drop", (e) => { e.preventDefault(); card.classList.remove("dragover"); addFiles(e.dataTransfer.files); });
  pens.set(id, pen);
  return card;
}

function addPen() {
  const n = penList.next++;
  const spec = { id: newPenId(n), name: `Pen ${n}`, mode: "mixed", animals: [], created: new Date().toISOString() };
  $("#pens").insertBefore(buildPen(spec), $("#addPenCard"));
  syncPen(pens.get(spec.id));
  savePens();
  toast(`${spec.name} added. Click its name to rename it.`);
  pens.get(spec.id).card.querySelector(".pen-title").focus();
}

function removePen(pen) {
  if (pens.size === 1) return toast("Keep at least one pen.");
  if (!confirm(`Remove ${pen.name}? Its animals and recent calls go with it.`)) return;
  if (pen.fx) stopFx(pen, true);
  unsyncPen(pen); // the servers stop tracking it, so it can't keep alerting
  pens.delete(pen.id);
  pen.card.remove();
  savePens();
  toast(`${pen.name} removed.`);
}

function setMode(pen, mode) {
  if (mode === "mine" && !pen.mine.length) return toast('Add a clip first: "＋ Add my clips", or drag a file onto the pen.');
  const changed = pen.mode !== mode;
  pen.mode = mode;
  for (const [m, b] of Object.entries(pen.modes)) b.setAttribute("aria-pressed", m === mode);
  applyMode(pen);
  if (changed) { resetPen(pen); savePens(); }
}

/** A new scenario starts the pen fresh: both models forget its recent calls, so an old warning clears. */
async function resetPen(pen) {
  pen.last = {};
  if (!pen.heard) return pollPens(); // the servers have nothing to forget for a pen that never made a call
  await Promise.all(pen.kinds.filter((sp) => online[sp]).map((sp) =>
    api(`${SPECIES[sp].base}/pens/${pen.id}/reset`, { method: "POST" }).catch(() => {})));
  pollPens();
}

const playable = (sp) => online[sp] && pools[sp].calm.length && pools[sp].distressed.length;

/** The barn's next call: a random animal in the pen speaks, in its own mood. */
function nextClip(pen) {
  if (pen.mode === "mine" && pen.mine.length) return pen.mine[pen.mineIdx++ % pen.mine.length];
  const speakers = pen.animals.filter((a) => playable(a.kind));
  if (!speakers.length) return null;
  const a = speakers[Math.floor(Math.random() * speakers.length)];
  return { ...clipFor(pen, a.kind, a.mood), animal: a };
}

/** A held-out call of species `sp` whose true label is `truth` (calm | distressed). */
function clipFor(pen, sp, truth) {
  const key = `${sp}:${truth}`;
  if (!pen.order[key]?.length) pen.order[key] = [...pools[sp][truth]].sort(() => Math.random() - 0.5);
  const c = pen.order[key].pop();
  return { name: c.name, url: c.url, species: sp };
}

/** Both models listen: the call goes to each once, with the pen. Each server's pen window skips calls
 *  it answers "not my animal" (and "not sure"), so a call only counts for the model that claims it, and
 *  with a pen the servers use template explanations (no LLM call per barn call).
 *  Returns [species, its prediction], or [null, null] if no single model claims it. */
async function judge(blob, name, penId) {
  const listeners = Object.keys(SPECIES).filter((sp) => online[sp]);
  const heard = await Promise.all(listeners.map((sp) => predictAt(sp, blob, name, penId).catch(() => null)));
  const claimed = listeners.filter((sp, i) => heard[i] && heard[i].abstain_reason !== "not_pig");
  const sure = claimed.filter((sp) => heard[listeners.indexOf(sp)].status !== "unsure");
  const winner = claimed.length === 1 ? claimed[0] : sure.length === 1 ? sure[0] : null;
  return winner ? [winner, heard[listeners.indexOf(winner)]] : [null, null];
}

async function feedPen(pen, aloud) {
  const clip = nextClip(pen);
  if (!clip) {
    if (aloud) toast(pen.kinds.includes("chicken") && !online.chicken ? "The chicken model isn't connected yet." : "No clips to play.");
    return;
  }
  const blob = clip.file || (await clipBlob(clip.url));
  if (aloud) play(clip.url);
  pen.heard = true;
  const [sp, p] = await judge(blob, clip.name, pen.id);
  if (sp) pen.last[sp] = p;
  speak(pen, sp, p, clip.species, clip.animal);
}

function speak(pen, sp, p, heardAs, speaker) {
  const kind = sp || heardAs;
  const pool = pen.animals.filter((a) => a.kind === kind);
  const who = speaker || (pool.length ? pool : pen.animals)[Math.floor(Math.random() * (pool.length || pen.animals.length))];
  if (!who) return;
  let label, color = "var(--unsure)";
  if (!sp) label = "Which animal?";
  else if (p.status === "calm") { label = `${SPECIES[sp].words.calm} · ${pct(p.valence.confidence)}`; color = "var(--calm)"; }
  else if (p.status === "distressed") { label = `${SPECIES[sp].words.distressed} · ${pct(p.valence.confidence)}`; color = "var(--alert)"; }
  else label = p.abstain_reason === "not_pig" ? `Not a ${SPECIES[sp].noun}?` : "Not sure";
  const w = label.length * 7 + 18;
  const bubble = el("g", { class: "bubble", transform: `translate(0,${who.bubbleY})` },
    el("rect", { x: -w / 2, y: -12, width: w, height: 24, rx: 12 }),
    el("text", { x: 0, y: 1, fill: color, text: label }));
  const [mx, my] = who.mouth;
  const ripple = el("circle", { class: `ripple ${who.kind}`, cx: mx * who.dir, cy: my, r: 6 },
    el("animate", { attributeName: "r", from: 6, to: 30, dur: "0.9s", fill: "freeze" }),
    el("animate", { attributeName: "opacity", from: 0.7, to: 0, dur: "0.9s", fill: "freeze" }));
  who.g.append(ripple, bubble);
  ripple.querySelectorAll("animate").forEach((a) => a.beginElement?.());
  setTimeout(() => ripple.remove(), 1000);
  setTimeout(() => bubble.remove(), 2600);
}

// Respect "reduce motion": animals stay put (new ones still walk in).
const REDUCED_MOTION = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
let lastFrame = performance.now();
function animate(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  for (const pen of pens.values()) {
    if (pen.fx) updateFx(pen, dt);
    for (const a of pen.animals) {
      const s = a.mood === "distressed";
      const hen = a.kind === "chicken";
      const panic = !!pen.fx && !a.entering;
      const speed = (hen ? 18 : 14) * (a.entering ? 3.5 : panic ? 4.2 : 1) * (REDUCED_MOTION && !a.entering ? 0 : 1);
      if (panic) {
        // panicking animals never rest: they keep running away from the danger
        a.rest = 0;
        a.panicT = (a.panicT ?? 0) - dt;
        if (a.panicT <= 0 || Math.hypot(a.tx - a.x, a.ty - a.y) < 4) { [a.tx, a.ty] = panicTarget(pen, a); a.panicT = rnd(0.5, 1.1); }
      }
      const dx = a.tx - a.x, dy = a.ty - a.y, d = Math.hypot(dx, dy);
      if (a.entering && d < 2) a.entering = false;
      if (a.rest > 0) a.rest -= dt;
      else if (d < 2) {
        a.tx = 45 + Math.random() * (W - 90);
        a.ty = 85 + Math.random() * (H - 115);
        a.rest = hen ? 1.5 + Math.random() * 3 : 2 + Math.random() * 4;
      } else {
        const step = Math.min(d, speed * dt);
        a.x += (dx / d) * step;
        a.y += (dy / d) * step;
        if (Math.abs(dx) > 1) a.dir = dx < 0 ? -1 : 1;
      }
      const walking = a.rest <= 0 && d >= 2;
      a.bob += dt * (hen ? 10 : 7);
      // pigs bob; chickens hop
      const bob = walking ? (hen ? -Math.abs(Math.sin(a.bob)) * 3 : Math.sin(a.bob) * 1.4) : 0;
      const shake = panic ? Math.sin(now / 30 + a.x) * 1.3 : 0;
      a.g.setAttribute("transform", `translate(${(a.x + shake).toFixed(1)},${(a.y + bob).toFixed(1)})`);
      a.flip.setAttribute("transform", `scale(${a.dir},1)`);
      if (hen) {
        // calm hens peck at the ground while resting
        a.peck += dt * 6;
        const pecking = !walking && !s && Math.sin(a.peck * 0.35) > 0.3;
        a.head.setAttribute("transform", pecking ? `rotate(${(28 + Math.sin(a.peck * 4) * 10).toFixed(1)},8,-6)` : "");
      }
      a.g.classList.toggle("walking", walking);
      a.g.classList.toggle("stressed", s);
      a.emote.textContent = s ? "!" : ""; // steady, not blinking
    }
  }
  // animals walking out: head for the left edge, then disappear
  for (const pen of pens.values()) {
    for (const a of [...pen.exiting]) {
      a.x -= 130 * dt;
      a.dir = -1;
      a.bob += dt * 10;
      a.g.setAttribute("transform", `translate(${a.x.toFixed(1)},${(a.y + Math.sin(a.bob) * 1.4).toFixed(1)})`);
      a.flip.setAttribute("transform", "scale(-1,1)");
      a.g.classList.add("walking");
      if (a.x < -50) { a.g.remove(); pen.exiting.splice(pen.exiting.indexOf(a), 1); }
    }
  }
  // keep animals drawn in depth order
  // Only touch the DOM when the front-to-back order actually changes (re-appending nodes every frame
  // drops clicks and flickers the hover highlight).
  for (const pen of pens.values()) {
    const order = [...pen.animals].sort((a, b) => a.y - b.y);
    if (order.every((a, i) => pen.layer.children[i] === a.g)) continue;
    const focused = document.activeElement;
    order.forEach((a) => pen.layer.append(a.g));
    if (focused && pen.layer.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }
  requestAnimationFrame(animate);
}

// Alert = 3 of the last 5 calls sound bad (a warning); critical = 4 or 5 of 5. Matches the bot (bot/src/guard.ts severity).
const CRITICAL_AT = 4;
const LEVEL = { calm: "✓ Calm", watch: "◐ Watch", alert: "⚠ Warning", critical: "🚨 Critical", idle: "○ Quiet", waiting: "○ Waiting" };
const RANK = { idle: 0, calm: 1, watch: 2, alert: 3, critical: 4 };
// Same rule as the bot (bot/src/commands.ts emergencyPens): a pen whose last 5 calls are all distress
// calls, or 2+ pens critical at once. The bot sends a 🚨 text + spoken voice note; we show it here too.
let emergencyNow = new Set();
const emergencyIncidents = {}; // species -> true while an incident is ongoing
function checkEmergencies(states) {
  const now = new Set();
  for (const sp of Object.keys(SPECIES)) {
    const mine = Object.values(states[sp] || {}).filter((s) => pens.has(s.pen_id));
    const full = mine.filter((s) => s.window >= 5 && s.distressed === s.window);
    const critical = mine.filter((s) => s.distressed >= CRITICAL_AT);
    const em = critical.length >= 2 ? critical : full;
    em.forEach((s) => now.add(s.pen_id));
    if (em.length && !emergencyIncidents[sp]) {
      emergencyIncidents[sp] = true;
      const names = em.map((s) => penLabel(s.pen_id)).join(", ");
      const msg = `🚨 EMERGENCY · ${SPECIES[sp].emoji} ${em.length > 1 ? `${em.length} pens at once: ${names}` : `${names}: every recent call is a distress call`}. ` +
        "Check the pen now. Reply \"OK\" when you're on it.";
      const li = el("li", { class: "sms emergency" }, el("time", { text: new Date().toLocaleTimeString() }), msg,
        el("div", { class: "why", text: "🔊 Also sent as a spoken voice note, repeated every minute until the farmer replies OK." }));
      $(".empty", $("#alertList"))?.remove();
      $("#alertList").prepend(li);
      toast(`🚨 Emergency voice message sent to the farmer: ${names}`);
    } else if (!em.length) delete emergencyIncidents[sp];
  }
  emergencyNow = now;
}

async function pollPens() {
  const states = {};
  for (const sp of Object.keys(SPECIES)) {
    if (!online[sp]) continue;
    try { states[sp] = Object.fromEntries((await api(`${SPECIES[sp].base}/pens`)).map((s) => [s.pen_id, s])); }
    catch { /* down: shown as waiting */ }
  }
  checkEmergencies(states);
  for (const pen of pens.values()) {
    const parts = [];
    let level = "idle";
    for (const sp of pen.kinds) {
      const s = states[sp]?.[pen.id];
      if (!s) {
        pen.levels[sp] = "idle";
        // No state just means this pen hasn't made a call yet; only say "waiting" if the model is really offline.
        if (!online[sp]) parts.push(el("span", {}, `${SPECIES[sp].emoji} waiting for the ${sp} model`));
        continue;
      }
      pen.levels[sp] = !s.window ? "idle" : s.level === "alert" && s.distressed >= CRITICAL_AT ? "critical" : s.level;
      if (RANK[pen.levels[sp]] > RANK[level]) level = pen.levels[sp];
      if (s.window) parts.push(el("span", {}, `${SPECIES[sp].emoji} `, el("b", { text: `${s.distressed} of the last ${s.window}` }),
        ` calls sounded ${sp === "pig" ? "stressed" : "sick"}`));
    }
    if (level === "idle" && !pen.kinds.some((sp) => states[sp])) level = "waiting";
    pen.level = level;
    pen.badge.className = `badge ${level === "waiting" ? "idle" : level === "critical" ? "alert critical" : level}`;
    pen.badge.textContent = LEVEL[level];
    pen.card.className = `pen ${level === "waiting" ? "idle" : level === "critical" ? "alert critical" : level}`;
    pen.card.classList.toggle("empty", !pen.animals.length); // keep the pen's own flags across refreshes
    pen.card.classList.toggle("heard", !!pen.clicked);
    pen.card.classList.toggle("disaster", !!pen.disaster);
    pen.card.classList.toggle("emergency", emergencyNow.has(pen.id));
    const shown = parts.length ? parts.flatMap((p, i) => (i ? [el("br"), p] : [p])) : ["No calls yet."];
    pen.summary.replaceChildren(...shown);
  }
}

// ---------- Barn simulator ----------
let running = false;
async function barnLoop() {
  let i = 0;
  while (running) {
    // Pens hearing stressed calls or your clips get two turns per round; the others get one.
    const order = [...pens.values()].flatMap((p) => (p.disaster ? [p, p, p] : p.mode === "distressed" || p.mode === "mine" ? [p, p] : [p]));
    if (!order.length) { await sleep(500); continue; }
    const pen = order[i++ % order.length];
    const t0 = performance.now();
    try { await feedPen(pen, pen.listen); } catch (e) { toast(`Couldn't check a call: ${e.message}`); }
    const wait = Number($("#speed").value) * 1000 - (performance.now() - t0);
    await sleep(Math.max(50, wait));
  }
}
function setRunning(on) {
  running = on;
  document.body.classList.toggle("barn-running", on); // shows each pen's 🔊 Listen toggle
  $("#barnToggle").textContent = on ? "■ Stop the barn" : "▶ Start the barn";
  if (on) barnLoop();
}

// ---------- Alerts (what the Photon bot texts) ----------
const alerts = new Map();
let alertsLoaded = false;
async function pollAlerts() {
  const list = [];
  for (const sp of Object.keys(SPECIES)) {
    if (!online[sp]) continue;
    // The chicken server is shared with the main hub: only this copy's pens ("L…") belong here.
    try { for (const a of await api(`${SPECIES[sp].base}/alerts`)) if (penCreated[a.pen_id] && a.created_at >= penCreated[a.pen_id]) list.push({ sp, a }); }
    catch { if (sp === "pig") return; }
  }
  const ol = $("#alertList");
  if (!list.length && alerts.size) { alerts.clear(); ol.replaceChildren(el("li", { class: "empty", text: "No alerts yet. All quiet." })); }
  list.sort((x, y) => (x.a.created_at < y.a.created_at ? -1 : 1));
  for (const { sp, a } of list) {
    const key = `${sp}:${a.alert_id}`;
    if (alerts.has(key)) { alerts.get(key).data = a; continue; }
    // The same single message the Photon bot texts (bot/src/commands.ts alertText): the reason is folded in.
    // The same single message the Photon bot texts (bot/src/commands.ts alertText). It counts calls, not animals.
    const noun = sp === "pig" ? "pig" : "hen", bad = sp === "pig" ? "stressed" : "sick";
    const reason = a.explanation.text.trim().split(/(?<=[.!?])\s+/).slice(1).join(" ");
    const critical = a.distressed >= CRITICAL_AT;
    const count = a.distressed === a.window ? `The last ${a.window} calls from the pen all sounded ${bad}`
      : `${a.distressed} of the last ${a.window} calls from the pen sounded ${bad}`;
    const message = `${critical ? "🚨 Critical" : "⚠️ Warning"} · ${SPECIES[sp].emoji} ${penLabel(a.pen_id)} sounds ${bad} ` +
      `(${a.confidence >= 0.995 ? ">99%" : `${Math.round(a.confidence * 100)}%`} sure). ${count}, could be one ${noun} or several.` + (critical ? " Please check the pen now." : "");
    const li = el("li", { class: "sms" },
      el("time", { text: new Date(a.created_at).toLocaleTimeString() }),
      message,
      reason && el("div", { class: "why", text: reason }),
      el("div", { class: "pen-actions" },
        el("button", { class: "btn small", text: "▶ Play it", onclick: () => play(`${SPECIES[sp].base}${a.audio_url}`) })));
    alerts.set(key, { data: a, li });
    $(".empty", ol)?.remove();
    ol.prepend(li);
    if (alertsLoaded) toast(`📱 Texted the farmer: ${message}`);
  }
  alertsLoaded = true;
}

// ---------- Hear it think ----------
const CASE_ICON = { calm: ["🐷", "#e3f2e4"], distressed: ["🐷", "#fbe2df"], notpig: ["👏", "#ecebe5"] };
const cases = [];
function buildCase(s) {
  const [icon, bg] = CASE_ICON[s.key] || ["🔊", "#eee"];
  const wave = el("div", { class: "wave" }, Array.from({ length: 18 }, () => el("i")));
  const result = el("div", { class: "result" });
  const btn = el("button", { class: "btn primary play-big", text: "▶ Play out loud" });
  const card = el("article", { class: "case" },
    el("div", { class: "case-top" },
      el("div", { class: "case-icon", style: `background:${bg}`, text: icon }),
      el("div", {}, el("h3", { text: s.title }), el("div", { class: "note", text: s.note }))),
    btn, wave, result);
  const run = async () => {
    btn.disabled = true;
    result.replaceChildren(el("div", { class: "thinking", text: "Playing the sound…" }));
    wave.classList.add("on");
    const blob = await clipBlob(s.url);
    const pending = predict(blob, s.file, null);
    await Promise.all([play(s.url), sleep(1200)]);
    wave.classList.remove("on");
    result.replaceChildren(el("div", { class: "thinking", text: "Measuring the call and writing an explanation…" }));
    try { renderResult(result, await pending, { truth: s.truth }); }
    catch (e) { result.replaceChildren(el("p", { class: "sub", text: `Couldn't check this one: ${e.message}` })); }
    btn.disabled = false;
  };
  btn.onclick = run;
  cases.push(run);
  return card;
}

// ---------- Try your own ----------
async function checkOwn(blob, name) {
  const box = $("#tryResult");
  box.replaceChildren(el("div", { class: "thinking", text: `Checking ${name}…` }));
  play(URL.createObjectURL(blob));
  try { renderResult(box, await predict(blob, name, null)); }
  catch (e) { box.replaceChildren(el("p", { class: "sub", text: `Couldn't read that file: ${e.message}` })); }
}

let recorder = null;
async function toggleRecord() {
  const btn = $("#tryRec");
  if (recorder) { recorder.stop(); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return toast("Microphone access was blocked."); }
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => chunks.push(e.data);
  const t0 = Date.now();
  const tick = setInterval(() => { btn.textContent = `■ Stop (${Math.round((Date.now() - t0) / 1000)} s)`; }, 250);
  recorder.onstop = () => {
    clearInterval(tick);
    stream.getTracks().forEach((t) => t.stop());
    const type = recorder.mimeType || "audio/webm";
    const blob = new Blob(chunks, { type });
    recorder = null;
    btn.textContent = "● Record";
    btn.classList.remove("rec");
    checkOwn(blob, type.includes("mp4") ? "recording.m4a" : "recording.webm");
  };
  recorder.start();
  btn.classList.add("rec");
}

// ---------- Disasters (demo, one pen at a time) ----------
// A disaster only decides which held-out recordings the animals make (real distress calls, more often);
// the models still judge every call for real, and the alerts and emergency follow from what they hear.
const DISASTERS = {
  wolf: { label: "🐺 Wolf attack", banner: "🐺 A wolf got into the pen!" },
  comet: { label: "☄️ Comet strike", banner: "☄️ A comet hit the pen!" },
  fire: { label: "🔥 Fire", banner: "🔥 Fire in the pen!" },
  storm: { label: "⛈️ Storm", banner: "⛈️ Storm over the pen!" },
};
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const GROUND = { x0: 30, x1: W - 30, y0: 85, y1: H - 25 };

function wolfNode() {
  const leg = (x, cls) => el("rect", { class: `leg ${cls}`, x, y: 8, width: 6, height: 16, rx: 2, fill: "#4b5058" });
  const jaw = el("path", { class: "jaw", d: "M34,-6 l15,1 l-13,6 z", fill: "#5c616a" });
  const flip = el("g", { class: "flip" },
    el("ellipse", { cx: 0, cy: 25, rx: 32, ry: 4.5, fill: "rgba(25,25,25,.22)" }),
    el("path", { d: "M-28,-8 q-22,-8 -30,6 q12,-3 26,4 z", fill: "#5c616a" }),
    leg(-22, "leg-a"), leg(-11, "leg-b"), leg(9, "leg-b"), leg(19, "leg-a"),
    el("ellipse", { cx: 0, cy: 0, rx: 31, ry: 14, fill: "#80868f" }),
    el("path", { d: "M-26,-6 q22,-16 50,-4 q-24,3 -50,4 z", fill: "#5c616a" }),
    el("ellipse", { cx: 6, cy: 6, rx: 20, ry: 6, fill: "#a7acb3" }),
    jaw,
    el("circle", { cx: 27, cy: -11, r: 11.5, fill: "#80868f" }),
    el("path", { d: "M33,-17 l17,6 l-16,5 z", fill: "#80868f" }),
    el("path", { class: "teeth", d: "M37,-6 l2,3 l2,-3 l2,3 l2,-3", fill: "none", stroke: "#fff", "stroke-width": 1.2 }),
    el("circle", { cx: 49, cy: -11, r: 2.2, fill: "#1b1b1b" }),
    el("path", { d: "M19,-19 l3,-13 l8,10 z", fill: "#5c616a" }),
    el("path", { d: "M26,-21 l5,-12 l6,11 z", fill: "#5c616a" }),
    el("circle", { cx: 32, cy: -14, r: 2.1, fill: "#f2c14e" }),
    el("circle", { cx: 32.6, cy: -14.2, r: 0.9, fill: "#1b1b1b" }));
  return { g: el("g", { class: "wolf walking" }, flip), flip };
}

function puff(layer, x, y, color, n = 10) {
  // a burst of little bits (fur, feathers, dust) that fly out and fade
  for (let i = 0; i < n; i++) {
    const c = el("circle", { cx: x, cy: y, r: rnd(2, 4.5), fill: color });
    layer.append(c);
    const vx = rnd(-70, 70), vy = rnd(-90, -10), t0 = performance.now();
    const step = (now) => {
      const t = (now - t0) / 1000;
      c.setAttribute("cx", (x + vx * t).toFixed(1));
      c.setAttribute("cy", (y + vy * t + 120 * t * t).toFixed(1));
      c.setAttribute("opacity", Math.max(0, 1 - t / 0.9).toFixed(2));
      if (t < 0.9) requestAnimationFrame(step); else c.remove();
    };
    requestAnimationFrame(step);
  }
}

function svgDefs(pen) {
  // gradients for the comet and flames, unique per pen
  const id = (n) => `${n}-${pen.id}`;
  return el("defs", {},
    el("radialGradient", { id: id("cometHead") },
      el("stop", { offset: "0", "stop-color": "#ffffff" }), el("stop", { offset: ".35", "stop-color": "#fff1a8" }),
      el("stop", { offset: ".7", "stop-color": "#ff9a3c" }), el("stop", { offset: "1", "stop-color": "#ff5a1f", "stop-opacity": "0" })),
    el("linearGradient", { id: id("cometTail"), x1: 1, y1: 0, x2: 0, y2: 0 },
      el("stop", { offset: "0", "stop-color": "#fff6c8", "stop-opacity": ".95" }), el("stop", { offset: ".35", "stop-color": "#ffb347", "stop-opacity": ".7" }),
      el("stop", { offset: "1", "stop-color": "#ff6a3d", "stop-opacity": "0" })),
    el("linearGradient", { id: id("scorch"), x1: 0, y1: 0, x2: 1, y2: 0 },
      el("stop", { offset: "0", "stop-color": "#2a1a10", "stop-opacity": ".55" }), el("stop", { offset: ".85", "stop-color": "#3a2214", "stop-opacity": ".45" }),
      el("stop", { offset: "1", "stop-color": "#3a2214", "stop-opacity": "0" })));
}

function flameNode(scale) {
  const tear = "M0,0 C-11,-6 -10,-24 0,-38 C10,-24 11,-6 0,0 Z";
  // outer group: position (set by the caller); inner group: the CSS flicker
  return el("g", { class: "flame-pos" }, el("g", { class: "flame", style: `--s:${scale.toFixed(2)};animation-delay:${rnd(0, .4).toFixed(2)}s` },
    el("path", { d: tear, fill: "#d8361c", transform: "scale(1.15,1.1)" }),
    el("path", { d: tear, fill: "#f4832a", transform: "scale(.85,.85)" }),
    el("path", { d: tear, fill: "#ffd45c", transform: "scale(.5,.55)" })));
}

/** Start a disaster in one pen. */
function startFx(pen, kind) {
  if (!pen.animals.length) return toast(`${pen.name} is empty: add some animals first.`);
  if (pen.fx) stopFx(pen, true);
  if (!pen.disaster) pen.prevMode = pen.mode === "mine" ? "mixed" : pen.mode;
  pen.disaster = kind;
  const under = el("g", { class: "fx-under" }), over = el("g", { class: "fx-over" });
  pen.svg.insertBefore(under, pen.layer);
  pen.svg.append(over);
  if (!pen.defs) { pen.defs = svgDefs(pen); pen.svg.prepend(pen.defs); }
  const fx = (pen.fx = { kind, t: 0, under, over, parts: [] });
  if (kind === "wolf") {
    const w = wolfNode();
    over.append(w.g);
    fx.wolf = { ...w, x: -60, y: rnd(120, 180), dir: 1, state: "enter", rest: 0, eaten: 0, target: null };
  } else if (kind === "comet") {
    fx.impact = { x: rnd(140, 290), y: rnd(130, 185) };
    fx.from = { x: W + 30, y: -50 };
    const ang = Math.atan2(fx.impact.y - fx.from.y, fx.impact.x - fx.from.x) * 180 / Math.PI;
    fx.comet = el("g", { class: "comet" },
      el("g", { transform: `rotate(${ang.toFixed(1)})` },
        el("path", { d: "M0,-14 L-230,-3 L-230,3 L0,14 Z", fill: `url(#cometTail-${pen.id})` }),
        el("circle", { r: 34, fill: `url(#cometHead-${pen.id})`, opacity: .6 }),
        el("circle", { r: 14, fill: `url(#cometHead-${pen.id})` })));
    // the tail is drawn toward -x and the group is rotated to the travel direction, so it trails behind
    over.append(fx.comet);
  } else if (kind === "fire") {
    fx.front = -20;
    fx.scorch = el("rect", { x: 0, y: 46, width: 0, height: H - 46, fill: `url(#scorch-${pen.id})` });
    under.append(fx.scorch);
    fx.spawn = 0; fx.ember = 0; fx.smoke = 0;
  } else if (kind === "storm") {
    fx.dark = el("rect", { x: 0, y: 0, width: W, height: H, fill: "rgba(18,22,38,.38)" });
    fx.clouds = el("g", { class: "clouds" },
      ...[[40, 18, 70, 26], [120, 10, 80, 28], [210, 20, 90, 30], [300, 8, 85, 27], [370, 22, 70, 24], [80, 34, 60, 18], [260, 38, 70, 20]]
        .map(([cx, cy, rx, ry], i) => el("ellipse", { cx, cy, rx, ry, fill: i % 2 ? "#3c4250" : "#4b5262" })));
    fx.rain = Array.from({ length: 55 }, () => {
      const l = el("line", { stroke: "rgba(200,215,240,.75)", "stroke-width": 1.3, "stroke-linecap": "round" });
      return { l, x: rnd(-40, W + 40), y: rnd(0, H) };
    });
    fx.flash = el("rect", { x: 0, y: 0, width: W, height: H, fill: "#fff", opacity: 0 });
    over.append(fx.dark, ...fx.rain.map((r) => r.l), fx.clouds, fx.flash);
    fx.nextBolt = rnd(0.8, 2); fx.gust = 1; fx.gustT = 3;
  }
  pen.card.querySelector(".disaster-banner")?.remove();
  pen.card.querySelector(".pen-head").after(el("div", { class: "disaster-banner", role: "status", text: DISASTERS[kind].banner }));
  pen.card.classList.add("disaster");
  for (const a of pen.animals) a.panicT = 0;
  if (pen.mode !== "distressed") setMode(pen, "distressed");
  updateDisasterMenu(pen);
  toast(`${DISASTERS[kind].banner.replace("the pen", pen.name)}`);
  if (!running) { $("#speed").value = "0.5"; $("#speedOut").textContent = "0.5 s"; setRunning(true); }
}

function stopFx(pen, quiet = false) {
  if (!pen.fx) return;
  if (pen.fx.wolf) {
    // the wolf runs off
    const w = pen.fx.wolf, g = w.g, over = pen.fx.over;
    pen.svg.append(over);
    const t0 = performance.now(), x0 = w.x;
    w.flip.setAttribute("transform", "scale(-1,1)");
    const run = (now) => {
      const x = x0 - (now - t0) / 1000 * 180;
      g.setAttribute("transform", `translate(${x.toFixed(1)},${w.y.toFixed(1)})`);
      if (x > -80) requestAnimationFrame(run); else over.remove();
    };
    requestAnimationFrame(run);
  } else pen.fx.over.remove();
  pen.fx.under.remove();
  delete pen.fx;
  pen.card.querySelector(".disaster-banner")?.remove();
  pen.card.classList.remove("disaster", "shaking");
  const back = pen.prevMode || "mixed";
  delete pen.disaster; delete pen.prevMode;
  if (!quiet) { setMode(pen, back); toast(`✓ All clear in ${pen.name}.`); }
  updateDisasterMenu(pen);
}

function eat(pen, a) {
  // the wolf catches an animal: it vanishes in a puff of fur or feathers
  puff(pen.fx.over, a.x, a.y - 4, a.kind === "pig" ? "#f2a3b3" : "#f7f3ea", 14);
  a.g.remove();
  pen.animals.splice(pen.animals.indexOf(a), 1);
  updateHint(pen); updateCounts(pen); savePens();
  toast(`🐺 The wolf caught a ${a.kind === "pig" ? "pig" : "hen"} in ${pen.name}!`);
}

/** Where a panicking animal runs next: away from the danger. */
function panicTarget(pen, a) {
  const fx = pen.fx;
  let tx = rnd(GROUND.x0, GROUND.x1), ty = rnd(GROUND.y0, GROUND.y1);
  const away = (p, far) => {
    const dx = a.x - p.x, dy = a.y - p.y, d = Math.hypot(dx, dy) || 1;
    tx = a.x + (dx / d) * far + rnd(-40, 40); ty = a.y + (dy / d) * far * 0.6 + rnd(-30, 30);
    if (tx < GROUND.x0 + 5 || tx > GROUND.x1 - 5) tx = rnd(GROUND.x0, GROUND.x1); // cornered: dash anywhere
  };
  if (fx.kind === "wolf") away(fx.wolf, 150);
  else if (fx.kind === "comet" && fx.landed) away(fx.impact, 170);
  else if (fx.kind === "fire") tx = rnd(Math.min(GROUND.x1 - 20, fx.front + 70), GROUND.x1);
  else if (fx.kind === "storm") tx += fx.gust * 90;
  return [clamp(tx, GROUND.x0, GROUND.x1), clamp(ty, GROUND.y0, GROUND.y1)];
}

/** Advance one pen's disaster by dt seconds. */
function updateFx(pen, dt) {
  const fx = pen.fx;
  fx.t += dt;
  if (fx.kind === "wolf") {
    const w = fx.wolf;
    if (w.rest > 0) {
      w.rest -= dt;
      w.g.classList.toggle("chomp", w.rest > 0.4);
    } else {
      if (!w.target || !pen.animals.includes(w.target)) w.target = pen.animals.length ? pen.animals.reduce((b, a) => (Math.hypot(a.x - w.x, a.y - w.y) < Math.hypot(b.x - w.x, b.y - w.y) ? a : b)) : null;
      const goal = w.eaten >= 2 || !w.target ? { x: W / 2 + Math.sin(fx.t) * 120, y: 150 + Math.cos(fx.t * 1.3) * 40 } : w.target;
      const dx = goal.x - w.x, dy = goal.y - w.y, d = Math.hypot(dx, dy) || 1;
      const sp = w.eaten >= 2 ? 45 : 78;
      w.x += (dx / d) * Math.min(d, sp * dt); w.y += (dy / d) * Math.min(d, sp * dt);
      if (Math.abs(dx) > 2) w.dir = dx < 0 ? -1 : 1;
      if (w.target && w.eaten < 2 && d < 24 && fx.t > 2.5) { eat(pen, w.target); w.eaten += 1; w.rest = 1.8; w.target = null; }
    }
    w.g.classList.toggle("walking", w.rest <= 0);
    w.g.setAttribute("transform", `translate(${w.x.toFixed(1)},${(w.y + (w.rest > 0 ? 0 : Math.sin(fx.t * 14) * 1.5)).toFixed(1)})`);
    w.flip.setAttribute("transform", `scale(${w.dir},1)`);
  } else if (fx.kind === "comet") {
    const T = 1.8;
    if (!fx.landed) {
      const k = Math.min(1, fx.t / T), e = 0.4 * k + 0.6 * k * k; // visible from the start, speeding up
      const x = fx.from.x + (fx.impact.x - fx.from.x) * e, y = fx.from.y + (fx.impact.y - fx.from.y) * e;
      fx.comet.setAttribute("transform", `translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${(0.85 + 0.35 * k).toFixed(2)})`);
      if (k >= 1) {
        fx.landed = true;
        fx.comet.remove();
        const { x: ix, y: iy } = fx.impact;
        fx.under.append(
          el("ellipse", { cx: ix, cy: iy + 4, rx: 46, ry: 16, fill: "#4a3424", opacity: .55 }),
          el("ellipse", { cx: ix, cy: iy + 3, rx: 34, ry: 11, fill: "#2b1d14" }),
          el("ellipse", { cx: ix, cy: iy + 3, rx: 34, ry: 11, fill: "none", stroke: "#8a6440", "stroke-width": 3 }),
          el("ellipse", { cx: ix - 4, cy: iy + 1, rx: 12, ry: 4, fill: "#ff8a3c", opacity: .85, class: "ember-glow" }));
        fx.flashC = el("circle", { cx: ix, cy: iy, r: 10, fill: "#fff6d4" });
        fx.ring = el("circle", { cx: ix, cy: iy, r: 10, fill: "none", stroke: "#fff1c2", "stroke-width": 4 });
        fx.over.append(fx.flashC, fx.ring);
        fx.tImpact = fx.t;
        puff(fx.over, ix, iy, "#6b4a2e", 16); puff(fx.over, ix, iy, "#ff9a3c", 10);
        pen.card.classList.add("shaking");
        setTimeout(() => pen.card.classList.remove("shaking"), 650);
        for (const a of pen.animals) a.panicT = 0;
      }
    } else {
      const s = fx.t - fx.tImpact;
      fx.flashC.setAttribute("r", (10 + 260 * Math.min(1, s / 0.5)).toFixed(1));
      fx.flashC.setAttribute("opacity", Math.max(0, 0.95 - s / 0.5).toFixed(2));
      fx.ring.setAttribute("r", (10 + 200 * Math.min(1, s / 0.9)).toFixed(1));
      fx.ring.setAttribute("opacity", Math.max(0, 1 - s / 0.9).toFixed(2));
      fx.smoke = (fx.smoke || 0) - dt;
      if (fx.smoke <= 0) { fx.smoke = 0.35; rise(fx, fx.impact.x + rnd(-14, 14), fx.impact.y, "#5d5a57", 3.5); }
    }
  } else if (fx.kind === "fire") {
    fx.front = Math.min(W * 0.62, fx.front + dt * 14);
    fx.scorch.setAttribute("width", Math.max(0, fx.front + 30).toFixed(1));
    fx.spawn -= dt; fx.ember -= dt; fx.smoke -= dt;
    if (fx.spawn <= 0) {
      fx.spawn = 0.12;
      const f = flameNode(rnd(0.6, 1.25));
      const x = rnd(Math.max(-10, fx.front - 70), fx.front + 8), y = rnd(70, H - 10);
      f.setAttribute("transform", `translate(${x.toFixed(1)},${y.toFixed(1)})`);
      // nearer flames drawn on top
      const after = [...fx.under.querySelectorAll(".flame-pos")].find((n) => +n.dataset.y > y);
      f.dataset.y = y;
      fx.under.insertBefore(f, after || null);
      fx.parts.push({ n: f, life: rnd(2.2, 3.6) });
    }
    if (fx.ember <= 0) { fx.ember = 0.06; spark(fx, rnd(fx.front - 60, fx.front), rnd(90, H - 15)); }
    if (fx.smoke <= 0) { fx.smoke = 0.3; rise(fx, rnd(fx.front - 70, fx.front), rnd(80, 200), "#4b4642", 4); }
    for (const p of [...fx.parts]) {
      p.life -= dt;
      if (p.life <= 0) { p.n.remove(); fx.parts.splice(fx.parts.indexOf(p), 1); }
      else if (p.life < 0.5) p.n.setAttribute("opacity", (p.life / 0.5).toFixed(2));
    }
  } else if (fx.kind === "storm") {
    for (const r of fx.rain) {
      r.y += 430 * dt; r.x += (fx.gust * 90 - 20) * dt;
      if (r.y > H) { r.y = rnd(-20, 0); r.x = rnd(-40, W + 40); }
      r.l.setAttribute("x1", r.x.toFixed(1)); r.l.setAttribute("y1", r.y.toFixed(1));
      r.l.setAttribute("x2", (r.x + fx.gust * 4 - 2).toFixed(1)); r.l.setAttribute("y2", (r.y + 11).toFixed(1));
    }
    fx.clouds.setAttribute("transform", `translate(${(Math.sin(fx.t * 0.35) * 18).toFixed(1)},0)`);
    fx.gustT -= dt;
    if (fx.gustT <= 0) { fx.gustT = rnd(2.5, 4); fx.gust = -fx.gust; for (const a of pen.animals) a.panicT = 0; }
    fx.nextBolt -= dt;
    if (fx.nextBolt <= 0) { fx.nextBolt = rnd(2.2, 4.5); bolt(pen); }
  }
}

function rise(fx, x, y, color, life) {
  const c = el("circle", { cx: x, cy: y, r: rnd(5, 9), fill: color, opacity: .55 });
  fx.over.insertBefore(c, fx.over.firstChild);
  const t0 = performance.now(), drift = rnd(-12, 12);
  const step = (now) => {
    const t = (now - t0) / 1000;
    if (!c.isConnected) return;
    c.setAttribute("cy", (y - 26 * t).toFixed(1)); c.setAttribute("cx", (x + drift * t).toFixed(1));
    c.setAttribute("r", (7 + 9 * t).toFixed(1)); c.setAttribute("opacity", Math.max(0, .55 * (1 - t / life)).toFixed(2));
    if (t < life) requestAnimationFrame(step); else c.remove();
  };
  requestAnimationFrame(step);
}

function spark(fx, x, y) {
  const c = el("circle", { cx: x, cy: y, r: rnd(1, 2.2), fill: Math.random() < .5 ? "#ffcc4d" : "#ff7b2e" });
  fx.over.append(c);
  const t0 = performance.now(), vx = rnd(-15, 15), vy = rnd(-70, -35);
  const step = (now) => {
    const t = (now - t0) / 1000;
    if (!c.isConnected) return;
    c.setAttribute("cx", (x + vx * t + Math.sin(t * 9) * 3).toFixed(1)); c.setAttribute("cy", (y + vy * t).toFixed(1));
    c.setAttribute("opacity", Math.max(0, 1 - t / 1.3).toFixed(2));
    if (t < 1.3) requestAnimationFrame(step); else c.remove();
  };
  requestAnimationFrame(step);
}

function bolt(pen) {
  // a forked lightning bolt from the clouds to the ground, with a flash
  const fx = pen.fx;
  let x = rnd(60, W - 60), y = 30;
  const pts = [[x, y]];
  while (y < 180) { y += rnd(14, 26); x += rnd(-22, 22); pts.push([x, y]); }
  const d = pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ");
  const glow = el("polyline", { points: d, fill: "none", stroke: "#cfe0ff", "stroke-width": 9, opacity: .35, "stroke-linejoin": "round" });
  const core = el("polyline", { points: d, fill: "none", stroke: "#fffbe6", "stroke-width": 3, "stroke-linejoin": "round" });
  fx.over.insertBefore(glow, fx.flash); fx.over.insertBefore(core, fx.flash);
  fx.flash.setAttribute("opacity", ".55");
  setTimeout(() => fx.flash?.setAttribute("opacity", ".1"), 70);
  setTimeout(() => fx.flash?.setAttribute("opacity", ".4"), 140);
  setTimeout(() => { fx.flash?.setAttribute("opacity", "0"); glow.remove(); core.remove(); }, 260);
  for (const a of pen.animals) a.panicT = 0;
}

function updateDisasterMenu(pen) {
  if (!pen.dMenu) return;
  pen.dMenu.querySelector(".clear").hidden = !pen.fx;
  pen.dBtn.classList.toggle("active", !!pen.fx);
}

function closeDisasterMenus(except) {
  for (const p of pens.values()) if (p.dMenu && p.dMenu !== except) { p.dMenu.hidden = true; p.dBtn.setAttribute("aria-expanded", "false"); }
}

// ---------- Boot ----------
async function boot() {
  setInterval(health, 10000);

  try {
    const c = await api("/hub-api/clips");
    pools = { pig: c.pool, chicken: c.chicken_pool || { calm: [], distressed: [] } };
    if (c.layout) layout = c.layout;
    $("#showcase").replaceChildren(...c.showcase.map(buildCase));
  } catch (e) {
    $("#showcase").replaceChildren(el("p", { class: "sub", text: `Demo clips unavailable (${e.message}).` }));
  }
  await health();
  const addCard = el("button", { class: "pen add-pen-card", id: "addPenCard", onclick: addPen },
    el("span", { class: "plus", text: "＋" }), el("span", { text: "Add a pen" }));
  $("#pens").replaceChildren(...penList.pens.map(buildPen), addCard);
  $("#addPen").onclick = addPen;
  // close any open pen disaster menu when clicking elsewhere
  document.addEventListener("click", (e) => { if (!e.target.closest(".pen-disaster")) closeDisasterMenus(); });
  for (const pen of pens.values()) syncPen(pen); // names may be new to a restarted server
  requestAnimationFrame(animate);

  $("#barnToggle").onclick = () => setRunning(!running);
  const speed = $("#speed");
  speed.oninput = () => { $("#speedOut").textContent = `${speed.value} s`; };
  $("#barnReset").onclick = async () => {
    setRunning(false);
    for (const pen of pens.values()) if (pen.fx) stopFx(pen, true);
    await api("/reset", { method: "POST" });
    // Don't reset the shared chicken server: forget only this copy's pens there.
    if (online.chicken) await Promise.all([...pens.values()].filter((p) => p.heard).map((p) =>
      api(`/hub-api/chicken/pens/${p.id}/reset`, { method: "POST" }).catch(() => {})));
    for (const pen of pens.values()) pen.last = {};
    pollPens(); pollAlerts();
    toast("Barn reset.");
  };
  $("#runAll").onclick = async () => { for (const run of cases) { await run(); await sleep(600); } };

  $("#tryFile").onchange = (e) => { const f = e.target.files[0]; if (f) checkOwn(f, f.name); e.target.value = ""; };
  $("#tryRec").onclick = toggleRecord;
  const drop = $("#tryDrop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragover"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("dragover"); const f = e.dataTransfer.files[0]; if (f) checkOwn(f, f.name); });

  pollPens(); pollAlerts();
  setInterval(pollPens, 1000);
  setInterval(pollAlerts, 2000);
}
boot();
