import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('无法获取可用端口')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForOk(url, { timeoutMs = 20_000, intervalMs = 200 } = {}) {
  const start = Date.now();
  while (true) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // ignore
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待服务就绪超时: ${url}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function stopProcess(child) {
  if (!child || child.killed) return;
  child.kill();
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 3000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

test('服务可启动并响应基础接口', async () => {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const entry = path.resolve('dist/index.js');

  const child = spawn(process.execPath, [entry, '--host', '127.0.0.1', '--port', String(port)], {
    env: {
      ...process.env,
      SERVER_ENV: 'dev',
      SERVER_HOST: '127.0.0.1',
      SERVER_PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  try {
    await waitForOk(`${baseUrl}/ping`);

    const pingResp = await fetch(`${baseUrl}/ping`);
    assert.equal(pingResp.status, 200);
    assert.equal(await pingResp.text(), 'pong');

    const infoResp = await fetch(`${baseUrl}/`);
    assert.equal(infoResp.status, 200);
    const info = await infoResp.json();
    assert.equal(info.service, 'jimeng-api');

    const modelsResp = await fetch(`${baseUrl}/v1/models`);
    assert.equal(modelsResp.status, 200);
    const models = await modelsResp.json();
    assert.equal(models.object, 'list');
    assert.ok(Array.isArray(models.data));
  } finally {
    await stopProcess(child);
  }
});
