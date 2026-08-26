const express = require("express");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { extractAudio, generateFingerprint, cleanup, AppError } = require("../utils/audioProcessor");
const { AcoustIdProvider, AuddProvider, RecognitionChain, fetchCoverArt, buildStreamingLinks } = require("../utils/recognitionProvider");
const { downloadMedia } = require("../utils/downloader");

const router = express.Router();

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50);
const ALLOWED_MIME = /^(audio|video)\//;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => cb(null, `mf-upload-${crypto.randomUUID()}${path.extname(file.originalname || "")}`),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.test(file.mimetype)) {
      return cb(new AppError("UNSUPPORTED_TYPE", "Only audio or video files are supported", 415));
    }
    cb(null, true);
  },
});

const providers = [];
if (process.env.AUDD_API_KEY) {
  providers.push(new AuddProvider(process.env.AUDD_API_KEY));
}
if (process.env.ACOUSTID_CLIENT_KEY) {
  providers.push(new AcoustIdProvider(process.env.ACOUSTID_CLIENT_KEY));
}
const chain = new RecognitionChain(providers);

// User-facing copy for every failure mode named in the spec.
const FRIENDLY_MESSAGES = {
  UNSUPPORTED_TYPE: "That file type isn't supported. Try an MP4, MOV, MP3, or M4A.",
  FILE_TOO_LARGE: `That file is over the ${MAX_UPLOAD_MB}MB limit. Try a shorter clip.`,
  NO_AUDIO: "We couldn't find audio in that file.",
  AUDIO_TOO_SHORT: "That clip is too short or silent to identify. Try a longer section.",
  FINGERPRINT_FAILED: "We couldn't analyze that audio. Try a different clip.",
  CONFIG_ERROR: "Song recognition is temporarily unavailable.",
  RATE_LIMITED: "We're getting a lot of requests right now — try again in a moment.",
  PROVIDER_UNREACHABLE: "The recognition service isn't responding. Try again shortly.",
  PROVIDER_ERROR: "The recognition service ran into an error. Try again shortly.",
  BINARY_MISSING: "Song recognition is temporarily unavailable.",
  TIMEOUT: "That took too long to process. Try a shorter clip.",
  PROCESS_FAILED: "We couldn't process that file. Try a different one.",
  DOWNLOAD_FAILED: "We couldn't download that link. It might be private or unsupported.",
};

function friendly(err) {
  const code = err.code || "UNKNOWN";
  return {
    code,
    message: (code === "PROVIDER_ERROR" && err.message !== "Recognition service error") ? err.message : (FRIENDLY_MESSAGES[code] || "Something went wrong identifying that song. Please try again."),
  };
}

router.post("/", (req, res) => {
  upload.single("media")(req, res, async (multerErr) => {
    if (multerErr) {
      const err =
        multerErr.code === "LIMIT_FILE_SIZE"
          ? new AppError("FILE_TOO_LARGE", "File too large", 413)
          : multerErr instanceof AppError
          ? multerErr
          : new AppError("UPLOAD_ERROR", multerErr.message, 400);
      const { code, message } = friendly(err);
      return res.status(err.status || 400).json({ status: "error", code, message });
    }

    if (!req.file && !req.body.url) {
      return res.status(400).json({ status: "error", code: "NO_FILE", message: "No file or URL was provided." });
    }

    let uploadedPath = null;
    let wavPath = null;
    let isDownloaded = false;

    try {
      if (req.file) {
        uploadedPath = req.file.path;
      } else if (req.body.url) {
        uploadedPath = await downloadMedia(req.body.url);
        isDownloaded = true;
      }

      wavPath = await extractAudio(uploadedPath);
      const fingerprintData = await generateFingerprint(wavPath);
      const match = await chain.identify({ ...fingerprintData, wavPath });

      if (!match) {
        return res.json({
          status: "no_match",
          message: "We couldn't identify this song. Try uploading a clearer or longer audio clip.",
        });
      }

      const [artwork] = await Promise.all([fetchCoverArt(match.musicbrainzReleaseId)]);
      const links = buildStreamingLinks(match.title, match.artist);

      return res.json({
        status: "ok",
        result: {
          title: match.title,
          artist: match.artist,
          album: match.album,
          releaseDate: match.releaseDate,
          confidence: match.confidence,
          artwork,
          links,
        },
      });
    } catch (err) {
      console.error("Recognition Error:", err);
      const status = err.status || 500;
      const { code, message } = friendly(err instanceof AppError ? err : new AppError("UNKNOWN", err.message));
      return res.status(status).json({ status: "error", code, message });
    } finally {
      cleanup(wavPath);
      if (req.file || isDownloaded) {
        cleanup(uploadedPath);
      }
    }
  });
});

module.exports = router;
