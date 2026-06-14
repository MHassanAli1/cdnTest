/* =========================================================================
   CDN Reel Lab — feed engine (no libraries, native HLS)

   Design goals:
   - Native HLS playback (<video> + .m3u8). On iOS Safari this needs zero
     JS decoder, which is the "no decoder problem" path the brief asked for.
   - Decoder windowing: iOS limits simultaneous hardware video decoders, so
     we only keep src attached on the active reel +/- 1 and release the rest.
   - Real per-reel telemetry for CDN speed comparison + a localStorage
     aggregate the landing page reads.
   ========================================================================= */

import * as L from "./reelLinks.js";

const CDN = {
  bunny: {
    name: "Bunny.net",
    label: "BUNNY STREAM",
    host: "b-cdn.net",
    urls: [L.reel1_b, L.reel2_b, L.reel3_b, L.reel4_b, L.reel5_b],
  },
  mux: {
    name: "Mux",
    label: "MUX VIDEO",
    host: "stream.mux.com",
    urls: [L.reel1_m, L.reel2_m, L.reel3_m, L.reel4_m, L.reel5_m],
  },
  cloudflare: {
    name: "Cloudflare",
    label: "CLOUDFLARE STREAM",
    host: "cloudflarestream.com",
    urls: [L.reel1_cf, L.reel2_cf, L.reel3_cf, L.reel4_cf, L.reel5_cf],
  },
};

const cdnKey = document.body.dataset.cdn;
const cfg = CDN[cdnKey];

/* ---- capability detection -------------------------------------------- */
const probe = document.createElement("video");
const HLS_NATIVE =
  !!probe.canPlayType &&
  (probe.canPlayType("application/vnd.apple.mpegurl") !== "" ||
    probe.canPlayType("application/x-mpegURL") !== "");

const isPlaceholder = (u) => !u || /example\.com/.test(u);

/* ---- shared mute state (Instagram-style: persists across reels) ------ */
let globalMuted = true;

/* =========================================================================
   Throughput observer (best-effort).
   Segment fetches from the CDN host are timed via Resource Timing. Cross-
   origin responses without Timing-Allow-Origin report transferSize 0, in
   which case we simply report "—" rather than a fake number.
   ========================================================================= */
const throughput = { bytes: 0, ms: 0, samples: 0 };
if (window.PerformanceObserver) {
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.name.includes(cfg.host)) continue;
        if (e.initiatorType !== "fetch" && e.initiatorType !== "xmlhttprequest" &&
            e.initiatorType !== "other" && e.initiatorType !== "video") continue;
        if (e.transferSize > 0 && e.duration > 0) {
          throughput.bytes += e.transferSize;
          throughput.ms += e.duration;
          throughput.samples++;
        }
      }
    });
    po.observe({ type: "resource", buffered: true });
  } catch (_) { /* unsupported entry type — ignore */ }
}
function throughputMbps() {
  if (throughput.samples === 0 || throughput.ms === 0) return null;
  return (throughput.bytes * 8) / (throughput.ms / 1000) / 1e6;
}

/* =========================================================================
   Aggregate stats persisted across routes for the landing comparison.
   ========================================================================= */
const STORE_KEY = "cdnReelLab.stats.v1";
function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
  catch (_) { return {}; }
}
function recordColdStartup(ms) {
  const s = loadStore();
  const e = (s[cdnKey] = s[cdnKey] || { startups: [], stalls: 0, plays: 0, updated: 0 });
  e.startups.push(Math.round(ms));
  if (e.startups.length > 25) e.startups.shift();
  e.updated = Date.now();
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (_) {}
}
function bumpStall() {
  const s = loadStore();
  const e = (s[cdnKey] = s[cdnKey] || { startups: [], stalls: 0, plays: 0, updated: 0 });
  e.stalls++;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (_) {}
}

/* =========================================================================
   Build the feed
   ========================================================================= */
const feed = document.getElementById("feed");
const reels = [];

cfg.urls.forEach((url, i) => {
  const reel = document.createElement("section");
  reel.className = "reel";

  if (isPlaceholder(url)) {
    reel.appendChild(placeholderCard(url));
    feed.appendChild(reel);
    reels.push({ el: reel, video: null, placeholder: true });
    return;
  }
  if (!HLS_NATIVE) {
    reel.appendChild(unsupportedCard());
    feed.appendChild(reel);
    reels.push({ el: reel, video: null, placeholder: true });
    return;
  }

  const r = buildReel(reel, url, i);
  feed.appendChild(reel);
  reels.push(r);
});

buildDots();

/* =========================================================================
   Reel construction + telemetry wiring
   ========================================================================= */
