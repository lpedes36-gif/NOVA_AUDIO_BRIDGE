import test from "node:test";
import assert from "node:assert/strict";
import worker, {
  encodeTrackId,
  decodeTrackId,
  parseFlacStreamInfo,
  inspect,
  normalizeQuality,
  buildTrackMetadata
} from "../src/index.js";

test("Track ID encode/decode", () => {
  const id = encodeTrackId("sample-album", "music.flac");
  assert.deepEqual(decodeTrackId(id), {
    identifier: "sample-album",
    filename: "music.flac"
  });
});

test("Reject malformed ID", () => {
  assert.equal(decodeTrackId("invalid"), null);
});

test("Reject unsafe path", () => {
  const id = encodeTrackId("album", "../secret.flac");
  assert.equal(decodeTrackId(id), null);
});

test("Reject non-FLAC data", () => {
  assert.equal(parseFlacStreamInfo(new Uint8Array(64)), null);
});

test("Read 96 kHz 24-bit stereo STREAMINFO", () => {
  const b = new Uint8Array(42);
  b.set([0x66, 0x4c, 0x61, 0x43], 0);
  b[7] = 34;

  const packed = 96000 * 4096 + (1 << 9) + (23 << 4);
  b[18] = (packed >>> 24) & 255;
  b[19] = (packed >>> 16) & 255;
  b[20] = (packed >>> 8) & 255;
  b[21] = packed & 255;

  assert.deepEqual(parseFlacStreamInfo(b), {
    format: "FLAC",
    sampleRate: 96000,
    bitDepth: 24,
    channels: 2
  });
});


function makeFlacHeader() {
  const b = new Uint8Array(42);
  b.set([0x66, 0x4c, 0x61, 0x43], 0);
  b[7] = 34;

  const packed = 96000 * 4096 + (1 << 9) + (23 << 4);
  b[18] = (packed >>> 24) & 255;
  b[19] = (packed >>> 16) & 255;
  b[20] = (packed >>> 8) & 255;
  b[21] = packed & 255;

  return b;
}

