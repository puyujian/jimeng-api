import path from "path";

import fs from "fs-extra";

import logger from "@/lib/logger.ts";
import type {
  AccountSessionTokens,
  LoginProvider,
  LoginProgressEntry,
  LoginResult,
  PoolAccount,
} from "@/haochi/types.ts";
import { maskSecret, nowIso, randomToken } from "@/haochi/utils/crypto.ts";

function emptySessionTokens(): AccountSessionTokens {
  return {
    sessionid: null,
    sessionid_ss: null,
    sid_tt: null,
    msToken: null,
    passport_csrf_token: null,
    passport_csrf_token_default: null,
    s_v_web_id: null,
    _tea_web_id: null,
  };
}

function ensurePassword(account: PoolAccount) {
  if (!account.password || typeof account.password !== "string") {
    throw new Error(`账号 ${account.email} 缺少可用密码，无法自动登录`);
  }
  return account.password;
}

class MockLoginProvider implements LoginProvider {
  readonly name = "mock";

  async login(account: PoolAccount, onProgress?: (message: string) => void): Promise<LoginResult> {
    const logs: LoginProgressEntry[] = [];
    const push = (message: string) => {
      logs.push({ time: nowIso(), message });
      onProgress?.(message);
    };

    push(`Mock 登录 ${account.email}`);
    const seed = randomToken(8);
    const sessionid = `mock-session-${seed}`;
    push("生成模拟 SessionID");

    return {
      success: true,
      email: account.email,
      userInfo: {
        email: account.email,
        nickName: account.email.split("@")[0],
        userId: `mock-user-${seed}`,
      },
      sessionTokens: {
        ...emptySessionTokens(),
        sessionid,
        sessionid_ss: sessionid,
        sid_tt: sessionid,
        msToken: `mock-ms-${seed}`,
      },
      allCookies: {
        sessionid,
        sessionid_ss: sessionid,
        sid_tt: sessionid,
      },
      logs,
      timestamp: nowIso(),
    };
  }
}

class DreaminaLoginProvider implements LoginProvider {
  readonly name = "dreamina";
  #browser: any = null;
  #puppeteer: any = null;
  readonly headless = process.env.HAOCHI_LOGIN_HEADLESS !== "0";
  readonly debugDir = path.resolve(
    process.env.HAOCHI_LOGIN_DEBUG_DIR || "data/haochi/debug"
  );

  async #loadPuppeteer() {
    if (this.#puppeteer) return this.#puppeteer;
    const mod = await import("puppeteer-core");
    this.#puppeteer = mod.default || mod;
    return this.#puppeteer;
  }

  #getExecutablePath() {
    const fromEnv = String(process.env.PUPPETEER_EXECUTABLE_PATH || "").trim();
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

    const candidates = [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/usr/bin/google-chrome",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];

    return candidates.find((item) => fs.existsSync(item)) || null;
  }

