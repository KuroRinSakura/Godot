const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const express = require("express");

const app = express();
const HOST = process.env.HOST || "0.0.0.0";
const PROTOCOL = (process.env.PROTOCOL || process.env.SERVER_PROTOCOL || "http").toLowerCase();
const PORT = Number(process.env.PORT || (PROTOCOL === "https" ? 3443 : 3000));
const HTTP_PORT = Number(process.env.HTTP_PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const WEB_ROOT = path.resolve(__dirname, process.env.WEB_DIR || ".");
const HTTPS_KEY = process.env.HTTPS_KEY || process.env.SSL_KEY;
const HTTPS_CERT = process.env.HTTPS_CERT || process.env.SSL_CERT;
const ALLOWED_PROTOCOLS = new Set(["http", "https", "both"]);

const MIME_TYPES = {
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

app.disable("x-powered-by");

if (!ALLOWED_PROTOCOLS.has(PROTOCOL)) {
  throw new Error("PROTOCOL must be http, https, or both.");
}

app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
});

app.use((req, res, next) => {
  let requestPath;

  try {
    requestPath = decodeURIComponent(req.path).replace(/\\/g, "/");
  } catch {
    res.status(400).type("text/plain; charset=utf-8").send("Bad Request");
    return;
  }

  const blocked = [
    "/server.js",
    "/package.json",
    "/package-lock.json",
    "/node_modules/",
    "/certs/",
    "/.env",
  ];

  if (blocked.some((entry) => requestPath === entry || requestPath.startsWith(entry))) {
    res.status(404).type("text/plain; charset=utf-8").send("Not Found");
    return;
  }

  next();
});

app.use(express.static(WEB_ROOT, {
  index: "index.html",
  dotfiles: "ignore",
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext];

    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }

    if (ext === ".html") {
      res.setHeader("Cache-Control", "no-store");
    } else {
      res.setHeader("Cache-Control", "public, max-age=3600");
    }
  },
}));

app.use((req, res) => {
  res.status(404).type("text/plain; charset=utf-8").send("Not Found");
});

function resolveLocalPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(__dirname, filePath);
}

function getLocalUrl(protocol, port) {
  const displayHost = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  return `${protocol}://${displayHost}:${port}/`;
}

function startServer(server, protocol, port) {
  server.listen(port, HOST, () => {
    console.log(`Godot Web server is running at ${getLocalUrl(protocol, port)}`);
  });
}

function startHttps(port) {
  if (!HTTPS_KEY || !HTTPS_CERT) {
    throw new Error("HTTPS requires HTTPS_KEY and HTTPS_CERT.");
  }

  const httpsOptions = {
    key: fs.readFileSync(resolveLocalPath(HTTPS_KEY)),
    cert: fs.readFileSync(resolveLocalPath(HTTPS_CERT)),
  };

  startServer(https.createServer(httpsOptions, app), "https", port);
}

if (PROTOCOL === "http") {
  startServer(http.createServer(app), "http", PORT);
} else if (PROTOCOL === "https") {
  startHttps(PORT);
} else {
  startServer(http.createServer(app), "http", HTTP_PORT);
  startHttps(HTTPS_PORT);
}

console.log(`Serving files from ${WEB_ROOT}`);
