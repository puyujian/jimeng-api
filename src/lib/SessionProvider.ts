import path from 'path';
import { spawn } from 'child_process';

import fs from 'fs-extra';

import logger from './logger.ts';

interface PlaywrightStorageStateCookie {
  name?: string;
  value?: string;
}

interface PlaywrightStorageState {
  cookies?: PlaywrightStorageStateCookie[];
}

export class SessionProvider {
  /**
   * 自动注册并获取新的 SessionID（Dreamina 国际站）。
   *
   * 说明：
   * - 该能力依赖 `playwright_getSession` 目录下的脚本与依赖（Playwright + 浏览器驱动）
   * - 默认关闭，避免在公网环境被滥用；如需启用请设置 `ENABLE_SESSION_GENERATION=1`
   */
  static async generateNewSession(): Promise<string> {
    if (process.env.ENABLE_SESSION_GENERATION !== '1') {
      throw new Error(
        'Session 自动生成未启用：请设置环境变量 ENABLE_SESSION_GENERATION=1，并在 playwright_getSession 目录安装依赖后再试'
      );
    }

    const toolDir = path.resolve('playwright_getSession');
    const scriptPath = path.join(toolDir, 'dreamina_registration.js');
    const nodeModulesDir = path.join(toolDir, 'node_modules');
    const storageStatePath = path.join(toolDir, 'playwrightTest', 'auth.json');

    if (!fs.existsSync(scriptPath)) {
      throw new Error('未找到 playwright_getSession/dreamina_registration.js，请确认仓库已正确合并');
    }

    if (!fs.existsSync(nodeModulesDir)) {
      throw new Error(
        'playwright_getSession 依赖未安装：请在 playwright_getSession 目录执行 npm install，并按需执行 npx playwright install chromium'
      );
    }

    try {
      await fs.remove(storageStatePath);
    } catch {
      // 忽略旧文件清理失败
    }

    const timeoutMs = Number(process.env.SESSION_GENERATION_TIMEOUT_MS || 10 * 60 * 1000);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath], {
        cwd: toolDir,
        env: {
          ...process.env,
          PLAYWRIGHT_HEADLESS: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      let stdout = '';

      const timeout = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        reject(new Error(`Session 生成超时（>${timeoutMs}ms），请稍后重试`));
      }, timeoutMs);

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) return resolve();

        logger.error('[SessionProvider] session 生成脚本执行失败');
        // 注意：stdout/stderr 可能包含邮箱等敏感信息，这里不做透传打印，避免泄露。

        reject(new Error(`Session 生成脚本退出码=${code}，请检查 playwright_getSession 运行环境与日志`));
      });
    });

    if (!fs.existsSync(storageStatePath)) {
      throw new Error('Session 生成完成但未找到 auth.json，请检查 playwright_getSession 脚本输出日志');
    }

    const storageState = (await fs.readJson(storageStatePath)) as PlaywrightStorageState;
    const cookies = Array.isArray(storageState.cookies) ? storageState.cookies : [];
    const sessionCookie = cookies.find((cookie) => cookie?.name === 'sessionid');
    const sessionId = sessionCookie?.value;

    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('未在 auth.json 中找到 sessionid Cookie，请检查是否登录成功');
    }

    return sessionId;
  }
}
