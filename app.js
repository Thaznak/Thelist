import { ALL_GENRES, BANDS, USER_PROFILE } from "./data.js";
import { FAVORITE_BANDS_SEED, FAVORITE_BANDS_SEED_VERSION } from "./favorite-bands-seed.js";

const STORAGE_KEY = "music-discovery-state-v1";
const FINGERPRINT_TOKEN_STORAGE_KEY = "music-discovery-fingerprint-token-v1";
const FAVORITE_BANDS_SEED_APPLIED_KEY = "music-discovery-favorite-seed-applied-v1";
const PROFILE_ARCHIVE_STORAGE_KEY = "music-discovery-profile-archive-v1";
const PROFILE_CLEARED_FLAG_KEY = "music-discovery-profile-cleared-for-quiz-v1";
const INTEREST_PROFILE_STORAGE_KEY = "music-discovery-interest-profile-v1";
const FINGERPRINT_API_PATH = "./api/fingerprint";
const BAND_ENRICH_API_PATH = "./api/band-enrich";
const LIVE_WATCHLIST_API_PATH = "./api/live/watchlist";
const LIVE_SNAPSHOT_API_PATH = "./api/live/snapshot";
const LIVE_SYNC_INTERVAL_MS = 45000;
const MAX_RECORD_SECONDS = 12;
const MIN_GRAPH_ZOOM = 0.6;
const MAX_GRAPH_ZOOM = 2;
const GRAPH_ZOOM_STEP = 0.2;
const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
const QUIZ_MIN_SELECTION = 5;
const QUIZ_MAX_SELECTION = 10;
const QUIZ_POOL_SIZE = 24;

const app = document.getElementById("app");
if (!app) {
  throw new Error("Missing #app container");
}
let activeRecorder = null;
let activeStream = null;
let recordingChunks = [];
let recordingTimer = null;
let liveSyncTimer = null;
let livePipelineInFlight = false;

function cloneBands() {
  return BANDS.map((band) => ({
    ...band,
    genres: [...band.genres],
    topSongs: band.topSongs.map((song) => ({ ...song })),
    tourDates: band.tourDates.map((tour) => ({ ...tour })),
    albums: Array.isArray(band.albums)
      ? band.albums.map((album) => ({
          title: typeof album?.title === "string" ? album.title : "Unknown album",
          year: Number.isFinite(album?.year) ? Number(album.year) : null,
          cover: typeof album?.cover === "string" ? album.cover : "",
        }))
      : [],
    image: typeof band.image === "string" ? band.image : "",
    links:
      band.links && typeof band.links === "object"
        ? {
            spotify: typeof band.links.spotify === "string" ? band.links.spotify : "",
            deezer: typeof band.links.deezer === "string" ? band.links.deezer : "",
          }
        : { spotify: "", deezer: "" },
  }));
}

const state = {
  bands: cloneBands(),
  profile: {
    ...USER_PROFILE,
    favoriteGenres: [...USER_PROFILE.favoriteGenres],
    favoriteBandIds: [...USER_PROFILE.favoriteBandIds],
  },
  interest: {
    bandIds: [],
    genres: [],
    completedAt: 0,
  },
  dashboard: {
    query: "",
    sort: "match",
    filter: "all",
    showFilters: false,
  },
  discover: {
    query: "",
    selectedGenres: [],
    selectedCountries: [],
    lowOnly: false,
    seed: 0,
    showAllGenres: false,
    showAllCountries: false,
    scanner: {
      token: "",
      status: "idle",
      message: "",
      results: [],
      isRecording: false,
      shouldDetectAfterStop: false,
    },
  },
  profileUi: {
    query: "",
    editing: false,
    view: "list",
    showGenrePicker: false,
    graphZoom: 1,
    importNotice: "",
    importNoticeType: "info",
    quiz: {
      active: false,
      candidateIds: [],
      pointer: 0,
      selectedIds: [],
      message: "",
      messageType: "info",
      completedAt: 0,
    },
  },
  pwa: {
    deferredPrompt: null,
    showInstall: false,
  },
  enrichment: {
    loadingByBandId: {},
    messageByBandId: {},
    autoAttemptedByBandId: {},
    batch: {
      running: false,
      total: 0,
      done: 0,
      failed: 0,
      message: "",
    },
  },
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(isoDate) {
  const date = new Date(isoDate);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const COUNTRY_NAMES =
  typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

function getCountryNameFromCode(countryCode) {
  if (!countryCode || countryCode.length !== 2 || !COUNTRY_NAMES) {
    return "";
  }
  try {
    return COUNTRY_NAMES.of(countryCode.toUpperCase()) || "";
  } catch {
    return "";
  }
}

function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededSort(list, seed) {
  return [...list].sort((a, b) => {
    const aScore = hashString(`${a.id}-${seed}`) / 4294967295;
    const bScore = hashString(`${b.id}-${seed}`) / 4294967295;
    return aScore - bScore;
  });
}

function toFlagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) {
    return "";
  }
  const code = countryCode.toUpperCase();
  const A = 127462;
  return String.fromCodePoint(A + code.charCodeAt(0) - 65, A + code.charCodeAt(1) - 65);
}

function toneClass(score) {
  if (score >= 80) return "tone-high";
  if (score >= 60) return "tone-mid";
  if (score >= 40) return "tone-low";
  return "tone-breaker";
}

function initials(name) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function bandHue(id) {
  return (Number(id) * 31 + 200) % 360;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isCustomBandId(id) {
  return typeof id === "string" && id.startsWith("custom-");
}

function sanitizeCustomBand(rawBand) {
  if (!rawBand || typeof rawBand !== "object") return null;
  const name = typeof rawBand.name === "string" ? rawBand.name.trim() : "";
  if (!name) return null;

  const rawId =
    typeof rawBand.id === "string" && rawBand.id.trim()
      ? rawBand.id.trim()
      : `custom-${hashString(`${name}-${Date.now()}-${Math.random()}`)}`;
  const id = isCustomBandId(rawId) ? rawId : `custom-${rawId}`;

  return {
    id,
    name,
    country: typeof rawBand.country === "string" && rawBand.country.trim() ? rawBand.country : "Unknown",
    countryCode:
      typeof rawBand.countryCode === "string" && rawBand.countryCode.length === 2
        ? rawBand.countryCode.toUpperCase()
        : "UN",
    genres:
      Array.isArray(rawBand.genres) && rawBand.genres.length
        ? rawBand.genres.map((genre) => String(genre))
        : ["Imported"],
    matchScore: Number.isFinite(rawBand.matchScore) ? Number(rawBand.matchScore) : 50,
    yearFormed: Number.isFinite(rawBand.yearFormed)
      ? Number(rawBand.yearFormed)
      : new Date().getFullYear(),
    description:
      typeof rawBand.description === "string" && rawBand.description.trim()
        ? rawBand.description
        : "Imported from your uploaded file.",
    topSongs:
      Array.isArray(rawBand.topSongs) && rawBand.topSongs.length
        ? rawBand.topSongs
            .map((song) => ({
              title: typeof song?.title === "string" && song.title.trim() ? song.title : "Unknown track",
              duration:
                typeof song?.duration === "string" && song.duration.trim() ? song.duration : "--:--",
            }))
            .slice(0, 5)
        : [{ title: "Unknown track", duration: "--:--" }],
    albums:
      Array.isArray(rawBand.albums) && rawBand.albums.length
        ? rawBand.albums
            .map((album) => ({
              title:
                typeof album?.title === "string" && album.title.trim()
                  ? album.title
                  : "Unknown album",
              year: Number.isFinite(album?.year) ? Number(album.year) : null,
              cover: typeof album?.cover === "string" ? album.cover : "",
            }))
            .slice(0, 8)
        : [],
    image: typeof rawBand.image === "string" ? rawBand.image : "",
    links:
      rawBand.links && typeof rawBand.links === "object"
        ? {
            spotify:
              typeof rawBand.links.spotify === "string" ? rawBand.links.spotify : "",
            deezer: typeof rawBand.links.deezer === "string" ? rawBand.links.deezer : "",
          }
        : { spotify: "", deezer: "" },
    tourDates: Array.isArray(rawBand.tourDates) ? rawBand.tourDates.slice(0, 10) : [],
    isFavorite: Boolean(rawBand.isFavorite),
  };
}

function getStoredCustomBands() {
  return state.bands.filter((band) => isCustomBandId(band.id));
}

function createCustomBand(name) {
  return sanitizeCustomBand({
    id: `custom-${hashString(`${name}-${Date.now()}-${Math.random()}`)}`,
    name,
    country: "Unknown",
    countryCode: "UN",
    genres: ["Imported"],
    matchScore: 50,
    yearFormed: new Date().getFullYear(),
    description: "Imported from your uploaded file.",
    topSongs: [{ title: "Unknown track", duration: "--:--" }],
    tourDates: [],
    isFavorite: true,
  });
}

function parseRoute() {
  const route = window.location.hash.slice(1) || "/";
  if (route.startsWith("/band/")) {
    const id = route.split("/")[2];
    return { name: "band", id };
  }
  if (route === "/discover") return { name: "discover" };
  if (route === "/profile") return { name: "profile" };
  return { name: "home" };
}

function navigate(path) {
  if (window.location.hash.slice(1) === path) {
    render();
    return;
  }
  window.location.hash = path;
}

function persistProfileState() {
  const payload = {
    favoriteBandIds: state.profile.favoriteBandIds,
    favoriteGenres: state.profile.favoriteGenres,
    customBands: getStoredCustomBands(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  tickLivePipeline({ refreshNow: true });
}

function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.customBands)) {
      const existingIds = new Set(state.bands.map((band) => band.id));
      parsed.customBands.forEach((rawBand) => {
        const customBand = sanitizeCustomBand(rawBand);
        if (customBand && !existingIds.has(customBand.id)) {
          state.bands.push(customBand);
          existingIds.add(customBand.id);
        }
      });
    }
    if (Array.isArray(parsed.favoriteBandIds)) {
      state.profile.favoriteBandIds = parsed.favoriteBandIds.filter((id) =>
        state.bands.some((band) => band.id === id)
      );
    }
    if (Array.isArray(parsed.favoriteGenres)) {
      state.profile.favoriteGenres = parsed.favoriteGenres;
    }
  } catch {
    // Ignore malformed persisted state.
  }
}