function buildReel(reel, url, index) {
  const video = document.createElement("video");
  video.muted = true;          // required for iOS autoplay
  video.defaultMuted = true;
  video.loop = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.preload = "none";      // cold-load only when activated -> honest startup metric
  video.disableRemotePlayback = true;
  reel.appendChild(video);

  reel.insertAdjacentHTML("beforeend", `
    <div class="spinner"></div>
    <div class="hud">
      <div class="hud-head">
        <span class="cdn"><i></i>${cfg.name}</span>
        <span class="idx">REEL ${index + 1}/${cfg.urls.length}</span>
      </div>
      <div class="row"><span class="k">STARTUP</span><span class="v" data-m="startup">— ms</span></div>
      <div class="row"><span class="k">STALLS</span><span class="v" data-m="stalls">0</span></div>
      <div class="row"><span class="k">RES</span><span class="v" data-m="res">—</span></div>
      <div class="row"><span class="k">BUFFER</span><span class="v" data-m="buffer">—</span></div>
      <div class="row"><span class="k">THRPUT</span><span class="v" data-m="thrput">—</span></div>
    </div>
    <button class="hud-toggle" aria-label="show metrics">
      <svg viewBox="0 0 24 24"><path d="M4 18V9M9 18V5M14 18v-6M19 18v-9"/></svg>
    </button>
    <div class="reel-ctrl">
      <button class="mute" aria-label="toggle sound"></button>
    </div>
    <div class="sound-hint"><svg width="14" height="14" viewBox="0 0 24 24" fill="#fff"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>Tap for sound</div>
    <div class="pause-flash"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
    <div class="caption">
      <div class="label">${cfg.label}</div>
      <div class="name">Reel ${String(index + 1).padStart(2, "0")}</div>
      <div class="sub">${shortHost(url)}</div>
    </div>
    <div class="progress"><span></span></div>
  `);

  const hud = reel.querySelector(".hud");
  const m = {
    startup: reel.querySelector('[data-m="startup"]'),
    stalls: reel.querySelector('[data-m="stalls"]'),
    res: reel.querySelector('[data-m="res"]'),
    buffer: reel.querySelector('[data-m="buffer"]'),
    thrput: reel.querySelector('[data-m="thrput"]'),
  };
  const muteBtn = reel.querySelector(".mute");
  const progress = reel.querySelector(".progress span");
  const hint = reel.querySelector(".sound-hint");

  const state = {
    el: reel, video, url, index,
    placeholder: false,
    t0: null, coldStartup: null, recorded: false,
    stalls: 0, stallStart: 0,
  };

  /* --- telemetry events --- */
  video.addEventListener("loadedmetadata", () => {
    m.res.textContent = `${video.videoWidth}×${video.videoHeight}`;
  });

  video.addEventListener("playing", () => {
    reel.classList.remove("is-buffering");
    if (state.t0 != null) {
      const ms = performance.now() - state.t0;
      m.startup.textContent = `${Math.round(ms)} ms`;
      gradeStartup(m.startup, ms);
      if (!state.recorded) {
        state.coldStartup = ms;
        state.recorded = true;
        recordColdStartup(ms);
      }
      state.t0 = null;
    }
    if (state.stallStart) {
      state.stallStart = 0;
    }
  });

  video.addEventListener("waiting", () => {
    reel.classList.add("is-buffering");
    if (!state.stallStart && state.recorded) {
      state.stallStart = performance.now();
      state.stalls++;
      m.stalls.textContent = String(state.stalls);
      m.stalls.classList.toggle("warn", state.stalls > 0);
      bumpStall();
    }
  });

  video.addEventListener("error", () => {
    reel.classList.remove("is-buffering");
    m.startup.textContent = "ERR";
    m.startup.className = "v bad";
  });

  video.addEventListener("timeupdate", () => {
    if (video.duration) progress.style.width = (video.currentTime / video.duration) * 100 + "%";
  });

  /* live buffer/throughput readout while active */
  state.tick = () => {
    if (video.buffered.length) {
      const ahead = video.buffered.end(video.buffered.length - 1) - video.currentTime;
      m.buffer.textContent = `${Math.max(0, ahead).toFixed(1)}s`;
      m.buffer.className = "v " + (ahead > 4 ? "good" : ahead > 1.5 ? "warn" : "bad");
    }
    const tp = throughputMbps();
    m.thrput.textContent = tp ? `${tp.toFixed(1)} Mbps` : "—";
  };

  /* --- interactions --- */
  syncMuteBtn(muteBtn);
  reel.addEventListener("click", (e) => {
    if (e.target.closest(".hud-toggle")) { hud.classList.remove("collapsed"); return; }
    if (e.target.closest(".mute")) { toggleMute(); return; }
    if (e.target.closest(".hud")) { hud.classList.add("collapsed"); return; }
    // tap on video body: first tap unmutes, later taps play/pause
    if (globalMuted) { toggleMute(); }
    else { togglePlay(); }
  });

  function toggleMute() {
    globalMuted = !globalMuted;
    applyMute();
    if (!globalMuted) {
      hint.classList.add("fade");
      reel.classList.remove("show-hint");
    }
  }
  function applyMute() {
    reels.forEach((rr) => { if (rr.video) rr.video.muted = globalMuted; });
    document.querySelectorAll(".reel .mute").forEach(syncMuteBtn);
  }
  function togglePlay() {
    if (video.paused) { video.play().catch(() => {}); }
    else { video.pause(); reel.classList.add("flash"); setTimeout(() => reel.classList.remove("flash"), 500); }
  }

  state.activate = () => {
    if (state.t0 == null && !state.recorded) state.t0 = performance.now();
    else if (state.t0 == null) state.t0 = performance.now(); // warm re-measure
    video.muted = globalMuted;
    video.play().catch(() => {});
    if (globalMuted) reel.classList.add("show-hint");
  };
  state.deactivate = () => {
    video.pause();
    reel.classList.remove("show-hint");
  };

  return state;
}

