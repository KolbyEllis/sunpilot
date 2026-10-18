const http = require("http");
const fs = require("fs");
const path = require("path");

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function compile(pattern) {
  if (pattern instanceof RegExp) return { regex: pattern, keys: [] };
  const keys = [];
  const source = String(pattern).split("/").map((part) => {
    if (part.startsWith(":")) {
      keys.push(part.slice(1));
      return "([^/]+)";
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/");
  return { regex: new RegExp(`^${source}$`), keys };
}

function decorate(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    if (res.writableEnded) return;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  };
  res.set = (name, value) => {
    res.setHeader(name, value);
    return res;
  };
  res.sendFile = (filePath) => {
    if (res.writableEnded) return;
    res.setHeader("Content-Type", types[path.extname(filePath)] || "application/octet-stream");
    fs.createReadStream(filePath).pipe(res);
  };
}

function json(limitBytes = 8 * 1024 * 1024) {
  return (req, res, next) => {
    const type = req.headers["content-type"] || "";
    if (req.method === "GET" || req.method === "HEAD" || !type.includes("application/json")) {
      req.body = {};
      next();
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        failed = true;
        res.status(413).json({ error: "That upload is too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed || res.writableEnded) return;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        req.body = text ? JSON.parse(text) : {};
        next();
      } catch {
        res.status(400).json({ error: "Invalid JSON" });
      }
    });
  };
}

function staticFiles(root) {
  const base = path.resolve(root);
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const pathname = req.path === "/" ? "/index.html" : req.path;
    const filePath = path.resolve(base, `.${pathname}`);
    if (filePath !== base && !filePath.startsWith(`${base}${path.sep}`)) return next();
    fs.stat(filePath, (error, stat) => {
      if (error || !stat.isFile()) return next();
      res.statusCode = 200;
      res.setHeader("Content-Type", types[path.extname(filePath)] || "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(filePath).pipe(res);
    });
  };
}

function createApp() {
  const layers = [];
  const app = {
    use(pathOrFn, maybeFn) {
      if (typeof pathOrFn === "function") layers.push({ kind: "use", prefix: "", fn: pathOrFn });
      else layers.push({ kind: "use", prefix: pathOrFn, fn: maybeFn });
    },
    listen(port, callback) {
      const server = http.createServer((req, res) => {
        decorate(res);
        const url = new URL(req.url, "http://127.0.0.1");
        req.path = decodeURIComponent(url.pathname);
        req.query = Object.fromEntries(url.searchParams);
        req.params = {};
        req.body = {};
        let index = 0;
        const next = () => {
          const layer = layers[index++];
          if (!layer) {
            res.status(404).json({ error: "Not found" });
            return;
          }
          if (layer.kind === "use" && layer.prefix && req.path !== layer.prefix && !req.path.startsWith(`${layer.prefix}/`)) {
            next();
            return;
          }
          if (layer.kind === "route") {
            if (layer.method !== req.method) {
              next();
              return;
            }
            const match = layer.regex.exec(req.path);
            if (!match) {
              next();
              return;
            }
            req.params = {};
            layer.keys.forEach((key, keyIndex) => {
              req.params[key] = decodeURIComponent(match[keyIndex + 1]);
            });
          }
          try {
            layer.fn(req, res, next);
          } catch (error) {
            if (!res.headersSent && !res.writableEnded) {
              res.status(error.status || 500).json({ error: error.message || "Something went wrong" });
            }
          }
        };
        next();
      });
      server.listen(port, callback);
      return server;
    },
  };
  for (const method of ["get", "post", "patch", "put", "delete"]) {
    app[method] = (pattern, fn) => {
      const compiled = compile(pattern);
      layers.push({ kind: "route", method: method.toUpperCase(), ...compiled, fn });
    };
  }
  return app;
}

module.exports = { createApp, json, staticFiles };
