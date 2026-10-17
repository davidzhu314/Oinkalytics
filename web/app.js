// Oinkalytics hub. Talks only to the API on the same origin (docs/API.md) plus /hub-api/* for demo clips.
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const SVG = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, ...kids) {
  const isSvg = ["svg", "g", "rect", "ellipse", "circle", "path", "text", "line", "animate"].includes(tag);
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
const pct = (x) => `${Math.round(x * 100)}%`;

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
    try { await api("/hub-api/chicken/health"); online.chicken = true; } catch { online.chicken = false; }
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
const PEN_NAMES = { 1: "Clover & friends", 2: "Hazel & friends", 3: "Truffle & friends", 4: "Biscuit & friends" };
const MIX = 1 / 6; // "Mixed calls": share of distressed calls a microphone hears
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

function addAnimal(pen, kind, walkIn) {
  if (pen.animals.length >= MAX_ANIMALS) return toast(`Pen ${pen.id} is full (${MAX_ANIMALS} animals).`);
  const i = pen.animals.length;
  const n = kind === "pig" ? pigNode() : chickenNode();
  pen.layer.append(n.g);
  const x = 90 + (i % 3) * 110 + Math.random() * 20, y = 110 + (i % 2) * 50 + Math.random() * 10;
  // A new animal starts just outside the left edge of the field and walks in.
  const a = { ...n, x: walkIn ? -50 : x, y, tx: x, ty: y, rest: walkIn ? 0 : Math.random() * 2, dir: 1,
    bob: Math.random() * 6, peck: Math.random() * 10, entering: walkIn };
  const name = kind === "pig" ? "pig" : "hen";
  n.g.setAttribute("tabindex", "0");
  n.g.setAttribute("role", "button");
  n.g.setAttribute("aria-label", `A ${name} in Pen ${pen.id}. Click to hear it.`);
  // React on press, not "click": a click is dropped if the node moves in the DOM between press and release.
  n.g.addEventListener("pointerdown", (e) => { if (e.button === 0) { e.preventDefault(); animalSpeaks(pen, a); } });
  n.g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); animalSpeaks(pen, a); } });
  pen.animals.push(a);
  for (const b of pen.addBtns) {
    b.disabled = pen.animals.length >= MAX_ANIMALS;
    b.dataset.n = pen.animals.filter((x) => x.kind === b.dataset.kind).length; // count badge
  }
  if (walkIn) toast(`A new ${name} is walking into Pen ${pen.id}.`);
}

/** Click an animal: it makes a call of its own species, out loud, and the pen's microphone hears it. */
async function animalSpeaks(pen, a) {
  pen.card.classList.add("heard"); // the "click an animal" hint has done its job
  if (!playable(a.kind)) return toast(a.kind === "chicken" && !online.chicken ? "The chicken model isn't connected yet." : `No ${a.kind} calls to play.`);
  const clip = clipFor(pen, a.kind);
  play(clip.url);
  try {
    const [sp, p] = await judge(await clipBlob(clip.url), clip.name, pen.id);
    if (sp) pen.last[sp] = p;
    speak(pen, sp, p, a.kind, a);
  } catch (e) { toast(`Couldn't check that call: ${e.message}`); }
}

