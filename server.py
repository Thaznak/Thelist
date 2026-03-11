#!/usr/bin/env python3
"""Static server + audio fingerprint proxy for the PWA.

Usage:
  python3 server.py 4173
"""

from __future__ import annotations

import base64
import csv
import io
import json
import mimetypes
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(
  os.getenv("MUSIC_DATA_DIR")
  or os.getenv("RAILWAY_VOLUME_MOUNT_PATH")
  or os.getenv("RENDER_DISK_MOUNT_PATH")
  or str(ROOT)
).resolve()
AUDD_ENDPOINT = "https://api.audd.io/"
MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 20
SPOTIFY_CLIENT_ID = os.getenv("SPOTIFY_CLIENT_ID", "").strip()
SPOTIFY_CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET", "").strip()
SPOTIFY_TOKEN_CACHE = {"access_token": "", "expires_at": 0.0}
LIVE_DB_PATH = DATA_DIR / "live_music_cache.sqlite3"
LIVE_REFRESH_SECONDS = max(60, int(os.getenv("LIVE_REFRESH_SECONDS", "600")))
LIVE_WORKER_POLL_SECONDS = max(10, int(os.getenv("LIVE_WORKER_POLL_SECONDS", "30")))
LIVE_MAX_REFRESH_PER_CYCLE = max(1, int(os.getenv("LIVE_MAX_REFRESH_PER_CYCLE", "6")))
LIVE_WORKER_STATE = {
  "last_run_at": 0.0,
  "last_error": "",
  "refreshed_this_run": 0,
}
LIVE_WAKE_EVENT = threading.Event()
LIVE_STOP_EVENT = threading.Event()


