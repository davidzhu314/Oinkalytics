// Bat colony "Who's calling?". Talks only to /hub-api/bats* (api/colony.py).
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const SVG = "http://www.w3.org/2000/svg";
function el(tag, attrs = {}, ...kids) {
  const isSvg = ["svg", "g", "rect", "ellipse", "circle", "path", "text", "line", "linearGradient", "stop", "defs"].includes(tag);
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
const pct = (x) => (x >= 0.995 ? ">99%" : `${Math.round(x * 100)}%`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 4000);
}

let data = null;
const bats = new Map(); // id -> { g, x, phase }
let current = null;     // { clip, guesses, revealed }
const score = { n: 0, right: 0, top3: 0 };

// ---------- Roost scene ----------
function batNode(id, x) {
  // Hanging upside down: feet on the beam (y=58), head at the bottom.
  const inner = el("g", { class: "inner" },
    el("line", { x1: -5, y1: 0, x2: -5, y2: 14, stroke: "var(--bat-ink)", "stroke-width": 2.5, "stroke-linecap": "round" }),
    el("line", { x1: 5, y1: 0, x2: 5, y2: 14, stroke: "var(--bat-ink)", "stroke-width": 2.5, "stroke-linecap": "round" }),
    el("path", { class: "wing l", d: "M-6,18 Q-34,40 -24,86 Q-14,74 -6,80 Z" }),
    el("path", { class: "wing r", d: "M6,18 Q34,40 24,86 Q14,74 6,80 Z" }),
    el("ellipse", { class: "body", cx: 0, cy: 50, rx: 16, ry: 34 }),
    el("circle", { class: "body", cx: 0, cy: 92, r: 14 }),
    el("path", { class: "body", d: "M-11,98 L-17,116 L-4,104 Z" }),
    el("path", { class: "body", d: "M11,98 L17,116 L4,104 Z" }),
    el("circle", { class: "eye", cx: -5, cy: 92, r: 2.4 }),
    el("circle", { class: "eye", cx: 5, cy: 92, r: 2.4 }),
    el("ellipse", { class: "ink", cx: 0, cy: 84, rx: 3, ry: 2 }));
  const g = el("g", { class: "bat", transform: `translate(${x},58)` },
    el("circle", { class: "ring g", cx: 0, cy: 62, r: 56 }),
    el("circle", { class: "ring t", cx: 0, cy: 62, r: 64, "stroke-dasharray": "8 6" }),
    inner,
    el("text", { class: "pct", x: 0, y: 150 }),
    el("text", { class: "tag", x: 0, y: 176, text: `Bat ${id}` }));
  return { g, inner, x, phase: Math.random() * Math.PI * 2 };
}

function buildRoost() {
  const svg = $("#roost");
  const defs = el("defs", {}, el("linearGradient", { id: "sky", x1: 0, y1: 0, x2: 0, y2: 1 },
    el("stop", { offset: "0", "stop-color": "#171b33" }), el("stop", { offset: "1", "stop-color": "#2a3154" })));
  const stars = Array.from({ length: 28 }, (_, i) => el("circle", {
    cx: (i * 137) % 1000, cy: 205 + ((i * 53) % 50), r: (i % 3) * 0.6 + 0.6, fill: "#c9cde6", opacity: 0.35 }));
  svg.replaceChildren(defs,
    el("rect", { x: 0, y: 0, width: 1000, height: 270, fill: "url(#sky)" }),
    stars,
    el("path", { d: "M0,0 H1000 V40 Q900,62 800,44 Q700,30 600,48 Q500,64 400,46 Q300,30 200,50 Q100,66 0,44 Z", fill: "#11142a" }),
    el("rect", { x: 20, y: 52, width: 960, height: 12, rx: 6, fill: "var(--beam)" }));
  const ids = data.bats.map((b) => b.id);
  ids.forEach((id, i) => {
    const b = batNode(id, 70 + i * (860 / (ids.length - 1)));
    svg.append(b.g);
    bats.set(id, b);
  });
}

function sway(now) {
  for (const b of bats.values()) {
    const speaking = b.g.classList.contains("speaking");
    const a = Math.sin(now / 900 + b.phase) * (speaking ? 7 : 2.5);
    b.inner.setAttribute("transform", `rotate(${a.toFixed(2)})`);
  }
  requestAnimationFrame(sway);
}

function ripple(id) {
  // Expanding, fading rings from the bat's face; animated here and removed when done.
  const b = bats.get(id);
  const c = el("circle", { class: "wave-ring", cx: 0, cy: 92, r: 10 });
  b.g.append(c);
  const t0 = performance.now(), dur = 1800;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur), cycle = (k * 2) % 1;
    c.setAttribute("r", (10 + 50 * cycle).toFixed(1));
    c.setAttribute("opacity", (0.8 * (1 - cycle)).toFixed(2));
    if (k < 1) requestAnimationFrame(step); else c.remove();
  };
  requestAnimationFrame(step);
}

function clearRoost() {
  for (const b of bats.values()) {
    b.g.classList.remove("guess", "truth", "speaking", "dim");
    b.g.querySelector(".pct").textContent = "";
  }
}

// ---------- Mystery call ----------
let audio = null;
function playClip(url) {
  audio?.pause();
  audio = new Audio(url);
  return new Promise((resolve) => { audio.onended = resolve; audio.onerror = resolve; audio.play().catch(resolve); });
}

