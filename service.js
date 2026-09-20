"use strict";

const http = require("node:http");

const SERVICE_ID = "venue-safety-interlock";
const SERVICE_NAME = "场馆档期安全联锁";

function healthPayload() {
  return { status: "ok", service: SERVICE_ID, name: SERVICE_NAME };
}

function createServer() {
  return http.createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = JSON.stringify(healthPayload());
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  });
}

if (require.main === module) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== SERVICE_ID) throw new Error("服务身份不一致");
    process.stdout.write("基础检查通过\n");
  } else {
    const port = Number(process.env.PORT || 8000);
    createServer().listen(port, "127.0.0.1");
  }
}

module.exports = { SERVICE_ID, SERVICE_NAME, createServer, healthPayload };

