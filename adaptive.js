/* =========================================================================
   CDN Reel Lab — adaptive quality route (/bunny-auto)

   iOS Safari exposes NO network-speed API (navigator.connection is absent),
   so we measure bandwidth actively: stream a ~1.5 MB Range chunk from the CDN
   (cache:'no-store') and divide bytes by elapsed time. Bunny serves
   access-control-allow-origin:* so the body is readable cross-origin.

   Mode: re-probe before EVERY reel, then pick a rendition rung. Manual
   override available via the quality chip (AUTO / 360 / 480 / 720).
   ========================================================================= */

import * as L from "./reelLinks.js";

const RENDITIONS = [
  { 360: L.reel1_b_360, 480: L.reel1_b_480, 720: L.reel1_b_720 },
  { 360: L.reel2_b_360, 480: L.reel2_b_480, 720: L.reel2_b_720 },
  { 360: L.reel3_b_360, 480: L.reel3_b_480, 720: L.reel3_b_720 },
  { 360: L.reel4_b_360, 480: L.reel4_b_480, 720: L.reel4_b_720 },
  { 360: L.reel5_b_360, 480: L.reel5_b_480, 720: L.reel5_b_720 },
];
const RUNGS = [360, 480, 720];
const PROBE_BYTES = 1_500_000;
const PROBE_MS = 4000;

/* throughput -> rung */
function pickRung(mbps) {
  if (mbps == null) return 480;        // measurement failed -> safe middle
  if (mbps < 1.5) return 360;
  if (mbps < 4)   return 480;
  return 720;
}

/* active streaming bandwidth probe (works on iOS Safari) */
async function probeMbps(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), PROBE_MS);
  const t0 = performance.now();
  let received = 0;
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received >= PROBE_BYTES || performance.now() - t0 >= PROBE_MS) {
          ctrl.abort();
          break;
        }
      }
    } else {
      const buf = await res.arrayBuffer();
      received = buf.byteLength;
    }
  } catch (_) { /* abort or network error -> use whatever we measured */ }
  finally { clearTimeout(to); }

  const dt = (performance.now() - t0) / 1000;
  if (received < 50_000 || dt <= 0) return null;
  return (received * 8) / dt / 1e6;
}

/* global quality override: "auto" | 360 | 480 | 720 */
let override = "auto";
let globalMuted = true;

const feed = document.getElementById("feed");
const reels = [];

RENDITIONS.forEach((rend, index) => {
  const reel = document.createElement("section");
  reel.className = "reel";
  reel.appendChild(buildReel(reel, rend, index));
  feed.appendChild(reel);
});
buildDots();

