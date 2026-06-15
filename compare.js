/* =========================================================================
   CDN Reel Lab — A/B comparison route

   Two HLS <video> elements stacked vertically, loaded in the SAME frame so
   cold-start latency is a fair race. iOS plays multiple muted inline videos
   fine (well under the ~4 simultaneous-decoder ceiling); only one side holds
   audio at a time.
   ========================================================================= */

import * as L from "./reelLinks.js";

const CDN = {
  bunny: {
    name: "Bunny.net", short: "BUNNY", accent: "#ff9416", host: "b-cdn.net",
    urls: [L.reel1_b, L.reel2_b, L.reel3_b, L.reel4_b, L.reel5_b],
  },
  bunny_mp4: {
    name: "Bunny MP4", short: "B·MP4", accent: "#34d399", host: "b-cdn.net",
    urls: [L.reel1_b_360, L.reel2_b_360, L.reel3_b_360, L.reel4_b_360, L.reel5_b_360],
  },
  mux: {
    name: "Mux", short: "MUX", accent: "#fa50b5", host: "stream.mux.com",
    urls: [L.reel1_m, L.reel2_m, L.reel3_m, L.reel4_m, L.reel5_m],
  },
  cloudflare: {
    name: "Cloudflare", short: "CF", accent: "#f6821f", host: "cloudflarestream.com",
    urls: [L.reel1_cf, L.reel2_cf, L.reel3_cf, L.reel4_cf, L.reel5_cf],
  },
};
const ORDER = ["bunny", "bunny_mp4", "mux", "cloudflare"];
const REELS = 5;

const probe = document.createElement("video");
const HLS_NATIVE = !!probe.canPlayType &&
  (probe.canPlayType("application/vnd.apple.mpegurl") !== "" ||
   probe.canPlayType("application/x-mpegURL") !== "");
const isPlaceholder = (u) => !u || /example\.com/.test(u);

let reelIdx = 0;
let audioSide = null; // "a" | "b" | null  -> which side has sound

/* ---- one comparison side ---------------------------------------------- */
function makeSide(id, defaultCdn) {
  const root = document.querySelector(`.side[data-side="${id}"]`);
  const video = root.querySelector("video");
  const elName = root.querySelector(".s-name");
  const elBig = root.querySelector(".s-startup");
  const elSub = root.querySelector(".s-sub");
  const chip = root.querySelector(".s-cdn");
  const card = root.querySelector(".s-card");

  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.preload = "none";
  video.disableRemotePlayback = true;

  const s = {
    id, cdn: defaultCdn, video,
    t0: null, startup: null, stalls: 0, stallStart: 0, dead: false,
  };

  video.addEventListener("loadedmetadata", () => {
    elSub.textContent = `${video.videoWidth}×${video.videoHeight}`;
  });
  video.addEventListener("playing", () => {
    root.classList.remove("buffering");
    if (s.t0 != null) {
      s.startup = performance.now() - s.t0;
      s.t0 = null;
      elBig.textContent = Math.round(s.startup) + " ms";
      gradeStartup(elBig, s.startup);
      judge();
    }
    if (s.stallStart) s.stallStart = 0;
  });
  video.addEventListener("waiting", () => {
    root.classList.add("buffering");
    if (!s.stallStart && s.startup != null) {
      s.stallStart = performance.now();
      s.stalls++;
      elSub.textContent = `${s.stalls} stall${s.stalls > 1 ? "s" : ""}`;
    }
  });
  video.addEventListener("error", () => {
    if (s.dead) return;
    root.classList.remove("buffering");
    elBig.textContent = "ERR";
    elBig.className = "s-startup bad";
  });

  function paintChip() {
    const c = CDN[s.cdn];
    elName.textContent = c.name;
    chip.textContent = c.short + " ▾";
    root.style.setProperty("--accent", c.accent);
  }

  s.reset = () => {
    s.t0 = null; s.startup = null; s.stalls = 0; s.stallStart = 0; s.dead = false;
    video.pause();
    video.removeAttribute("src");
    video.load();
    root.classList.remove("buffering");
    card.hidden = true;
    video.hidden = false;
    elBig.className = "s-startup";

    const url = CDN[s.cdn].urls[reelIdx];
    if (isPlaceholder(url)) {
      s.dead = true;
      video.hidden = true;
      card.hidden = false;
      card.innerHTML = `<b>${CDN[s.cdn].name}</b><span>no links yet — add them to reelLinks.js</span>`;
      elBig.textContent = "—"; elSub.textContent = "n/a";
    } else if (!HLS_NATIVE) {
      s.dead = true;
      video.hidden = true;
      card.hidden = false;
      card.innerHTML = `<b>Native HLS only</b><span>open on iOS / Safari</span>`;
      elBig.textContent = "—"; elSub.textContent = "n/a";
    } else {
      elBig.textContent = "…"; elSub.textContent = "loading";
    }
  };

  s.start = (t) => {
    if (s.dead) return;
    s.t0 = t;
    video.setAttribute("src", CDN[s.cdn].urls[reelIdx]);
    video.muted = audioSide !== id;
    video.load();
    video.play().catch(() => {});
  };

  // cycle CDN on chip tap (skip the one the other side uses)
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    let i = ORDER.indexOf(s.cdn);
    for (let n = 0; n < ORDER.length; n++) {
      i = (i + 1) % ORDER.length;
      if (ORDER[i] !== otherCdn(id)) break;
    }
    s.cdn = ORDER[i];
    paintChip();
    runTest();
  });

  // tap side -> give it audio
  root.addEventListener("click", () => {
    audioSide = audioSide === id ? null : id;
    applyAudio();
  });

  paintChip();
  return s;
}

