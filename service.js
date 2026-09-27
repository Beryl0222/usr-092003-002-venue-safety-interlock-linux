"use strict";

const http = require("node:http");
const { Store } = require("./lib/store");
const { createApp, SERVICE_ID, SERVICE_NAME, healthPayload } = require("./lib/api");
const seed = require("./lib/seed");

function createServer(store) {
  const s = store || new Store();
  const server = http.createServer(createApp(s));
  server.store = s;
  return server;
}

if (require.main === module) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== SERVICE_ID) throw new Error("服务身份不一致");
    const store = new Store();
    seed(store);
    const replayed = store.replay(store.clock());
    if (!replayed.spaces["main-arena"] || !replayed.permits["permit-2026"]) {
      throw new Error("状态回放不一致");
    }
    process.stdout.write("基础检查通过\n");
  } else {
    const store = new Store();
    if (process.argv.includes("--seed")) seed(store);
    const port = Number(process.env.PORT || 8000);
    createServer(store).listen(port, "127.0.0.1", () => {
      process.stdout.write(`${SERVICE_NAME} 已启动: http://127.0.0.1:${port}/health\n`);
    });
  }
}

module.exports = { SERVICE_ID, SERVICE_NAME, createServer, healthPayload, Store };
