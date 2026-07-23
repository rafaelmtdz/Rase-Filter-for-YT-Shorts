(() => {
  "use strict";

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

  const LANGS = {
    pt: ["português", "portugues", "você", "voce", "não", "nao", "para", "uma", "com", "isso", "hoje", "aqui"],
    en: ["the", "you", "this", "that", "with", "for", "what", "today"],
    es: ["que", "para", "una", "con", "esto", "hoy", "como", "pero"],
    hi: ["है", "के", "का", "की", "में", "और", "यह", "को"],
    id: ["yang", "dan", "ini", "untuk", "dengan", "tidak", "dari"],
    ar: ["في", "من", "على", "هذا", "التي", "الى"],
    fr: ["le", "la", "les", "une", "avec", "pour", "pas"],
    de: ["der", "die", "das", "und", "mit", "für"],
    ru: ["это", "что", "как", "для", "не", "на"],
    ja: ["です", "ます", "の", "に", "は", "を"],
    ko: ["입니다", "에서", "이", "가", "을", "를"],
    zh: ["的", "了", "是", "在", "我", "你"]
  };

  const FILTER_KEYS = new Set([
    "enabled", "minViews", "ageEnabled", "maxAgeDays", "durationEnabled",
    "maxDurationSeconds", "blockedLanguages", "strictLanguage", "skipAds"
  ]);
  const SOUND_KEYS = new Set(["soundEnabled", "volumePercent", "soundMuted"]);
  const pauseState = new WeakMap();

  let settings = { ...DEFAULTS };
  let currentId = "";
  let serial = 0;
  let gate;
  let hud;
  let currentData;
  let lastUrl = location.href;
  let adSkipLocked = false;

  boot();

  async function boot() {
    settings = { ...DEFAULTS, ...await chrome.storage.local.get(DEFAULTS) };
    ensureUI();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const keys = Object.keys(changes);
      for (const key of keys) settings[key] = changes[key].newValue;

      if (keys.some((key) => SOUND_KEYS.has(key))) applySoundSettings();

      if (keys.includes("showBigViews")) {
        if (settings.showBigViews && currentData) renderHud(currentData);
        else hud.classList.remove("show");
      }

      if (keys.includes("savedVideos") && currentData && settings.showBigViews) {
        renderHud(currentData);
      }

      if (keys.some((key) => FILTER_KEYS.has(key))) {
        currentId = "";
        void evaluate();
      }
    });

    // Mantido como na base estável: observa a navegação dinâmica do feed.
    new MutationObserver(() => {
      positionHud();
      void evaluate();
    }).observe(document.documentElement, { childList: true, subtree: true });

    addEventListener("yt-navigate-finish", () => {
      currentId = "";
      void evaluate();
    }, true);

    addEventListener("resize", positionHud, { passive: true });

    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        currentId = "";
        void evaluate();
      }
      positionHud();
    }, 180);

    void evaluate();
  }

  async function evaluate() {
    if (!settings.enabled || !isShort()) {
      allowNoFilter();
      return;
    }

    if (settings.skipAds && isCurrentShortAd()) {
      await skipAd();
      return;
    }

    const id = getId();
    if (!id || id === currentId) return;

    currentId = id;
    const request = ++serial;
    checking();

    const result = await fetchData(id);
    if (request !== serial || id !== getId()) return;

    if (!result?.ok) {
      reject("Não foi possível ler os dados");
      return;
    }

    currentData = result;
    const reason = rejectReason(result);
    if (reason) {
      reject(reason);
      return;
    }

    allow(result);
  }

  function rejectReason(data) {
    if (data.viewCount < Number(settings.minViews || 0)) {
      return `${fmt(data.viewCount)} views — mínimo ${fmt(settings.minViews)}`;
    }

    if (settings.ageEnabled) {
      const age = ageInDays(data.publishDate);
      if (age == null) return "Data de publicação não encontrada";
      if (age > Number(settings.maxAgeDays || 0)) {
        return `Publicado há ${age} dias — máximo ${settings.maxAgeDays}`;
      }
    }

    if (settings.durationEnabled) {
      if (!Number.isFinite(Number(data.lengthSeconds))) return "Duração não encontrada";
      if (Number(data.lengthSeconds) > Number(settings.maxDurationSeconds || 180)) {
        return `${formatDuration(data.lengthSeconds)} — máximo ${settings.maxDurationSeconds}s`;
      }
    }

    const language = detectLanguage(data);
    if (language && settings.blockedLanguages?.includes(language)) {
      return `Idioma bloqueado: ${language.toUpperCase()}`;
    }
    if (!language && settings.strictLanguage && settings.blockedLanguages?.length) {
      return "Idioma não identificado";
    }
    return "";
  }

  function detectLanguage(data) {
    const hints = (data.languageHints || []).map((value) => String(value).split("-")[0]);
    if (hints.length) return hints[0];

    const text = `${data.title || ""} ${data.description || ""}`.toLowerCase();
    let best = null;
    let score = 0;

    for (const [language, tokens] of Object.entries(LANGS)) {
      let matches = 0;
      for (const token of tokens) if (text.includes(token)) matches++;
      if (matches > score) {
        best = language;
        score = matches;
      }
    }
    return score >= 2 ? best : null;
  }

  function checking() {
    document.documentElement.dataset.raseState = "checking";
    showGate("Analisando Short…", "Views, data, idioma e duração");
    pause();
    hud.classList.remove("show");
  }

  function allow(data) {
    document.documentElement.dataset.raseState = "allowed";
    hideGate();
    resume();
    renderHud(data);
  }

  function allowNoFilter() {
    document.documentElement.dataset.raseState = "allowed";
    hideGate();
    resume();
    hud?.classList.remove("show");
  }

  async function reject(reason) {
    showGate("Procurando o próximo…", reason);
    await sleep(130);
    next();
  }

  async function fetchData(id) {
    try {
      return await chrome.runtime.sendMessage({ type: "GET_VIDEO_DATA", videoId: id });
    } catch {
      return null;
    }
  }

  function next() {
    for (const selector of [
      "#navigation-button-down button",
      "button[aria-label='Next video']",
      "button[aria-label='Próximo vídeo']",
      "button[aria-label*='Next']",
      "button[aria-label*='Próximo']"
    ]) {
      const button = document.querySelector(selector);
      if (button && button.offsetParent) {
        button.click();
        return;
      }
    }

    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40, bubbles: true
    }));
    setTimeout(() => scrollBy(0, innerHeight), 250);
  }

  function isCurrentShortAd() {
    const active = document.querySelector("ytd-reel-video-renderer[is-active]")
      || document.querySelector("ytd-reel-video-renderer[aria-hidden='false']")
      || document.querySelector("ytd-reel-video-renderer");
    if (!active) return false;

    for (const selector of [
      "ytd-ad-slot-renderer", "ytd-promoted-video-renderer",
      "ytm-promoted-sparkles-web-renderer", ".ytp-ad-module",
      ".ytp-ad-player-overlay", "[class*='ad-badge']", "[id*='ad-badge']",
      "[aria-label*='Sponsored']", "[aria-label*='Patrocinado']", "[aria-label*='Anúncio']"
    ]) {
      if (active.querySelector(selector)) return true;
    }

    const text = (active.innerText || "").replace(/\s+/g, " ").trim();
    return /(^|\s)(sponsored|patrocinado|anúncio|anuncio)(\s|$)/i.test(text);
  }

  async function skipAd() {
    if (adSkipLocked) return;
    adSkipLocked = true;
    currentId = "";
    ++serial;
    document.documentElement.dataset.raseState = "checking";
    hud.classList.remove("show");
    pause();
    showGate("Pulando anúncio…", "Conteúdo patrocinado detectado");
    await sleep(110);
    next();

    setTimeout(() => {
      adSkipLocked = false;
      currentId = "";
      void evaluate();
    }, 700);
  }

  function ensureUI() {
    gate = document.createElement("div");
    gate.id = "rase-gate";
    gate.innerHTML = '<div id="rase-gate-card"><div id="rase-spinner"></div><div id="rase-status"></div><div id="rase-detail"></div></div>';

    hud = document.createElement("div");
    hud.id = "rase-hud";
    hud.innerHTML = '<div class="rase-approved">✓ APROVADO</div><div class="rase-main-row"><div id="rase-hud-views">—</div><button id="rase-save" title="Salvar referência">☆</button></div><div class="rase-stats"><span id="rase-hud-age">DATA ?</span><span id="rase-hud-lang">IDIOMA ?</span><span id="rase-hud-duration">0:00</span></div><div id="rase-hud-speed" class="rase-speed"></div>';

    document.documentElement.append(gate, hud);
    hud.querySelector("#rase-save").onclick = saveCurrent;
  }

  function renderHud(data) {
    if (!settings.showBigViews) {
      hud.classList.remove("show");
      return;
    }

    const age = ageInDays(data.publishDate);
    const language = detectLanguage(data);
    const speed = age == null ? null : data.viewCount / Math.max(1, age || 1);

    hud.querySelector("#rase-hud-views").textContent = fmt(data.viewCount);
    hud.querySelector("#rase-hud-age").textContent = ageLabel(age);
    hud.querySelector("#rase-hud-lang").textContent = language ? language.toUpperCase() : "IDIOMA ?";
    hud.querySelector("#rase-hud-duration").textContent = formatDuration(data.lengthSeconds);

    const speedNode = hud.querySelector("#rase-hud-speed");
    speedNode.textContent = speed == null ? "" : `≈ ${fmt(speed)} views/dia`;
    speedNode.style.display = speed == null ? "none" : "block";

    const saved = (settings.savedVideos || []).some((video) => video.videoId === data.videoId);
    const button = hud.querySelector("#rase-save");
    button.textContent = saved ? "★" : "☆";
    button.classList.toggle("saved", saved);

    hud.classList.add("show");
    positionHud();
  }

  function positionHud() {
    if (!hud?.classList.contains("show")) return;

    const active = document.querySelector("ytd-reel-video-renderer[is-active]")
      || document.querySelector("ytd-reel-video-renderer[aria-hidden='false']")
      || document.querySelector("ytd-reel-video-renderer");
    const target = active?.querySelector("video") || active || document.querySelector("video");
    if (!target) return;

    const rect = target.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) return;

    const gap = 12;
    const margin = 8;
    const hudWidth = hud.offsetWidth || 180;
    const hudHeight = hud.offsetHeight || 120;
    const fitsLeft = rect.left - gap - hudWidth >= margin;
    const fitsRight = rect.right + gap + hudWidth <= innerWidth - margin;

    let left;
    let top = rect.top + 12;

    if (fitsLeft) {
      left = rect.left - gap - hudWidth;
      hud.dataset.placement = "outside";
    } else if (fitsRight) {
      left = rect.right + gap;
      hud.dataset.placement = "outside";
    } else {
      left = rect.left + 12;
      top = rect.top + 64;
      hud.dataset.placement = "inside";
    }

    top = Math.max(margin, Math.min(top, innerHeight - hudHeight - margin));
    hud.style.left = `${Math.round(left)}px`;
    hud.style.top = `${Math.round(top)}px`;
  }

  async function saveCurrent() {
    if (!currentData) return;
    const stored = await chrome.storage.local.get({ savedVideos: [] });
    let videos = stored.savedVideos || [];

    if (videos.some((video) => video.videoId === currentData.videoId)) {
      videos = videos.filter((video) => video.videoId !== currentData.videoId);
    } else {
      videos.unshift({
        ...currentData,
        language: detectLanguage(currentData),
        ageDays: ageInDays(currentData.publishDate),
        savedAt: new Date().toISOString()
      });
    }

    videos = videos.slice(0, 500);
    await chrome.storage.local.set({ savedVideos: videos });
    settings.savedVideos = videos;
    renderHud(currentData);
  }

  function activeVideo() {
    return document.querySelector("ytd-reel-video-renderer[is-active] video")
      || document.querySelector("ytd-reel-video-renderer[aria-hidden='false'] video")
      || document.querySelector("video");
  }

  function pause() {
    const video = activeVideo();
    if (!video) return;

    if (!pauseState.has(video)) {
      pauseState.set(video, { muted: video.muted });
    }

    video.muted = true;
    try { video.pause(); } catch {}
  }

  function resume() {
    const video = activeVideo();
    if (!video) return;

    const snapshot = pauseState.get(video);
    if (snapshot) {
      video.muted = snapshot.muted;
      pauseState.delete(video);
    }

    applySoundSettings(video);
    video.play().catch(() => {});
  }

  function applySoundSettings(video = activeVideo()) {
    if (!video || !settings.enabled || !settings.soundEnabled) return;
    const volume = Math.max(0, Math.min(100, Number(settings.volumePercent) || 0));
    video.volume = volume / 100;
    video.muted = Boolean(settings.soundMuted) || volume === 0;
  }

  function showGate(status, detail) {
    gate.classList.add("show");
    gate.querySelector("#rase-status").textContent = status;
    gate.querySelector("#rase-detail").textContent = detail;
  }

  function hideGate() {
    gate.classList.remove("show");
  }

  function ageInDays(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return null;
    const parsed = new Date(`${date}T00:00:00`);
    return Number.isNaN(parsed.getTime())
      ? null
      : Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 86400000));
  }

  function ageLabel(age) {
    if (age == null) return "DATA ?";
    if (age === 0) return "HOJE";
    if (age === 1) return "HÁ 1 DIA";
    return `HÁ ${age} DIAS`;
  }

  function formatDuration(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "TEMPO ?";
    return `${Math.floor(number / 60)}:${String(Math.floor(number % 60)).padStart(2, "0")}`;
  }

  function getId() {
    return location.pathname.match(/^\/shorts\/([\w-]{11})/)?.[1] || "";
  }

  function isShort() {
    return Boolean(getId());
  }

  function fmt(number) {
    number = Number(number) || 0;
    if (number >= 1e9) return `${(number / 1e9).toFixed(number >= 1e10 ? 0 : 1)}B`;
    if (number >= 1e6) return `${(number / 1e6).toFixed(number >= 1e7 ? 0 : 1)}M`;
    if (number >= 1e3) return `${(number / 1e3).toFixed(number >= 1e4 ? 0 : 1)}K`;
    return String(Math.round(number));
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
})();