/* ---- controller ------------------------------------------------------- */
let sideA, sideB;

function otherCdn(id) {
  return id === "a" ? (sideB && sideB.cdn) : (sideA && sideA.cdn);
}
function applyAudio() {
  [sideA, sideB].forEach((s) => { if (s.video) s.video.muted = audioSide !== s.id; });
  document.querySelectorAll(".side").forEach((el) =>
    el.classList.toggle("has-audio", el.dataset.side === audioSide));
}

function judge() {
  const verdict = document.getElementById("verdict");
  const a = sideA.startup, b = sideB.startup;
  if (a == null || b == null) { verdict.textContent = ""; verdict.className = "verdict"; return; }
  const winner = a < b ? sideA : sideB;
  const delta = Math.abs(a - b);
  verdict.style.setProperty("--accent", CDN[winner.cdn].accent);
  verdict.className = "verdict show";
  verdict.textContent = delta < 30
    ? "dead heat"
    : `${CDN[winner.cdn].name} faster · ${Math.round(delta)} ms`;
}

function runTest() {
  document.getElementById("verdict").className = "verdict";
  sideA.reset();
  sideB.reset();
  // start both in the same frame for a fair cold-start race
  requestAnimationFrame(() => {
    const t = performance.now();
    sideA.start(t);
    sideB.start(t);
    applyAudio();
  });
}

/* reel selector dots */
function buildDots() {
  const wrap = document.getElementById("reeldots");
  for (let i = 0; i < REELS; i++) {
    const b = document.createElement("button");
    b.className = "rdot" + (i === 0 ? " on" : "");
    b.addEventListener("click", () => {
      reelIdx = i;
      wrap.querySelectorAll(".rdot").forEach((d, k) => d.classList.toggle("on", k === i));
      runTest();
    });
    wrap.appendChild(b);
  }
}

/* live buffer readout for active sides */
function loop() {
  [sideA, sideB].forEach((s) => {
    if (!s || s.dead || !s.video.buffered.length) return;
    // nothing extra needed; sub line already shows res/stalls
  });
  requestAnimationFrame(loop);
}

function gradeStartup(el, ms) {
  el.className = "s-startup " + (ms < 800 ? "good" : ms < 2000 ? "warn" : "bad");
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) [sideA, sideB].forEach((s) => s && s.video.pause());
  else [sideA, sideB].forEach((s) => s && !s.dead && s.video.play().catch(() => {}));
});

/* ---- boot ------------------------------------------------------------- */
buildDots();
sideA = makeSide("a", "bunny");
sideB = makeSide("b", "mux");
document.getElementById("rerun").addEventListener("click", runTest);
requestAnimationFrame(loop);
runTest();