function buildPen(id) {
  const kinds = layout[id] || ["pig"];
  const svg = fieldSvg();
  const layer = el("g");
  svg.append(layer);
  const animals = [];
  // Compact round icon buttons with a hover/focus tooltip (data-tip); the label is also the aria-label.
  const icon = (glyph, tip, cls = "", tag = "button") => el(tag, { class: `ic ${cls}`, "data-tip": tip, "aria-label": tip, text: glyph });
  const addBtns = kinds.map((k) => {
    const b = icon(k === "pig" ? "＋🐷" : "＋🐔", `Walk a new ${k === "pig" ? "pig" : "hen"} in`, "add");
    b.dataset.kind = k;
    b.onclick = () => addAnimal(pen, k, true);
    return b;
  });

  const who = kinds.map((k) => `${SPECIES[k].emoji} ${SPECIES[k].noun}s`).join(" + ");
  const badge = el("span", { class: "badge idle", text: "○ Quiet" });
  const summary = el("div", { class: "pen-summary", text: "No calls yet." });
  const mineBtn = el("button", { "aria-pressed": "false", title: "Your own recordings", text: "Mine" });
  const modes = {
    mixed: el("button", { "aria-pressed": "true", title: "Mostly calm calls, about 1 in 6 stressed", text: "Mixed" }),
    calm: el("button", { "aria-pressed": "false", title: "Only calm calls", text: "Calm" }),
    distressed: el("button", { "aria-pressed": "false", title: "Only stressed calls", text: "Stressed" }),
    mine: mineBtn,
  };
  const listen = icon("🔊", "Listen: play calls out loud", "toggle");
  listen.setAttribute("aria-pressed", "false");
  const fileIn = el("input", { type: "file", accept: "audio/*,video/*,.m4a,.mp4,.mov,.caf", multiple: true, hidden: true });
  const clips = icon("📎", "Add your own recordings", "", "label");
  clips.append(fileIn);
  const card = el("article", { class: "pen calm" },
    el("div", { class: "pen-head" }, el("div", { class: "pen-name" }, `Pen ${id}`, el("small", { text: `${PEN_NAMES[id] || ""} · ${who}` })), badge),
    el("div", { class: "field-wrap" }, svg, el("span", { class: "field-hint", text: "Click an animal to hear it" })),
    el("div", { class: "pen-foot" },
      summary,
      el("div", { class: "pen-tools" },
        el("div", { class: "seg", role: "group", "aria-label": "What this pen's microphone hears" }, Object.values(modes)),
        el("div", { class: "tools" },
          icon("▶", "Play the next call", "play"),
          listen,
          el("span", { class: "tools-sep", "aria-hidden": "true" }),
          addBtns,
          clips))));
  card.querySelector(".ic.play").onclick = () => feedPen(pen, true);

  const pen = { id, kinds, card, svg, layer, animals, addBtns, badge, summary, modes, mineBtn, mode: "mixed", mine: [], mineIdx: 0,
    listen: false, level: "idle", levels: {}, last: {}, order: {} };
  for (const kind of herd(kinds)) addAnimal(pen, kind, false);
  for (const [m, b] of Object.entries(modes)) b.onclick = () => setMode(pen, m);
  listen.onclick = () => { pen.listen = !pen.listen; listen.setAttribute("aria-pressed", pen.listen); };
  const addFiles = (files) => {
    for (const f of files) pen.mine.push({ file: f, name: f.name, url: URL.createObjectURL(f) });
    mineBtn.textContent = `Mine (${pen.mine.length})`;
    if (pen.mine.length) setMode(pen, "mine");
    toast(`Pen ${id} will now hear your ${pen.mine.length} clip${pen.mine.length === 1 ? "" : "s"}.`);
  };
  fileIn.onchange = () => { addFiles(fileIn.files); fileIn.value = ""; };
  card.addEventListener("dragover", (e) => { e.preventDefault(); card.classList.add("dragover"); });
  card.addEventListener("dragleave", () => card.classList.remove("dragover"));
  card.addEventListener("drop", (e) => { e.preventDefault(); card.classList.remove("dragover"); addFiles(e.dataTransfer.files); });
  pens.set(id, pen);
  return card;
}

function setMode(pen, mode) {
  if (mode === "mine" && !pen.mine.length) return toast('Add a clip first: "＋ Add my clips", or drag a file onto the pen.');
  pen.mode = mode;
  for (const [m, b] of Object.entries(pen.modes)) b.setAttribute("aria-pressed", m === mode);
}

const playable = (sp) => online[sp] && pools[sp].calm.length && pools[sp].distressed.length;

function nextClip(pen) {
  if (pen.mode === "mine" && pen.mine.length) return pen.mine[pen.mineIdx++ % pen.mine.length];
  const kinds = pen.kinds.filter(playable);
  if (!kinds.length) return null;
  return clipFor(pen, kinds[Math.floor(Math.random() * kinds.length)]);
}

