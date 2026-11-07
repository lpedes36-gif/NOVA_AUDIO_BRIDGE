const APP = "NOVA AUDIO BRIDGE";
const VERSION = "1.0.0";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store"
    }
  });

export function encodeTrackId(identifier, filename) {
  const data = JSON.stringify({ identifier, filename });
  const bytes = new TextEncoder().encode(data);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-")
    .replaceAll("/", "_").replaceAll("=", "");
}

export function decodeTrackId(id) {
  try {
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > 4096 ||
      !/^[A-Za-z0-9_-]+$/.test(id) ||
      id.length % 4 === 1
    ) return null;

    const normalized = id.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const data = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );

    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      typeof data.identifier !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(data.identifier) ||
      !validFilename(data.filename)
    ) return null;

    let canonical = "";
    for (const byte of bytes) {
      canonical += String.fromCharCode(byte);
    }

    canonical = btoa(canonical)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");

    if (canonical !== id) return null;

    return data;
  } catch {
    return null;
  }
}

export function parseFlacStreamInfo(input) {
  const b = input instanceof Uint8Array
    ? input
    : new Uint8Array(input);

  if (
    b.length < 42 ||
    b[0] !== 0x66 ||
    b[1] !== 0x4c ||
    b[2] !== 0x61 ||
    b[3] !== 0x43 ||
    (b[4] & 0x7f) !== 0 ||
    ((b[5] << 16) | (b[6] << 8) | b[7]) !== 34
  ) return null;

  const packed =
    b[18] * 0x1000000 +
    (b[19] << 16) +
    (b[20] << 8) +
    b[21];

  const sampleRate = packed >>> 12;
  const channels = ((packed >>> 9) & 7) + 1;
  const bitDepth = ((packed >>> 4) & 31) + 1;

  if (
    sampleRate < 1 || sampleRate > 655350 ||
    channels < 1 || channels > 8 ||
    bitDepth < 4 || bitDepth > 32
  ) return null;

  return { format: "FLAC", sampleRate, bitDepth, channels };
}

function validFilename(name) {
  if (
    typeof name !== "string" ||
    name.length < 5 ||
    name.length > 512 ||
    !name.toLowerCase().endsWith(".flac") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    /[\\?#\u0000-\u001f\u007f]/.test(name)
  ) return false;

  const parts = name.split("/");
  return parts.every(part =>
    part.length > 0 && part !== "." && part !== ".."
  );
}

function archiveUrl(identifier, filename) {
  return "https://archive.org/download/" +
    encodeURIComponent(identifier) + "/" +
    filename.split("/").map(encodeURIComponent).join("/");
}

async function metadata(identifier) {
  const r = await fetch(
    "https://archive.org/metadata/" + encodeURIComponent(identifier),
    { signal: AbortSignal.timeout(10000) }
  );
  if (!r.ok) return null;
  return r.json();
}

function firstText(...values) {
  for (const value of values) {
    const text = Array.isArray(value)
      ? value.filter(v => typeof v === "string").join(", ").trim()
      : typeof value === "string"
        ? value.trim()
        : "";

    if (text) return text;
  }
  return null;
}

export function buildTrackMetadata(item, file, fallback = {}) {
  const meta = item?.metadata || {};
  const filename = String(file?.name || "").split("/").pop() || "";
  const filenameTitle = filename.replace(/\.flac$/i, "").replace(/[_-]+/g, " ").trim();

  const durationValue = Number(file?.length);
  const duration = Number.isFinite(durationValue) && durationValue > 0
    ? durationValue
    : null;

  return {
    title: firstText(file?.title, filenameTitle, fallback.title) || "Untitled",
    artist: firstText(file?.creator, meta.creator, fallback.creator) || "Unknown",
    album: firstText(file?.album, meta.album, meta.title, fallback.title, item?.identifier) || "Unknown",
    ...(duration !== null ? { duration } : {})
  };
}

export async function inspect(url) {
  let reader;

  try {
    const r = await fetch(url, {
      headers: { Range: "bytes=0-63" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000)
    });

    if (r.status !== 206) {
      await r.body?.cancel();
      return null;
    }

    const contentRange = r.headers.get("content-range") || "";
    const match = /^bytes 0-(\d+)\/(\d+)$/i.exec(contentRange);

    if (!match) {
      await r.body?.cancel();
      return null;
    }

    const end = Number(match[1]);
    const fileSize = Number(match[2]);
    const expectedLength = end + 1;

    if (
      !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(fileSize) ||
      end < 41 ||
      end > 63 ||
      fileSize <= end
    ) {
      await r.body?.cancel();
      return null;
    }

    const lengthHeader = r.headers.get("content-length");

    if (
      lengthHeader !== null &&
      (!/^\d+$/.test(lengthHeader) ||
       Number(lengthHeader) !== expectedLength)
    ) {
      await r.body?.cancel();
      return null;
    }

    reader = r.body?.getReader();
    if (!reader) return null;

    const chunks = [];
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;

      if (total > expectedLength) {
        await reader.cancel();
        return null;
      }

      chunks.push(value);
    }

    if (total !== expectedLength) return null;

    const data = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return parseFlacStreamInfo(data);
  } catch {
    try {
      await reader?.cancel();
    } catch {}

    return null;
  }
}