function loadInterestProfile() {
  try {
    const raw = localStorage.getItem(INTEREST_PROFILE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const validBandIds = Array.isArray(parsed.bandIds)
      ? parsed.bandIds.filter((id) => state.bands.some((band) => band.id === id))
      : [];
    const validGenres = Array.isArray(parsed.genres)
      ? parsed.genres.map((genre) => String(genre || "").trim()).filter(Boolean)
      : [];

    state.interest.bandIds = validBandIds;
    state.interest.genres = validGenres;
    state.interest.completedAt = Number.isFinite(parsed.completedAt)
      ? Number(parsed.completedAt)
      : 0;
    const favoriteIds = new Set([...state.profile.favoriteBandIds, ...validBandIds]);
    state.profile.favoriteBandIds = [...favoriteIds];
    recomputeProfileGenresFromSources();
    state.profileUi.quiz.completedAt = state.interest.completedAt;
  } catch {
    // Ignore malformed interest profile and fallback to defaults.
  }
}

function persistInterestProfile() {
  const payload = {
    bandIds: [...state.interest.bandIds],
    genres: [...state.interest.genres],
    completedAt: Number(state.interest.completedAt || 0),
  };
  localStorage.setItem(INTEREST_PROFILE_STORAGE_KEY, JSON.stringify(payload));
  tickLivePipeline({ refreshNow: true });
}

function archiveAndClearProfileBandsOnce() {
  try {
    if (localStorage.getItem(PROFILE_CLEARED_FLAG_KEY) === "1") {
      return;
    }

    const archivePayload = {
      archivedAt: Date.now(),
      favoriteBandIds: [...state.profile.favoriteBandIds],
      favoriteGenres: [...state.profile.favoriteGenres],
      customBands: getStoredCustomBands(),
    };
    localStorage.setItem(PROFILE_ARCHIVE_STORAGE_KEY, JSON.stringify(archivePayload));
    localStorage.setItem(PROFILE_CLEARED_FLAG_KEY, "1");
  } catch {
    // Continue with best effort even if archive cannot be saved.
  }

  state.profile.favoriteBandIds = [];
  state.profile.favoriteGenres = [];
  persistProfileState();
}

function loadFingerprintToken() {
  try {
    state.discover.scanner.token = localStorage.getItem(FINGERPRINT_TOKEN_STORAGE_KEY) || "";
  } catch {
    state.discover.scanner.token = "";
  }
}

function persistFingerprintToken() {
  try {
    if (state.discover.scanner.token.trim()) {
      localStorage.setItem(FINGERPRINT_TOKEN_STORAGE_KEY, state.discover.scanner.token.trim());
    } else {
      localStorage.removeItem(FINGERPRINT_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures and keep feature functional.
  }
}

function syncFavoriteFlags() {
  const favorites = new Set(state.profile.favoriteBandIds);
  state.bands.forEach((band) => {
    band.isFavorite = favorites.has(band.id);
  });
}

function getPreferredRecorderMimeType() {
  if (typeof MediaRecorder === "undefined") {
    return "";
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((mime) => MediaRecorder.isTypeSupported(mime)) || "";
}

function normalizeFingerprintResults(payload) {
  const rawResult = payload?.result ?? payload?.response?.result ?? null;
  if (!rawResult) {
    return [];
  }

  const items = Array.isArray(rawResult) ? rawResult : [rawResult];
  return items.map((item, index) => ({
    id: String(item.song_id || item.id || `${item.artist || "artist"}-${index}`),
    title: item.title || "Unknown song",
    artist: item.artist || "Unknown artist",
    album: item.album || "",
    releaseDate: item.release_date || "",
    label: item.label || "",
    songLink:
      item.song_link ||
      item.spotify?.external_urls?.spotify ||
      item.apple_music?.url ||
      "",
    spotifyUrl: item.spotify?.external_urls?.spotify || "",
    appleMusicUrl: item.apple_music?.url || "",
    timecode: item.timecode || "",
  }));
}

function cleanupActiveRecordingResources() {
  if (recordingTimer) {
    window.clearTimeout(recordingTimer);
    recordingTimer = null;
  }
  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
  }
  activeRecorder = null;
  recordingChunks = [];
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Could not read audio blob."));
        return;
      }
      const commaIndex = reader.result.indexOf(",");
      resolve(commaIndex >= 0 ? reader.result.slice(commaIndex + 1) : reader.result);
    };
    reader.onerror = () => reject(new Error("Failed to encode audio clip."));
    reader.readAsDataURL(blob);
  });
}

function stopFingerprintRecording(shouldDetect) {
  if (!activeRecorder) {
    return;
  }
  state.discover.scanner.shouldDetectAfterStop = shouldDetect;
  if (activeRecorder.state !== "inactive") {
    activeRecorder.stop();
  }
}

async function detectSongFromAudioBlob(audioBlob) {
  if (state.discover.scanner.status === "loading") {
    return;
  }

  const token = state.discover.scanner.token.trim();
  if (!token) {
    state.discover.scanner.status = "error";
    state.discover.scanner.message = "Enter your fingerprint API token first.";
    render();
    return;
  }

  if (!audioBlob || audioBlob.size < 1200) {
    state.discover.scanner.status = "error";
    state.discover.scanner.message = "Audio sample too short. Record a longer clip.";
    render();
    return;
  }

  state.discover.scanner.status = "loading";
  state.discover.scanner.message = "Fingerprinting audio sample...";
  state.discover.scanner.results = [];
  render();

  try {
    const audioBase64 = await blobToBase64(audioBlob);
    const response = await fetch(FINGERPRINT_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiToken: token,
        audioBase64,
        mimeType: audioBlob.type || "audio/webm",
      }),
    });

    const payload = await response.json();
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }

    const results = normalizeFingerprintResults(payload);
    state.discover.scanner.results = results;
    state.discover.scanner.status = results.length ? "success" : "error";
    state.discover.scanner.message = results.length
      ? `Detected ${results.length} matching track${results.length > 1 ? "s" : ""}.`
      : "No match found. Try recording closer to the speaker.";
    persistFingerprintToken();
  } catch (error) {
    state.discover.scanner.results = [];
    state.discover.scanner.status = "error";
    state.discover.scanner.message =
      error instanceof Error ? error.message : "Fingerprint detection failed.";
  }

  render();
}

async function startFingerprintRecording() {
  if (activeRecorder || state.discover.scanner.status === "loading") {
    return;
  }
  if (
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== "function" ||
    typeof MediaRecorder === "undefined"
  ) {
    state.discover.scanner.status = "error";
    state.discover.scanner.message =
      "Audio recording is not supported in this browser/device.";
    render();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    activeStream = stream;

    const mimeType = getPreferredRecorderMimeType();
    activeRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recordingChunks = [];
    state.discover.scanner.isRecording = true;
    state.discover.scanner.shouldDetectAfterStop = false;
    state.discover.scanner.status = "recording";
    state.discover.scanner.message = `Recording audio (${MAX_RECORD_SECONDS}s max)...`;
    render();

    activeRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordingChunks.push(event.data);
      }
    };

    activeRecorder.onerror = () => {
      state.discover.scanner.isRecording = false;
      state.discover.scanner.status = "error";
      state.discover.scanner.message = "Recording failed. Check microphone permissions.";
      cleanupActiveRecordingResources();
      render();
    };

    activeRecorder.onstop = async () => {
      const shouldDetect = state.discover.scanner.shouldDetectAfterStop;
      state.discover.scanner.shouldDetectAfterStop = false;
      state.discover.scanner.isRecording = false;

      const mime = activeRecorder?.mimeType || "audio/webm";
      const audioBlob = new Blob(recordingChunks, { type: mime });
      cleanupActiveRecordingResources();

      if (shouldDetect) {
        await detectSongFromAudioBlob(audioBlob);
        return;
      }

      state.discover.scanner.status = "idle";
      state.discover.scanner.message = "Recording canceled.";
      render();
    };

    activeRecorder.start();
    recordingTimer = window.setTimeout(() => {
      stopFingerprintRecording(true);
    }, MAX_RECORD_SECONDS * 1000);
  } catch {
    state.discover.scanner.status = "error";
    state.discover.scanner.message = "Could not access microphone.";
    cleanupActiveRecordingResources();
    render();
  }
}

function normalizeImportedBandName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function findBandByName(name) {
  const query = normalizeImportedBandName(name).toLowerCase();
  if (!query) return null;

  const exact = state.bands.find((band) => band.name.toLowerCase() === query);
  if (exact) return exact;

  return state.bands.find(
    (band) => band.name.toLowerCase().includes(query) || query.includes(band.name.toLowerCase())
  );
}

function addBandsFromImportedNames(names) {
  const dedupedNames = [];
  const seen = new Set();
  names.forEach((rawName) => {
    const name = normalizeImportedBandName(rawName);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    dedupedNames.push(name);
  });

  let existingAdded = 0;
  let customCreated = 0;
  let alreadyPresent = 0;
  const newlyAddedIds = [];

  dedupedNames.forEach((name) => {
    const matchedBand = findBandByName(name);
    if (matchedBand) {
      if (state.profile.favoriteBandIds.includes(matchedBand.id)) {
        alreadyPresent += 1;
      } else {
        state.profile.favoriteBandIds = [...state.profile.favoriteBandIds, matchedBand.id];
        existingAdded += 1;
        newlyAddedIds.push(matchedBand.id);
      }
      return;
    }

    const customBand = createCustomBand(name);
    if (!customBand) return;
    state.bands.push(customBand);
    state.profile.favoriteBandIds = [...state.profile.favoriteBandIds, customBand.id];
    customCreated += 1;
    newlyAddedIds.push(customBand.id);
  });

  absorbGenresFromBandIds(newlyAddedIds);
  syncFavoriteFlags();
  persistProfileState();

  return {
    total: dedupedNames.length,
    existingAdded,
    customCreated,
    alreadyPresent,
  };
}