  async #getBrowser() {
    if (this.#browser && this.#browser.isConnected()) return this.#browser;
    const puppeteer = await this.#loadPuppeteer();
    const executablePath = this.#getExecutablePath();
    if (!executablePath) {
      throw new Error(
        "未找到可用浏览器，请设置 PUPPETEER_EXECUTABLE_PATH 或在系统中安装 Chrome/Chromium"
      );
    }

    this.#browser = await puppeteer.launch({
      executablePath,
      headless: this.headless,
      defaultViewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--lang=en-US,en",
      ],
    });
    return this.#browser;
  }

  async close() {
    if (!this.#browser) return;
    try {
      await this.#browser.close();
    } catch {
      // ignore
    } finally {
      this.#browser = null;
    }
  }

  async #captureDebugArtifacts(page: any, tag: string) {
    try {
      fs.ensureDirSync(this.debugDir);
      const safeTag = String(tag || "debug").replace(/[^a-zA-Z0-9_.-]/g, "_");
      const baseName = `${safeTag}_${Date.now()}`;
      await page.screenshot({
        path: path.join(this.debugDir, `${baseName}.png`),
        fullPage: true,
      });
      fs.writeFileSync(
        path.join(this.debugDir, `${baseName}.html`),
        await page.content(),
        "utf8"
      );
    } catch (error: any) {
      logger.warn(`保存登录调试信息失败: ${error?.message || error}`);
    }
  }

  async #delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async #extractCookies(page: any) {
    try {
      const list = await page.cookies(
        "https://dreamina.capcut.com/",
        "https://dreamina.capcut.com/ai-tool/home",
        "https://dreamina.capcut.com/ai-tool/login",
        "https://capcut.com/",
        "https://www.capcut.com/"
      );
      const cookies = Object.fromEntries(
        (list || [])
          .filter((item: any) => item?.name)
          .map((item: any) => [item.name, item.value])
      );
      if (Object.keys(cookies).length > 0) return cookies;
    } catch (error: any) {
      logger.warn(`通过 page.cookies 获取 Dreamina Cookie 失败: ${error?.message || error}`);
    }

    const cookieString = await page.evaluate(() => document.cookie || "");
    return String(cookieString)
      .split("; ")
      .filter(Boolean)
      .reduce<Record<string, string>>((acc, item) => {
        const [key, ...rest] = item.split("=");
        if (key) acc[key] = rest.join("=");
        return acc;
      }, {});
  }

  async #setInputValue(frame: any, selector: string, value: string) {
    await frame.evaluate(
      (sel: string, nextValue: string) => {
        const element = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!element) throw new Error(`Element not found: ${sel}`);
        element.focus();
        const proto =
          element.tagName.toLowerCase() === "textarea"
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        const setter = desc?.set;
        if (setter) setter.call(element, nextValue);
        else element.value = nextValue;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      },
      selector,
      value
    );
  }

  async #clickByTextDeep(page: any, texts: string[], timeoutMs = 10000) {
    const start = Date.now();
    const candidates = texts.map((item) => String(item || "").trim()).filter(Boolean);
    const upperAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lowerAlphabet = "abcdefghijklmnopqrstuvwxyz";
    while (Date.now() - start < timeoutMs) {
      for (const frame of page.frames()) {
        for (const text of candidates) {
          const lower = text.toLowerCase();
          const xpath = `//*[self::button or self::a or self::span or (self::div and (@role="button" or contains(@class,"button") or contains(@class,"btn")))]` +
            `[contains(translate(normalize-space(string(.)), "${upperAlphabet}", "${lowerAlphabet}"), ${JSON.stringify(lower)})]`;
          try {
            const handles = await frame.$x(xpath);
            for (const handle of handles) {
              await handle.click({ delay: 30 });
              await this.#delay(250);
              return true;
            }
          } catch {
            // ignore frame errors
          }
        }
      }
      await this.#delay(300);
    }
    return false;
  }

  async #fillInputDeep(page: any, selectors: string[], value: string, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const frame of page.frames()) {
        for (const selector of selectors) {
          try {
            const found = await frame.evaluate((candidate: string) => {
              const element = document.querySelector(candidate) as HTMLElement | null;
              if (!element) return false;
              const style = window.getComputedStyle(element);
              if (
                style.display === "none" ||
                style.visibility === "hidden" ||
                style.opacity === "0"
              ) {
                return false;
              }
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }, selector);

            if (found) {
              await this.#setInputValue(frame, selector, value);
              return true;
            }
          } catch {
            // ignore
          }
        }
      }
      await this.#delay(300);
    }
    return false;
  }

  async #clickSelectorDeep(page: any, selector: string, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const frame of page.frames()) {
        try {
          const handle = await frame.$(selector);
          if (!handle) continue;
          try {
            await handle.click({ delay: 30 });
          } catch {
            await frame.evaluate((sel: string) => {
              const element = document.querySelector(sel) as HTMLElement | null;
              element?.click();
            }, selector);
          }
          return true;
        } catch {
          // ignore
        }
      }
      await this.#delay(300);
    }
    return false;
  }

  async #hasCaptcha(page: any) {
    for (const frame of page.frames()) {
      for (const selector of [
        'iframe[src*="captcha"]',
        '[class*="captcha"]',
        '[id*="captcha"]',
      ]) {
        try {
          const handle = await frame.$(selector);
          if (handle) return true;
        } catch {
          // ignore
        }
      }
    }
    return false;
  }

  async #isLoginUiPresent(page: any) {
    for (const frame of page.frames()) {
      for (const selector of [
        'input[type="email"]',
        'input[name="email"]',
        'input[type="password"]',
        '.lv_new_sign_in_panel_wide-form-email input',
        '.lv_new_sign_in_panel_wide-form-password input',
      ]) {
        try {
          const handle = await frame.$(selector);
          if (handle) return true;
        } catch {
          // ignore
        }
      }
    }
    return false;
  }

  async #waitForLoginUi(page: any, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.#isLoginUiPresent(page)) return true;
      await this.#delay(300);
    }
    return false;
  }

  async #openLoginUi(browser: any, page: any) {
    if (await this.#waitForLoginUi(page, 1000)) return page;

    await this.#clickSelectorDeep(page, "#SiderMenuLogin", 4000);
    await this.#waitForLoginUi(page, 5000);
    if (!(await this.#isLoginUiPresent(page))) {
      await this.#clickByTextDeep(page, ["Sign in", "Log in", "登录"], 6000);
      await this.#waitForLoginUi(page, 10000);
    }

    const popup = await new Promise<any>((resolve) => {
      const timer = setTimeout(() => {
        browser.off("targetcreated", onTargetCreated);
        resolve(null);
      }, 3000);

      const onTargetCreated = async (target: any) => {
        if (target.type() !== "page") return;
        clearTimeout(timer);
        browser.off("targetcreated", onTargetCreated);
        try {
          resolve(await target.page());
        } catch {
          resolve(null);
        }
      };

      browser.on("targetcreated", onTargetCreated);
    });

    if (popup) {
      try {
        await popup.bringToFront();
      } catch {
        // ignore
      }
      page = popup;
    }

    return page;
  }

  async login(account: PoolAccount, onProgress?: (message: string) => void): Promise<LoginResult> {
    const logs: LoginProgressEntry[] = [];
    const push = (message: string) => {
      logs.push({ time: nowIso(), message });
      logger.info(`[号池登录] ${account.email}: ${message}`);
      onProgress?.(message);
    };

    const password = ensurePassword(account);
    const maskedEmail = maskSecret(account.email, 4, 8);
    const browser = await this.#getBrowser();
    const context = await browser.createBrowserContext();
    let page = await context.newPage();

    try {
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
      );

      push(`访问 Dreamina 登录页 (${maskedEmail})`);
      await page.goto("https://dreamina.capcut.com/ai-tool/login", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      push("打开登录界面");
      page = await this.#openLoginUi(browser, page);
      if (!(await this.#isLoginUiPresent(page))) {
        await this.#captureDebugArtifacts(page, "login_ui_not_found");
        throw new Error("未成功打开 Dreamina 登录表单");
      }

      push("切换到邮箱登录");
      await this.#clickByTextDeep(
        page,
        ["Continue with email", "Continue With Email", "Email", "邮箱", "使用邮箱"],
        10000
      );

      push("填写邮箱");
      const emailFilled = await this.#fillInputDeep(
        page,
        [
          'input[type="email"]',
          'input[name="email"]',
          'input[name="username"]',
          'input[autocomplete="email"]',
          'input[autocomplete="username"]',
          'input[placeholder*="mail"]',
          'input[placeholder*="邮箱"]',
        ],
        account.email
      );
      if (!emailFilled) {
        await this.#captureDebugArtifacts(page, "email_not_found");
        throw new Error("无法找到邮箱输入框");
      }

      push("填写密码");
      let passwordFilled = await this.#fillInputDeep(
        page,
        ['input[type="password"]', 'input[name="password"]'],
        password,
        5000
      );
      if (!passwordFilled) {
        await this.#clickByTextDeep(page, ["Continue", "Next", "继续", "下一步"], 5000);
        passwordFilled = await this.#fillInputDeep(
          page,
          ['input[type="password"]', 'input[name="password"]'],
          password,
          10000
        );
      }
      if (!passwordFilled) {
        await this.#captureDebugArtifacts(page, "password_not_found");
        throw new Error("无法找到密码输入框");
      }

      push("提交登录");
      let submitted = await this.#clickSelectorDeep(
        page,
        'button[type="submit"], button.lv_new_sign_in_panel_wide-sign-in-button',
        6000
      );
      if (!submitted) {
        submitted = await this.#clickByTextDeep(page, ["Log in", "Sign in", "登录"], 6000);
      }
      if (!submitted) {
        try {
          await page.keyboard.press("Enter");
          submitted = true;
        } catch {
          // ignore
        }
      }
      if (!submitted) {
        await this.#captureDebugArtifacts(page, "submit_not_clicked");
        throw new Error("无法提交登录表单");
      }

      push("等待 SessionID 落地");
      const startedAt = Date.now();
      let captchaLogged = false;
      let cookies = await this.#extractCookies(page);
      while (
        Date.now() - startedAt < 180000 &&
        !cookies.sessionid &&
        !cookies.sessionid_ss &&
        !cookies.sid_tt
      ) {
        if (!captchaLogged && (await this.#hasCaptcha(page))) {
          captchaLogged = true;
          push("检测到验证码或安全校验，请关闭 headless 并人工协助首登");
        }
        await this.#delay(800);
        cookies = await this.#extractCookies(page);
      }

      if (!cookies.sessionid && !cookies.sessionid_ss && !cookies.sid_tt) {
        await this.#captureDebugArtifacts(page, "sessionid_not_found");
        throw new Error("登录未获取到 sessionid，可能触发验证码、二次确认或账号密码错误");
      }

      push("读取用户信息");
      const userInfo = await page.evaluate(() => {
        const anyWindow = window as any;
        const info = anyWindow.__userInfo;
        if (info?.user_info) {
          return {
            userId: info.user_info.user_id || null,
            nickName: info.user_info.nick_name || null,
            email: info.user_info.email || null,
          };
        }

        const lvwebStatus = localStorage.getItem("__lvweb_user_status");
        if (lvwebStatus) {
          try {
            const parsed = JSON.parse(lvwebStatus);
            return {
              userId: parsed.user_id || parsed.userId || null,
              nickName: parsed.nick_name || parsed.nickName || null,
              email: parsed.email || null,
            };
          } catch {
            return null;
          }
        }
        return null;
      });

      return {
        success: true,
        email: account.email,
        userInfo,
        sessionTokens: {
          ...emptySessionTokens(),
          sessionid: cookies.sessionid || null,
          sessionid_ss: cookies.sessionid_ss || null,
          sid_tt: cookies.sid_tt || null,
          msToken: cookies.msToken || null,
          passport_csrf_token: cookies.passport_csrf_token || null,
          passport_csrf_token_default: cookies.passport_csrf_token_default || null,
          s_v_web_id: cookies.s_v_web_id || null,
          _tea_web_id: cookies._tea_web_id || null,
        },
        allCookies: cookies,
        logs,
        timestamp: nowIso(),
      };
    } catch (error: any) {
      logger.error(`[号池登录] ${account.email} 登录失败: ${error?.message || error}`);
      return {
        success: false,
        email: account.email,
        error: error?.message || String(error),
        logs,
        timestamp: nowIso(),
      };
    } finally {
      try {
        await page.close();
      } catch {
        // ignore
      }
      try {
        await context.close();
      } catch {
        // ignore
      }
    }
  }
}

export function createLoginProvider(): LoginProvider {
  const mode = String(process.env.HAOCHI_LOGIN_PROVIDER || "dreamina").trim().toLowerCase();
  if (mode === "mock") return new MockLoginProvider();
  return new DreaminaLoginProvider();
}
