/**
 * NCII Prompt Risk Detector — background.js (service worker)
 * Handles badge updates and cross-tab state.
 */

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== "RESULT") return;

  const tabId = sender?.tab?.id;
  if (!tabId) return;

  if (msg.prediction === "Harmful") {
    chrome.action.setBadgeText({ text: "!", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444", tabId });
  } else {
    chrome.action.setBadgeText({ text: "✓", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#22c55e", tabId });
  }

  // Store last result for popup to read
  chrome.storage.local.set({
    lastResult: {
      prediction: msg.prediction,
      confidence: msg.confidence,
      tabId,
      ts: Date.now(),
    },
  });
});

// Clear badge when navigating to a new page
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.action.setBadgeText({ text: "", tabId });
    chrome.storage.local.remove("lastResult");
  }
});