export function normalizeQuality(value) {
  const quality = String(value || "hires").trim().toLowerCase();

  if (["hires", "lossless", "high", "low"].includes(quality)) {
    return quality;
  }

  return null;
}

async function search(query, quality) {
  if (quality === "low" || quality === "high") return [];
  const params = new URLSearchParams({
    q: `mediatype:audio AND (${query})`,
    fl: "identifier,title,creator,year",
    rows: "10",
    output: "json"
  });

  const r = await fetch(
    "https://archive.org/advancedsearch.php?" + params,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!r.ok) throw new Error("Internet Archive search failed");

  const result = await r.json();
  const docs = result?.response?.docs || [];
  const tracks = [];

  for (const doc of docs.slice(0, 8)) {
    if (!doc.identifier) continue;

    const item = await metadata(doc.identifier);
    if (!item || item.is_dark) continue;

    const files = (item.files || []).filter(f =>
      validFilename(f.name) &&
      !f.name.toLowerCase().includes("_sample")
    );

    for (const file of files.slice(0, 3)) {
      const url = archiveUrl(doc.identifier, file.name);
      const info = await inspect(url);

      if (!info) continue;

      if (
        quality === "hires" &&
        (info.sampleRate <= 44100 || info.bitDepth <= 16)
      ) continue;

      tracks.push({
        id: encodeTrackId(doc.identifier, file.name),
        ...buildTrackMetadata(item, file, doc),
        format: "flac",
        audioQuality:
          info.sampleRate > 44100 && info.bitDepth > 16
            ? "HI_RES"
            : "LOSSLESS",
        source: "Internet Archive",
        sampleRate: info.sampleRate,
        bitDepth: info.bitDepth,
        channels: info.channels,
        size: Number(file.size) || null
      });
    }
  }

  return tracks;
}

async function streamInternal(id, quality = "hires") {
  quality = normalizeQuality(quality);

  if (!quality) {
    return json({ error: "Invalid quality" }, 400);
  }
  if (quality === "low" || quality === "high") {
    return json({ error: "No rendition available for this quality tier" }, 404);
  }

  const track = decodeTrackId(id);
  if (!track) return json({ error: "Invalid track ID" }, 400);

  const item = await metadata(track.identifier);
  if (!item || item.is_dark) {
    return json({ error: "Archive item unavailable" }, 404);
  }

  const file = (item.files || []).find(
    f => f.name === track.filename
  );

  if (!file || !validFilename(file.name)) {
    return json({ error: "FLAC file not found" }, 404);
  }

  const url = archiveUrl(track.identifier, file.name);
  const info = await inspect(url);

  if (!info) {
    return json({ error: "FLAC STREAMINFO verification failed" }, 422);
  }

  if (
    quality === "hires" &&
    (info.sampleRate <= 44100 || info.bitDepth <= 16)
  ) {
    return json({ error: "No verified Hi-Res FLAC rendition" }, 404);
  }

  return json({
    id,
    ...buildTrackMetadata(item, file),
    url,
    format: "flac",
    quality:
      info.sampleRate > 44100 && info.bitDepth > 16
        ? `Hi-Res FLAC · ${info.bitDepth}-bit / ${info.sampleRate / 1000} kHz`
        : "Lossless FLAC",
    codec: "flac",
    container: "flac",
    manifest: "none",
    encrypted: false,
    mimeType: "audio/flac",
    sampleRate: info.sampleRate,
    bitDepth: info.bitDepth,
    channels: info.channels,
    size: Number(file.size) || null,
    source: "Internet Archive"
  });
}


async function stream(id, quality = "hires") {
  try {
    return await streamInternal(id, quality);
  } catch {
    return json({ error: "Stream resolution failed. Please try again." }, 502);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "Range, Content-Type"
        }
      });
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    if (path === "/healthz" || path === "/health") {
      return json({ status: "ok", addon: APP, version: VERSION });
    }

    if (path === "/manifest.json") {
      return json({
        id: "id.nova.audio.bridge",
        name: APP,
        version: VERSION,
        description: "Internet Archive FLAC discovery bridge",
        resources: ["search", "stream"],
        types: ["track"],
        contentType: "music",
        allowDownloads: 1,
        checkValidLossless: 0,
        settings: [{
          key: "quality",
          type: "select",
          label: "Audio Quality",
          default: "hires",
          options: [
            { value: "hires", label: "Verified Hi-Res FLAC" },
            { value: "lossless", label: "FLAC Lossless" }
          ]
        }]
      });
    }

    if (path === "/search") {
      const q = (url.searchParams.get("q") || "").trim();
      const quality = normalizeQuality(
        url.searchParams.get("quality") || "hires"
      );

      if (!q || q.length > 120) {
        return json({ error: "Invalid or missing q parameter" }, 400);
      }
      if (!quality) {
        return json({ error: "Invalid quality" }, 400);
      }

      try {
        const tracks = await search(q, quality);
        return json({
          addon: APP,
          version: VERSION,
          quality,
          count: tracks.length,
          tracks
        });
      } catch (e) {
        return json({ error: "Search failed. Please try again." }, 502);
      }
    }

    if (path.startsWith("/stream/")) {
      return stream(
        path.slice("/stream/".length),
        url.searchParams.get("quality") || "hires"
      );
    }

    return json({ error: "Not found" }, 404);
  }
};