test("Reject HTTP 200 even if body contains FLAC", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      new Response(makeFlacHeader(), { status: 200 });

    assert.equal(await inspect("https://example.test/audio.flac"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Accept valid HTTP 206 FLAC Range response", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (_url, options) => {
      assert.equal(
        new Headers(options.headers).get("range"),
        "bytes=0-63"
      );

      return new Response(makeFlacHeader(), {
        status: 206,
        headers: {
          "content-range": "bytes 0-41/100"
        }
      });
    };

    const info = await inspect("https://example.test/audio.flac");

    assert.deepEqual(info, {
      format: "FLAC",
      sampleRate: 96000,
      bitDepth: 24,
      channels: 2
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Reject response body larger than 64 bytes", async () => {
  const originalFetch = globalThis.fetch;

  try {
    const oversized = new Uint8Array(65);
    oversized.set(makeFlacHeader());

    globalThis.fetch = async () =>
      new Response(oversized, {
        status: 206,
        headers: {
          "content-range": "bytes 0-63/100"
        }
      });

    assert.equal(await inspect("https://example.test/audio.flac"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Reject Content-Range ending beyond requested byte 63", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(makeFlacHeader(), {
      status: 206,
      headers: { "content-range": "bytes 0-64/100" }
    });

    assert.equal(await inspect("https://example.test/audio.flac"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Reject body shorter than Content-Range claims", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(
      makeFlacHeader().subarray(0, 41),
      {
        status: 206,
        headers: { "content-range": "bytes 0-41/100" }
      }
    );

    assert.equal(await inspect("https://example.test/audio.flac"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Reject body longer than Content-Range claims", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const body = new Uint8Array(43);
    body.set(makeFlacHeader());

    globalThis.fetch = async () => new Response(body, {
      status: 206,
      headers: { "content-range": "bytes 0-41/100" }
    });

    assert.equal(await inspect("https://example.test/audio.flac"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Reject mismatched Content-Length", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(makeFlacHeader(), {
      status: 206,
      headers: {
        "content-range": "bytes 0-41/100",
        "content-length": "41"
      }
    });

    assert.equal(await inspect("https://example.test/audio.flac"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Reject Content-Range with zero-length file", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(makeFlacHeader(), {
      status: 206,
      headers: { "content-range": "bytes 0-41/41" }
    });

    assert.equal(await inspect("https://example.test/audio.flac"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Handle FLAC inspection timeout safely", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      assert.ok(options.signal);
      throw new DOMException("Timeout", "AbortError");
    };
    assert.equal(
      await inspect("https://example.test/audio.flac"),
      null
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Handle search timeout with sanitized error", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      assert.ok(options.signal);
      throw new DOMException("Timeout", "AbortError");
    };
    const response = await worker.fetch(
      new Request("https://nova.test/search?q=daft")
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: "Search failed. Please try again."
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Handle stream metadata timeout safely", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      assert.ok(options.signal);
      throw new DOMException("Timeout", "AbortError");
    };
    const id = encodeTrackId("sample-album", "music.flac");
    const response = await worker.fetch(
      new Request(`https://nova.test/stream/${id}`)
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: "Stream resolution failed. Please try again."
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("Normalize quality tiers", () => {
  assert.equal(normalizeQuality("hires"), "hires");
  assert.equal(normalizeQuality("HIRES"), "hires");
  assert.equal(normalizeQuality("lossless"), "lossless");
  assert.equal(normalizeQuality("LOSSLESS"), "lossless");
  assert.equal(normalizeQuality("HIGH"), "high");
  assert.equal(normalizeQuality("LOW"), "low");
  assert.equal(normalizeQuality("unknown"), null);
});

test("Default quality is Hi-Res", () => {
  assert.equal(normalizeQuality(null), "hires");
  assert.equal(normalizeQuality(""), "hires");
});

test("LOW search returns no unsupported rendition", async () => {
  const response = await worker.fetch(
    new Request("https://nova.test/search?q=daft&quality=LOW")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.count, 0);
  assert.deepEqual(body.tracks, []);
});

test("LOW stream is rejected without conversion", async () => {
  const id = encodeTrackId("sample-album", "music.flac");
  const response = await worker.fetch(
    new Request(`https://nova.test/stream/${id}?quality=LOW`)
  );

  assert.equal(response.status, 404);
});

test("Invalid search quality is rejected", async () => {
  const response = await worker.fetch(
    new Request("https://nova.test/search?q=daft&quality=unknown")
  );

  assert.equal(response.status, 400);
});

test("Invalid stream quality is rejected", async () => {
  const id = encodeTrackId("sample-album", "music.flac");
  const response = await worker.fetch(
    new Request(`https://nova.test/stream/${id}?quality=unknown`)
  );

  assert.equal(response.status, 400);
});

test("HIGH search does not mislabel FLAC as lossy", async () => {
  const response = await worker.fetch(
    new Request("https://nova.test/search?q=daft&quality=HIGH")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.count, 0);
  assert.deepEqual(body.tracks, []);
});

test("HIGH stream is rejected without lossy rendition", async () => {
  const id = encodeTrackId("sample-album", "music.flac");
  const response = await worker.fetch(
    new Request(`https://nova.test/stream/${id}?quality=HIGH`)
  );

  assert.equal(response.status, 404);
});

test("Build track metadata from verified archive metadata", () => {
  const result = buildTrackMetadata(
    {
      identifier: "sample-album",
      metadata: {
        title: "Sample Album",
        creator: "Sample Artist"
      }
    },
    {
      name: "01_test_track.flac",
      length: "245.75"
    }
  );

  assert.deepEqual(result, {
    title: "01 test track",
    artist: "Sample Artist",
    album: "Sample Album",
    duration: 245.75
  });
});

test("Omit unavailable or invalid track duration", () => {
  const result = buildTrackMetadata(
    { metadata: { title: "Album" } },
    { name: "track.flac", length: "unknown" }
  );

  assert.deepEqual(result, {
    title: "track",
    artist: "Unknown",
    album: "Album"
  });
});
