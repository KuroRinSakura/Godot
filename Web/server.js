const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 80;
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, "database.json");
const INTERNAL_PATHS = new Set([
  "/database.json",
  "/server.js",
  "/package.json",
  "/package-lock.json",
]);

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.use((_req, res, next) => {
  res.set({
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  next();
});

app.get("/api/game-state", (_req, res) => {
  res.json(readDatabase());
});

app.put("/api/game-state", saveGameState);
app.post("/api/game-state", saveGameState);

app.post("/api/reset-database", (_req, res) => {
  const database = createDefaultDatabase();
  writeDatabase(database);
  console.log("[database] reset");
  res.json({ ok: true, database });
});

app.use((req, res, next) => {
  let requestPath;

  try {
    requestPath = decodeURIComponent(req.path);
  } catch {
    res.status(400).type("text/plain").send("Bad Request");
    return;
  }

  if (isInternalPath(requestPath)) {
    res.status(404).type("text/plain").send("Not Found");
    return;
  }

  next();
});

app.use(express.static(__dirname, {
  dotfiles: "ignore",
  index: "index.html",
  setHeaders: (res, filePath) => {
    const lowerPath = filePath.toLowerCase();

    res.setHeader(
      "Cache-Control",
      lowerPath.endsWith(".html") ? "no-store" : "public, max-age=3600",
    );

    if (lowerPath.endsWith(".wasm")) {
      res.setHeader("Content-Type", "application/wasm");
    } else if (lowerPath.endsWith(".pck")) {
      res.setHeader("Content-Type", "application/octet-stream");
    }
  },
}));

app.use((_req, res) => {
  res.status(404).type("text/plain").send("Not Found");
});

app.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;

  console.log(`Serving files from ${__dirname}`);
  console.log(`Godot Web server is running at http://${displayHost}:${PORT}/`);
});

function isInternalPath(requestPath) {
  return (
    INTERNAL_PATHS.has(requestPath) ||
    requestPath.startsWith("/node_modules/") ||
    requestPath.startsWith("/.idea/")
  );
}

function saveGameState(req, res) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    res.status(400).json({ ok: false, error: "Expected a JSON object." });
    return;
  }

  const payload = req.body;
  if (!payload.game || typeof payload.game !== "object" || Array.isArray(payload.game)) {
    res.status(400).json({ ok: false, error: "Missing game payload." });
    return;
  }

  const database = normalizeDatabase(readDatabase());
  const winner = getWinner(payload);
  const gameId = getGameId(payload);

  if (
    payload.source === "victory" &&
    winner &&
    Object.prototype.hasOwnProperty.call(database.victory_counts, winner) &&
    gameId &&
    !database.counted_victory_game_ids.includes(gameId)
  ) {
    database.victory_counts[winner] += 1;
    database.counted_victory_game_ids.push(gameId);
    if (database.counted_victory_game_ids.length > 200) {
      database.counted_victory_game_ids = database.counted_victory_game_ids.slice(-200);
    }
  }

  database.game_payload = payload;
  database.updated_at_unix_ms = Date.now();
  writeDatabase(database);
  console.log(
    `[database] saved source=${String(payload.source || "")} game_id=${gameId || ""} turn=${String(payload.game.turn || "")} winner=${winner || ""}`,
  );
  res.json({ ok: true, database });
}

function readDatabase() {
  try {
    if (!fs.existsSync(DATABASE_PATH)) {
      const database = createDefaultDatabase();
      writeDatabase(database);
      return database;
    }

    const parsed = JSON.parse(fs.readFileSync(DATABASE_PATH, "utf8"));
    return normalizeDatabase(parsed);
  } catch (error) {
    console.error("Failed to read database:", error);
    return createDefaultDatabase();
  }
}

function writeDatabase(database) {
  const normalized = normalizeDatabase(database);
  const tmpPath = `${DATABASE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tmpPath, DATABASE_PATH);
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EEXIST")) {
      fs.rmSync(DATABASE_PATH, { force: true });
      fs.renameSync(tmpPath, DATABASE_PATH);
      return;
    }
    throw error;
  }
}

function createDefaultDatabase() {
  return {
    schema_version: 1,
    victory_counts: {
      blue: 0,
      red: 0,
    },
    game_payload: null,
    counted_victory_game_ids: [],
    updated_at_unix_ms: null,
  };
}

function normalizeDatabase(value) {
  const defaults = createDefaultDatabase();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }

  return {
    schema_version: 1,
    victory_counts: {
      blue: sanitizeCount(value.victory_counts && value.victory_counts.blue),
      red: sanitizeCount(value.victory_counts && value.victory_counts.red),
    },
    game_payload:
      value.game_payload && typeof value.game_payload === "object" && !Array.isArray(value.game_payload)
        ? value.game_payload
        : null,
    counted_victory_game_ids: Array.isArray(value.counted_victory_game_ids)
      ? value.counted_victory_game_ids.map(String)
      : [],
    updated_at_unix_ms:
      Number.isFinite(Number(value.updated_at_unix_ms)) ? Number(value.updated_at_unix_ms) : null,
  };
}

function sanitizeCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) {
    return 0;
  }
  return Math.floor(count);
}

function getWinner(payload) {
  if (!payload.game || typeof payload.game !== "object") {
    return "";
  }
  const winner = String(payload.game.winner || "");
  return winner === "blue" || winner === "red" ? winner : "";
}

function getGameId(payload) {
  if (payload.game_id) {
    return String(payload.game_id);
  }
  if (payload.game && payload.game.game_id) {
    return String(payload.game.game_id);
  }
  return "";
}
