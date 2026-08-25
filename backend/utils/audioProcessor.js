const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const FPCALC_PATH = process.env.FPCALC_PATH || "fpcalc";

// Recognizable AppError so the route layer can map these to friendly messages.
class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function runCommand(cmd, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new AppError("TIMEOUT", `${cmd} timed out`, 504));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new AppError("BINARY_MISSING", `${cmd} is not installed or not on PATH`, 500));
      } else {
        reject(new AppError("PROCESS_ERROR", err.message, 500));
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new AppError("PROCESS_FAILED", `${cmd} exited with code ${code}: ${stderr.slice(0, 500)}`, 500));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Extracts a clean mono 16kHz WAV snippet from any uploaded audio/video file.
 * Trims to a middle window when the source is long, since a clear ~30-60s
 * section fingerprints better than a whole clip full of talking/silence.
 */
async function extractAudio(inputPath, { maxDurationSec = 60 } = {}) {
  const outPath = path.join(os.tmpdir(), `mf-${crypto.randomUUID()}.wav`);

  const probe = await getDurationSec(inputPath).catch(() => null);
  let startOffset = 0;
  if (probe && probe > maxDurationSec + 5) {
    // Prefer a section a little past the start — Reels often open with
    // talking or a caption card before the music kicks in.
    startOffset = Math.max(0, Math.floor((probe - maxDurationSec) / 2));
  }

  const args = [
    "-y",
    "-i", inputPath,
    ...(startOffset > 0 ? ["-ss", String(startOffset)] : []),
    "-t", String(maxDurationSec),
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-acodec", "pcm_s16le",
    outPath,
  ];

  try {
    await runCommand(FFMPEG_PATH, args);
  } catch (err) {
    if (err.code === "PROCESS_FAILED") {
      throw new AppError("NO_AUDIO", "Could not extract audio from this file", 422);
    }
    throw err;
  }

  const stats = fs.statSync(outPath);
  if (stats.size < 8000) {
    fs.unlinkSync(outPath);
    throw new AppError("AUDIO_TOO_SHORT", "Audio too short or silent to identify", 422);
  }

  return outPath;
}

async function getDurationSec(inputPath) {
  const { stdout, stderr } = await runCommand(FFMPEG_PATH, ["-i", inputPath]).catch((e) => {
    // ffmpeg with no output file exits non-zero but still prints duration to stderr
    if (e.stderr) return { stdout: "", stderr: e.message };
    throw e;
  });
  const text = stdout + stderr;
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!match) return null;
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/**
 * Runs Chromaprint's fpcalc against a WAV file and returns the fingerprint
 * plus duration needed for an AcoustID lookup.
 */
async function generateFingerprint(wavPath) {
  let stdout;
  try {
    ({ stdout } = await runCommand(FPCALC_PATH, ["-json", wavPath]));
  } catch (err) {
    if (err.code === "BINARY_MISSING") throw err;
    throw new AppError("FINGERPRINT_FAILED", "Could not generate an audio fingerprint", 500);
  }

  try {
    const parsed = JSON.parse(stdout);
    if (!parsed.fingerprint || !parsed.duration) {
      throw new Error("missing fields");
    }
    return { fingerprint: parsed.fingerprint, duration: Math.round(parsed.duration) };
  } catch {
    throw new AppError("FINGERPRINT_FAILED", "Fingerprint output was invalid", 500);
  }
}

function cleanup(...paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      fs.unlink(p, () => {});
    }
  }
}

module.exports = { extractAudio, generateFingerprint, cleanup, AppError };
