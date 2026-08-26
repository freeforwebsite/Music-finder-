const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { AppError } = require("./audioProcessor");

const YTDLP_PATH = process.env.YTDLP_PATH || "yt-dlp";

function downloadMedia(url) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(os.tmpdir(), `mf-dl-${crypto.randomUUID()}.%(ext)s`);
    // Download the best audio or best video+audio, yt-dlp will save it to outPath
    const args = [
      "-f", "bestaudio/best",
      "--no-playlist",
      "-o", outPath,
      url,
    ];

    const child = spawn(YTDLP_PATH, args);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new AppError("TIMEOUT", "Downloading media timed out", 504));
    }, 120000); // 2 minute timeout for downloads

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new AppError("BINARY_MISSING", "yt-dlp is not installed", 500));
      } else {
        reject(new AppError("PROCESS_ERROR", err.message, 500));
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new AppError("DOWNLOAD_FAILED", `Failed to download URL. It may be private or unsupported.`, 400));
      } else {
        // yt-dlp replaces %(ext)s with the actual extension. We need to find the file it created.
        const fs = require("fs");
        const dir = os.tmpdir();
        const baseName = path.basename(outPath, ".%(ext)s");
        const files = fs.readdirSync(dir);
        const downloadedFile = files.find(f => f.startsWith(baseName));
        
        if (downloadedFile) {
          resolve(path.join(dir, downloadedFile));
        } else {
          reject(new AppError("DOWNLOAD_FAILED", "Could not locate downloaded file", 500));
        }
      }
    });
  });
}

module.exports = { downloadMedia };
