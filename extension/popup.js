/**
 * NCII Prompt Risk Detector — popup.js
 */

const API = "http://127.0.0.1:5000";

// ── DOM refs ─────────────────────────────────────────────────────────────────
const serverPill  = document.getElementById("server-pill");
const resultCard  = document.getElementById("result-card");
const pulseDot    = document.getElementById("pulse-dot");
const resultLabel = document.getElementById("result-label");
const resultConf  = document.getElementById("result-conf");
const barFill     = document.getElementById("bar-fill");
const warningMsg  = document.getElementById("warning-msg");
const manualInput = document.getElementById("manual-input");
const analyseBtn  = document.getElementById("analyse-btn");
const statThresh  = document.getElementById("stat-threshold");
const statVocab   = document.getElementById("stat-vocab");

// ── Helpers ───────────────────────────────────────────────────────────────────
function setResult(prediction, confidence) {
  const pct   = Math.round(confidence * 100);
  const state = prediction === "Harmful" ? "harmful" : "safe";

  pulseDot.className    = `pulse-dot ${state}`;
  resultCard.className  = `result-card ${state}`;
  resultLabel.className = `result-label ${state}`;
  barFill.className     = `bar-fill ${state}`;

  resultLabel.textContent = prediction === "Harmful"
    ? "⚠ Harmful Content Detected"
    : "✓ Prompt is Safe";

  resultConf.textContent = `${pct}%`;
  barFill.style.width    = `${pct}%`;

  warningMsg.classList.toggle("show", prediction === "Harmful");
}

function setAnalysing() {
  pulseDot.className    = "pulse-dot";
  resultCard.className  = "result-card";
  resultLabel.className = "result-label idle";
  resultLabel.innerHTML = '<span class="spinner"></span>Analysing…';
  resultConf.textContent = "";
  barFill.style.width   = "30%";
  barFill.className     = "bar-fill";
  barFill.style.background = "#6366f1";
  warningMsg.classList.remove("show");
}

function setIdle() {
  pulseDot.className    = "pulse-dot idle";
  resultCard.className  = "result-card";
  resultLabel.className = "result-label idle";
  resultLabel.textContent = "Awaiting input…";
  resultConf.textContent = "—";
  barFill.style.width = "0%";
  barFill.className = "bar-fill";
  barFill.style.background = "";
}

// ── Check server health & load stats ─────────────────────────────────────────
async function checkHealth() {
  try {
    const res  = await fetch(`${API}/health`, { cache: "no-store" });
    const data = await res.json();

    serverPill.textContent  = "Online";
    serverPill.className    = "status-pill online";
    statThresh.textContent  = data.threshold ?? "—";
    statVocab.textContent   = data.vocab_size
      ? (data.vocab_size >= 1000
        ? (data.vocab_size / 1000).toFixed(1) + "k"
        : data.vocab_size)
      : "—";
  } catch {
    serverPill.textContent = "Offline";
    serverPill.className   = "status-pill offline";
  }
}

// ── Restore last result from storage ─────────────────────────────────────────
chrome.storage.local.get("lastResult", ({ lastResult }) => {
  if (lastResult && Date.now() - lastResult.ts < 30000) {
    setResult(lastResult.prediction, lastResult.confidence);
  } else {
    setIdle();
  }
});

// ── Manual analyse ────────────────────────────────────────────────────────────
async function doAnalyse() {
  const text = manualInput.value.trim();
  if (!text || text.length < 5) return;

  setAnalysing();

  try {
    const res  = await fetch(`${API}/predict`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ prompt: text }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setResult(data.prediction, data.confidence);

    // Also trigger content script overlay on active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: "ANALYSE_NOW",
        text,
      }).catch(() => {}); // tab may not have content script
    }

  } catch (err) {
    resultLabel.textContent = "Error — Is the server running?";
    resultLabel.className   = "result-label idle";
    resultConf.textContent  = "";
    console.error("[NCII popup]", err);
  }
}

analyseBtn.addEventListener("click", doAnalyse);
manualInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doAnalyse();
});

// ── Init ──────────────────────────────────────────────────────────────────────
checkHealth();