/** A held-out call of species `sp`, calm or distressed as the pen's microphone mode says. */
function clipFor(pen, sp) {
  const truth = pen.mode === "distressed" ? "distressed" : pen.mode === "calm" ? "calm" : Math.random() < MIX ? "distressed" : "calm";
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
  const [sp, p] = await judge(blob, clip.name, pen.id);
  if (sp) pen.last[sp] = p;
  speak(pen, sp, p, clip.species);
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

function stressed(pen, sp) {
  const lv = pen.levels[sp];
  return lv === "alert" || (lv === "watch" && pen.last[sp]?.status === "distressed");
}

let lastFrame = performance.now();
function animate(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  for (const pen of pens.values()) {
    for (const a of pen.animals) {
      const s = stressed(pen, a.kind);
      const hen = a.kind === "chicken";
      const speed = (s ? (hen ? 95 : 75) : (hen ? 28 : 20)) * (a.entering ? 2.5 : 1);
      const dx = a.tx - a.x, dy = a.ty - a.y, d = Math.hypot(dx, dy);
      if (a.entering && d < 2) a.entering = false;
      if (a.rest > 0) a.rest -= dt;
      else if (d < 2) {
        a.tx = 45 + Math.random() * (W - 90);
        a.ty = 85 + Math.random() * (H - 115);
        a.rest = s ? Math.random() * 0.3 : hen ? 0.4 + Math.random() * 2 : 0.8 + Math.random() * 3;
      } else {
        const step = Math.min(d, speed * dt);
        a.x += (dx / d) * step;
        a.y += (dy / d) * step;
        if (Math.abs(dx) > 1) a.dir = dx < 0 ? -1 : 1;
      }
      const walking = a.rest <= 0 && d >= 2;
      a.bob += dt * (s ? 22 : hen ? 14 : 9);
      // pigs bob; chickens hop
      const bob = walking ? (hen ? -Math.abs(Math.sin(a.bob)) * 3 : Math.sin(a.bob) * 1.4) : 0;
      const shake = s ? Math.sin(now / 35 + a.x) * 1.2 : 0;
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
      a.emote.textContent = s && Math.sin(now / 300 + a.x) > 0.2 ? "!" : "";
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

const LEVEL = { calm: "✓ Calm", watch: "◐ Watch", alert: "⚠ Alert", idle: "○ Quiet", waiting: "○ Waiting" };
const RANK = { idle: 0, calm: 1, watch: 2, alert: 3 };
async function pollPens() {
  const states = {};
  for (const sp of Object.keys(SPECIES)) {
    if (!online[sp]) continue;
    try { states[sp] = Object.fromEntries((await api(`${SPECIES[sp].base}/pens`)).map((s) => [s.pen_id, s])); }
    catch { /* down: shown as waiting */ }
  }
  for (const pen of pens.values()) {
    const parts = [];
    let level = "idle";
    for (const sp of pen.kinds) {
      const s = states[sp]?.[pen.id];
      if (!s) {
        pen.levels[sp] = "idle";
        if (sp !== "pig") parts.push(el("span", {}, `${SPECIES[sp].emoji} waiting for the ${sp} model`));
        continue;
      }
      pen.levels[sp] = s.window ? s.level : "idle";
      if (RANK[pen.levels[sp]] > RANK[level]) level = pen.levels[sp];
      if (s.window) parts.push(el("span", {}, `${SPECIES[sp].emoji} `, el("b", { text: `${s.distressed} of last ${s.window}` }), ` sounded ${SPECIES[sp].risk}`));
    }
    if (level === "idle" && !pen.kinds.some((sp) => states[sp])) level = "waiting";
    pen.level = level;
    pen.badge.className = `badge ${level === "waiting" ? "idle" : level}`;
    pen.badge.textContent = LEVEL[level];
    pen.card.className = `pen ${level === "waiting" ? "idle" : level}`;
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
    const order = [...pens.values()].flatMap((p) => (p.mode === "distressed" || p.mode === "mine" ? [p, p] : [p]));
    const pen = order[i++ % order.length];
    const t0 = performance.now();
    try { await feedPen(pen, pen.listen); } catch (e) { toast(`Couldn't check a call: ${e.message}`); }
    const wait = Number($("#speed").value) * 1000 - (performance.now() - t0);
    await sleep(Math.max(50, wait));
  }
}
function setRunning(on) {
  running = on;
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
    try { for (const a of await api(`${SPECIES[sp].base}/alerts`)) list.push({ sp, a }); }
    catch { if (sp === "pig") return; }
  }
  const ol = $("#alertList");
  const many = Object.values(layout).some((k) => k.includes("chicken"));
  if (!list.length && alerts.size) { alerts.clear(); ol.replaceChildren(el("li", { class: "empty", text: "No alerts yet. All quiet." })); }
  list.sort((x, y) => (x.a.created_at < y.a.created_at ? -1 : 1));
  for (const { sp, a } of list) {
    const key = `${sp}:${a.alert_id}`;
    if (alerts.has(key)) { alerts.get(key).data = a; continue; }
    const message = many ? `${SPECIES[sp].emoji} ${a.message}` : a.message;
    const why = el("div", { class: "why", hidden: true });
    const li = el("li", { class: "sms" },
      el("time", { text: new Date(a.created_at).toLocaleTimeString() }),
      message,
      el("div", { class: "pen-actions" },
        el("button", { class: "btn small", text: "Why?", onclick: () => {
          const fresh = alerts.get(key).data;
          why.textContent = fresh.explanation.text;
          why.hidden = !why.hidden;
        } }),
        el("button", { class: "btn small", text: "▶ Play it", onclick: () => play(`${SPECIES[sp].base}${a.audio_url}`) })),
      why);
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

// ---------- Boot ----------
async function boot() {
  setInterval(health, 10000);

  let ids = ["1", "2", "3", "4"];
  try { ids = (await api("/pens")).map((p) => p.pen_id); } catch { /* use defaults */ }
  try {
    const c = await api("/hub-api/clips");
    pools = { pig: c.pool, chicken: c.chicken_pool || { calm: [], distressed: [] } };
    if (c.layout) layout = c.layout;
    $("#showcase").replaceChildren(...c.showcase.map(buildCase));
  } catch (e) {
    $("#showcase").replaceChildren(el("p", { class: "sub", text: `Demo clips unavailable (${e.message}).` }));
  }
  await health();
  $("#pens").replaceChildren(...ids.map(buildPen));
  requestAnimationFrame(animate);

  $("#barnToggle").onclick = () => setRunning(!running);
  const speed = $("#speed");
  speed.oninput = () => { $("#speedOut").textContent = `${speed.value} s`; };
  $("#barnReset").onclick = async () => {
    setRunning(false);
    await api("/reset", { method: "POST" });
    if (online.chicken) await api("/hub-api/chicken/reset", { method: "POST" }).catch(() => {});
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
