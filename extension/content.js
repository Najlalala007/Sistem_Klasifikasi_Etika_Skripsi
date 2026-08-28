/**
 * NCII Prompt Risk Blocker — content.js  v2.0
 *
 * Detection + hard blocking strategy:
 *   1. Debounced API call on every input change
 *   2. While HARMFUL:
 *      - A transparent shield div is placed over every submit button
 *        (intercepts pointer events before React/the page sees them)
 *      - Native button.disabled = true
 *      - Enter key is blocked in capture phase
 *      - Form submit is blocked in capture phase
 *      - The active textarea gets a red outline + shake on attempt
 *   3. Shields/disabled removed the moment a new Safe result comes in
 */

(function () {
  "use strict";

  const API_URL     = "http://127.0.0.1:5000/predict";
  const DEBOUNCE_MS = 800;
  const MIN_CHARS   = 10;
  const OVERLAY_ID  = "ncii-risk-overlay";

  let debounceTimer  = null;
  let lastPrompt     = "";
  let lastPrediction = null;   // "Harmful" | "Safe" | null (null = analysing/unknown)
  let isAnalysing    = false;

  // ── Submit-button selectors ───────────────────────────────────────────────
  const SUBMIT_SELECTORS = [
    'button[type="submit"]',
    'button[aria-label*="generate" i]',
    'button[aria-label*="create"   i]',
    'button[aria-label*="run"      i]',
    'button[aria-label*="send"     i]',
    'button[class*="generate"      i]',
    'button[class*="submit"        i]',
    'button[class*="send"          i]',
    '[role="button"][class*="generate" i]',
    '[role="button"][class*="submit"   i]',
    '[role="button"][class*="send"     i]',
    'button[data-testid="send-button"]',
    'button[data-testid*="submit"]',
    'form button:last-of-type',
  ].join(",");

  // ── Shield management ─────────────────────────────────────────────────────
  // We create an invisible div that sits exactly on top of each submit button.
  // It swallows all pointer events so the button can never be clicked.

  const shields = new Map(); // element → shield div

  function createShield(btn) {
    if (shields.has(btn)) return;

    const shield = document.createElement("div");
    shield.setAttribute("data-ncii-shield", "1");
    Object.assign(shield.style, {
      position:      "fixed",
      zIndex:        "2147483646",
      cursor:        "not-allowed",
      pointerEvents: "all",
      background:    "transparent",
    });

    shield.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      showBlockedFeedback();
    }, true);

    document.body.appendChild(shield);
    shields.set(btn, shield);
    positionShield(btn, shield);
  }

  function positionShield(btn, shield) {
    const r = btn.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return; // not visible yet
    Object.assign(shield.style, {
      top:    r.top    + "px",
      left:   r.left   + "px",
      width:  r.width  + "px",
      height: r.height + "px",
    });
  }

  function repositionAllShields() {
    shields.forEach((shield, btn) => positionShield(btn, shield));
  }

  function removeAllShields() {
    shields.forEach((shield, btn) => {
      shield.remove();
      // restore disabled state only if we set it
      if (btn.dataset.nciiDisabled) {
        btn.removeAttribute("disabled");
        delete btn.dataset.nciiDisabled;
      }
    });
    shields.clear();
  }

  function applyShieldsToButtons() {
    document.querySelectorAll(SUBMIT_SELECTORS).forEach((btn) => {
      // Also set disabled so keyboard Tab+Enter can't trigger it
      if (!btn.disabled) {
        btn.setAttribute("disabled", "true");
        btn.dataset.nciiDisabled = "1";
      }
      createShield(btn);
    });
  }

  // Reposition on scroll / resize / layout shifts
  window.addEventListener("scroll",  repositionAllShields, { passive: true });
  window.addEventListener("resize",  repositionAllShields, { passive: true });

  // ── Enter / Form blocking (keyboard path) ─────────────────────────────────
  function blockEnter(e) {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (lastPrediction === "Harmful" || isAnalysing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showBlockedFeedback();
    }
  }

  function blockFormSubmit(e) {
    if (lastPrediction === "Harmful" || isAnalysing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showBlockedFeedback();
    }
  }

  // ── Visual feedback on block attempt ─────────────────────────────────────
  function showBlockedFeedback() {
    // Shake + red outline the active textarea
    const active = document.activeElement;
    if (active && (
      active.tagName.toLowerCase() === "textarea" ||
      active.isContentEditable ||
      active.getAttribute("role") === "textbox"
    )) {
      active.classList.add("ncii-blocked-input", "ncii-shake");
      setTimeout(() => active.classList.remove("ncii-shake"), 500);
    }

    // Show panel with blocked banner
    showPanel();
    const banner = document.getElementById("ncii-warning-banner");
    if (banner) {
      banner.classList.add("show");
      banner.textContent =
        "🚫  Submission blocked — harmful NCII content detected. " +
        "Revise your prompt to enable the submit button again.";
    }
    const panel = document.getElementById("ncii-panel");
    if (panel) {
      panel.style.border = "1.5px solid #ef4444";
      setTimeout(() => { panel.style.border = ""; }, 1200);
    }
  }

  // ── Attach input listeners ────────────────────────────────────────────────
  function attachInputListeners() {
    const SEL = [
      "textarea",
      'input[type="text"]',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ].join(",");

    document.querySelectorAll(SEL).forEach((el) => {
      if (el.dataset.nciiWatched) return;
      el.dataset.nciiWatched = "1";
      el.addEventListener("input",   onInput);
      el.addEventListener("keydown", blockEnter, true);
    });

    document.querySelectorAll("form").forEach((form) => {
      if (form.dataset.nciiFormWatched) return;
      form.dataset.nciiFormWatched = "1";
      form.addEventListener("submit", blockFormSubmit, true);
    });
  }

  function onInput(e) {
    const val = (e.target.value || e.target.innerText || "").trim();
    clearTimeout(debounceTimer);

    // While user is editing, reset prediction state to unknown.
    // This keeps shields in place (safe default) until API responds.
    if (lastPrediction === "Safe") {
      lastPrediction = null;
    }

    if (val.length < MIN_CHARS) {
      // Short / cleared — lift any existing block
      lastPrediction = "Safe";
      isAnalysing    = false;
      removeAllShields();
      document.querySelectorAll(".ncii-blocked-input").forEach(el =>
        el.classList.remove("ncii-blocked-input"));
      return;
    }

    debounceTimer = setTimeout(() => analysePrompt(val), DEBOUNCE_MS);
  }

  // ── API call ──────────────────────────────────────────────────────────────
  async function analysePrompt(text) {
    if (text === lastPrompt && lastPrediction !== null) return;
    lastPrompt = text;

    setAnalysing();

    try {
      const res = await fetch(API_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ prompt: text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setResult(data.prediction, data.confidence);
    } catch (err) {
      setError("Cannot reach backend. Is the server running?");
      console.warn("[NCII Blocker] API error:", err.message);
    }
  }

  // ── State transitions ─────────────────────────────────────────────────────
  function setAnalysing() {
    isAnalysing    = true;
    lastPrediction = null;

    // Block while analysing — we don't know yet
    applyShieldsToButtons();

    showPanel();
    setUI({
      dotClass: "analysing",
      labelClass: "",
      labelText: "Analysing…",
      subText:   "Checking prompt for NCII risk",
      barPct: 40, barColor: "#f59e0b",
      banner: false,
    });
  }

  function setResult(prediction, confidence) {
    isAnalysing    = false;
    lastPrediction = prediction;
    const pct      = Math.round(confidence * 100);

    if (prediction === "Harmful") {
      applyShieldsToButtons();
      showPanel();
      setUI({
        dotClass: "harmful", labelClass: "harmful",
        labelText: "⚠ Harmful — Submission Blocked",
        subText:   `Confidence: ${pct}% — fix your prompt to unblock`,
        barPct: pct, barColor: "#ef4444",
        banner: true,
        bannerText: "🚫  Submission blocked — harmful NCII content detected. " +
                    "Revise your prompt to enable the submit button again.",
      });
    } else {
      removeAllShields();
      document.querySelectorAll(".ncii-blocked-input").forEach(el =>
        el.classList.remove("ncii-blocked-input"));
      showPanel();
      setUI({
        dotClass: "safe", labelClass: "safe",
        labelText: "✓ Prompt is Safe — Submission Allowed",
        subText:   `Confidence: ${pct}% — No NCII risk detected`,
        barPct: pct, barColor: "#22c55e",
        banner: false,
      });
    }

    chrome.runtime.sendMessage({ type: "RESULT", prediction, confidence });
  }

  function setError(msg) {
    isAnalysing    = false;
    // On error, remove shields — fail open (don't permanently block)
    removeAllShields();
    ensureOverlay();
    const dot   = document.getElementById("ncii-status-dot");
    const label = document.getElementById("ncii-label");
    const sub   = document.getElementById("ncii-sub");
    if (dot)   { dot.className = ""; }
    if (label) { label.className = ""; label.textContent = "Backend Offline"; }
    if (sub)   { sub.textContent = msg || "Start the Flask server on port 5000."; }
  }

  // ── Overlay UI helpers ────────────────────────────────────────────────────
  function ensureOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;

    const el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.innerHTML = `
      <div id="ncii-panel">
        <div id="ncii-header">
          <span id="ncii-icon">🛡️</span>
          <span id="ncii-title">NCII Risk Blocker</span>
          <button id="ncii-close" title="Dismiss">✕</button>
        </div>
        <div id="ncii-body">
          <div id="ncii-status-dot"></div>
          <div id="ncii-text">
            <div id="ncii-label">Analysing…</div>
            <div id="ncii-sub"></div>
          </div>
        </div>
        <div id="ncii-bar-wrap"><div id="ncii-bar"></div></div>
        <div id="ncii-warning-banner"></div>
      </div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #ncii-risk-overlay {
        position: fixed; bottom: 24px; right: 24px;
        z-index: 2147483647;
        font-family: 'Segoe UI', system-ui, sans-serif;
        pointer-events: none;
      }
      #ncii-panel {
        pointer-events: all; width: 320px; border-radius: 14px;
        overflow: hidden;
        box-shadow: 0 8px 32px rgba(0,0,0,.28), 0 2px 8px rgba(0,0,0,.18);
        background: #0f1117; border: 1px solid rgba(255,255,255,.08);
        transition: opacity .25s, transform .25s, border .3s;
        opacity: 0; transform: translateY(12px);
      }
      #ncii-panel.visible { opacity:1; transform:translateY(0); }
      #ncii-header {
        display:flex; align-items:center; gap:8px;
        padding:12px 16px 10px;
        background:rgba(255,255,255,.04);
        border-bottom:1px solid rgba(255,255,255,.06);
      }
      #ncii-icon { font-size:18px; }
      #ncii-title { flex:1; font-size:13px; font-weight:600; color:#e2e8f0; letter-spacing:.3px; }
      #ncii-close {
        background:none; border:none; color:#64748b; cursor:pointer;
        font-size:14px; line-height:1; padding:2px 4px; border-radius:4px;
        transition:color .15s, background .15s;
      }
      #ncii-close:hover { color:#e2e8f0; background:rgba(255,255,255,.08); }
      #ncii-body { display:flex; align-items:center; gap:14px; padding:14px 16px 10px; }
      #ncii-status-dot {
        width:14px; height:14px; border-radius:50%; flex-shrink:0;
        background:#475569; transition:background .3s, box-shadow .3s;
      }
      #ncii-status-dot.safe    { background:#22c55e; box-shadow:0 0 10px rgba(34,197,94,.5); }
      #ncii-status-dot.harmful { background:#ef4444; box-shadow:0 0 10px rgba(239,68,68,.55); animation:ncii-pulse 1.4s infinite; }
      #ncii-status-dot.analysing { background:#f59e0b; box-shadow:0 0 10px rgba(245,158,11,.4); animation:ncii-blink 1s infinite; }
      @keyframes ncii-pulse  { 0%,100%{box-shadow:0 0 10px rgba(239,68,68,.55)} 50%{box-shadow:0 0 18px rgba(239,68,68,.9)} }
      @keyframes ncii-blink  { 0%,100%{opacity:1} 50%{opacity:.4} }
      #ncii-label { font-size:14px; font-weight:700; color:#f1f5f9; letter-spacing:.2px; }
      #ncii-label.safe    { color:#4ade80; }
      #ncii-label.harmful { color:#f87171; }
      #ncii-sub { font-size:11.5px; color:#64748b; margin-top:2px; line-height:1.4; }
      #ncii-bar-wrap { height:4px; background:rgba(255,255,255,.06); }
      #ncii-bar { height:100%; width:0%; transition:width .4s, background .4s; background:#475569; }
      #ncii-warning-banner {
        display:none; padding:10px 16px;
        background:rgba(239,68,68,.12); border-top:1px solid rgba(239,68,68,.25);
        font-size:12px; color:#fca5a5; line-height:1.5;
      }
      #ncii-warning-banner.show { display:block; }
      [data-ncii-shield] { pointer-events:all !important; }
      @keyframes ncii-shake {
        0%,100%{transform:translateX(0)} 20%{transform:translateX(-6px)}
        40%{transform:translateX(6px)} 60%{transform:translateX(-4px)} 80%{transform:translateX(4px)}
      }
      .ncii-shake { animation:ncii-shake .4s ease !important; }
      .ncii-blocked-input { outline:2px solid #ef4444 !important; outline-offset:2px !important; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(el);

    document.getElementById("ncii-close").addEventListener("click", () => {
      document.getElementById("ncii-panel").classList.remove("visible");
    });
  }

  function showPanel() {
    ensureOverlay();
    document.getElementById("ncii-panel").classList.add("visible");
  }

  function setUI({ dotClass, labelClass, labelText, subText, barPct, barColor, banner, bannerText }) {
    ensureOverlay();
    const dot    = document.getElementById("ncii-status-dot");
    const label  = document.getElementById("ncii-label");
    const sub    = document.getElementById("ncii-sub");
    const bar    = document.getElementById("ncii-bar");
    const banner_ = document.getElementById("ncii-warning-banner");

    if (dot)    { dot.className = dotClass; }
    if (label)  { label.className = labelClass; label.textContent = labelText; }
    if (sub)    { sub.textContent = subText; }
    if (bar)    { bar.style.width = `${barPct}%`; bar.style.background = barColor; }
    if (banner_) {
      if (banner) {
        banner_.classList.add("show");
        if (bannerText) banner_.textContent = bannerText;
      } else {
        banner_.classList.remove("show");
      }
    }
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  function init() {
    ensureOverlay();
    attachInputListeners();
  }

  init();

  // Watch for dynamically added elements (React / SPA)
  const observer = new MutationObserver(() => {
    attachInputListeners();
    // Re-apply shields/repositioning if harmful
    if (lastPrediction === "Harmful" || isAnalysing) {
      applyShieldsToButtons();
    }
    if (lastPrediction === "Harmful" || isAnalysing) {
      repositionAllShields();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Also reposition shields on any animation frame when harmful (layout shifts)
  let rafActive = false;
  function rafLoop() {
    if (lastPrediction === "Harmful" || isAnalysing) {
      repositionAllShields();
      rafActive = true;
      requestAnimationFrame(rafLoop);
    } else {
      rafActive = false;
    }
  }
  // Start raf loop when state becomes harmful
  const _origSetResult = setResult;

  // Messages from popup
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "ANALYSE_NOW" && msg.text) {
      analysePrompt(msg.text);
    }
    if (msg.type === "GET_BLOCK_STATUS") {
      sendResponse({ prediction: lastPrediction, isAnalysing });
    }
  });

})();
