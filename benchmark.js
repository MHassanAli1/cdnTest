/* =========================================================================
   CDN Reel Lab — best-of-N benchmark runner

   Sequential (never parallel) so bandwidth/decoder contention can't skew
   results. Per CDN it collects three cohorts:
     - MANIFEST RTT  : fetch(.m3u8, no-cors, no-store) round trip
     - FIRST FRAME (cold) : first play of each of the 5 distinct reels
     - FIRST FRAME (warm) : replays (served from HTTP cache)
   First frame is captured via requestVideoFrameCallback when available
   (fires when a frame is actually presented), else loadeddata + rAF.
   ========================================================================= */

import * as L from "./reelLinks.js";

const CDN = {
  bunny: {
    name: "Bunny.net", accent: "#ff9416",
    urls: [L.reel1_b, L.reel2_b, L.reel3_b, L.reel4_b, L.reel5_b],
  },
  mux: {
    name: "Mux", accent: "#fa50b5",
    urls: [L.reel1_m, L.reel2_m, L.reel3_m, L.reel4_m, L.reel5_m],
  },
  cloudflare: {
    name: "Cloudflare", accent: "#f6821f",
    urls: [L.reel1_cf, L.reel2_cf, L.reel3_cf, L.reel4_cf, L.reel5_cf],
  },
};

const probe = document.createElement("video");
const HLS_NATIVE = !!probe.canPlayType &&
  (probe.canPlayType("application/vnd.apple.mpegurl") !== "" ||
   probe.canPlayType("application/x-mpegURL") !== "");
const HAS_RVFC = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
const isPlaceholder = (u) => !u || /example\.com/.test(u);

const STORE_KEY = "cdnReelLab.stats.v1";
const SETTLE_MS = 300; // pause + teardown between samples for stable real-device timing
const sleep = (m) => new Promise((r) => setTimeout(r, m));

/* ---- DOM refs ---------------------------------------------------------- */
const elToggles = document.getElementById("toggles");
const elReps = document.getElementById("reps");
const elRepsVal = document.getElementById("repsVal");
const elRun = document.getElementById("run");
const elBar = document.getElementById("pbar");
const elStatus = document.getElementById("pstatus");
const elPreview = document.getElementById("preview");
const elPLabel = document.getElementById("plabel");
const elResults = document.getElementById("results");
const elLog = document.getElementById("log");
const video = elPreview;

video.muted = true;
video.defaultMuted = true;
video.playsInline = true;
video.setAttribute("playsinline", "");
video.setAttribute("webkit-playsinline", "");
video.preload = "none";
video.disableRemotePlayback = true;

/* ---- config UI --------------------------------------------------------- */
const selected = new Set(["bunny", "mux"]);
Object.keys(CDN).forEach((k) => {
  const disabled = CDN[k].urls.every(isPlaceholder);
  const b = document.createElement("button");
  b.type = "button";
  b.className = "toggle" + (selected.has(k) && !disabled ? " on" : "");
  b.style.setProperty("--accent", CDN[k].accent);
  b.disabled = disabled;
  b.innerHTML = `<i></i>${CDN[k].name}${disabled ? " <small>· no links</small>" : ""}`;
  if (disabled) selected.delete(k);
  b.addEventListener("click", () => {
    if (selected.has(k)) selected.delete(k); else selected.add(k);
    b.classList.toggle("on", selected.has(k));
  });
  elToggles.appendChild(b);
});

let warmReps = 3;
elReps.addEventListener("input", () => {
  warmReps = +elReps.value;
  elRepsVal.textContent = warmReps;
});

/* ---- stats ------------------------------------------------------------- */
function stats(arr) {
  const a = arr.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const n = a.length;
  const med = n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  const mean = a.reduce((s, x) => s + x, 0) / n;
  const p95 = a[Math.min(n - 1, Math.ceil(n * 0.95) - 1)];
  return { med, mean, min: a[0], max: a[n - 1], p95, n };
}
const ms = (x) => (x == null ? "—" : Math.round(x) + "");

/* ---- measurement primitives ------------------------------------------- */
function manifestRTT(url) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    fetch(url, { mode: "no-cors", cache: "no-store" })
      .then(() => resolve(performance.now() - t0))
      .catch(() => resolve(null));
  });
}

function measureTTFF(url) {
  return new Promise((resolve) => {
    let done = false;
    let timer = 0;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener("error", onErr);
      resolve(v);
    };
    const onErr = () => finish(null);
    video.addEventListener("error", onErr, { once: true });

    video.pause();
    video.setAttribute("src", url);
    video.load();
    const t0 = performance.now();
    video.play().catch(() => {});

    if (HAS_RVFC) {
      video.requestVideoFrameCallback(() => finish(performance.now() - t0));
    } else {
      video.addEventListener(
        "loadeddata",
        () => requestAnimationFrame(() => finish(performance.now() - t0)),
        { once: true }
      );
    }
    timer = setTimeout(() => finish(null), 20000); // give up after 20s
  });
}

function teardown() {
  video.pause();
  video.removeAttribute("src");
  video.load();
}

/* ---- store integration (feeds landing comparison) --------------------- */
function pushColdSamples(cdn, samples) {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (_) {}
  const e = (s[cdn] = s[cdn] || { startups: [], stalls: 0, plays: 0, updated: 0 });
  samples.filter((x) => x != null).forEach((x) => e.startups.push(Math.round(x)));
  while (e.startups.length > 50) e.startups.shift();
  e.updated = Date.now();
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (_) {}
}