async function mystery() {
  const filter = $("#filter").value;
  let pool = data.clips.filter((c) => !filter || String(c.bat) === filter);
  if (!pool.length) return toast("No held-out calls for that bat.");
  if (!filter) {
    // Like a real colony: pick a bat in proportion to how often it actually called on the held-out days.
    const weights = data.bats.map((b) => b.heldout_calls);
    let r = Math.random() * weights.reduce((a, b) => a + b, 0), i = 0;
    while (r > weights[i]) r -= weights[i++];
    const own = pool.filter((c) => c.bat === data.bats[i].id);
    if (own.length) pool = own;
  }
  const clip = pool[Math.floor(Math.random() * pool.length)];
  current = { clip, guesses: null, revealed: false };
  clearRoost();
  for (const b of bats.values()) b.g.classList.add("speaking");
  $("#play").disabled = true; $("#reveal").disabled = true; $("#replay").disabled = false;
  $("#result").replaceChildren(el("h3", { text: "Listening…" }), el("p", { class: "sub small", text: `A ${clip.dur_s} s call. Who made it?` }));

  const guessP = fetch(`/hub-api/bats/guess/${clip.clip}`).then((r) => r.json());
  await Promise.all([playClip(clip.url), sleep(1200)]);
  for (const b of bats.values()) b.g.classList.remove("speaking");
  const g = (current.guesses = (await guessP).guesses);
  const top = g[0];
  for (const b of bats.values()) b.g.classList.add("dim");
  const tb = bats.get(top.bat);
  tb.g.classList.remove("dim"); tb.g.classList.add("guess");
  tb.g.querySelector(".pct").textContent = pct(top.p);
  ripple(top.bat);

  $("#result").replaceChildren(
    el("h3", { text: `The model thinks it's Bat ${top.bat}` }),
    el("p", { class: "sub small", text: `${pct(top.p)} sure. Its top three guesses:` }),
    el("div", { class: "guesses" }, g.slice(0, 3).map((x, i) => el("div", { class: `gl${i === 0 ? " top" : ""}` },
      el("b", { text: `Bat ${x.bat}` }), el("div", { class: "bar" }, el("i", { style: `width:${Math.round(x.p * 100)}%` })),
      el("span", { text: pct(x.p) })))),
    el("p", { class: "sub small", id: "revealHint", text: "Press Reveal to see who really called." }));
  $("#play").disabled = false; $("#reveal").disabled = false;
}

function reveal() {
  if (!current || current.revealed || !current.guesses) return;
  current.revealed = true;
  const truth = current.clip.bat;
  const rank = current.guesses.findIndex((x) => x.bat === truth);
  const b = bats.get(truth);
  b.g.classList.remove("dim"); b.g.classList.add("truth");
  b.g.querySelector(".ring.t").setAttribute("stroke", rank === 0 ? "var(--right)" : "var(--wrong)");
  ripple(truth);
  score.n += 1; score.right += rank === 0 ? 1 : 0; score.top3 += rank < 3 ? 1 : 0;
  $("#scoreRight").textContent = `${score.right} / ${score.n}`;
  $("#scoreTop3").textContent = `${score.top3} / ${score.n}`;
  const line = rank === 0 ? `✓ It was Bat ${truth}.`
    : `✗ It was Bat ${truth}, the model's #${rank + 1} guess (${pct(current.guesses[rank].p)}).`;
  $("#revealHint")?.remove();
  $("#result").append(
    el("p", { class: `verdict-line ${rank === 0 ? "ok" : "no"}`, text: line }),
    el("p", { class: "sub small", text: `Recorded ${current.clip.day}. Researchers' video notes for this call: ${current.clip.context.toLowerCase()}.` }));
  $("#reveal").disabled = true;
}

// ---------- Boot ----------
async function boot() {
  try {
    const r = await fetch("/hub-api/bats");
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
  } catch {
    $("#result").replaceChildren(el("h3", { text: "Bat data isn't built on this machine" }),
      el("p", { class: "sub small", text: "Run python -m ml.bat_prep and python -m ml.bat_train, then restart the API." }));
    $("#play").disabled = true;
    return;
  }
  buildRoost();
  requestAnimationFrame(sway);
  for (const b of data.bats) $("#filter").append(el("option", { value: b.id, text: `Bat ${b.id}` }));
  const h = data.heldout;
  $("#heldout").textContent = `On all ${h.n_test} calls from the ${h.days.length} days it never heard: right ${pct(h.accuracy)} of the time ` +
    `(${pct(h.balanced)} averaged per bat), right bat in its top 3 ${pct(h.top3)}. Guessing would be 10% and 30%.`;
  $("#perBat").replaceChildren(...data.bats.map((b) => el("div", { class: "bat-card" },
    el("b", { text: `Bat ${b.id}` }),
    el("div", { class: "meter" }, el("i", { style: `width:${Math.round((b.heldout_accuracy ?? 0) * 100)}%` })),
    el("span", { text: b.heldout_calls ? `${pct(b.heldout_accuracy)} right · ${b.heldout_calls} calls` : "no calls those days" }))));
  $("#play").onclick = mystery;
  $("#replay").onclick = () => current && playClip(current.clip.url);
  $("#reveal").onclick = reveal;
}
boot();
