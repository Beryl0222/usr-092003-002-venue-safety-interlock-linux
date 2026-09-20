"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer, healthPayload } = require("./service");

async function withServer(run) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await run("http://127.0.0.1:" + address.port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("健康检查返回稳定身份", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), healthPayload());
  });
});

test("未知路由返回不存在", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/unknown");
    assert.equal(response.status, 404);
  });
});

