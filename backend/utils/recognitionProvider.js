const axios = require("axios");
const { AppError } = require("./audioProcessor");

const ACOUSTID_URL = "https://api.acoustid.org/v2/lookup";
const MB_URL = "https://musicbrainz.org/ws/2";
const COVERART_URL = "https://coverartarchive.org";

/**
 * Every recognition provider implements: identify({ fingerprint, duration }) -> Result|null
 * This lets a second/paid provider be added later (see fallback chain below)
 * without touching the route layer or the frontend contract.
 */
class AcoustIdProvider {
  constructor(clientKey) {
    this.clientKey = clientKey;
  }

  async identify({ fingerprint, duration }) {
    if (!this.clientKey) {
      throw new AppError("CONFIG_ERROR", "Recognition service is not configured", 500);
    }

    let res;
    try {
      res = await axios.get(ACOUSTID_URL, {
        params: {
          client: this.clientKey,
          fingerprint,
          duration,
          meta: "recordings+releasegroups+releases+compress",
        },
        timeout: 15000,
      });
    } catch (err) {
      if (err.response?.status === 429) {
        throw new AppError("RATE_LIMITED", "Recognition service is busy, try again shortly", 429);
      }
      throw new AppError("PROVIDER_UNREACHABLE", "Could not reach the recognition service", 502);
    }

    const data = res.data;
    if (data.status !== "ok") {
      throw new AppError("PROVIDER_ERROR", data.error?.message || "Recognition service error", 502);
    }

    const results = (data.results || []).filter((r) => r.recordings?.length);
    if (!results.length) return null;

    // Highest-confidence result with an actual recording match
    results.sort((a, b) => (b.score || 0) - (a.score || 0));
    const best = results[0];
    const recording = best.recordings[0];

    const releaseGroup = recording.releasegroups?.[0];
    const release = releaseGroup?.releases?.[0];

    return {
      confidence: Math.round((best.score || 0) * 100),
      title: recording.title || "Unknown title",
      artist: (recording.artists || []).map((a) => a.name).join(", ") || "Unknown artist",
      album: releaseGroup?.title || null,
      releaseDate: release?.date || null,
      musicbrainzRecordingId: recording.id,
      musicbrainzReleaseId: release?.id || null,
    };
  }
}

async function fetchCoverArt(releaseId) {
  if (!releaseId) return null;
  try {
    const res = await axios.get(`${COVERART_URL}/release/${releaseId}`, { timeout: 8000 });
    const front = (res.data.images || []).find((i) => i.front) || res.data.images?.[0];
    return front?.thumbnails?.large || front?.image || null;
  } catch {
    return null; // Cover art is optional — never fail recognition over it
  }
}

function buildStreamingLinks(title, artist) {
  const q = encodeURIComponent(`${title} ${artist}`);
  return {
    youtube: `https://www.youtube.com/results?search_query=${q}`,
    spotify: `https://open.spotify.com/search/${q}`,
    appleMusic: `https://music.apple.com/search?term=${q}`,
  };
}

/**
 * Tries each configured provider in order until one returns a match.
 * v1 ships with AcoustID only; add another provider instance to this
 * array later (e.g. a paid ACRCloud/AudD provider) with zero changes
 * to the route or frontend.
 */
class RecognitionChain {
  constructor(providers) {
    this.providers = providers;
  }

  async identify(fingerprintData) {
    let lastErr = null;
    for (const provider of this.providers) {
      try {
        const match = await provider.identify(fingerprintData);
        if (match) return match;
      } catch (err) {
        lastErr = err;
        // try the next provider in the chain instead of failing outright
      }
    }
    if (lastErr) throw lastErr;
    return null;
  }
}

module.exports = { AcoustIdProvider, RecognitionChain, fetchCoverArt, buildStreamingLinks };
