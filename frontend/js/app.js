(() => {
  "use strict";

  // Point this at your deployed backend (Render, etc). Left relative for local dev
  // where the frontend is served by the same origin as the API.
  const API_BASE = window.MUSIC_FINDER_API_BASE || "/api";

  const $ = (sel) => document.querySelector(sel);
  const screens = document.querySelectorAll("[data-screen]");
  const bottomNav = $("#bottomNav");

  function showScreen(id) {
    screens.forEach((s) => (s.hidden = s.id !== id));
    bottomNav.style.display = ["screen-home", "screen-history", "screen-settings"].includes(id)
      ? "flex"
      : "none";
  }

  function setActiveNav(name) {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.nav === name));
  }

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.nav;
      setActiveNav(target);
      if (target === "home") showScreen("screen-home");
      if (target === "history") { renderHistory(); showScreen("screen-history"); }
      if (target === "settings") showScreen("screen-settings");
    });
  });

  // ---------------- Settings ----------------
  const settings = {
    get saveHistory() { return localStorage.getItem("mf_save_history") !== "false"; },
    set saveHistory(v) { localStorage.setItem("mf_save_history", String(v)); },
  };
  const saveHistoryToggle = $("#settingSaveHistory");
  saveHistoryToggle.checked = settings.saveHistory;
  saveHistoryToggle.addEventListener("change", () => (settings.saveHistory = saveHistoryToggle.checked));

  $("#clearHistoryBtn").addEventListener("click", () => {
    if (confirm("Clear all identified songs from history?")) {
      localStorage.removeItem("mf_history");
      renderHistory();
    }
  });

  // ---------------- History (local device only, v1) ----------------
  function getHistory() {
    try { return JSON.parse(localStorage.getItem("mf_history") || "[]"); }
    catch { return []; }
  }

  function addToHistory(result) {
    if (!settings.saveHistory) return;
    const history = getHistory();
    history.unshift({ ...result, identifiedAt: Date.now() });
    localStorage.setItem("mf_history", JSON.stringify(history.slice(0, 100)));
  }

  function renderHistory() {
    const list = $("#historyList");
    const empty = $("#historyEmpty");
    const history = getHistory();
    list.innerHTML = "";
    empty.hidden = history.length > 0;

    for (const item of history) {
      const li = document.createElement("li");
      li.className = "history-item";
      const timeAgo = formatTimeAgo(item.identifiedAt);
      li.innerHTML = `
        ${item.artwork ? `<img class="history-art" src="${escapeAttr(item.artwork)}" alt="">` : `<div class="history-art"></div>`}
        <div class="history-text">
          <p class="history-title">${escapeHtml(item.title)}</p>
          <p class="history-artist">${escapeHtml(item.artist)}</p>
        </div>
        <span class="history-time mono">${timeAgo}</span>
      `;
      list.appendChild(li);
    }
  }

  function formatTimeAgo(ts) {
    const diffMin = Math.round((Date.now() - ts) / 60000);
    if (diffMin < 1) return "now";
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;
    return `${Math.round(diffHr / 24)}d`;
  }

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(str) { return escapeHtml(str); }

  // ---------------- Upload triggers ----------------
  $('[data-action="upload-video"]').addEventListener("click", () => $("#fileInputVideo").click());
  $('[data-action="upload-audio"]').addEventListener("click", () => $("#fileInputAudio").click());
  $("#captureButton").addEventListener("click", () => $("#fileInputVideo").click());
  $("#captureButton").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#fileInputVideo").click(); }
  });

  $("#fileInputVideo").addEventListener("change", (e) => {
    if (e.target.files[0]) recognize(e.target.files[0]);
    e.target.value = "";
  });
  $("#fileInputAudio").addEventListener("change", (e) => {
    if (e.target.files[0]) recognize(e.target.files[0]);
    e.target.value = "";
  });

  // ---------------- Microphone recording ----------------
  let mediaRecorder = null;
  let recordedChunks = [];

  $('[data-action="record-audio"]').addEventListener("click", async () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => e.data.size && recordedChunks.push(e.data);
      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordedChunks, { type: "audio/webm" });
        if (blob.size > 1000) recognize(new File([blob], "recording.webm", { type: "audio/webm" }));
      };
      mediaRecorder.start();
      const btn = document.querySelector('[data-action="record-audio"] span:last-child');
      btn.textContent = "Stop (recording…)";
      setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
        btn.textContent = "Record";
      }, 15000); // auto-stop after 15s of listening
    } catch {
      showError({ message: "Microphone access was denied or unavailable." });
    }
  });

  // ---------------- Recognition pipeline (UI) ----------------
  const STEPS = ["uploading", "extracting", "fingerprinting", "searching", "identifying", "complete"];
  const STEP_LABELS = {
    uploading: "Uploading…",
    extracting: "Extracting audio…",
    fingerprinting: "Creating fingerprint…",
    searching: "Searching music database…",
    identifying: "Identifying song…",
    complete: "Complete",
  };

  let stepTimer = null;

  function setStep(name) {
    $("#progressStatus").textContent = STEP_LABELS[name];
    const items = document.querySelectorAll("#progressSteps li");
    const idx = STEPS.indexOf(name);
    items.forEach((li, i) => {
      li.classList.toggle("done", i < idx);
      li.classList.toggle("active", i === idx);
    });
  }

  function advanceStepsWhileWaiting() {
    // We only get real progress for the upload itself; the rest of the
    // pipeline runs server-side, so step through the remaining labels on a
    // timer to keep the user oriented while we wait for the response.
    let i = 1; // uploading already shown via XHR progress
    setStep(STEPS[i]);
    stepTimer = setInterval(() => {
      i = Math.min(i + 1, STEPS.length - 2); // never auto-advance to "complete"
      setStep(STEPS[i]);
    }, 1400);
  }

  let currentXhr = null;

  function recognize(file) {
    showScreen("screen-recognizing");
    setStep("uploading");

    const form = new FormData();
    form.append("media", file);

    const xhr = new XMLHttpRequest();
    currentXhr = xhr;
    xhr.open("POST", `${API_BASE}/recognize`);

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        $("#progressStatus").textContent = `Uploading… ${pct}%`;
        if (pct >= 100) advanceStepsWhileWaiting();
      }
    });

    xhr.onload = () => {
      clearInterval(stepTimer);
      let data;
      try { data = JSON.parse(xhr.responseText); }
      catch { return showError({ message: "Unexpected response from the server." }); }

      if (xhr.status >= 200 && xhr.status < 300 && data.status === "ok") {
        setStep("complete");
        setTimeout(() => showResult(data.result), 250);
      } else if (data.status === "no_match") {
        showNoMatch(data.message);
      } else {
        showError(data);
      }
    };

    xhr.onerror = () => {
      clearInterval(stepTimer);
      showError({ message: "Network error — check your connection and try again." });
    };

    xhr.send(form);
  }

  $("#cancelRecognize").addEventListener("click", () => {
    if (currentXhr) currentXhr.abort();
    clearInterval(stepTimer);
    showScreen("screen-home");
  });

  // ---------------- Result screens ----------------
  function showResult(result) {
    $("#resultTitle").textContent = result.title;
    $("#resultArtist").textContent = result.artist;
    $("#resultConfidence").textContent = result.confidence ? `${result.confidence}% match` : "match";

    const metaParts = [];
    if (result.album) metaParts.push(result.album);
    if (result.releaseDate) metaParts.push(result.releaseDate.slice(0, 4));
    $("#resultMeta").textContent = metaParts.join(" · ");

    const img = $("#resultArtwork");
    const fallback = $("#artworkFallback");
    if (result.artwork) {
      img.src = result.artwork;
      img.style.display = "block";
      fallback.style.display = "none";
      img.onerror = () => { img.style.display = "none"; fallback.style.display = "flex"; };
    } else {
      img.style.display = "none";
      fallback.style.display = "flex";
    }

    $("#linkYoutube").href = result.links?.youtube || "#";
    $("#linkSpotify").href = result.links?.spotify || "#";
    $("#linkAppleMusic").href = result.links?.appleMusic || "#";

    addToHistory(result);
    showScreen("screen-result");
  }

  function showNoMatch(message) {
    if (message) $("#noMatchMessage").textContent = message;
    showScreen("screen-no-match");
  }

  function showError(data) {
    $("#errorMessage").textContent = data?.message || "Please try again.";
    showScreen("screen-error");
  }

  $("#resultBack").addEventListener("click", () => { setActiveNav("home"); showScreen("screen-home"); });
  $("#findAnotherBtn").addEventListener("click", () => { setActiveNav("home"); showScreen("screen-home"); });
  $("#tryAgainBtn").addEventListener("click", () => { setActiveNav("home"); showScreen("screen-home"); });
  $("#errorRetryBtn").addEventListener("click", () => { setActiveNav("home"); showScreen("screen-home"); });

  // ---------------- init ----------------
  showScreen("screen-home");
})();
