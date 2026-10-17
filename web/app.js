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
const PEN_NAMES = { 1: "Clover & friends", 2: "Hazel & friends", 3: "Truffle & friends", 4: "Biscuit & friends" };
const W = 400, H = 230;
const pens = new Map();
let pool = { calm: [], distressed: [] };

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
  return { g: el("g", { class: "pig" }, flip, emote), flip, emote };
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

function buildPen(id) {
  const svg = fieldSvg();
  const layer = el("g");
  svg.append(layer);
  const pigs = [0, 1, 2].map((i) => {
    const n = pigNode();
    layer.append(n.g);
    const x = 70 + i * 110, y = 110 + (i % 2) * 45;
    return { ...n, x, y, tx: x, ty: y, rest: Math.random() * 2, dir: 1, bob: Math.random() * 6 };
  });

  const badge = el("span", { class: "badge idle", text: "○ Quiet" });
  const summary = el("div", { class: "pen-summary", text: "No calls yet." });
  const mineBtn = el("button", { "aria-pressed": "false", text: "My clips (0)" });
  const modes = { calm: el("button", { "aria-pressed": "true", text: "Calm calls" }), distressed: el("button", { "aria-pressed": "false", text: "Stressed calls" }), mine: mineBtn };
  const listen = el("button", { class: "btn small listen", "aria-pressed": "false", text: "🔊 Listen" });
  const fileIn = el("input", { type: "file", accept: "audio/*,video/*,.m4a,.mp4,.mov,.caf", multiple: true, hidden: true });
  const card = el("article", { class: "pen calm" },
    el("div", { class: "pen-head" }, el("div", { class: "pen-name" }, `Pen ${id}`, el("small", { text: PEN_NAMES[id] || "" })), badge),
    svg,
    el("div", { class: "pen-foot" },
      summary,
      el("div", { class: "pen-actions" }, el("span", { class: "sub small", text: "Microphone hears:" }), el("div", { class: "seg" }, Object.values(modes))),
      el("div", { class: "pen-actions" },
        el("button", { class: "btn small", onclick: () => feedPen(pen, true), text: "▶ Play next call" }),
        listen,
        el("label", { class: "btn small" }, "＋ Add my clips", fileIn))));

  const pen = { id, card, svg, pigs, badge, summary, modes, mineBtn, mode: "calm", mine: [], mineIdx: 0, listen: false, level: "idle", last: null, order: [] };
  for (const [m, b] of Object.entries(modes)) b.onclick = () => setMode(pen, m);
  listen.onclick = () => { pen.listen = !pen.listen; listen.setAttribute("aria-pressed", pen.listen); };
  const addFiles = (files) => {
    for (const f of files) pen.mine.push({ file: f, name: f.name, url: URL.createObjectURL(f) });
    mineBtn.textContent = `My clips (${pen.mine.length})`;
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

function nextClip(pen) {
  if (pen.mode === "mine" && pen.mine.length) return pen.mine[pen.mineIdx++ % pen.mine.length];
  const list = pool[pen.mode === "distressed" ? "distressed" : "calm"];
  if (!list.length) return null;
  if (!pen.order.length || pen.order.src !== pen.mode) {
    pen.order = [...list].sort(() => Math.random() - 0.5);
    pen.order.src = pen.mode;
  }
  const c = pen.order.pop();
  return { name: c.name, url: c.url };
}

async function feedPen(pen, aloud) {
  const clip = nextClip(pen);
  if (!clip) return;
  const blob = clip.file || (await clipBlob(clip.url));
  if (aloud) play(clip.url);
  const p = await predict(blob, clip.name, pen.id);
  pen.last = p;
  speak(pen, p);
}

function speak(pen, p) {
  const pig = pen.pigs[Math.floor(Math.random() * pen.pigs.length)];
  const label = p.status === "calm" ? `Calm · ${pct(p.valence.confidence)}`
    : p.status === "distressed" ? `Distressed · ${pct(p.valence.confidence)}`
    : p.abstain_reason === "not_pig" ? "Not a pig?" : "Not sure";
  const color = p.status === "calm" ? "var(--calm)" : p.status === "distressed" ? "var(--alert)" : "var(--unsure)";
  const w = label.length * 7 + 18;
  const bubble = el("g", { class: "bubble", transform: "translate(0,-46)" },
    el("rect", { x: -w / 2, y: -12, width: w, height: 24, rx: 12 }),
    el("text", { x: 0, y: 1, fill: color, text: label }));
  // Sound ripple from the snout (SMIL: animates SVG attributes reliably in every browser).
  const ripple = el("circle", { class: "ripple", cx: 33, cy: -4, r: 6 },
    el("animate", { attributeName: "r", from: 6, to: 30, dur: "0.9s", fill: "freeze" }),
    el("animate", { attributeName: "opacity", from: 0.7, to: 0, dur: "0.9s", fill: "freeze" }));
  pig.g.append(ripple, bubble);
  ripple.querySelectorAll("animate").forEach((a) => a.beginElement?.());
  setTimeout(() => ripple.remove(), 1000);
  setTimeout(() => bubble.remove(), 2600);
}

function stressed(pen) {
  return pen.level === "alert" || pen.level === "watch" && pen.last?.status === "distressed";
}

let lastFrame = performance.now();
function animate(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  for (const pen of pens.values()) {
    const s = stressed(pen);
    const speed = s ? 75 : 20;
    for (const pig of pen.pigs) {
      const dx = pig.tx - pig.x, dy = pig.ty - pig.y, d = Math.hypot(dx, dy);
      if (pig.rest > 0) pig.rest -= dt;
      else if (d < 2) {
        pig.tx = 45 + Math.random() * (W - 90);
        pig.ty = 85 + Math.random() * (H - 115);
        pig.rest = s ? Math.random() * 0.3 : 0.8 + Math.random() * 3;
      } else {
        const step = Math.min(d, speed * dt);
        pig.x += (dx / d) * step;
        pig.y += (dy / d) * step;
        if (Math.abs(dx) > 1) pig.dir = dx < 0 ? -1 : 1;
      }
      const walking = pig.rest <= 0 && d >= 2;
      pig.bob += dt * (s ? 22 : 9);
      const bob = walking ? Math.sin(pig.bob) * 1.4 : 0;
      const shake = s ? Math.sin(now / 35 + pig.x) * 1.2 : 0;
      pig.g.setAttribute("transform", `translate(${(pig.x + shake).toFixed(1)},${(pig.y + bob).toFixed(1)})`);
      pig.flip.setAttribute("transform", `scale(${pig.dir},1)`);
      pig.g.classList.toggle("walking", walking);
      pig.g.classList.toggle("stressed", s);
      pig.emote.textContent = s && Math.sin(now / 300 + pig.x) > 0.2 ? "!" : "";
    }
  }
  // keep pigs drawn in depth order
  for (const pen of pens.values()) {
    const layer = pen.pigs[0].g.parentNode;
    [...pen.pigs].sort((a, b) => a.y - b.y).forEach((p) => layer.append(p.g));
  }
  requestAnimationFrame(animate);
}

const LEVEL = { calm: "✓ Calm", watch: "◐ Watch", alert: "⚠ Alert", idle: "○ Quiet" };
async function pollPens() {
  try {
    for (const s of await api("/pens")) {
      const pen = pens.get(s.pen_id);
      if (!pen) continue;
      pen.level = s.window ? s.level : "idle";
      pen.badge.className = `badge ${pen.level}`;
      pen.badge.textContent = LEVEL[pen.level];
      pen.card.className = `pen ${pen.level}`;
      pen.summary.replaceChildren(s.window
        ? el("span", {}, el("b", { text: `${s.distressed} of last ${s.window}` }), " confident calls sounded distressed")
        : "No calls yet.");
    }
  } catch { /* API down: the health chip says so */ }
}

// ---------- Barn simulator ----------
let running = false;
async function barnLoop() {
  let i = 0;
  while (running) {
    // Pens hearing stressed calls or your clips get two turns per round; calm pens get one.
    const order = [...pens.values()].flatMap((p) => (p.mode === "calm" ? [p] : [p, p]));
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
  let list;
  try { list = await api("/alerts"); } catch { return; }
  const ol = $("#alertList");
  if (!list.length && alerts.size) { alerts.clear(); ol.replaceChildren(el("li", { class: "empty", text: "No alerts yet. All quiet." })); }
  for (const a of list) {
    if (alerts.has(a.alert_id)) { alerts.get(a.alert_id).data = a; continue; }
    const why = el("div", { class: "why", hidden: true });
    const li = el("li", { class: "sms" },
      el("time", { text: new Date(a.created_at).toLocaleTimeString() }),
      a.message,
      el("div", { class: "pen-actions" },
        el("button", { class: "btn small", text: "Why?", onclick: () => {
          const fresh = alerts.get(a.alert_id).data;
          why.textContent = fresh.explanation.text;
          why.hidden = !why.hidden;
        } }),
        el("button", { class: "btn small", text: "▶ Play it", onclick: () => play(a.audio_url) })),
      why);
    alerts.set(a.alert_id, { data: a, li });
    $(".empty", ol)?.remove();
    ol.prepend(li);
    if (alertsLoaded) toast(`📱 Texted the farmer: ${a.message}`);
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
  health();
  setInterval(health, 10000);

  let ids = ["1", "2", "3", "4"];
  try { ids = (await api("/pens")).map((p) => p.pen_id); } catch { /* use defaults */ }
  $("#pens").replaceChildren(...ids.map(buildPen));
  requestAnimationFrame(animate);

  try {
    const c = await api("/hub-api/clips");
    pool = c.pool;
    $("#showcase").replaceChildren(...c.showcase.map(buildCase));
  } catch (e) {
    $("#showcase").replaceChildren(el("p", { class: "sub", text: `Demo clips unavailable (${e.message}).` }));
  }

  $("#barnToggle").onclick = () => setRunning(!running);
  const speed = $("#speed");
  speed.oninput = () => { $("#speedOut").textContent = `${speed.value} s`; };
  $("#barnReset").onclick = async () => {
    setRunning(false);
    await api("/reset", { method: "POST" });
    for (const pen of pens.values()) pen.last = null;
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