/* ---- logging + progress ------------------------------------------------ */
function log(msg, accent) {
  const row = document.createElement("div");
  row.className = "logrow";
  if (accent) row.style.color = accent;
  row.textContent = msg;
  elLog.prepend(row);
  while (elLog.children.length > 120) elLog.lastChild.remove();
}
let totalSteps = 0, doneSteps = 0;
function tick(label) {
  doneSteps++;
  elBar.style.width = (doneSteps / totalSteps) * 100 + "%";
  if (label) elStatus.textContent = label;
}

/* ---- the run ----------------------------------------------------------- */
let running = false;

async function run() {
  if (running) return;
  if (!HLS_NATIVE) {
    elStatus.textContent = "Native HLS unsupported — open on iOS / Safari.";
    return;
  }
  const cdns = [...selected];
  if (!cdns.length) { elStatus.textContent = "Pick at least one CDN."; return; }

  running = true;
  elRun.disabled = true;
  elRun.textContent = "RUNNING…";
  elResults.innerHTML = "";
  elLog.innerHTML = "";
  doneSteps = 0;
  elBar.style.width = "0%";

  const perCdn = 5 /*manifest*/ + 5 /*cold*/ + 5 * warmReps /*warm*/;
  totalSteps = cdns.length * perCdn;

  const results = {};

  for (const cdn of cdns) {
    const c = CDN[cdn];
    const reels = c.urls.map((u, i) => ({ u, i })).filter((r) => !isPlaceholder(r.u));
    const R = { manifest: [], cold: [], warm: [] };
    results[cdn] = R;
    elPreview.style.setProperty("--accent", c.accent);

    // phase A — manifest RTT
    for (const { u, i } of reels) {
      elPLabel.textContent = `${c.name} · reel ${i + 1} · manifest`;
      const v = await manifestRTT(u);
      R.manifest.push(v);
      log(`${c.name} reel${i + 1} · manifest ${v == null ? "ERR" : Math.round(v) + "ms"}`, c.accent);
      tick(`${c.name}: measuring manifest latency`);
    }
    // top up manifest to fill skipped placeholder reels in progress accounting
    for (let k = reels.length; k < 5; k++) tick();

    // phase B — first frame, COLD (first play of each reel)
    for (const { u, i } of reels) {
      elPLabel.textContent = `${c.name} · reel ${i + 1} · cold`;
      const v = await measureTTFF(u);
      R.cold.push(v);
      log(`${c.name} reel${i + 1} · first frame (cold) ${v == null ? "ERR" : Math.round(v) + "ms"}`, c.accent);
      tick(`${c.name}: cold first-frame`);
      teardown();
      await sleep(SETTLE_MS);
    }
    for (let k = reels.length; k < 5; k++) tick();

    // phase C — first frame, WARM (replays from cache)
    for (let rep = 0; rep < warmReps; rep++) {
      for (const { u, i } of reels) {
        elPLabel.textContent = `${c.name} · reel ${i + 1} · warm ${rep + 1}/${warmReps}`;
        const v = await measureTTFF(u);
        R.warm.push(v);
        tick(`${c.name}: warm first-frame ${rep + 1}/${warmReps}`);
        teardown();
        await sleep(SETTLE_MS);
      }
      for (let k = reels.length; k < 5; k++) tick();
    }
    log(`${c.name} · warm samples: ${R.warm.filter((x) => x != null).length}`, c.accent);

    teardown();
    pushColdSamples(cdn, R.cold);
    renderResults(results);
  }

  elPLabel.textContent = "done";
  elStatus.textContent = "Benchmark complete. Reload the page for fresh cold samples.";
  elRun.disabled = false;
  elRun.textContent = "RUN AGAIN";
  running = false;
}

/* ---- rendering --------------------------------------------------------- */
function renderResults(results) {
  const cdns = Object.keys(results);
  // headline comparison: cold median
  const colds = cdns
    .map((k) => ({ k, s: stats(results[k].cold) }))
    .filter((r) => r.s);
  const maxMed = Math.max(1, ...colds.map((r) => r.s.med));

  let html = `<div class="chart"><h3>First-frame · cold · median</h3>`;
  colds.sort((a, b) => a.s.med - b.s.med).forEach((r) => {
    html += `
      <div class="chartrow" style="--accent:${CDN[r.k].accent}">
        <span class="cw">${CDN[r.k].name}</span>
        <span class="cb"><span style="width:${(r.s.med / maxMed) * 100}%"></span></span>
        <span class="cv">${ms(r.s.med)} ms</span>
      </div>`;
  });
  html += `</div>`;

  // per-cdn cohort cards
  cdns.forEach((k) => {
    const c = CDN[k], R = results[k];
    html += `<div class="rcard" style="--accent:${c.accent}">
      <h3><i></i>${c.name}</h3>
      <div class="cohorts">
        ${cohort("First frame · cold", stats(R.cold))}
        ${cohort("First frame · warm", stats(R.warm))}
        ${cohort("Manifest RTT", stats(R.manifest))}
      </div>
    </div>`;
  });

  elResults.innerHTML = html;
}

function cohort(title, s) {
  if (!s) return `<div class="cohort"><span class="ct">${title}</span><span class="cmed">—</span></div>`;
  return `<div class="cohort">
    <span class="ct">${title}</span>
    <span class="cmed">${ms(s.med)}<small>ms</small></span>
    <span class="crange">${ms(s.min)}–${ms(s.max)} ms · p95 ${ms(s.p95)} · n=${s.n}</span>
  </div>`;
}

elRun.addEventListener("click", run);
if (!HAS_RVFC) log("note: requestVideoFrameCallback unavailable — using loadeddata fallback for first-frame timing.");
