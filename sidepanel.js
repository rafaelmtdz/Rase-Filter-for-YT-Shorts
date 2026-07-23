const DEFAULTS = {
  enabled: true,
  minViews: 1000000,
  ageEnabled: false,
  maxAgeDays: 30,
  durationEnabled: true,
  maxDurationSeconds: 28,
  blockedLanguages: ["pt"],
  showBigViews: true,
  strictLanguage: false,
  skipAds: true,
  soundEnabled: true,
  volumePercent: 100,
  soundMuted: false,
  savedVideos: []
};

const LANGUAGES = {
  pt: "Português", en: "Inglês", es: "Espanhol", hi: "Hindi",
  id: "Indonésio", ar: "Árabe", fr: "Francês", de: "Alemão",
  ru: "Russo", ja: "Japonês", ko: "Coreano", zh: "Chinês"
};

let state = { ...DEFAULTS };
let pendingSave = {};
let saveTimer = null;

init();

async function init() {
  state = { ...DEFAULTS, ...await chrome.storage.local.get(DEFAULTS) };
  render();
  bind();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key in changes) state[key] = changes[key].newValue;
    renderSaved();
  });
}

function bind() {
  for (const id of [
    "enabled", "ageEnabled", "durationEnabled", "strictLanguage",
    "showBigViews", "skipAds", "soundEnabled"
  ]) {
    document.getElementById(id).addEventListener("change", (event) => {
      save({ [id]: event.target.checked });
      if (id === "soundEnabled") updateSoundUI();
    });
  }

  document.getElementById("minViews").addEventListener("change", (event) => setViews(event.target.value));
  document.getElementById("minViewsRange").addEventListener("input", (event) => setViews(event.target.value));
  document.getElementById("maxAgeDays").addEventListener("change", (event) => {
    save({ maxAgeDays: Math.max(0, Number(event.target.value) || 0) });
  });

  const durationSlider = document.getElementById("maxDurationSeconds");
  durationSlider.addEventListener("input", (event) => {
    const value = clamp(Number(event.target.value) || 28, 1, 180);
    state.maxDurationSeconds = value;
    updateDurationLabel();
    queueSave({ maxDurationSeconds: value });
  });
  durationSlider.addEventListener("change", flushSave);

  const volumeSlider = document.getElementById("volumePercent");
  volumeSlider.addEventListener("input", (event) => {
    const value = clamp(Number(event.target.value) || 0, 0, 100);
    state.volumePercent = value;
    state.soundMuted = value === 0;
    updateSoundUI();
    queueSave({ volumePercent: value, soundMuted: state.soundMuted });
  });
  volumeSlider.addEventListener("change", flushSave);

  document.getElementById("muteToggle").addEventListener("click", () => {
    state.soundMuted = !state.soundMuted;
    if (!state.soundMuted && state.volumePercent === 0) state.volumePercent = 50;
    updateSoundUI();
    save({ soundMuted: state.soundMuted, volumePercent: state.volumePercent });
  });

  document.querySelectorAll("[data-v]").forEach((button) => {
    button.onclick = () => setViews(button.dataset.v);
  });

  document.getElementById("languages").addEventListener("change", () => {
    save({
      blockedLanguages: [...document.querySelectorAll(".lang input:checked")].map((input) => input.value)
    });
  });

  document.getElementById("searchSaved").oninput = renderSaved;
  document.getElementById("clearSaved").onclick = () => {
    if (confirm("Apagar todos os vídeos salvos?")) save({ savedVideos: [] });
  };

  document.getElementById("savedList").onclick = (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const id = button.dataset.id;

    if (button.dataset.action === "open") {
      chrome.runtime.sendMessage({ type: "OPEN_VIDEO", url: `https://www.youtube.com/shorts/${id}` });
    }
    if (button.dataset.action === "remove") {
      save({ savedVideos: (state.savedVideos || []).filter((video) => video.videoId !== id) });
    }
  };
}