def build_multipart_form(fields: dict[str, str], files: dict[str, tuple[str, str, bytes]]) -> tuple[str, bytes]:
  boundary = f"----CodexBoundary{uuid.uuid4().hex}"
  body = io.BytesIO()

  for name, value in fields.items():
    body.write(f"--{boundary}\r\n".encode("utf-8"))
    body.write(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
    body.write(str(value).encode("utf-8"))
    body.write(b"\r\n")

  for name, (filename, content_type, data) in files.items():
    body.write(f"--{boundary}\r\n".encode("utf-8"))
    body.write(
      f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode(
        "utf-8"
      )
    )
    body.write(f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"))
    body.write(data)
    body.write(b"\r\n")

  body.write(f"--{boundary}--\r\n".encode("utf-8"))
  return f"multipart/form-data; boundary={boundary}", body.getvalue()


def normalize_band_name(value: object) -> str:
  text = str(value or "").strip()
  text = re.sub(r"\s+", " ", text)
  if text.lower() in {"nan", "none", "null", "n/a"}:
    return ""
  return text


def is_likely_band_name(value: str) -> bool:
  normalized = value.strip().lower()
  if normalized in {"band", "bands", "artist", "artists", "name", "names"}:
    return False
  if len(value) < 2:
    return False
  if len(value) > 120:
    return False
  return any(char.isalpha() for char in value)


def unique_preserve_order(items: list[str]) -> list[str]:
  seen: set[str] = set()
  output: list[str] = []
  for item in items:
    key = item.lower()
    if key in seen:
      continue
    seen.add(key)
    output.append(item)
  return output


def parse_txt_names(file_bytes: bytes) -> list[str]:
  text = file_bytes.decode("utf-8", errors="replace")
  names: list[str] = []
  for line in text.splitlines():
    chunks = re.split(r"[,\t;]", line) if any(sep in line for sep in [",", "\t", ";"]) else [line]
    for chunk in chunks:
      name = normalize_band_name(chunk)
      if is_likely_band_name(name):
        names.append(name)
  return unique_preserve_order(names)


def parse_csv_names(file_bytes: bytes) -> list[str]:
  text = file_bytes.decode("utf-8", errors="replace")
  reader = csv.reader(io.StringIO(text))
  names: list[str] = []
  for row in reader:
    if not row:
      continue
    non_empty = [normalize_band_name(cell) for cell in row]
    non_empty = [cell for cell in non_empty if cell]
    if not non_empty:
      continue
    first = non_empty[0]
    if is_likely_band_name(first):
      names.append(first)
  return unique_preserve_order(names)


def parse_xlsx_names(file_bytes: bytes) -> list[str]:
  namespace = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
  names: list[str] = []

  with zipfile.ZipFile(io.BytesIO(file_bytes)) as workbook:
    shared_strings: list[str] = []
    if "xl/sharedStrings.xml" in workbook.namelist():
      shared_root = ET.fromstring(workbook.read("xl/sharedStrings.xml"))
      for si in shared_root.findall("x:si", namespace):
        # shared strings can be plain <t> or rich text <r><t>.
        text_nodes = si.findall(".//x:t", namespace)
        text = "".join(node.text or "" for node in text_nodes)
        shared_strings.append(normalize_band_name(text))

    worksheet_files = sorted(
      name
      for name in workbook.namelist()
      if name.startswith("xl/worksheets/sheet") and name.endswith(".xml")
    )

    for sheet_name in worksheet_files:
      root = ET.fromstring(workbook.read(sheet_name))
      for cell in root.findall(".//x:c", namespace):
        cell_type = cell.attrib.get("t", "")
        value = ""
        if cell_type == "s":
          raw = cell.find("x:v", namespace)
          if raw is not None and raw.text and raw.text.isdigit():
            idx = int(raw.text)
            if 0 <= idx < len(shared_strings):
              value = shared_strings[idx]
        elif cell_type == "inlineStr":
          inline_nodes = cell.findall(".//x:t", namespace)
          value = "".join(node.text or "" for node in inline_nodes)
        else:
          raw = cell.find("x:v", namespace)
          if raw is not None:
            value = raw.text or ""

        candidate = normalize_band_name(value)
        if is_likely_band_name(candidate):
          names.append(candidate)

  return unique_preserve_order(names)


def parse_xls_names(file_bytes: bytes) -> list[str]:
  # Some .xls files are actually zipped .xlsx data.
  if file_bytes.startswith(b"PK\x03\x04"):
    return parse_xlsx_names(file_bytes)

  # Try xlrd if available (legacy .xls support).
  try:
    import xlrd  # type: ignore

    workbook = xlrd.open_workbook(file_contents=file_bytes)
    names: list[str] = []
    for sheet in workbook.sheets():
      for row_index in range(sheet.nrows):
        row_values = [
          normalize_band_name(sheet.cell_value(row_index, col_index))
          for col_index in range(sheet.ncols)
        ]
        row_values = [value for value in row_values if value]
        if row_values and is_likely_band_name(row_values[0]):
          names.append(row_values[0])
    return unique_preserve_order(names)
  except Exception:
    pass

  raise ValueError(
    "Could not parse .xls in this environment. Convert it to .xlsx or .csv and retry."
  )


def parse_uploaded_band_names(file_name: str, file_bytes: bytes) -> list[str]:
  if len(file_bytes) > MAX_IMPORT_FILE_BYTES:
    raise ValueError("File is too large. Use a file under 5MB.")

  extension = Path(file_name).suffix.lower()
  if extension == ".txt":
    names = parse_txt_names(file_bytes)
  elif extension == ".csv":
    names = parse_csv_names(file_bytes)
  elif extension == ".xlsx":
    names = parse_xlsx_names(file_bytes)
  elif extension == ".xls":
    names = parse_xls_names(file_bytes)
  else:
    # Default fallback to text parsing when extension is unknown.
    names = parse_txt_names(file_bytes)

  if not names:
    raise ValueError("No valid band names found in the uploaded file.")
  return names


def get_json(url: str, timeout: int = REQUEST_TIMEOUT_SECONDS) -> dict:
  request = urllib.request.Request(
    url,
    headers={
      "User-Agent": "SelfcareMusicDiscovery/1.0 (+https://localhost)",
      "Accept": "application/json",
    },
  )
  with urllib.request.urlopen(request, timeout=timeout) as response:
    raw = response.read().decode("utf-8", errors="replace")
  return json.loads(raw)


def format_seconds_to_mmss(total_seconds: int) -> str:
  minutes = max(total_seconds, 0) // 60
  seconds = max(total_seconds, 0) % 60
  return f"{minutes}:{seconds:02d}"


def get_spotify_access_token() -> str:
  if not SPOTIFY_CLIENT_ID or not SPOTIFY_CLIENT_SECRET:
    return ""

  now = time.time()
  cached_token = str(SPOTIFY_TOKEN_CACHE.get("access_token") or "")
  expires_at = float(SPOTIFY_TOKEN_CACHE.get("expires_at") or 0)
  if cached_token and expires_at - 30 > now:
    return cached_token

  payload = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode("utf-8")
  credentials = f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode("utf-8")
  auth_header = base64.b64encode(credentials).decode("utf-8")

  request = urllib.request.Request(
    "https://accounts.spotify.com/api/token",
    data=payload,
    method="POST",
    headers={
      "Authorization": f"Basic {auth_header}",
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "User-Agent": "SelfcareMusicDiscovery/1.0 (+https://localhost)",
    },
  )

  with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
    token_payload = json.loads(response.read().decode("utf-8", errors="replace"))

  access_token = str(token_payload.get("access_token") or "")
  expires_in = int(token_payload.get("expires_in") or 0)
  if not access_token:
    return ""

  SPOTIFY_TOKEN_CACHE["access_token"] = access_token
  SPOTIFY_TOKEN_CACHE["expires_at"] = now + expires_in
  return access_token


def spotify_get_json(url: str, access_token: str, timeout: int = REQUEST_TIMEOUT_SECONDS) -> dict:
  request = urllib.request.Request(
    url,
    headers={
      "Authorization": f"Bearer {access_token}",
      "Accept": "application/json",
      "User-Agent": "SelfcareMusicDiscovery/1.0 (+https://localhost)",
    },
  )
  with urllib.request.urlopen(request, timeout=timeout) as response:
    raw = response.read().decode("utf-8", errors="replace")
  return json.loads(raw)


def spotify_enrich(name: str) -> dict:
  access_token = get_spotify_access_token()
  if not access_token:
    return {"found": False}

  query = urllib.parse.quote(name)
  search_payload = spotify_get_json(
    f"https://api.spotify.com/v1/search?type=artist&limit=1&q={query}",
    access_token=access_token,
  )
  artists = (
    search_payload.get("artists", {}).get("items", [])
    if isinstance(search_payload.get("artists"), dict)
    else []
  )
  if not artists:
    return {"found": False}

  artist = artists[0]
  artist_id = artist.get("id")
  if not artist_id:
    return {"found": False}

  top_tracks_payload = spotify_get_json(
    f"https://api.spotify.com/v1/artists/{artist_id}/top-tracks?market=US",
    access_token=access_token,
  )
  albums_payload = spotify_get_json(
    "https://api.spotify.com/v1/artists/"
    f"{artist_id}/albums?include_groups=album,single&market=US&limit=12",
    access_token=access_token,
  )

  top_tracks = []
  for track in top_tracks_payload.get("tracks", [])[:5]:
    duration_ms = int(track.get("duration_ms") or 0)
    top_tracks.append(
      {
        "title": normalize_band_name(track.get("name")) or "Unknown track",
        "duration": format_seconds_to_mmss(duration_ms // 1000) if duration_ms else "--:--",
      }
    )

  albums = []
  for album in albums_payload.get("items", []):
    release_date = str(album.get("release_date") or "")
    year = int(release_date[:4]) if len(release_date) >= 4 and release_date[:4].isdigit() else None
    images = album.get("images") if isinstance(album.get("images"), list) else []
    cover = images[0].get("url") if images and isinstance(images[0], dict) else ""
    albums.append(
      {
        "title": normalize_band_name(album.get("name")) or "Unknown album",
        "year": year,
        "cover": cover,
      }
    )

  unique_albums = []
  seen_albums: set[str] = set()
  for album in albums:
    key = album["title"].lower()
    if key in seen_albums:
      continue
    seen_albums.add(key)
    unique_albums.append(album)

  images = artist.get("images") if isinstance(artist.get("images"), list) else []
  artist_image = images[0].get("url") if images and isinstance(images[0], dict) else ""

  return {
    "found": True,
    "artistName": normalize_band_name(artist.get("name")) or name,
    "image": artist_image,
    "genres": unique_preserve_order(
      [normalize_band_name(genre) for genre in artist.get("genres", [])]
    )[:4],
    "topSongs": top_tracks,
    "albums": unique_albums,
    "spotifyLink": (artist.get("external_urls") or {}).get("spotify", "")
    if isinstance(artist.get("external_urls"), dict)
    else "",
  }


def deezer_enrich(name: str) -> dict:
  query = urllib.parse.quote(name)
  artist_search = get_json(f"https://api.deezer.com/search/artist?q={query}")
  artists = artist_search.get("data") if isinstance(artist_search, dict) else []
  if not artists:
    return {"found": False}

  artist = artists[0]
  artist_id = artist.get("id")
  if not artist_id:
    return {"found": False}

  top_tracks_json = get_json(f"https://api.deezer.com/artist/{artist_id}/top?limit=5")
  albums_json = get_json(f"https://api.deezer.com/artist/{artist_id}/albums?limit=6")

  top_tracks = []
  for track in top_tracks_json.get("data", []):
    duration_seconds = int(track.get("duration") or 0)
    minutes = duration_seconds // 60
    seconds = duration_seconds % 60
    top_tracks.append(
      {
        "title": normalize_band_name(track.get("title")) or "Unknown track",
        "duration": f"{minutes}:{seconds:02d}" if duration_seconds else "--:--",
      }
    )

  albums = []
  for album in albums_json.get("data", []):
    release = str(album.get("release_date") or "")
    year = int(release[:4]) if len(release) >= 4 and release[:4].isdigit() else None
    albums.append(
      {
        "title": normalize_band_name(album.get("title")) or "Unknown album",
        "year": year,
        "cover": album.get("cover_xl") or album.get("cover_big") or album.get("cover_medium") or "",
      }
    )

  unique_albums = []
  seen_albums: set[str] = set()
  for album in albums:
    key = album["title"].lower()
    if key in seen_albums:
      continue
    seen_albums.add(key)
    unique_albums.append(album)

  return {
    "found": True,
    "artistName": normalize_band_name(artist.get("name")) or name,
    "image": artist.get("picture_xl")
    or artist.get("picture_big")
    or artist.get("picture_medium")
    or artist.get("picture")
    or "",
    "topSongs": top_tracks,
    "albums": unique_albums,
    "deezerLink": artist.get("link") or "",
  }


def musicbrainz_enrich(name: str) -> dict:
  query = urllib.parse.quote(f'artist:"{name}"')
  payload = get_json(f"https://musicbrainz.org/ws/2/artist/?query={query}&fmt=json&limit=5")
  artists = payload.get("artists") if isinstance(payload, dict) else []
  if not artists:
    return {"found": False}

  artist = artists[0]
  country = normalize_band_name(artist.get("country"))
  life_span = artist.get("life-span") if isinstance(artist.get("life-span"), dict) else {}
  begin = normalize_band_name(life_span.get("begin")) if isinstance(life_span, dict) else ""
  year_formed = int(begin[:4]) if len(begin) >= 4 and begin[:4].isdigit() else None

  tags = []
  for tag in artist.get("tags", []) if isinstance(artist.get("tags"), list) else []:
    tag_name = normalize_band_name(tag.get("name"))
    if tag_name:
      tags.append(tag_name)

  return {
    "found": True,
    "countryCode": country if len(country) == 2 else "",
    "yearFormed": year_formed,
    "genres": unique_preserve_order(tags)[:4],
  }


def combine_band_enrichment(name: str) -> dict:
  spotify = {}
  deezer = {}
  musicbrainz = {}

  try:
    spotify = spotify_enrich(name)
  except Exception:
    spotify = {"found": False}

  try:
    deezer = deezer_enrich(name)
  except Exception:
    deezer = {"found": False}

  try:
    musicbrainz = musicbrainz_enrich(name)
  except Exception:
    musicbrainz = {"found": False}

  if not spotify.get("found") and not deezer.get("found"):
    return {"found": False}

  primary_name = (
    spotify.get("artistName")
    or deezer.get("artistName")
    or name
  )
  image = spotify.get("image") or deezer.get("image") or ""
  top_songs = spotify.get("topSongs") or deezer.get("topSongs") or []
  albums = spotify.get("albums") or deezer.get("albums") or []
  genres = spotify.get("genres") or musicbrainz.get("genres") or []

  description_parts = []
  if spotify.get("found"):
    description_parts.append("Spotify")
  if deezer.get("found"):
    description_parts.append("Deezer")
  if musicbrainz.get("found"):
    description_parts.append("MusicBrainz")

  return {
    "found": True,
    "name": primary_name,
    "image": image,
    "albums": albums,
    "topSongs": top_songs,
    "countryCode": musicbrainz.get("countryCode") or "",
    "yearFormed": musicbrainz.get("yearFormed"),
    "genres": genres,
    "description": "Real data sourced from " + ", ".join(description_parts) + ".",
    "links": {
      "spotify": spotify.get("spotifyLink") or "",
      "deezer": deezer.get("deezerLink") or "",
    },
  }


def normalize_band_key(name: str) -> str:
  return normalize_band_name(name).lower()


def db_connect() -> sqlite3.Connection:
  connection = sqlite3.connect(str(LIVE_DB_PATH))
  connection.row_factory = sqlite3.Row
  return connection


def init_live_db() -> None:
  LIVE_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
  with db_connect() as connection:
    connection.execute(
      """
      CREATE TABLE IF NOT EXISTS watched_bands (
        normalized_name TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updated_at REAL NOT NULL
      )
      """
    )
    connection.execute(
      """
      CREATE TABLE IF NOT EXISTS band_cache (
        normalized_name TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        refreshed_at REAL NOT NULL,
        last_error TEXT NOT NULL DEFAULT ''
      )
      """
    )
    connection.execute(
      "CREATE INDEX IF NOT EXISTS idx_watched_bands_updated_at ON watched_bands(updated_at DESC)"
    )


def set_watchlist(names: list[str]) -> list[str]:
  now = time.time()
  cleaned = unique_preserve_order([normalize_band_name(name) for name in names if normalize_band_name(name)])
  keys = [normalize_band_key(name) for name in cleaned]

  with db_connect() as connection:
    for name, key in zip(cleaned, keys):
      connection.execute(
        """
        INSERT INTO watched_bands(normalized_name, name, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(normalized_name) DO UPDATE SET
          name = excluded.name,
          updated_at = excluded.updated_at
        """,
        (key, name, now),
      )

    if keys:
      placeholders = ",".join("?" for _ in keys)
      connection.execute(
        f"DELETE FROM watched_bands WHERE normalized_name NOT IN ({placeholders})",
        keys,
      )
    else:
      connection.execute("DELETE FROM watched_bands")

  return cleaned


def get_watchlist() -> list[dict]:
  with db_connect() as connection:
    rows = connection.execute(
      "SELECT normalized_name, name, updated_at FROM watched_bands ORDER BY updated_at DESC"
    ).fetchall()
  return [dict(row) for row in rows]


def store_band_cache(name: str, payload: dict, error_message: str = "") -> None:
  key = normalize_band_key(name)
  if not key:
    return
  now = time.time()
  payload_json = json.dumps(payload)
  with db_connect() as connection:
    connection.execute(
      """
      INSERT INTO band_cache(normalized_name, name, payload_json, refreshed_at, last_error)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(normalized_name) DO UPDATE SET
        name = excluded.name,
        payload_json = excluded.payload_json,
        refreshed_at = excluded.refreshed_at,
        last_error = excluded.last_error
      """,
      (key, normalize_band_name(name) or name, payload_json, now, error_message[:200]),
    )


def get_band_cache_map(keys: list[str]) -> dict[str, dict]:
  if not keys:
    return {}
  placeholders = ",".join("?" for _ in keys)
  with db_connect() as connection:
    rows = connection.execute(
      f"""
      SELECT normalized_name, name, payload_json, refreshed_at, last_error
      FROM band_cache
      WHERE normalized_name IN ({placeholders})
      """,
      keys,
    ).fetchall()

  output: dict[str, dict] = {}
  for row in rows:
    try:
      payload = json.loads(row["payload_json"])
    except json.JSONDecodeError:
      payload = {"found": False}
    output[str(row["normalized_name"])] = {
      "name": str(row["name"]),
      "payload": payload,
      "refreshed_at": float(row["refreshed_at"] or 0.0),
      "last_error": str(row["last_error"] or ""),
    }
  return output


def refresh_watchlist_once(force: bool = False, max_count: int = LIVE_MAX_REFRESH_PER_CYCLE) -> int:
  watchlist = get_watchlist()
  keys = [str(item["normalized_name"]) for item in watchlist]
  cache_by_key = get_band_cache_map(keys)
  now = time.time()
  refreshed = 0

  for item in watchlist:
    if refreshed >= max_count:
      break
    key = str(item["normalized_name"])
    name = str(item["name"])
    cached = cache_by_key.get(key)
    cached_age = now - float(cached["refreshed_at"]) if cached else (LIVE_REFRESH_SECONDS + 1)
    should_refresh = force or cached is None or cached_age >= LIVE_REFRESH_SECONDS
    if not should_refresh:
      continue

    try:
      payload = combine_band_enrichment(name)
      store_band_cache(name, payload, "")
    except Exception as error:  # noqa: BLE001
      fallback_payload = cached["payload"] if cached else {"found": False}
      store_band_cache(name, fallback_payload, str(error))
    refreshed += 1

  LIVE_WORKER_STATE["last_run_at"] = now
  LIVE_WORKER_STATE["refreshed_this_run"] = refreshed
  return refreshed


def get_live_snapshot() -> dict:
  watchlist = get_watchlist()
  keys = [str(item["normalized_name"]) for item in watchlist]
  cache_by_key = get_band_cache_map(keys)
  now = time.time()
  items = []

  for item in watchlist:
    key = str(item["normalized_name"])
    name = str(item["name"])
    cached = cache_by_key.get(key)
    if cached:
      age_seconds = max(0, int(now - cached["refreshed_at"]))
      items.append(
        {
          "name": name,
          "result": cached["payload"],
          "refreshedAt": cached["refreshed_at"],
          "ageSeconds": age_seconds,
          "isStale": age_seconds >= LIVE_REFRESH_SECONDS,
          "lastError": cached["last_error"],
        }
      )
    else:
      items.append(
        {
          "name": name,
          "result": {"found": False},
          "refreshedAt": 0.0,
          "ageSeconds": 0,
          "isStale": True,
          "lastError": "Not synced yet.",
        }
      )

  return {
    "items": items,
    "watchCount": len(items),
    "refreshSeconds": LIVE_REFRESH_SECONDS,
    "worker": {
      "lastRunAt": float(LIVE_WORKER_STATE["last_run_at"] or 0.0),
      "lastError": str(LIVE_WORKER_STATE["last_error"] or ""),
      "refreshedThisRun": int(LIVE_WORKER_STATE["refreshed_this_run"] or 0),
    },
  }


def live_sync_worker() -> None:
  while not LIVE_STOP_EVENT.is_set():
    try:
      refresh_watchlist_once(force=False, max_count=LIVE_MAX_REFRESH_PER_CYCLE)
      LIVE_WORKER_STATE["last_error"] = ""
    except Exception as error:  # noqa: BLE001
      LIVE_WORKER_STATE["last_error"] = str(error)

    LIVE_WAKE_EVENT.wait(timeout=LIVE_WORKER_POLL_SECONDS)
    LIVE_WAKE_EVENT.clear()


class AppHandler(SimpleHTTPRequestHandler):
  def __init__(self, *args, **kwargs):
    super().__init__(*args, directory=str(ROOT), **kwargs)

  def do_GET(self) -> None:  # noqa: N802
    if self.path.startswith("/healthz"):
      self._write_json({"ok": True, "status": "healthy"})
      return
    if self.path.startswith("/api/live/snapshot"):
      self.handle_live_snapshot()
      return
    super().do_GET()

  def do_OPTIONS(self) -> None:  # noqa: N802
    self.send_response(204)
    self.send_header("Access-Control-Allow-Origin", "*")
    self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    self.send_header("Access-Control-Allow-Headers", "Content-Type")
    self.end_headers()

  def do_POST(self) -> None:  # noqa: N802
    if self.path.rstrip("/") == "/api/fingerprint":
      self.handle_fingerprint()
      return
    if self.path.rstrip("/") == "/api/import-bands":
      self.handle_import_bands()
      return
    if self.path.rstrip("/") == "/api/band-enrich":
      self.handle_band_enrich()
      return
    if self.path.rstrip("/") == "/api/live/watchlist":
      self.handle_live_watchlist()
      return

    self._write_json({"ok": False, "error": "Not found"}, status=404)

  def handle_live_snapshot(self) -> None:
    parsed = urllib.parse.urlparse(self.path)
    query = urllib.parse.parse_qs(parsed.query)
    if str(query.get("refresh", ["0"])[0]).lower() in {"1", "true", "yes"}:
      refresh_watchlist_once(force=True, max_count=LIVE_MAX_REFRESH_PER_CYCLE)
    snapshot = get_live_snapshot()
    self._write_json({"ok": True, "snapshot": snapshot})

  def handle_live_watchlist(self) -> None:
    content_length = int(self.headers.get("Content-Length", "0"))
    if content_length <= 0:
      self._write_json({"ok": False, "error": "Empty request body"}, status=400)
      return

    raw_body = self.rfile.read(content_length)
    try:
      payload = json.loads(raw_body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
      self._write_json({"ok": False, "error": "Invalid JSON payload"}, status=400)
      return

    names = payload.get("names")
    if not isinstance(names, list):
      self._write_json({"ok": False, "error": "names must be an array"}, status=400)
      return

    cleaned_names = [
      normalize_band_name(item)
      for item in names
      if isinstance(item, str) and normalize_band_name(item)
    ]
    cleaned_names = unique_preserve_order(cleaned_names)[:300]
    watched = set_watchlist(cleaned_names)

    refresh_now = bool(payload.get("refreshNow"))
    if refresh_now:
      refresh_watchlist_once(force=True, max_count=max(1, min(30, len(watched) or 1)))
    else:
      LIVE_WAKE_EVENT.set()

    snapshot = get_live_snapshot()
    self._write_json(
      {
        "ok": True,
        "watchCount": len(watched),
        "snapshot": snapshot,
      }
    )

  def handle_band_enrich(self) -> None:
    content_length = int(self.headers.get("Content-Length", "0"))
    if content_length <= 0:
      self._write_json({"ok": False, "error": "Empty request body"}, status=400)
      return

    raw_body = self.rfile.read(content_length)
    try:
      payload = json.loads(raw_body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
      self._write_json({"ok": False, "error": "Invalid JSON payload"}, status=400)
      return

    name = normalize_band_name(payload.get("name"))
    if not name:
      self._write_json({"ok": False, "error": "Missing band name"}, status=400)
      return

    try:
      result = combine_band_enrichment(name)
    except urllib.error.HTTPError as error:
      self._write_json(
        {"ok": False, "error": f"Upstream API error ({error.code})"},
        status=502,
      )
      return
    except urllib.error.URLError:
      self._write_json({"ok": False, "error": "Could not reach enrichment APIs"}, status=502)
      return
    except Exception:
      self._write_json({"ok": False, "error": "Band enrichment failed"}, status=500)
      return

    store_band_cache(name, result, "")
    self._write_json({"ok": True, "result": result})

  def handle_import_bands(self) -> None:
    content_length = int(self.headers.get("Content-Length", "0"))
    if content_length <= 0:
      self._write_json({"ok": False, "error": "Empty request body"}, status=400)
      return

    raw_body = self.rfile.read(content_length)
    try:
      payload = json.loads(raw_body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
      self._write_json({"ok": False, "error": "Invalid JSON payload"}, status=400)
      return

    file_name = str(payload.get("fileName") or "").strip() or "bands.txt"
    file_base64 = str(payload.get("fileBase64") or "")
    if not file_base64:
      self._write_json({"ok": False, "error": "Missing file content"}, status=400)
      return

    if "," in file_base64:
      file_base64 = file_base64.split(",", 1)[1]

    try:
      file_bytes = base64.b64decode(file_base64, validate=True)
    except Exception:
      self._write_json({"ok": False, "error": "Invalid base64 file payload"}, status=400)
      return

    try:
      names = parse_uploaded_band_names(file_name=file_name, file_bytes=file_bytes)
    except ValueError as error:
      self._write_json({"ok": False, "error": str(error)}, status=400)
      return
    except zipfile.BadZipFile:
      self._write_json({"ok": False, "error": "Invalid spreadsheet format."}, status=400)
      return
    except Exception:
      self._write_json({"ok": False, "error": "Could not parse this file."}, status=400)
      return

    self._write_json({"ok": True, "count": len(names), "names": names})

  def handle_fingerprint(self) -> None:
    content_length = int(self.headers.get("Content-Length", "0"))
    if content_length <= 0:
      self._write_json({"ok": False, "error": "Empty request body"}, status=400)
      return

    raw_body = self.rfile.read(content_length)
    try:
      payload = json.loads(raw_body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
      self._write_json({"ok": False, "error": "Invalid JSON payload"}, status=400)
      return

    api_token = str(payload.get("apiToken") or os.getenv("AUDD_API_TOKEN") or "").strip()
    audio_base64 = str(payload.get("audioBase64") or "")
    mime_type = str(payload.get("mimeType") or "audio/webm").split(";")[0]

    if not api_token:
      self._write_json({"ok": False, "error": "Missing fingerprint API token"}, status=400)
      return

    if not audio_base64:
      self._write_json({"ok": False, "error": "Missing audio sample"}, status=400)
      return

    if "," in audio_base64:
      audio_base64 = audio_base64.split(",", 1)[1]

    try:
      audio_bytes = base64.b64decode(audio_base64, validate=True)
    except Exception:
      self._write_json({"ok": False, "error": "Invalid base64 audio payload"}, status=400)
      return

    if len(audio_bytes) > MAX_AUDIO_BYTES:
      self._write_json({"ok": False, "error": "Audio sample is too large"}, status=413)
      return

    if len(audio_bytes) < 1200:
      self._write_json({"ok": False, "error": "Audio sample is too short"}, status=400)
      return

    extension = mimetypes.guess_extension(mime_type) or ".webm"
    content_type, multipart_body = build_multipart_form(
      fields={
        "api_token": api_token,
        "return": "apple_music,spotify",
      },
      files={
        "file": (f"sample{extension}", mime_type, audio_bytes),
      },
    )

    request = urllib.request.Request(
      AUDD_ENDPOINT,
      data=multipart_body,
      headers={"Content-Type": content_type},
      method="POST",
    )

    try:
      with urllib.request.urlopen(request, timeout=35) as response:
        upstream_raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
      message = error.read().decode("utf-8", errors="replace")
      self._write_json(
        {"ok": False, "error": f"Fingerprint provider rejected the request ({error.code})", "details": message},
        status=502,
      )
      return
    except urllib.error.URLError:
      self._write_json(
        {"ok": False, "error": "Could not reach fingerprint provider"},
        status=502,
      )
      return

    try:
      upstream = json.loads(upstream_raw)
    except json.JSONDecodeError:
      self._write_json(
        {"ok": False, "error": "Fingerprint provider returned invalid JSON"},
        status=502,
      )
      return

    if upstream.get("status") != "success":
      error_message = (
        upstream.get("error", {}).get("error_message")
        if isinstance(upstream.get("error"), dict)
        else "Fingerprint provider could not identify this sample."
      )
      self._write_json({"ok": False, "error": error_message, "response": upstream}, status=502)
      return

    self._write_json({"ok": True, "result": upstream.get("result"), "response": upstream})

  def _write_json(self, payload: dict, status: int = 200) -> None:
    data = json.dumps(payload).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Content-Length", str(len(data)))
    self.send_header("Cache-Control", "no-store")
    self.send_header("Access-Control-Allow-Origin", "*")
    self.end_headers()
    self.wfile.write(data)


def main() -> None:
  env_port = os.getenv("PORT", "").strip()
  default_port = int(env_port) if env_port.isdigit() else 4173
  port = int(sys.argv[1]) if len(sys.argv) > 1 else default_port
  host = os.getenv("HOST", "0.0.0.0").strip() or "0.0.0.0"
  init_live_db()
  worker = threading.Thread(target=live_sync_worker, name="live-sync-worker", daemon=True)
  worker.start()
  server = ThreadingHTTPServer((host, port), AppHandler)
  print(f"Serving app at http://{host}:{port}")
  print(f"Live cache DB path: {LIVE_DB_PATH}")
  print("Fingerprint endpoint: POST /api/fingerprint")
  print("Band enrichment endpoint: POST /api/band-enrich")
  print("Live watchlist endpoint: POST /api/live/watchlist")
  print("Live snapshot endpoint: GET /api/live/snapshot")
  print("Health endpoint: GET /healthz")
  print("Optional Spotify env vars: SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET")
  try:
    server.serve_forever()
  except KeyboardInterrupt:
    pass
  finally:
    LIVE_STOP_EVENT.set()
    LIVE_WAKE_EVENT.set()
    worker.join(timeout=2.0)
    server.server_close()


if __name__ == "__main__":
  main()
