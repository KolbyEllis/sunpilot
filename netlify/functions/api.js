const { Readable, Writable } = require("stream");
const { app } = require("../../server");

function requestUrl(event) {
  if (event.rawUrl) return new URL(event.rawUrl);
  const query = event.rawQuery ? `?${event.rawQuery}` : "";
  return new URL(`${event.path || "/"}${query}`, "https://sunpilot.netlify.app");
}

function invoke(event) {
  const url = requestUrl(event);
  const req = new Readable({ read() {} });
  req.method = event.httpMethod || "GET";
  req.url = `${url.pathname}${url.search}`;
  req.headers = {};
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (value != null) req.headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }

  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (name, value) => {
    res.headers[name] = value;
  };
  res.getHeader = (name) => res.headers[name];
  res.removeHeader = (name) => {
    delete res.headers[name];
  };

  const payload = event.body
    ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8")
    : null;

  return new Promise((resolve, reject) => {
    res.on("finish", () => {
      const body = Buffer.concat(chunks);
      const type = String(res.getHeader("Content-Type") || "");
      const text = /json|text\/|javascript|svg|xml/.test(type);
      resolve({
        statusCode: res.statusCode || 200,
        headers: res.headers,
        body: text || !body.length ? body.toString("utf8") : body.toString("base64"),
        isBase64Encoded: !text && body.length > 0,
      });
    });
    res.on("error", reject);
    try {
      app.handle(req, res);
      if (payload) req.push(payload);
      req.push(null);
    } catch (error) {
      reject(error);
    }
  });
}

exports.handler = async (event) => {
  try {
    return await invoke(event);
  } catch (error) {
    console.error(error);
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "SunPilot could not answer that request." }) };
  }
};
