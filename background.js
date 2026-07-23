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

const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({ ...DEFAULTS, ...current });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "GET_VIDEO_DATA") {
    if (!/^[\w-]{11}$/.test(msg.videoId || "")) {
      sendResponse({ ok: false, error: "invalid_id" });
      return;
    }

    getVideoData(msg.videoId)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (msg?.type === "OPEN_VIDEO" && msg.url) {
    chrome.tabs.create({ url: msg.url });
    sendResponse({ ok: true });
  }
});

async function getVideoData(videoId) {
  const hit = cache.get(videoId);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.data;

  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    credentials: "include",
    cache: "no-store",
    headers: { "Accept-Language": "en-US,en;q=0.9" }
  });

  if (!response.ok) throw new Error(`youtube_http_${response.status}`);

  const html = await response.text();
  const player = extractPlayerResponse(html);
  const details = player?.videoDetails || {};
  const micro = player?.microformat?.playerMicroformatRenderer || {};
  const captions = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

  const viewCount = firstInt(
    details.viewCount,
    meta(html, "interactionCount"),
    match(html, /"viewCount"\s*:\s*"?(\d+)"?/)
  );

  if (!Number.isFinite(viewCount)) throw new Error("view_count_not_found");

  const publishDate = normalizeDate(firstText(
    micro.publishDate,
    micro.uploadDate,
    meta(html, "datePublished"),
    meta(html, "uploadDate"),
    match(html, /"publishDate"\s*:\s*"([^"]+)"/),
    match(html, /"uploadDate"\s*:\s*"([^"]+)"/)
  ));

  const lengthSeconds = firstInt(
    details.lengthSeconds,
    match(html, /"lengthSeconds"\s*:\s*"?(\d+)"?/)
  );

  const languageHints = [...new Set([
    details.defaultAudioLanguage,
    details.defaultLanguage,
    micro.defaultAudioLanguage,
    ...captions.map((track) => track.languageCode)
  ].filter(Boolean).map(normalizeLang))];

  const data = {
    videoId,
    url: `https://www.youtube.com/shorts/${videoId}`,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    viewCount,
    title: details.title || property(html, "og:title") || "",
    author: details.author || "",
    channelId: details.channelId || "",
    publishDate,
    lengthSeconds: Number.isFinite(lengthSeconds) ? lengthSeconds : null,
    description: details.shortDescription || property(html, "og:description") || "",
    languageHints
  };

  cache.set(videoId, { t: Date.now(), data });
  return data;
}

function extractPlayerResponse(html) {
  for (const marker of [
    "ytInitialPlayerResponse =",
    "var ytInitialPlayerResponse =",
    'window["ytInitialPlayerResponse"] ='
  ]) {
    const value = extractJson(html, marker);
    if (value) return value;
  }

  const escaped = match(html, /"playerResponse"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (escaped) {
    try {
      return JSON.parse(JSON.parse(`"${escaped}"`));
    } catch {}
  }
  return null;
}

function extractJson(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf("{", markerIndex + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, index + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function meta(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return match(html, new RegExp(`<meta[^>]+itemprop=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"))
    || match(html, new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+itemprop=["']${escaped}["']`, "i"));
}

function property(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return decode(match(html, new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i")) || "");
}

function firstInt(...values) {
  for (const value of values) {
    const number = Number.parseInt(String(value), 10);
    if (Number.isSafeInteger(number) && number >= 0) return number;
  }
  return Number.NaN;
}

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || "";
}

function match(text, regex) {
  return text.match(regex)?.[1] || "";
}

function normalizeDate(value) {
  return String(value || "").match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
}

function normalizeLang(value) {
  return String(value).toLowerCase().replace("_", "-").split("-")[0];
}

function decode(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
