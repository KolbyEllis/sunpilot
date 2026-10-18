const http = require("http");

const port = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<!DOCTYPE html><html><head><title>sunpilot</title></head><body><h1>sunpilot</h1></body></html>");
});

server.listen(port, () => {
  console.log(`sunpilot listening on http://localhost:${port}`);
});