function buildReel(reel, rend, index) {
  const video = document.createElement("video");
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.preload = "none";
  video.disableRemotePlayback = true;
  reel.appendChild(video);

  reel.insertAdjacentHTML("beforeend", `
    <div class="spinner"></div>
    <div class="hud">
      <div class="hud-head">
        <span class="cdn"><i></i>Bunny AUTO</span>
        <span class="idx">REEL ${index + 1}/${RENDITIONS.length}</span>
      </div>
      <div class="row"><span class="k">LINK</span><span class="v" data-m="link">probing…</span></div>
      <div class="row"><span class="k">QUALITY</span><span class="v" data-m="quality">—</span></div>
      <div class="row"><span class="k">STARTUP</span><span class="v" data-m="startup">— ms</span></div>
      <div class="row"><span class="k">STALLS</span><span class="v" data-m="stalls">0</span></div>
      <div class="row"><span class="k">RES</span><span class="v" data-m="res">—</span></div>
      <div class="row"><span class="k">BUFFER</span><span class="v" data-m="buffer">—</span></div>
    </div>
    <button class="hud-toggle" aria-label="show metrics">
      <svg viewBox="0 0 24 24"><path d="M4 18V9M9 18V5M14 18v-6M19 18v-9"/></svg>
    </button>
    <div class="reel-ctrl">
      <button class="qbtn" aria-label="quality">AUTO</button>
      <button class="mute" aria-label="toggle sound"></button>
    </div>
    <div class="sound-hint"><svg width="14" height="14" viewBox="0 0 24 24" fill="#fff"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>Tap for sound</div>
    <div class="pause-flash"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
    <div class="caption">
      <div class="label">BUNNY · ADAPTIVE MP4</div>
      <div class="name">Reel ${String(index + 1).padStart(2, "0")}</div>
      <div class="sub">re-probes bandwidth each reel</div>
    </div>
    <div class="progress"><span></span></div>
  `);

  const hud = reel.querySelector(".hud");
  const m = {
    link: reel.querySelector('[data-m="link"]'),
    quality: reel.querySelector('[data-m="quality"]'),
    startup: reel.querySelector('[data-m="startup"]'),
    stalls: reel.querySelector('[data-m="stalls"]'),
    res: reel.querySelector('[data-m="res"]'),
    buffer: reel.querySelector('[data-m="buffer"]'),
  };
  const muteBtn = reel.querySelector(".mute");
  const qBtn = reel.querySelector(".qbtn");
  const progress = reel.querySelector(".progress span");
  const hint = reel.querySelector(".sound-hint");

  const s = {
    el: reel, video, rend, index,
    placeholder: false,
    t0: null, recorded: false, stalls: 0, stallStart: 0, runToken: 0,
  };

  video.addEventListener("loadedmetadata", () => {
    m.res.textContent = `${video.videoWidth}×${video.videoHeight}`;
  });
  video.addEventListener("playing", () => {
    reel.classList.remove("is-buffering");
    if (s.t0 != null) {
      const ms = performance.now() - s.t0;
      m.startup.textContent = `${Math.round(ms)} ms`;
      gradeStartup(m.startup, ms);
      s.t0 = null;
      s.recorded = true;
    }
    if (s.stallStart) s.stallStart = 0;
  });
  video.addEventListener("waiting", () => {
    reel.classList.add("is-buffering");
    if (!s.stallStart && s.recorded) {
      s.stallStart = performance.now();
      s.stalls++;
      m.stalls.textContent = String(s.stalls);
      m.stalls.classList.toggle("warn", s.stalls > 0);
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

  s.tick = () => {
    if (video.buffered.length) {
      const ahead = video.buffered.end(video.buffered.length - 1) - video.currentTime;
      m.buffer.textContent = `${Math.max(0, ahead).toFixed(1)}s`;
      m.buffer.className = "v " + (ahead > 4 ? "good" : ahead > 1.5 ? "warn" : "bad");
    }
  };

  syncMuteBtn(muteBtn);
  qBtn.textContent = labelFor(override);
  reel.addEventListener("click", (e) => {
    if (e.target.closest(".hud-toggle")) { hud.classList.remove("collapsed"); return; }
    if (e.target.closest(".qbtn")) { cycleQuality(); return; }
    if (e.target.closest(".mute")) { toggleMute(); return; }
    if (e.target.closest(".hud")) { hud.classList.add("collapsed"); return; }
    if (globalMuted) toggleMute(); else togglePlay();
  });

  function toggleMute() {
    globalMuted = !globalMuted;
    reels.forEach((rr) => (rr.video.muted = globalMuted));
    document.querySelectorAll(".reel .mute").forEach(syncMuteBtn);
    if (!globalMuted) { hint.classList.add("fade"); reel.classList.remove("show-hint"); }
  }
  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else { video.pause(); reel.classList.add("flash"); setTimeout(() => reel.classList.remove("flash"), 500); }
  }

  /* activate: (re-)probe, pick rung, load + play. Guarded against fast
     scrolling via runToken so a stale probe never hijacks the current reel. */
  s.activate = async () => {
    const token = ++s.runToken;
    s.recorded = false; s.t0 = null; s.stalls = 0;
    m.stalls.textContent = "0"; m.stalls.classList.remove("warn");
    if (globalMuted) reel.classList.add("show-hint");

    let rung, mbps = null;
    if (override === "auto") {
      m.link.textContent = "probing…";
      m.quality.textContent = "auto · …";
      mbps = await probeMbps(rend[720]);
      if (token !== s.runToken) return; // scrolled away mid-probe
      rung = pickRung(mbps);
      m.link.textContent = mbps == null ? "n/a" : `${mbps.toFixed(1)} Mbps`;
      m.link.className = "v " + (mbps == null ? "" : mbps >= 4 ? "good" : mbps >= 1.5 ? "warn" : "bad");
      m.quality.textContent = `${rung}p · auto`;
    } else {
      rung = override;
      m.link.textContent = "forced";
      m.link.className = "v";
      m.quality.textContent = `${rung}p · manual`;
    }

    video.muted = globalMuted;
    video.setAttribute("src", rend[rung]);
    video.load();
    s.t0 = performance.now();
    video.play().catch(() => {});
  };

  s.deactivate = () => {
    s.runToken++; // cancel any in-flight probe application
    video.pause();
    video.removeAttribute("src");
    video.load();
    reel.classList.remove("show-hint", "is-buffering");
  };

  return s;
}

function cycleQuality() {
  override = override === "auto" ? 360 : override === 720 ? "auto" : RUNGS[RUNGS.indexOf(override) + 1];
  document.querySelectorAll(".reel .qbtn").forEach((b) => (b.textContent = labelFor(override)));
  const r = reels[activeIndex];
  if (r) r.activate();
}
function labelFor(o) { return o === "auto" ? "AUTO" : `${o}p`; }

function syncMuteBtn(btn) {
  btn.innerHTML = globalMuted
    ? `<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.59 3 2.7-2.71-1.42-1.42L15.17 10.6 12.46 7.9 11.05 9.3l2.7 2.71-2.7 2.7 1.41 1.42 2.71-2.71 2.71 2.71 1.42-1.42L16.59 12z"/></svg>`
    : `<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z"/></svg>`;
}

/* active-reel detection */
let activeIndex = -1;
function setActive(i) {
  if (i === activeIndex) return;
  activeIndex = i;
  reels.forEach((r, idx) => {
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

function loop() {
  const r = reels[activeIndex];
  if (r && r.tick) r.tick();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) reels.forEach((r) => r.video.pause());
  else { const r = reels[activeIndex]; if (r) r.video.play().catch(() => {}); }
});

setActive(0);

/* helpers */
function gradeStartup(el, ms) {
  el.className = "v " + (ms < 800 ? "good" : ms < 2000 ? "warn" : "bad");
}
function buildDots() {
  const wrap = document.createElement("div");
  wrap.className = "dots";
  reels.forEach(() => wrap.appendChild(document.createElement("i")));
  document.body.appendChild(wrap);
}
function updateDots(i) {
  document.querySelectorAll(".dots i").forEach((d, idx) => d.classList.toggle("on", idx === i));
}