function getBandSyncMessage(bandId) {
  return state.enrichment.messageByBandId[bandId] || null;
}

function setBandSyncMessage(bandId, type, text) {
  state.enrichment.messageByBandId[bandId] = { type, text };
}

function setBandSyncLoading(bandId, loading) {
  if (loading) {
    state.enrichment.loadingByBandId[bandId] = true;
    return;
  }
  delete state.enrichment.loadingByBandId[bandId];
}

function isBandSyncLoading(bandId) {
  return Boolean(state.enrichment.loadingByBandId[bandId]);
}

function normalizeEnrichmentResult(raw) {
  if (!raw || typeof raw !== "object" || !raw.found) {
    return null;
  }

  const result = {
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "",
    image: typeof raw.image === "string" ? raw.image : "",
    countryCode:
      typeof raw.countryCode === "string" && raw.countryCode.length === 2
        ? raw.countryCode.toUpperCase()
        : "",
    yearFormed: Number.isFinite(raw.yearFormed) ? Number(raw.yearFormed) : null,
    description:
      typeof raw.description === "string" && raw.description.trim()
        ? raw.description.trim()
        : "",
    genres: Array.isArray(raw.genres)
      ? raw.genres
          .map((genre) => String(genre || "").trim())
          .filter(Boolean)
          .slice(0, 5)
      : [],
    topSongs: Array.isArray(raw.topSongs)
      ? raw.topSongs
          .map((song) => ({
            title:
              typeof song?.title === "string" && song.title.trim()
                ? song.title.trim()
                : "Unknown track",
            duration:
              typeof song?.duration === "string" && song.duration.trim()
                ? song.duration.trim()
                : "--:--",
          }))
          .slice(0, 5)
      : [],
    albums: Array.isArray(raw.albums)
      ? raw.albums
          .map((album) => ({
            title:
              typeof album?.title === "string" && album.title.trim()
                ? album.title.trim()
                : "Unknown album",
            year: Number.isFinite(album?.year) ? Number(album.year) : null,
            cover: typeof album?.cover === "string" ? album.cover : "",
          }))
          .slice(0, 8)
      : [],
    links:
      raw.links && typeof raw.links === "object"
        ? {
            spotify:
              typeof raw.links.spotify === "string" ? raw.links.spotify : "",
            deezer: typeof raw.links.deezer === "string" ? raw.links.deezer : "",
          }
        : { spotify: "", deezer: "" },
  };

  return result;
}

function applyEnrichmentToBand(band, enrichment) {
  if (enrichment.name && isCustomBandId(band.id)) {
    band.name = enrichment.name;
  }
  if (enrichment.image) {
    band.image = enrichment.image;
  }
  if (enrichment.topSongs.length) {
    band.topSongs = enrichment.topSongs;
  }
  if (enrichment.albums.length) {
    band.albums = enrichment.albums;
  }
  if (enrichment.genres.length) {
    band.genres = enrichment.genres;
  }
  if (enrichment.countryCode) {
    band.countryCode = enrichment.countryCode;
    const countryName = getCountryNameFromCode(enrichment.countryCode);
    if (countryName) {
      band.country = countryName;
    }
  }
  if (Number.isFinite(enrichment.yearFormed)) {
    band.yearFormed = Number(enrichment.yearFormed);
  }
  if (enrichment.description) {
    band.description = enrichment.description;
  }
  if (enrichment.links.spotify || enrichment.links.deezer) {
    band.links = {
      ...(band.links && typeof band.links === "object" ? band.links : {}),
      spotify: enrichment.links.spotify || band.links?.spotify || "",
      deezer: enrichment.links.deezer || band.links?.deezer || "",
    };
  }
  band.lastEnrichedAt = Date.now();
}

async function syncLiveWatchlist(options = {}) {
  const { refreshNow = false } = options;
  const names = getAlgorithmBandNames();
  try {
    await fetch(LIVE_WATCHLIST_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names, refreshNow }),
    });
  } catch {
    // Keep app usable even when live sync backend is not reachable.
  }
}

function applyLiveSnapshotItems(items) {
  if (!Array.isArray(items) || !items.length) {
    return;
  }

  let changed = false;
  items.forEach((item) => {
    const enrichment = normalizeEnrichmentResult(item?.result);
    if (!enrichment) return;

    let band = null;
    if (typeof item?.name === "string" && item.name.trim()) {
      band = findBandByName(item.name);
    }
    if (!band && enrichment.name) {
      band = findBandByName(enrichment.name);
    }
    if (!band) return;

    applyEnrichmentToBand(band, enrichment);
    changed = true;
  });

  if (!changed) {
    return;
  }

  const activeElement = document.activeElement;
  const userTyping =
    activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement;
  if (!userTyping) {
    render();
  }
}

async function fetchLiveSnapshot() {
  try {
    const response = await fetch(LIVE_SNAPSHOT_API_PATH);
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    if (!payload?.ok) {
      return;
    }
    applyLiveSnapshotItems(payload?.snapshot?.items);
  } catch {
    // Ignore polling errors and keep local recommendations functional.
  }
}

async function tickLivePipeline(options = {}) {
  const { refreshNow = false } = options;
  if (livePipelineInFlight) {
    return;
  }
  livePipelineInFlight = true;
  try {
    await syncLiveWatchlist({ refreshNow });
    await fetchLiveSnapshot();
  } finally {
    livePipelineInFlight = false;
  }
}

function startLivePipeline() {
  if (liveSyncTimer) {
    window.clearInterval(liveSyncTimer);
  }
  tickLivePipeline({ refreshNow: true });
  liveSyncTimer = window.setInterval(() => {
    tickLivePipeline({ refreshNow: false });
  }, LIVE_SYNC_INTERVAL_MS);
}

async function enrichBandById(bandId, options = {}) {
  const { renderNow = true, silent = false } = options;
  const band = getBandById(bandId);
  if (!band || isBandSyncLoading(bandId)) {
    return false;
  }

  setBandSyncLoading(bandId, true);
  if (!silent) {
    setBandSyncMessage(bandId, "info", "Syncing real data from Spotify/Deezer...");
  }
  if (renderNow) {
    render();
  }

  try {
    const response = await fetch(BAND_ENRICH_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: band.name }),
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }

    const enrichment = normalizeEnrichmentResult(payload.result);
    if (!enrichment) {
      setBandSyncMessage(bandId, "error", "No matching real data found for this band.");
      return false;
    }

    applyEnrichmentToBand(band, enrichment);
    persistProfileState();
    setBandSyncMessage(
      bandId,
      "success",
      enrichment.description || "Band profile updated with real source data."
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Real data sync failed.";
    setBandSyncMessage(bandId, "error", message);
    return false;
  } finally {
    setBandSyncLoading(bandId, false);
    if (renderNow) {
      render();
    }
  }
}

function bandLikelyNeedsEnrichment(band) {
  const hasImage = typeof band.image === "string" && band.image.trim() !== "";
  const hasAlbums = Array.isArray(band.albums) && band.albums.length > 0;
  const hasRealDescription =
    typeof band.description === "string" &&
    band.description.toLowerCase().includes("real data sourced from");
  return !(hasImage && hasAlbums && hasRealDescription);
}

function maybeAutoEnrichBand(bandId) {
  const band = getBandById(bandId);
  if (!band || !bandLikelyNeedsEnrichment(band)) {
    return;
  }
  if (state.enrichment.autoAttemptedByBandId[bandId]) {
    return;
  }
  state.enrichment.autoAttemptedByBandId[bandId] = true;
  enrichBandById(bandId, { renderNow: true, silent: true });
}

async function syncFavoriteBandsRealData() {
  if (state.enrichment.batch.running) {
    return;
  }
  const favoriteIds = [...getAlgorithmBandIdSet()];
  if (!favoriteIds.length) {
    state.enrichment.batch = {
      running: false,
      total: 0,
      done: 0,
      failed: 0,
      message: "No selected bands to sync.",
    };
    render();
    return;
  }

  state.enrichment.batch = {
    running: true,
    total: favoriteIds.length,
    done: 0,
    failed: 0,
    message: `Syncing 0/${favoriteIds.length} favorites...`,
  };
  render();

  for (let index = 0; index < favoriteIds.length; index += 1) {
    const bandId = favoriteIds[index];
    const ok = await enrichBandById(bandId, { renderNow: false, silent: true });
    if (ok) {
      state.enrichment.batch.done += 1;
    } else {
      state.enrichment.batch.failed += 1;
    }
    state.enrichment.batch.message = `Syncing ${index + 1}/${favoriteIds.length} favorites...`;
    render();
    if (index < favoriteIds.length - 1) {
      // Light pacing lowers API burst risk when syncing long lists.
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
  }

  state.enrichment.batch.running = false;
  state.enrichment.batch.message = `Sync complete: ${state.enrichment.batch.done}/${state.enrichment.batch.total} updated${
    state.enrichment.batch.failed ? `, ${state.enrichment.batch.failed} failed` : ""
  }.`;
  render();
}

function applyFavoriteBandsSeed() {
  if (!Array.isArray(FAVORITE_BANDS_SEED) || FAVORITE_BANDS_SEED.length === 0) {
    return;
  }

  try {
    const appliedVersion = localStorage.getItem(FAVORITE_BANDS_SEED_APPLIED_KEY);
    if (appliedVersion === FAVORITE_BANDS_SEED_VERSION) {
      return;
    }
  } catch {
    // Continue with best effort when storage is unavailable.
  }

  const result = addBandsFromImportedNames(FAVORITE_BANDS_SEED);
  if (result && result.total > 0) {
    state.profileUi.importNotice =
      `Loaded your seed list: ${result.total} bands (${result.existingAdded} matched, ` +
      `${result.customCreated} created, ${result.alreadyPresent} already present).`;
    state.profileUi.importNoticeType = "success";
  }

  try {
    localStorage.setItem(FAVORITE_BANDS_SEED_APPLIED_KEY, FAVORITE_BANDS_SEED_VERSION);
  } catch {
    // Ignore storage write failures.
  }
}

async function importBandsFromFile(file) {
  if (!file) return;

  if (file.size > MAX_IMPORT_FILE_BYTES) {
    state.profileUi.importNotice = "File is too large. Use a file under 5MB.";
    state.profileUi.importNoticeType = "error";
    render();
    return;
  }

  state.profileUi.importNotice = `Importing ${file.name}...`;
  state.profileUi.importNoticeType = "info";
  render();

  try {
    const fileBase64 = await blobToBase64(file);
    const response = await fetch("./api/import-bands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type || "",
        fileBase64,
      }),
    });

    const payload = await response.json();
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }

    const result = addBandsFromImportedNames(Array.isArray(payload.names) ? payload.names : []);
    if (!result.total) {
      state.profileUi.importNotice = "No valid band names found in this file.";
      state.profileUi.importNoticeType = "error";
      render();
      return;
    }

    state.profileUi.importNotice =
      `Imported ${result.total} bands: ${result.existingAdded} matched, ` +
      `${result.customCreated} created, ${result.alreadyPresent} already in favorites.`;
    state.profileUi.importNoticeType = "success";
  } catch (error) {
    state.profileUi.importNotice =
      error instanceof Error ? error.message : "Failed to import band list.";
    state.profileUi.importNoticeType = "error";
  }

  render();
}