function syncMuteBtn(btn) {
  btn.innerHTML = globalMuted
    ? `<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.59 3 2.7-2.71-1.42-1.42L15.17 10.6 12.46 7.9 11.05 9.3l2.7 2.71-2.7 2.7 1.41 1.42 2.71-2.71 2.71 2.71 1.42-1.42L16.59 12z"/></svg>`
    : `<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z"/></svg>`;
}

/* =========================================================================
   Decoder windowing + active-reel detection
   ========================================================================= */
let activeIndex = -1;

function setActive(i) {
  if (i === activeIndex) return;
  activeIndex = i;

  reels.forEach((r, idx) => {
    if (r.placeholder) return;
    const near = Math.abs(idx - i) <= 1; // keep active +/- 1 ready

    if (near) {
      if (!r.video.getAttribute("src")) {
        r.video.setAttribute("src", r.url);
        r.video.load();
      }
    } else if (r.video.getAttribute("src")) {
      // release decoder + memory for far reels
      r.deactivate();
      r.video.removeAttribute("src");
      r.video.load();
    }

    if (idx === i) r.activate();
    else r.deactivate();
  });

  updateDots(i);
}

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting && e.intersectionRatio >= 0.6) {
      const idx = reels.findIndex((r) => r.el === e.target);
      if (idx !== -1) setActive(idx);
    }
  }
}, { threshold: [0.6] });

reels.forEach((r) => io.observe(r.el));

/* drive live HUD updates for the active reel only (one rAF loop) */
function loop() {
  const r = reels[activeIndex];
  if (r && r.tick) r.tick();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* pause everything when tab is hidden (saves battery + decoder) */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) reels.forEach((r) => r.video && r.video.pause());
  else { const r = reels[activeIndex]; if (r && r.activate) r.activate(); }
});

/* kick off the first reel */
setActive(0);

/* =========================================================================
   Helpers / UI bits
   ========================================================================= */
function gradeStartup(el, ms) {
  el.className = "v " + (ms < 800 ? "good" : ms < 2000 ? "warn" : "bad");
}

function shortHost(u) {
  try { return new URL(u).hostname; } catch (_) { return u; }
}

function placeholderCard(url) {
  const d = document.createElement("div");
  d.className = "placeholder";
  d.innerHTML = `
    <div class="pglyph">🚧</div>
    <h2>Not wired up yet</h2>
    <p>Cloudflare Stream URLs aren't configured. Drop real <code>.m3u8</code> playlist links into <b>reelLinks.js</b> and this route lights up automatically.</p>
    <code>${url || "https://…cloudflarestream.com/&lt;id&gt;/manifest/video.m3u8"}</code>`;
  return d;
}

function unsupportedCard() {
  const d = document.createElement("div");
  d.className = "placeholder";
  d.innerHTML = `
    <div class="pglyph">📱</div>
    <h2>Open on iOS Safari</h2>
    <p>This lab uses <b>native HLS</b> (no JS decoder library, by design). Your browser can't play <code>.m3u8</code> natively. Open it on an iPhone/iPad or desktop Safari for the real CDN test.</p>`;
  return d;
}

function buildDots() {
  const wrap = document.createElement("div");
  wrap.className = "dots";
  reels.forEach(() => wrap.appendChild(document.createElement("i")));
  document.body.appendChild(wrap);
}
function updateDots(i) {
  const dots = document.querySelectorAll(".dots i");
  dots.forEach((d, idx) => d.classList.toggle("on", idx === i));
}
