require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const recognizeRoute = require("./routes/recognize");

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim());

app.use(
  cors({
    origin: ALLOWED_ORIGINS.includes("*") ? true : ALLOWED_ORIGINS,
  })
);
app.use(express.json());

// Recognition is the expensive path (ffmpeg + fingerprinting + network calls),
// so it gets its own tighter limiter than the rest of the API.
const recognizeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", code: "RATE_LIMITED", message: "Too many requests — please slow down." },
});

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api/recognize", recognizeLimiter, recognizeRoute);

// Fallback error handler for anything that slips past the route-level handling
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({
    status: "error",
    code: err.code || "SERVER_ERROR",
    message: "Something went wrong on our end. Please try again.",
  });
});

app.listen(PORT, () => {
  console.log(`Music Finder API listening on port ${PORT}`);
});