function getCountries() {
  return [...new Set(state.bands.map((band) => band.country))].sort((a, b) => a.localeCompare(b));
}

function getAlgorithmBandIdSet() {
  return new Set([...state.interest.bandIds, ...state.profile.favoriteBandIds]);
}

function getAlgorithmBandNames() {
  const names = [];
  const seen = new Set();
  getAlgorithmBandIdSet().forEach((bandId) => {
    const band = getBandById(bandId);
    if (!band) return;
    const normalized = normalizeImportedBandName(band.name);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) return;
    seen.add(key);
    names.push(normalized);
  });
  return names;
}

function absorbGenresFromBandIds(bandIds) {
  const genres = new Set([...state.profile.favoriteGenres, ...state.interest.genres]);
  bandIds.forEach((bandId) => {
    const band = getBandById(bandId);
    if (!band) return;
    band.genres.forEach((genre) => genres.add(genre));
  });
  state.profile.favoriteGenres = [...genres].slice(0, 18);
}

function recomputeProfileGenresFromSources() {
  const genres = new Set([...state.interest.genres]);
  state.profile.favoriteBandIds.forEach((bandId) => {
    const band = getBandById(bandId);
    if (!band) return;
    band.genres.forEach((genre) => genres.add(genre));
  });
  state.profile.favoriteGenres = [...genres].slice(0, 18);
}

function buildPreferenceModel() {
  const genreWeights = new Map();
  const countries = new Set();

  const sourceGenres = [...new Set([...state.interest.genres, ...state.profile.favoriteGenres])];
  const sourceBandIds = [...getAlgorithmBandIdSet()];

  sourceGenres.forEach((genre) => {
    const normalized = String(genre || "").trim();
    if (!normalized) return;
    genreWeights.set(normalized, (genreWeights.get(normalized) || 0) + 3);
  });

  sourceBandIds.forEach((bandId) => {
    const band = getBandById(bandId);
    if (!band) return;
    countries.add(band.country);
    band.genres.forEach((genre) => {
      const normalized = String(genre || "").trim();
      if (!normalized) return;
      genreWeights.set(normalized, (genreWeights.get(normalized) || 0) + 1);
    });
  });

  return { genreWeights, countries };
}

function getGuidedMatchScore(band, model = null) {
  const preference = model || buildPreferenceModel();
  let score = Number.isFinite(band.matchScore) ? Number(band.matchScore) : 50;
  let overlapCount = 0;

  band.genres.forEach((genre) => {
    const weight = preference.genreWeights.get(genre) || 0;
    if (weight > 0) {
      overlapCount += 1;
      score += weight * 2;
    }
  });

  if (preference.countries.has(band.country)) {
    score += 2;
  }
  if (overlapCount === 0 && preference.genreWeights.size > 0) {
    score -= 4;
  }
  if (state.interest.bandIds.includes(band.id) || state.profile.favoriteBandIds.includes(band.id)) {
    score = Math.max(score, 92);
  }

  return Math.round(clamp(score, 1, 99));
}

function matchesQuery(band, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    band.name.toLowerCase().includes(q) ||
    band.country.toLowerCase().includes(q) ||
    band.genres.some((genre) => genre.toLowerCase().includes(q))
  );
}

function getDashboardBands() {
  const model = buildPreferenceModel();
  let bands = state.bands.filter((band) => matchesQuery(band, state.dashboard.query));
  const scoreById = new Map(
    bands.map((band) => [band.id, getGuidedMatchScore(band, model)])
  );
  const getScore = (band) => scoreById.get(band.id) || 50;

  if (state.dashboard.filter === "high") {
    bands = bands.filter((band) => getScore(band) >= 80);
  } else if (state.dashboard.filter === "medium") {
    bands = bands.filter((band) => getScore(band) >= 55 && getScore(band) < 80);
  } else if (state.dashboard.filter === "low") {
    bands = bands.filter((band) => getScore(band) >= 35 && getScore(band) < 55);
  } else if (state.dashboard.filter === "breaker") {
    bands = bands.filter((band) => getScore(band) < 55);
  }

  if (state.dashboard.sort === "match") {
    bands.sort((a, b) => getScore(b) - getScore(a));
  } else if (state.dashboard.sort === "matchAsc") {
    bands.sort((a, b) => getScore(a) - getScore(b));
  } else if (state.dashboard.sort === "name") {
    bands.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    bands = seededSort(bands, state.discover.seed + 77);
  }

  return bands;
}

function getDiscoverBands() {
  const model = buildPreferenceModel();
  let bands = state.bands.filter((band) => matchesQuery(band, state.discover.query));
  const scoreById = new Map(
    bands.map((band) => [band.id, getGuidedMatchScore(band, model)])
  );
  const getScore = (band) => scoreById.get(band.id) || 50;

  if (state.discover.selectedGenres.length > 0) {
    bands = bands.filter((band) =>
      band.genres.some((genre) => state.discover.selectedGenres.includes(genre))
    );
  }

  if (state.discover.selectedCountries.length > 0) {
    bands = bands.filter((band) => state.discover.selectedCountries.includes(band.country));
  }

  if (state.discover.lowOnly) {
    bands = bands.filter((band) => getScore(band) < 55);
  }

  return seededSort(bands, state.discover.seed);
}

function getBandById(id) {
  return state.bands.find((band) => band.id === id);
}

function renderBandVisual(band, size = "md") {
  const hue = bandHue(band.id);
  const image = typeof band.image === "string" ? band.image.trim() : "";
  if (image) {
    return `<div class="band-visual ${size}" style="--hue:${hue}">
      <img src="${escapeHtml(image)}" alt="${escapeHtml(
        band.name
      )} photo" loading="lazy" referrerpolicy="no-referrer" />
    </div>`;
  }
  return `<div class="band-visual ${size}" style="--hue:${hue}"><span>${escapeHtml(
    initials(band.name)
  )}</span></div>`;
}

function renderMatchBadge(score) {
  return `<span class="match-badge ${toneClass(score)}"><strong>${score}%</strong></span>`;
}

function renderGenreTag(genre, active = false) {
  return `<span class="genre-tag ${active ? "active" : ""}">${escapeHtml(genre)}</span>`;
}

function renderBandCard(band, withFavorite = true, score = null) {
  const guidedScore = Number.isFinite(score) ? Number(score) : getGuidedMatchScore(band);
  return `
    <article class="band-card" data-action="open-band" data-id="${band.id}">
      <div class="band-card-header">
        ${renderBandVisual(band)}
        ${
          withFavorite
            ? `<button class="icon-btn favorite-btn" data-action="toggle-favorite" data-id="${band.id}" aria-label="Toggle favorite">${
                band.isFavorite ? "♥" : "♡"
              }</button>`
            : ""
        }
      </div>
      <div class="band-card-body">
        <h3>${escapeHtml(band.name)}</h3>
        <div class="band-meta-row">
          ${renderMatchBadge(guidedScore)}
          <span class="country-pill">${toFlagEmoji(band.countryCode)} ${escapeHtml(band.country)}</span>
        </div>
        <div class="genre-row">${band.genres
          .slice(0, 2)
          .map((genre) => renderGenreTag(genre))
          .join("")}</div>
      </div>
    </article>
  `;
}

function renderSearchInput(model, value, placeholder) {
  return `
    <label class="search-shell">
      <span>⌕</span>
      <input type="search" data-model="${model}" value="${escapeHtml(value)}" placeholder="${escapeHtml(
        placeholder
      )}" autocomplete="off" />
    </label>
  `;
}

