// Long-running server: good for testing `vajra-run serve` + `vajra-run --stop`.
const http = require("node:http");

const port = Number(process.env.PORT) || 3123;
const secretLoaded = Boolean(process.env.SECRET);

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, secretLoaded }));
});

server.listen(port, () => {
  console.log(`demo-app listening on http://localhost:${port} (secret ${secretLoaded ? "loaded" : "MISSING"})`);
});

setInterval(() => console.log("tick", new Date().toISOString()), 2000);