function render() {
  for (const id of [
    "enabled", "ageEnabled", "durationEnabled", "strictLanguage",
    "showBigViews", "skipAds", "soundEnabled"
  ]) {
    document.getElementById(id).checked = Boolean(state[id]);
  }

  document.getElementById("minViews").value = state.minViews;
  document.getElementById("minViewsRange").value = Math.min(100000000, state.minViews);
  document.getElementById("maxAgeDays").value = state.maxAgeDays;
  document.getElementById("maxDurationSeconds").value = state.maxDurationSeconds;
  document.getElementById("volumePercent").value = state.volumePercent;

  updateDurationLabel();
  updateSoundUI();

  document.getElementById("languages").innerHTML = Object.entries(LANGUAGES)
    .map(([key, label]) => `<label class="lang"><input type="checkbox" value="${key}" ${(state.blockedLanguages || []).includes(key) ? "checked" : ""}> ${label}</label>`)
    .join("");

  renderSaved();
}

function updateDurationLabel() {
  const seconds = Number(state.maxDurationSeconds) || 28;
  document.getElementById("durationValue").textContent = seconds < 60
    ? `${seconds} segundos`
    : `${Math.floor(seconds / 60)}min ${seconds % 60 ? `${seconds % 60}s` : ""}`.trim();
}

function updateSoundUI() {
  const enabled = Boolean(state.soundEnabled);
  const muted = Boolean(state.soundMuted) || Number(state.volumePercent) === 0;
  const volume = clamp(Number(state.volumePercent) || 0, 0, 100);
  const slider = document.getElementById("volumePercent");
  const button = document.getElementById("muteToggle");

  slider.value = String(volume);
  slider.disabled = !enabled;
  button.disabled = !enabled;
  button.textContent = muted ? "🔇" : volume < 50 ? "🔉" : "🔊";
  button.title = muted ? "Ativar som" : "Silenciar";
  document.getElementById("volumeValue").textContent = muted ? "Mudo" : `${volume}%`;
}

function renderSaved() {
  const search = (document.getElementById("searchSaved")?.value || "").toLowerCase();
  const list = (state.savedVideos || []).filter((video) =>
    `${video.title} ${video.author} ${video.language}`.toLowerCase().includes(search)
  );

  document.getElementById("savedList").innerHTML = list.length
    ? list.map((video) => `<article class="saved">
        <img src="${esc(video.thumbnail || `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`)}">
        <div class="savedBody">
          <div class="savedTitle">${esc(video.title || "Sem título")}</div>
          <div class="savedMeta">${fmt(video.viewCount)} · ${duration(video.lengthSeconds)} · ${(video.language || "?").toUpperCase()}</div>
          <div class="savedActions">
            <button data-action="open" data-id="${video.videoId}">Abrir</button>
            <button data-action="remove" data-id="${video.videoId}">Remover</button>
          </div>
        </div>
      </article>`).join("")
    : '<div class="empty">Nenhum vídeo salvo ainda.</div>';
}

function setViews(value) {
  const number = Math.max(0, Number(value) || 0);
  document.getElementById("minViews").value = number;
  document.getElementById("minViewsRange").value = Math.min(100000000, number);
  save({ minViews: number });
}

function queueSave(patch) {
  state = { ...state, ...patch };
  pendingSave = { ...pendingSave, ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 120);
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!Object.keys(pendingSave).length) return;
  const patch = pendingSave;
  pendingSave = {};
  await chrome.storage.local.set(patch);
}

async function save(patch) {
  state = { ...state, ...patch };
  await chrome.storage.local.set(patch);
  if ("savedVideos" in patch) renderSaved();
}

function duration(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? `${Math.floor(number / 60)}:${String(number % 60).padStart(2, "0")}`
    : "?";
}

function fmt(number) {
  number = Number(number) || 0;
  if (number >= 1e9) return `${(number / 1e9).toFixed(1)}B`;
  if (number >= 1e6) return `${(number / 1e6).toFixed(1)}M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(1)}K`;
  return String(number);
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