function renderDashboard() {
  const model = buildPreferenceModel();
  const scoreOf = (band) => getGuidedMatchScore(band, model);
  const visibleBands = getDashboardBands();
  const suggestedBands = [...state.bands]
    .filter((band) => !band.isFavorite)
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, 3);
  const bubbleBreakers = seededSort(
    state.bands.filter((band) => scoreOf(band) < 55),
    state.discover.seed + 19
  ).slice(0, 3);

  return `
    <section class="page-stack">
      ${renderSearchInput("dashboard-query", state.dashboard.query, "Search or add a band...")}

      <div class="chip-row">
        <button class="chip" data-action="dashboard-random">Surprise me</button>
        <button class="chip" data-action="dashboard-sort" data-sort="match">Best matches</button>
        <button class="chip ${state.dashboard.filter === "breaker" ? "chip-danger" : ""}" data-action="dashboard-filter" data-filter="breaker">Break the algorithm</button>
      </div>

      <section>
        <div class="section-head">
          <h2><strong>Suggested</strong> for you</h2>
          <span>${suggestedBands.length} bands</span>
        </div>
        <div class="stack-cards">${suggestedBands
          .map((band) => renderBandCard(band, true, scoreOf(band)))
          .join("")}</div>
      </section>

      <section>
        <div class="section-head">
          <h2><strong>Break</strong> your bubble</h2>
          <span>Low match</span>
        </div>
        <p class="muted-copy">Outside your comfort zone, intentionally.</p>
        <div class="stack-cards">${bubbleBreakers
          .map((band) => renderBandCard(band, false, scoreOf(band)))
          .join("")}</div>
      </section>

      <section>
        <div class="section-head">
          <h2><strong>All</strong> recommendations</h2>
          <button class="text-btn" data-action="toggle-dashboard-filters">${
            state.dashboard.showFilters ? "Hide filters" : "Filter"
          }</button>
        </div>
        ${
          state.dashboard.showFilters
            ? `<div class="filter-panel">
                <p>Sort by</p>
                <div class="chip-row dense">
                  <button class="chip ${
                    state.dashboard.sort === "match" ? "chip-active" : ""
                  }" data-action="dashboard-sort" data-sort="match">Best match</button>
                  <button class="chip ${
                    state.dashboard.sort === "matchAsc" ? "chip-active" : ""
                  }" data-action="dashboard-sort" data-sort="matchAsc">Lowest match</button>
                  <button class="chip ${
                    state.dashboard.sort === "name" ? "chip-active" : ""
                  }" data-action="dashboard-sort" data-sort="name">Name</button>
                  <button class="chip ${
                    state.dashboard.sort === "random" ? "chip-active" : ""
                  }" data-action="dashboard-sort" data-sort="random">Random</button>
                </div>
                <p>Match level</p>
                <div class="chip-row dense">
                  <button class="chip ${
                    state.dashboard.filter === "all" ? "chip-active" : ""
                  }" data-action="dashboard-filter" data-filter="all">All</button>
                  <button class="chip ${
                    state.dashboard.filter === "high" ? "chip-active" : ""
                  }" data-action="dashboard-filter" data-filter="high">High</button>
                  <button class="chip ${
                    state.dashboard.filter === "medium" ? "chip-active" : ""
                  }" data-action="dashboard-filter" data-filter="medium">Medium</button>
                  <button class="chip ${
                    state.dashboard.filter === "low" ? "chip-active" : ""
                  }" data-action="dashboard-filter" data-filter="low">Low</button>
                  <button class="chip ${
                    state.dashboard.filter === "breaker" ? "chip-active" : ""
                  }" data-action="dashboard-filter" data-filter="breaker">Breakers</button>
                </div>
              </div>`
            : ""
        }
        <div class="stack-cards">${visibleBands
          .map((band) => renderBandCard(band, true, scoreOf(band)))
          .join("")}</div>
        <p class="muted-copy centered">Showing ${visibleBands.length} of ${state.bands.length} bands</p>
      </section>
    </section>
  `;
}

