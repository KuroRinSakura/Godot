const path = require("path");
const crypto = require("crypto");
const express = require("express");
const Datastore = require("@seald-io/nedb");

const app = express();
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 80;
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, "database.db");
const DATABASE_DOCUMENT_ID = "game_state";
const IP_DATABASE_DOCUMENT_PREFIX = "game_state_by_ip:";
const databaseStore = new Datastore({ filename: DATABASE_PATH });
const INTERNAL_PATHS = new Set([
  "/database.db",
  "/database.db~",
  "/server.js",
  "/package.json",
  "/package-lock.json",
]);
let databaseMutationQueue = Promise.resolve();

registerInternalDatabasePath(DATABASE_PATH);
configureTrustProxy();

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

app.get("/api/game-state", async (req, res) => {
  await waitForDatabaseMutations();
  const identity = getRequestIdentity(req);
  res.json(withConnectionMetadata(await readDatabase(identity.documentId), identity));
});

app.put("/api/game-state", saveGameState);
app.post("/api/game-state", saveGameState);

app.post("/api/reset-database", async (req, res) => {
  const identity = getRequestIdentity(req);
  const database = await runDatabaseMutation(async () => {
    const nextDatabase = createDefaultDatabase();
    await writeDatabase(identity.documentId, nextDatabase);
    return nextDatabase;
  });

  console.log(`[database] reset player_key=${identity.playerKey} ip=${identity.address}`);
  res.json({ ok: true, database: withConnectionMetadata(database, identity) });
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

app.use((error, req, res, next) => {
  console.error("Request failed:", error);

  if (res.headersSent) {
    next(error);
    return;
  }

  if (req.path.startsWith("/api/")) {
    res.status(500).json({ ok: false, error: "Internal server error." });
    return;
  }

  res.status(500).type("text/plain").send("Internal Server Error");
});

initializeDatabaseStorage()
  .then(() => {
    app.listen(PORT, HOST, () => {
      const displayHost = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;

      console.log(`Serving files from ${__dirname}`);
      console.log(`Database file: ${DATABASE_PATH}`);
      console.log(`Godot Web server is running at http://${displayHost}:${PORT}/`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });

function registerInternalDatabasePath(filePath) {
  const resolvedPath = path.resolve(filePath);

  if (path.dirname(resolvedPath) !== path.resolve(__dirname)) {
    return;
  }

  const basename = path.basename(resolvedPath);
  INTERNAL_PATHS.add(`/${basename}`);
  INTERNAL_PATHS.add(`/${basename}~`);
}

function isInternalPath(requestPath) {
  return (
    INTERNAL_PATHS.has(requestPath) ||
    requestPath.startsWith("/node_modules/") ||
    requestPath.startsWith("/.idea/")
  );
}

async function saveGameState(req, res) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    res.status(400).json({ ok: false, error: "Expected a JSON object." });
    return;
  }

  const payload = req.body;
  if (!payload.game || typeof payload.game !== "object" || Array.isArray(payload.game)) {
    res.status(400).json({ ok: false, error: "Missing game payload." });
    return;
  }

  const identity = getRequestIdentity(req);
  const winner = getWinner(payload);
  const gameId = getGameId(payload);
  const database = await runDatabaseMutation(async () => {
    const nextDatabase = normalizeDatabase(await readDatabase(identity.documentId));

    if (
      payload.source === "victory" &&
      winner &&
      Object.prototype.hasOwnProperty.call(nextDatabase.victory_counts, winner) &&
      gameId &&
      !nextDatabase.counted_victory_game_ids.includes(gameId)
    ) {
      nextDatabase.victory_counts[winner] += 1;
      nextDatabase.counted_victory_game_ids.push(gameId);
      if (nextDatabase.counted_victory_game_ids.length > 200) {
        nextDatabase.counted_victory_game_ids = nextDatabase.counted_victory_game_ids.slice(-200);
      }
    }

    nextDatabase.game_payload = payload;
    nextDatabase.updated_at_unix_ms = Date.now();
    await writeDatabase(identity.documentId, nextDatabase);
    return nextDatabase;
  });

  console.log(
    `[database] saved player_key=${identity.playerKey} ip=${identity.address} source=${String(payload.source || "")} game_id=${gameId || ""} turn=${String(payload.game.turn || "")} winner=${winner || ""}`,
  );
  res.json({ ok: true, database: withConnectionMetadata(database, identity) });
}

async function initializeDatabaseStorage() {
  await databaseStore.loadDatabaseAsync();
  databaseStore.setAutocompactionInterval(10 * 60 * 1000);

  const currentDocument = await databaseStore.findOneAsync({ _id: DATABASE_DOCUMENT_ID });
  if (currentDocument) {
    return;
  }

  await writeDatabase(DATABASE_DOCUMENT_ID, createDefaultDatabase());
}

async function readDatabase(documentId = DATABASE_DOCUMENT_ID) {
  const document = await databaseStore.findOneAsync({ _id: documentId });
  if (!document) {
    return createDefaultDatabase();
  }

  return normalizeDatabase(document);
}

async function writeDatabase(documentId, database) {
  const normalized = normalizeDatabase(database);
  await databaseStore.updateAsync(
    { _id: documentId },
    { _id: documentId, ...normalized },
    { upsert: true },
  );
  return normalized;
}

async function waitForDatabaseMutations() {
  await databaseMutationQueue.catch(() => {});
}

function runDatabaseMutation(operation) {
  const run = databaseMutationQueue.then(operation, operation);
  databaseMutationQueue = run.catch(() => {});
  return run;
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

function configureTrustProxy() {
  if (process.env.TRUST_PROXY === undefined) {
    return;
  }

  app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));
}

function parseTrustProxy(value) {
  const raw = String(value || "").trim();
  const normalized = raw.toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "") {
    return false;
  }

  const hopCount = Number(raw);
  if (Number.isInteger(hopCount) && hopCount >= 0) {
    return hopCount;
  }

  return raw;
}

function getRequestIdentity(req) {
  const address = normalizeIpAddress(
    req.ip ||
    (req.socket && req.socket.remoteAddress) ||
    (req.connection && req.connection.remoteAddress) ||
    "",
  );
  const playerKey = crypto.createHash("sha256").update(address).digest("hex").slice(0, 32);

  return {
    address,
    playerKey,
    documentId: `${IP_DATABASE_DOCUMENT_PREFIX}${playerKey}`,
  };
}

function normalizeIpAddress(value) {
  let address = String(value || "").trim();
  if (address.includes(",")) {
    address = address.split(",")[0].trim();
  }
  if (address.startsWith("::ffff:")) {
    address = address.slice("::ffff:".length);
  }
  if (address === "::1") {
    return "127.0.0.1";
  }
  return address || "unknown";
}

function withConnectionMetadata(database, identity) {
  return {
    ...normalizeDatabase(database),
    connection: {
      player_key: identity.playerKey,
      ip_address: identity.address,
    },
  };
}