function renderDiscover() {
  const model = buildPreferenceModel();
  const scoreOf = (band) => getGuidedMatchScore(band, model);
  const countries = getCountries();
  const visibleBands = getDiscoverBands();
  const scanner = state.discover.scanner;
  const recordingSupported =
    Boolean(navigator.mediaDevices) &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined";
  const scannerStatusClass = `scan-status ${scanner.status}`.trim();

  return `
    <section class="page-stack">
      <div class="section-head">
        <h2><strong>Discover</strong></h2>
        <button class="icon-btn" data-action="discover-reshuffle" aria-label="Shuffle">↻</button>
      </div>
      <p class="muted-copy">Break free from your usual algorithm.</p>

      <section class="scan-panel">
        <div class="section-head">
          <h3>Live fingerprint scan</h3>
          <span>Audio ID</span>
        </div>
        <p class="muted-copy">Records live audio and runs true fingerprint detection via backend lookup.</p>
        <label class="stack-field">
          <span>Fingerprint API token</span>
          <input type="password" data-model="scanner-token" value="${escapeHtml(
            scanner.token
          )}" placeholder="Paste your token" autocomplete="off" />
        </label>
        <div class="chip-row">
          <button class="chip ${scanner.isRecording ? "chip-active" : ""}" data-action="${
            scanner.isRecording ? "scanner-stop-record" : "scanner-start-record"
          }" ${recordingSupported ? "" : "disabled"}>${
            scanner.isRecording ? "Stop & detect" : "Start recording"
          }</button>
          <button class="chip" data-action="scanner-clear">Clear</button>
        </div>
        ${
          !recordingSupported
            ? '<p class="scan-status error">Browser does not support live audio recording.</p>'
            : ""
        }
        ${
          scanner.message
            ? `<p class="${scannerStatusClass}">${escapeHtml(scanner.message)}</p>`
            : ""
        }
        ${
          scanner.results.length
            ? `<div class="scan-results">
                ${scanner.results
                  .map((result, index) => {
                    const artistLower = result.artist.toLowerCase();
                    const mappedBand = state.bands.find((band) =>
                      band.name.toLowerCase().includes(artistLower) ||
                      artistLower.includes(band.name.toLowerCase())
                    );
                    return `<article class="scan-result">
                      <div class="scan-result-head">
                        <span class="scan-rank">#${index + 1}</span>
                        <div>
                          <h4>${escapeHtml(result.title)}</h4>
                          <p>${escapeHtml(result.artist)}</p>
                        </div>
                      </div>
                      <p class="muted-copy">${
                        result.album ? escapeHtml(result.album) : "Album unknown"
                      }${
                      result.releaseDate ? ` · ${escapeHtml(result.releaseDate)}` : ""
                    }${result.timecode ? ` · at ${escapeHtml(result.timecode)}` : ""}</p>
                      <div class="chip-row dense">
                        ${
                          mappedBand
                            ? `<button class="chip chip-active" data-action="open-band" data-id="${mappedBand.id}">Open local band</button>`
                            : ""
                        }
                        ${
                          result.spotifyUrl
                            ? `<a class="chip link-chip" href="${escapeHtml(
                                result.spotifyUrl
                              )}" target="_blank" rel="noopener noreferrer">Open Spotify</a>`
                            : ""
                        }
                        ${
                          result.appleMusicUrl
                            ? `<a class="chip link-chip" href="${escapeHtml(
                                result.appleMusicUrl
                              )}" target="_blank" rel="noopener noreferrer">Open Apple Music</a>`
                            : ""
                        }
                        ${
                          result.songLink
                            ? `<a class="chip link-chip" href="${escapeHtml(
                                result.songLink
                              )}" target="_blank" rel="noopener noreferrer">Song link</a>`
                            : ""
                        }
                      </div>
                    </article>`;
                  })
                  .join("")}
              </div>`
            : ""
        }
      </section>

      ${renderSearchInput("discover-query", state.discover.query, "Search genres, bands, countries...")}

      <div class="split-toggle">
        <button class="${!state.discover.lowOnly ? "active" : ""}" data-action="discover-toggle-low" data-value="all">All bands</button>
        <button class="${state.discover.lowOnly ? "active" : ""}" data-action="discover-toggle-low" data-value="low">Low match only</button>
      </div>

      <section>
        <div class="section-head">
          <h3>Genres</h3>
          <button class="text-btn" data-action="discover-toggle-all-genres">${
            state.discover.showAllGenres ? "Show less" : `Show all (${ALL_GENRES.length})`
          }</button>
        </div>
        <div class="chip-row dense">
          ${(state.discover.showAllGenres ? ALL_GENRES : ALL_GENRES.slice(0, 12))
            .map(
              (genre) =>
                `<button class="chip ${
                  state.discover.selectedGenres.includes(genre) ? "chip-active" : ""
                }" data-action="discover-genre" data-genre="${escapeHtml(genre)}">${escapeHtml(
                  genre
                )}</button>`
            )
            .join("")}
        </div>
        ${
          state.discover.selectedGenres.length
            ? `<button class="text-btn" data-action="discover-clear-genres">Clear genres</button>`
            : ""
        }
      </section>

      <section>
        <div class="section-head">
          <h3>Countries</h3>
          <button class="text-btn" data-action="discover-toggle-all-countries">${
            state.discover.showAllCountries ? "Show less" : `Show all (${countries.length})`
          }</button>
        </div>
        <div class="chip-row dense">
          ${(state.discover.showAllCountries ? countries : countries.slice(0, 8))
            .map((country) => {
              const band = state.bands.find((candidate) => candidate.country === country);
              return `<button class="chip ${
                state.discover.selectedCountries.includes(country) ? "chip-active" : ""
              }" data-action="discover-country" data-country="${escapeHtml(country)}">${toFlagEmoji(
                band?.countryCode
              )} ${escapeHtml(country)}</button>`;
            })
            .join("")}
        </div>
        ${
          state.discover.selectedCountries.length
            ? `<button class="text-btn" data-action="discover-clear-countries">Clear countries</button>`
            : ""
        }
      </section>

      <section>
        <div class="section-head">
          <h3>Results</h3>
          <span>${visibleBands.length} bands</span>
        </div>
        <div class="stack-cards">${visibleBands
          .map((band) => renderBandCard(band, true, scoreOf(band)))
          .join("")}</div>
      </section>
    </section>
  `;
}

function startProfileQuiz() {
  const excludedIds = getAlgorithmBandIdSet();
  const available = state.bands.filter((band) => !excludedIds.has(band.id));
  if (available.length < QUIZ_MIN_SELECTION) {
    state.profileUi.quiz.active = false;
    state.profileUi.quiz.message =
      `Not enough unselected bands left for the quiz (need ${QUIZ_MIN_SELECTION}).`;
    state.profileUi.quiz.messageType = "error";
    return;
  }
  const model = buildPreferenceModel();
  const candidates = seededSort(
    [...available].sort((a, b) => getGuidedMatchScore(b, model) - getGuidedMatchScore(a, model)),
    Date.now()
  ).slice(0, QUIZ_POOL_SIZE);

  state.profileUi.quiz.active = true;
  state.profileUi.quiz.candidateIds = candidates.map((band) => band.id);
  state.profileUi.quiz.pointer = 0;
  state.profileUi.quiz.selectedIds = [];
  state.profileUi.quiz.message = `Pick ${QUIZ_MIN_SELECTION}-${QUIZ_MAX_SELECTION} bands to tune your recommendations.`;
  state.profileUi.quiz.messageType = "info";
}

function moveQuizPointerToNextAvailable() {
  const quiz = state.profileUi.quiz;
  while (quiz.pointer < quiz.candidateIds.length) {
    const id = quiz.candidateIds[quiz.pointer];
    if (!quiz.selectedIds.includes(id)) {
      return;
    }
    quiz.pointer += 1;
  }
}

function handleQuizPick(addCurrentBand) {
  const quiz = state.profileUi.quiz;
  if (!quiz.active) return;

  moveQuizPointerToNextAvailable();
  const currentId = quiz.candidateIds[quiz.pointer];
  if (!currentId) return;

  if (addCurrentBand && quiz.selectedIds.length < QUIZ_MAX_SELECTION) {
    quiz.selectedIds = [...quiz.selectedIds, currentId];
  }
  quiz.pointer += 1;
  moveQuizPointerToNextAvailable();

  if (quiz.selectedIds.length >= QUIZ_MAX_SELECTION) {
    quiz.message = `You selected ${QUIZ_MAX_SELECTION}. Finish quiz to apply.`;
    quiz.messageType = "success";
    return;
  }

  const remaining = quiz.candidateIds.length - quiz.pointer;
  if (remaining <= 0) {
    if (quiz.selectedIds.length < QUIZ_MIN_SELECTION) {
      quiz.message = `Need at least ${QUIZ_MIN_SELECTION} picks. Restart quiz for more options.`;
      quiz.messageType = "error";
    } else {
      quiz.message = "Review your picks, then finish quiz.";
      quiz.messageType = "success";
    }
  } else {
    quiz.message = `${quiz.selectedIds.length} selected, ${remaining} remaining cards.`;
    quiz.messageType = "info";
  }
}

function finishProfileQuiz() {
  const quiz = state.profileUi.quiz;
  const selectedIds = [...quiz.selectedIds];
  if (selectedIds.length < QUIZ_MIN_SELECTION || selectedIds.length > QUIZ_MAX_SELECTION) {
    quiz.message = `Select between ${QUIZ_MIN_SELECTION} and ${QUIZ_MAX_SELECTION} bands before finishing.`;
    quiz.messageType = "error";
    return;
  }

  const selectedBands = selectedIds.map((id) => getBandById(id)).filter(Boolean);
  if (!selectedBands.length) {
    quiz.message = "Could not resolve selected bands. Restart the quiz.";
    quiz.messageType = "error";
    return;
  }

  const genreSet = new Set();
  selectedBands.forEach((band) => {
    band.genres.forEach((genre) => genreSet.add(genre));
  });
  state.interest.bandIds = selectedIds;
  state.interest.genres = [...genreSet].slice(0, 18);
  state.interest.completedAt = Date.now();
  persistInterestProfile();

  const favoriteIds = new Set(state.profile.favoriteBandIds);
  selectedIds.forEach((id) => favoriteIds.add(id));
  state.profile.favoriteBandIds = [...favoriteIds];
  recomputeProfileGenresFromSources();

  syncFavoriteFlags();
  persistProfileState();

  quiz.active = false;
  quiz.completedAt = state.interest.completedAt;
  quiz.message = `Quiz applied: ${selectedIds.length} bands saved for recommendation guidance.`;
  quiz.messageType = "success";
}

function renderProfile() {
  const model = buildPreferenceModel();
  const scoreOf = (band) => getGuidedMatchScore(band, model);
  const favoriteBands = state.profile.favoriteBandIds
    .map((id) => getBandById(id))
    .filter(Boolean);
  const searchResults = state.profileUi.query.trim()
    ? state.bands
        .filter((band) => matchesQuery(band, state.profileUi.query))
        .filter((band) => !state.profile.favoriteBandIds.includes(band.id))
        .slice(0, 6)
    : [];
  const algorithmGenres = [...new Set([...state.interest.genres, ...state.profile.favoriteGenres])];
  const quiz = state.profileUi.quiz;
  const quizSelectedBands = quiz.selectedIds.map((id) => getBandById(id)).filter(Boolean);
  const currentQuizBand = getBandById(quiz.candidateIds[quiz.pointer]);
  const quizCanFinish =
    quiz.selectedIds.length >= QUIZ_MIN_SELECTION &&
    quiz.selectedIds.length <= QUIZ_MAX_SELECTION;

  return `
    <section class="page-stack">
      <section class="profile-head">
        <div class="avatar-circle">${escapeHtml(initials(state.profile.name))}</div>
        <div>
          <h2>${escapeHtml(state.profile.name)}</h2>
          <p>${favoriteBands.length} favorite bands · ${algorithmGenres.length} active genres</p>
        </div>
        <button class="chip ${state.profileUi.editing ? "chip-active" : ""}" data-action="profile-toggle-edit">${
          state.profileUi.editing ? "Done" : "Edit"
        }</button>
      </section>

      <section>
        <div class="section-head">
          <h3><strong>Taste</strong> profile</h3>
        </div>
        <p class="muted-copy">Algorithm guidance combines quiz picks and manual favorites stored on this device.</p>
        <div class="chip-row dense">
          ${algorithmGenres.length
            ? algorithmGenres
            .map(
              (genre) =>
                `<span class="chip chip-active">${escapeHtml(genre)}</span>`
            )
            .join("")
            : '<span class="chip">No genres yet. Complete the quiz.</span>'}
        </div>
      </section>

      <section class="quiz-panel">
        <div class="section-head">
          <h3><strong>Quiz</strong> your taste</h3>
          ${
            quiz.active
              ? `<button class="text-btn" data-action="profile-quiz-restart">Restart</button>`
              : `<button class="chip" data-action="profile-quiz-start">Start quiz</button>`
          }
        </div>
        <p class="muted-copy">Pick ${QUIZ_MIN_SELECTION}-${QUIZ_MAX_SELECTION} favorite bands to guide the algorithm.</p>
        ${
          quiz.message
            ? `<p class="import-notice ${quiz.messageType}">${escapeHtml(quiz.message)}</p>`
            : ""
        }
        ${
          quiz.active
            ? `<div class="quiz-progress">
                <span>Selected ${quiz.selectedIds.length}/${QUIZ_MAX_SELECTION}</span>
                <span>Card ${Math.min(quiz.pointer + 1, quiz.candidateIds.length)}/${quiz.candidateIds.length}</span>
              </div>`
            : quiz.completedAt
            ? `<p class="muted-copy">Last updated ${escapeHtml(
                new Date(quiz.completedAt).toLocaleString("en-US")
              )}</p>`
            : ""
        }
        ${
          quiz.active && currentQuizBand
            ? `<article class="quiz-card">
                <div class="quiz-card-head">
                  ${renderBandVisual(currentQuizBand, "sm")}
                  <div>
                    <h4>${escapeHtml(currentQuizBand.name)}</h4>
                    <p>${toFlagEmoji(currentQuizBand.countryCode)} ${escapeHtml(
                        currentQuizBand.country
                      )} · ${renderMatchBadge(scoreOf(currentQuizBand))}</p>
                  </div>
                </div>
                <div class="genre-row">${currentQuizBand.genres
                  .slice(0, 3)
                  .map((genre) => renderGenreTag(genre))
                  .join("")}</div>
                <div class="chip-row">
                  <button class="chip" data-action="profile-quiz-skip">Skip</button>
                  <button class="chip chip-active" data-action="profile-quiz-pick">Add to quiz picks</button>
                </div>
              </article>`
            : ""
        }
        ${
          quizSelectedBands.length
            ? `<div class="chip-row dense">
                ${quizSelectedBands
                  .map(
                    (band) =>
                      `<span class="chip chip-active">
                         ${escapeHtml(band.name)}
                         <button class="remove-x" data-action="profile-quiz-remove" data-id="${band.id}" aria-label="Remove pick">×</button>
                       </span>`
                  )
                  .join("")}
              </div>`
            : ""
        }
        ${
          quiz.active
            ? `<button class="chip ${
                quizCanFinish ? "chip-active" : ""
              }" data-action="profile-quiz-finish" ${
                quizCanFinish ? "" : "disabled"
              }>Finish quiz</button>`
            : ""
        }
      </section>

      <section>
        <div class="search-upload-row">
          ${renderSearchInput("profile-query", state.profileUi.query, "Add a band to favorites...")}
          <label class="chip upload-chip">
            Upload list
            <input
              type="file"
              data-model="profile-band-file"
              accept=".txt,.csv,.xls,.xlsx,text/plain,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            />
          </label>
        </div>
        ${
          state.profileUi.importNotice
            ? `<p class="import-notice ${state.profileUi.importNoticeType}">${escapeHtml(
                state.profileUi.importNotice
              )}</p>`
            : ""
        }
        ${
          searchResults.length
            ? `<div class="result-list">${searchResults
                .map(
                  (band) =>
                    `<button class="result-item" data-action="profile-add-favorite" data-id="${band.id}">
                      ${renderBandVisual(band, "sm")}
                      <span>
                        <strong>${escapeHtml(band.name)}</strong>
                        <small>${escapeHtml(band.genres[0])} · ${escapeHtml(band.country)}</small>
                      </span>
                    </button>`
                )
                .join("")}</div>`
            : ""
        }
      </section>

      <section>
        <div class="section-head profile-favorites-head">
          <h3><strong>Favorite</strong> bands</h3>
          <div class="profile-favorites-tools">
            <button
              class="chip ${state.enrichment.batch.running ? "chip-active" : ""}"
              data-action="profile-sync-favorites"
              ${state.enrichment.batch.running ? "disabled" : ""}
            >
              ${state.enrichment.batch.running ? "Syncing..." : "Sync real data"}
            </button>
            <div class="split-mini">
              <button class="${state.profileUi.view === "list" ? "active" : ""}" data-action="profile-toggle-view" data-view="list">List</button>
              <button class="${state.profileUi.view === "graph" ? "active" : ""}" data-action="profile-toggle-view" data-view="graph">Graph</button>
            </div>
          </div>
        </div>
        ${
          state.enrichment.batch.message
            ? `<p class="import-notice ${
                state.enrichment.batch.running
                  ? "info"
                  : state.enrichment.batch.failed
                  ? "error"
                  : "success"
              }">${escapeHtml(state.enrichment.batch.message)}</p>`
            : ""
        }

        ${
          state.profileUi.view === "list"
            ? `<div class="stack-rows">
                ${favoriteBands
                  .map(
                    (band) =>
                      `<article class="favorite-row" data-action="open-band" data-id="${band.id}">
                        ${renderBandVisual(band, "sm")}
                        <div class="favorite-copy">
                          <h4>${escapeHtml(band.name)}</h4>
                          <p>${renderMatchBadge(scoreOf(band))} <span>${toFlagEmoji(
                        band.countryCode
                      )} ${escapeHtml(band.country)}</span></p>
                        </div>
                        ${
                          state.profileUi.editing
                            ? `<button class="icon-btn" data-action="profile-remove-favorite" data-id="${band.id}" aria-label="Remove favorite">×</button>`
                            : `<span class="arrow">›</span>`
                        }
                      </article>`
                  )
                  .join("")}
              </div>`
            : renderGalaxy(favoriteBands, state.profileUi.graphZoom)
        }
      </section>
    </section>
  `;
}

function renderGalaxy(bands, zoomLevel) {
  if (!bands.length) {
    return '<p class="muted-copy centered">No favorites yet.</p>';
  }

  const nodes = bands
    .map((band, index) => {
      const angle = (index / bands.length) * Math.PI * 2;
      const radius = 14 + (index % 3) * 8;
      const x = 50 + Math.cos(angle) * (28 + radius);
      const y = 50 + Math.sin(angle) * (24 + radius);
      return `<button class="orbit-node" style="left:${x}%;top:${y}%;--hue:${bandHue(
        band.id
      )}" data-action="open-band" data-id="${band.id}" title="${escapeHtml(band.name)}">${escapeHtml(
        initials(band.name)
      )}</button>`;
    })
    .join("");

  const zoom = Number(clamp(zoomLevel, MIN_GRAPH_ZOOM, MAX_GRAPH_ZOOM).toFixed(2));
  const atDefaultZoom = Math.abs(zoom - 1) < 0.01;
  return `
    <div class="galaxy-wrap">
      <div class="galaxy-toolbar">
        <button class="chip zoom-btn" data-action="profile-graph-zoom-out" ${
          zoom <= MIN_GRAPH_ZOOM ? "disabled" : ""
        }>-</button>
        <span class="galaxy-zoom-label">${Math.round(zoom * 100)}%</span>
        <button class="chip zoom-btn" data-action="profile-graph-zoom-in" ${
          zoom >= MAX_GRAPH_ZOOM ? "disabled" : ""
        }>+</button>
        <button class="chip zoom-btn" data-action="profile-graph-zoom-reset" ${
          atDefaultZoom ? "disabled" : ""
        }>Reset</button>
      </div>
      <div class="galaxy-viewport">
        <div class="galaxy-grid" style="--galaxy-zoom:${zoom.toFixed(2)}">${nodes}</div>
      </div>
    </div>
  `;
}

function renderBandDetail(id) {
  const band = getBandById(id);
  if (!band) {
    return `
      <section class="page-stack">
        <p class="muted-copy centered">Band not found.</p>
        <button class="chip" data-action="back">Back</button>
      </section>
    `;
  }
  const model = buildPreferenceModel();
  const scoreOf = (candidate) => getGuidedMatchScore(candidate, model);

  const similarBands = state.bands
    .filter((candidate) => candidate.id !== band.id)
    .filter((candidate) => candidate.genres.some((genre) => band.genres.includes(genre)))
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, 3);
  const bandSyncMessage = getBandSyncMessage(band.id);
  const isBandSyncing = isBandSyncLoading(band.id);
  const links = band.links && typeof band.links === "object" ? band.links : {};

  return `
    <section class="band-detail">
      <div class="detail-hero" style="--hue:${bandHue(band.id)}">
        <button class="icon-btn" data-action="back" aria-label="Back">←</button>
        <button class="icon-btn" data-action="toggle-favorite" data-id="${band.id}" aria-label="Toggle favorite">${
          band.isFavorite ? "♥" : "♡"
        }</button>
        <div class="hero-inner">
          ${renderBandVisual(band, "lg")}
          <h1>${escapeHtml(band.name)}</h1>
          <p>${band.yearFormed} · ${toFlagEmoji(band.countryCode)} ${escapeHtml(band.country)}</p>
          ${renderMatchBadge(scoreOf(band))}
        </div>
      </div>

      <div class="page-stack detail-copy">
        <div class="genre-row wrap">${band.genres.map((genre) => renderGenreTag(genre, true)).join("")}</div>

        <p class="muted-copy">${escapeHtml(band.description)}</p>
        <div class="chip-row dense">
          <button class="chip ${isBandSyncing ? "chip-active" : ""}" data-action="band-enrich" data-id="${
    band.id
  }" ${isBandSyncing ? "disabled" : ""}>${
    isBandSyncing ? "Syncing..." : "Refresh real data"
  }</button>
          ${
            links.spotify
              ? `<a class="chip link-chip" href="${escapeHtml(
                  links.spotify
                )}" target="_blank" rel="noopener noreferrer">Spotify</a>`
              : ""
          }
          ${
            links.deezer
              ? `<a class="chip link-chip" href="${escapeHtml(
                  links.deezer
                )}" target="_blank" rel="noopener noreferrer">Deezer</a>`
              : ""
          }
        </div>
        ${
          bandSyncMessage
            ? `<p class="import-notice ${bandSyncMessage.type}">${escapeHtml(
                bandSyncMessage.text
              )}</p>`
            : ""
        }

        <section>
          <h3>Top songs</h3>
          <div class="song-list">
            ${band.topSongs
              .map(
                (song, index) =>
                  `<div class="song-row"><span>${index + 1}.</span><strong>${escapeHtml(
                    song.title
                  )}</strong><small>${escapeHtml(song.duration)}</small></div>`
              )
              .join("")}
          </div>
        </section>

        ${
          Array.isArray(band.albums) && band.albums.length
            ? `<section>
                <h3>Albums</h3>
                <div class="album-grid">
                  ${band.albums
                    .map(
                      (album) =>
                        `<article class="album-card">
                          ${
                            album.cover
                              ? `<img src="${escapeHtml(album.cover)}" alt="${escapeHtml(
                                  album.title
                                )} cover" loading="lazy" referrerpolicy="no-referrer" />`
                              : `<div class="album-cover-fallback">${escapeHtml(
                                  initials(album.title)
                                )}</div>`
                          }
                          <div>
                            <strong>${escapeHtml(album.title)}</strong>
                            <small>${
                              Number.isFinite(album.year) ? escapeHtml(String(album.year)) : "Year unknown"
                            }</small>
                          </div>
                        </article>`
                    )
                    .join("")}
                </div>
              </section>`
            : ""
        }

        ${
          band.tourDates.length
            ? `<section>
                <h3>Tour dates</h3>
                <div class="stack-rows">
                  ${band.tourDates
                    .map(
                      (tour) =>
                        `<article class="tour-row">
                           <div>
                             <strong>${escapeHtml(tour.venue)}</strong>
                             <p>${escapeHtml(tour.city)}</p>
                           </div>
                           <span>${escapeHtml(formatDate(tour.date))}</span>
                         </article>`
                    )
                    .join("")}
                </div>
              </section>`
            : ""
        }

        ${
          similarBands.length
            ? `<section>
                <h3>Similar bands</h3>
                <div class="stack-cards">${similarBands
                  .map((candidate) => renderBandCard(candidate, false, scoreOf(candidate)))
                  .join("")}</div>
              </section>`
            : ""
        }
      </div>
    </section>
  `;
}

function renderHeader(route) {
  const title =
    route.name === "discover"
      ? "Discover"
      : route.name === "profile"
      ? "Profile"
      : route.name === "band"
      ? "Band"
      : "The List";

  return `
    <header class="app-header">
      <div class="header-left">
        ${
          route.name === "band"
            ? '<button class="icon-btn" data-action="back" aria-label="Back">←</button>'
            : '<span class="spark">✦</span>'
        }
        <p>${escapeHtml(title)}</p>
      </div>
      <button class="avatar-mini" data-action="nav" data-path="/profile" aria-label="Open profile">${escapeHtml(
        initials(state.profile.name)
      )}</button>
    </header>
  `;
}

function renderNavigation(route) {
  const items = [
    { path: "/", label: "Home" },
    { path: "/discover", label: "Discover" },
    { path: "/profile", label: "Profile" },
  ];

  return `
    <nav class="bottom-nav">
      ${items
        .map(
          (item) =>
            `<button data-action="nav" data-path="${item.path}" class="nav-btn ${
              (route.name === "home" && item.path === "/") ||
              (route.name === "discover" && item.path === "/discover") ||
              (route.name === "profile" && item.path === "/profile")
                ? "active"
                : ""
            }">${item.label}</button>`
        )
        .join("")}
    </nav>
  `;
}

function renderInstallBanner() {
  if (!state.pwa.showInstall) return "";
  return `
    <section class="install-banner">
      <p>Install this app for offline listening discovery.</p>
      <button class="chip chip-active" data-action="pwa-install">Install</button>
    </section>
  `;
}

function render() {
  const route = parseRoute();

  let page = "";
  if (route.name === "home") {
    page = renderDashboard();
  } else if (route.name === "discover") {
    page = renderDiscover();
  } else if (route.name === "profile") {
    page = renderProfile();
  } else {
    maybeAutoEnrichBand(route.id);
    page = renderBandDetail(route.id);
  }

  app.innerHTML = `
    <div class="app-shell">
      ${renderHeader(route)}
      <main class="app-main">${page}</main>
      ${renderNavigation(route)}
      ${renderInstallBanner()}
    </div>
  `;
}

function toggleFavorite(_id) {
  const id = _id || "";
  if (!id) return;
  if (state.profile.favoriteBandIds.includes(id)) {
    state.profile.favoriteBandIds = state.profile.favoriteBandIds.filter((bandId) => bandId !== id);
    recomputeProfileGenresFromSources();
  } else {
    state.profile.favoriteBandIds = [...state.profile.favoriteBandIds, id];
    absorbGenresFromBandIds([id]);
  }
  syncFavoriteFlags();
  persistProfileState();
}

async function installPwa() {
  if (!state.pwa.deferredPrompt) return;
  state.pwa.deferredPrompt.prompt();
  await state.pwa.deferredPrompt.userChoice;
  state.pwa.deferredPrompt = null;
  state.pwa.showInstall = false;
  render();
}

function handleClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;

  const action = target.dataset.action;

  if (action === "nav") {
    navigate(target.dataset.path || "/");
  } else if (action === "open-band") {
    const id = target.dataset.id || "";
    if (id) {
      navigate(`/band/${id}`);
      maybeAutoEnrichBand(id);
    }
  } else if (action === "toggle-favorite") {
    event.stopPropagation();
    toggleFavorite(target.dataset.id);
    render();
  } else if (action === "toggle-dashboard-filters") {
    state.dashboard.showFilters = !state.dashboard.showFilters;
    render();
  } else if (action === "dashboard-sort") {
    state.dashboard.sort = target.dataset.sort || "match";
    render();
  } else if (action === "dashboard-filter") {
    state.dashboard.filter = target.dataset.filter || "all";
    render();
  } else if (action === "dashboard-random") {
    state.dashboard.sort = "random";
    state.discover.seed += 1;
    render();
  } else if (action === "discover-reshuffle") {
    state.discover.seed += 1;
    render();
  } else if (action === "discover-toggle-low") {
    state.discover.lowOnly = target.dataset.value === "low";
    render();
  } else if (action === "discover-genre") {
    const genre = target.dataset.genre || "";
    if (state.discover.selectedGenres.includes(genre)) {
      state.discover.selectedGenres = state.discover.selectedGenres.filter((g) => g !== genre);
    } else {
      state.discover.selectedGenres = [...state.discover.selectedGenres, genre];
    }
    render();
  } else if (action === "discover-country") {
    const country = target.dataset.country || "";
    if (state.discover.selectedCountries.includes(country)) {
      state.discover.selectedCountries = state.discover.selectedCountries.filter((c) => c !== country);
    } else {
      state.discover.selectedCountries = [...state.discover.selectedCountries, country];
    }
    render();
  } else if (action === "discover-clear-genres") {
    state.discover.selectedGenres = [];
    render();
  } else if (action === "discover-clear-countries") {
    state.discover.selectedCountries = [];
    render();
  } else if (action === "discover-toggle-all-genres") {
    state.discover.showAllGenres = !state.discover.showAllGenres;
    render();
  } else if (action === "discover-toggle-all-countries") {
    state.discover.showAllCountries = !state.discover.showAllCountries;
    render();
  } else if (action === "scanner-start-record") {
    startFingerprintRecording();
  } else if (action === "scanner-stop-record") {
    stopFingerprintRecording(true);
  } else if (action === "scanner-clear") {
    state.discover.scanner.results = [];
    state.discover.scanner.status = "idle";
    state.discover.scanner.message = "";
    if (state.discover.scanner.isRecording) {
      stopFingerprintRecording(false);
      return;
    }
    render();
  } else if (action === "profile-toggle-edit") {
    state.profileUi.editing = !state.profileUi.editing;
    if (!state.profileUi.editing) {
      state.profileUi.showGenrePicker = false;
    }
    render();
  } else if (action === "profile-toggle-view") {
    state.profileUi.view = target.dataset.view || "list";
    render();
  } else if (action === "profile-quiz-start" || action === "profile-quiz-restart") {
    startProfileQuiz();
    render();
  } else if (action === "profile-quiz-pick") {
    handleQuizPick(true);
    render();
  } else if (action === "profile-quiz-skip") {
    handleQuizPick(false);
    render();
  } else if (action === "profile-quiz-remove") {
    const id = target.dataset.id || "";
    state.profileUi.quiz.selectedIds = state.profileUi.quiz.selectedIds.filter(
      (selectedId) => selectedId !== id
    );
    state.profileUi.quiz.message = `${state.profileUi.quiz.selectedIds.length} selected.`;
    state.profileUi.quiz.messageType = "info";
    render();
  } else if (action === "profile-quiz-finish") {
    finishProfileQuiz();
    render();
  } else if (action === "profile-sync-favorites") {
    syncFavoriteBandsRealData();
  } else if (action === "profile-graph-zoom-in") {
    state.profileUi.graphZoom = clamp(
      state.profileUi.graphZoom + GRAPH_ZOOM_STEP,
      MIN_GRAPH_ZOOM,
      MAX_GRAPH_ZOOM
    );
    render();
  } else if (action === "profile-graph-zoom-out") {
    state.profileUi.graphZoom = clamp(
      state.profileUi.graphZoom - GRAPH_ZOOM_STEP,
      MIN_GRAPH_ZOOM,
      MAX_GRAPH_ZOOM
    );
    render();
  } else if (action === "profile-graph-zoom-reset") {
    state.profileUi.graphZoom = 1;
    render();
  } else if (action === "profile-remove-favorite") {
    const id = target.dataset.id || "";
    state.profile.favoriteBandIds = state.profile.favoriteBandIds.filter((bandId) => bandId !== id);
    recomputeProfileGenresFromSources();
    syncFavoriteFlags();
    persistProfileState();
    render();
  } else if (action === "profile-add-favorite") {
    const id = target.dataset.id || "";
    if (id && !state.profile.favoriteBandIds.includes(id)) {
      state.profile.favoriteBandIds = [...state.profile.favoriteBandIds, id];
      absorbGenresFromBandIds([id]);
      state.profileUi.query = "";
      syncFavoriteFlags();
      persistProfileState();
    }
    render();
  } else if (action === "profile-toggle-genre-picker") {
    state.profileUi.showGenrePicker = !state.profileUi.showGenrePicker;
    render();
  } else if (action === "profile-add-genre") {
    const genre = target.dataset.genre || "";
    if (genre && !state.profile.favoriteGenres.includes(genre)) {
      state.profile.favoriteGenres = [...state.profile.favoriteGenres, genre];
      persistProfileState();
    }
    render();
  } else if (action === "profile-remove-genre") {
    const genre = target.dataset.genre || "";
    state.profile.favoriteGenres = state.profile.favoriteGenres.filter((item) => item !== genre);
    persistProfileState();
    render();
  } else if (action === "band-enrich") {
    const id = target.dataset.id || "";
    if (id) {
      enrichBandById(id);
    }
  } else if (action === "back") {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      navigate("/");
    }
  } else if (action === "pwa-install") {
    installPwa();
  }
}

function handleInput(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;

  const model = input.dataset.model || "";
  const cursorStart = Number.isFinite(input.selectionStart) ? input.selectionStart : null;
  const rerenderKeepingCursor = (modelName) => {
    render();
    const nextInput = app.querySelector(`input[data-model="${modelName}"]`);
    if (!(nextInput instanceof HTMLInputElement)) return;
    nextInput.focus();
    if (typeof cursorStart === "number") {
      const position = Math.min(cursorStart, nextInput.value.length);
      nextInput.setSelectionRange(position, position);
    }
  };

  if (input.dataset.model === "dashboard-query") {
    state.dashboard.query = input.value;
    rerenderKeepingCursor(model);
  } else if (input.dataset.model === "discover-query") {
    state.discover.query = input.value;
    rerenderKeepingCursor(model);
  } else if (input.dataset.model === "scanner-token") {
    state.discover.scanner.token = input.value;
    rerenderKeepingCursor(model);
  } else if (input.dataset.model === "profile-query") {
    state.profileUi.query = input.value;
    rerenderKeepingCursor(model);
  }
}

function handleChange(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;

  if (input.dataset.model === "profile-band-file") {
    const [file] = input.files || [];
    if (!file) return;
    importBandsFromFile(file);
    input.value = "";
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Keep app functional even when service worker registration fails.
    });
  });
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.pwa.deferredPrompt = event;
  state.pwa.showInstall = true;
  render();
});

window.addEventListener("appinstalled", () => {
  state.pwa.deferredPrompt = null;
  state.pwa.showInstall = false;
  render();
});

window.addEventListener("hashchange", render);
app.addEventListener("click", handleClick);
app.addEventListener("input", handleInput);
app.addEventListener("change", handleChange);
window.addEventListener("beforeunload", () => {
  if (liveSyncTimer) {
    window.clearInterval(liveSyncTimer);
    liveSyncTimer = null;
  }
  if (activeRecorder && activeRecorder.state !== "inactive") {
    activeRecorder.stop();
  }
  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
  }
});

if (!window.location.hash) {
  window.location.hash = "/";
}

loadPersistedState();
archiveAndClearProfileBandsOnce();
loadInterestProfile();
loadFingerprintToken();
syncFavoriteFlags();
registerServiceWorker();
render();
startLivePipeline();
