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
import { maskProxyUrl, parseProxyConfig } from "@/haochi/utils/proxy.ts";

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

  async #launchBrowser(proxyUrl?: string | null) {
    const puppeteer = await this.#loadPuppeteer();
    const executablePath = this.#getExecutablePath();
    if (!executablePath) {
      throw new Error(
        "未找到可用浏览器，请设置 PUPPETEER_EXECUTABLE_PATH 或在系统中安装 Chrome/Chromium"
      );
    }

    const proxyConfig = parseProxyConfig(proxyUrl);
    const args = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--lang=en-US,en",
    ];
    if (proxyConfig?.server) {
      args.push(`--proxy-server=${proxyConfig.server}`);
    }

    const browser = await puppeteer.launch({
      executablePath,
      headless: this.headless,
      protocolTimeout: Number(process.env.HAOCHI_LOGIN_PROTOCOL_TIMEOUT_MS || 240000),
      defaultViewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
      args,
    });
    return {
      browser,
      proxyAuth:
        proxyConfig?.username || proxyConfig?.password
          ? {
              username: proxyConfig.username || "",
              password: proxyConfig.password || "",
            }
          : null,
      maskedProxy: proxyConfig ? maskProxyUrl(proxyConfig.normalized) : null,
    };
  }

  async close() {
    // no-op: 登录浏览器按次启动并在单次登录后立即回收
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

  async #applyProxyAuth(page: any, proxyAuth: { username: string; password: string } | null) {
    if (!page || !proxyAuth) return;
    await page.authenticate(proxyAuth);
  }

  async #waitForPopup(
    browser: any,
    proxyAuth: { username: string; password: string } | null,
    timeoutMs = 4000
  ) {
    return new Promise<any>((resolve) => {
      const timer = setTimeout(() => {
        browser.off("targetcreated", onTargetCreated);
        resolve(null);
      }, timeoutMs);

      const onTargetCreated = async (target: any) => {
        if (target.type() !== "page") return;
        clearTimeout(timer);
        browser.off("targetcreated", onTargetCreated);
        try {
          const page = await target.page();
          await this.#applyProxyAuth(page, proxyAuth);
          resolve(page);
        } catch {
          resolve(null);
        }
      };

      browser.on("targetcreated", onTargetCreated);
    });
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

  #normalizeRegionPrefix(value: string | null | undefined) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "us" || normalized === "us-") return "us-";
    if (normalized === "hk" || normalized === "hk-") return "hk-";
    if (normalized === "jp" || normalized === "jp-") return "jp-";
    if (normalized === "sg" || normalized === "sg-") return "sg-";
    return "";
  }

  #prefixSessionToken(token: string | null | undefined, regionPrefix: string) {
    const raw = String(token || "").trim();
    if (!raw) return null;
    if (!regionPrefix) return raw;
    if (/^(us|hk|jp|sg)-/i.test(raw)) return raw;
    return `${regionPrefix}${raw}`;
  }

  async #detectRegionPrefix(page: any) {
    const envPrefix = this.#normalizeRegionPrefix(process.env.HAOCHI_LOGIN_REGION_PREFIX);
    if (envPrefix) return envPrefix;

    for (const frame of page.frames()) {
      try {
        const regionCode = await frame.evaluate(() => {
          const normalize = (value: unknown) => {
            const text = String(value || "").trim().toUpperCase();
            return ["US", "HK", "JP", "SG"].includes(text) ? text : "";
          };

          const configText = document.getElementById("tiktok-cookie-banner-config")?.textContent || "";
          const configMatch = configText.match(/"region":"(US|HK|JP|SG)"/i);
          if (configMatch?.[1]) return normalize(configMatch[1]);

          const regionLink = Array.from(document.querySelectorAll("a[href*='store_region=']"))
            .map((node) => (node as HTMLAnchorElement).href || "")
            .find(Boolean);
          const linkMatch = regionLink?.match(/[?&]store_region=(us|hk|jp|sg)/i);
          if (linkMatch?.[1]) return normalize(linkMatch[1]);

          const bodyHtml = document.body?.innerHTML || "";
          const htmlMatch =
            bodyHtml.match(/"region":"(US|HK|JP|SG)"/i) ||
            bodyHtml.match(/[?&]store_region=(us|hk|jp|sg)/i);
          if (htmlMatch?.[1]) return normalize(htmlMatch[1]);

          return "";
        });

        const prefix = this.#normalizeRegionPrefix(regionCode);
        if (prefix) return prefix;
      } catch {
        // ignore
      }
    }

    return "";
  }

  async #acceptPrivacyConsent(page: any) {
    for (const frame of page.frames()) {
      try {
        const hasCheckbox = await frame.evaluate(() => {
          const input = document.querySelector(".privacyCheck input") as HTMLInputElement | null;
          if (input) return !input.checked;
          return !!document.querySelector(".privacyCheck");
        });
        if (!hasCheckbox) continue;

        try {
          await frame.click(".privacyCheck", { delay: 30 });
        } catch {
          await frame.evaluate(() => {
            const target =
              document.querySelector(".privacyCheck") ||
              document.querySelector(".privacyCheck input");
            if (target instanceof HTMLElement) target.click();
          });
        }
        await this.#delay(400);
        return true;
      } catch {
        // ignore
      }
    }
    return false;
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

  async #hasVisibleSelector(frame: any, selector: string) {
    return frame.evaluate((candidate: string) => {
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
            const found = await this.#hasVisibleSelector(frame, selector);

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

  async #isEmailLoginFormPresent(page: any) {
    for (const frame of page.frames()) {
      for (const selector of [
        '.lv_new_sign_in_panel_wide-form-email input',
        '.lv_new_sign_in_panel_wide-form-password input',
        'input[type="email"]',
        'input[name="email"]',
        'input[name="username"]',
        'input[autocomplete="email"]',
        'input[autocomplete="username"]',
        'input[autocomplete="on"]',
        'input[placeholder*="Enter email"]',
        'input[placeholder*="mail"]',
      ]) {
        try {
          if (await this.#hasVisibleSelector(frame, selector)) return true;
        } catch {
          // ignore
        }
      }
    }
    return false;
  }

  async #waitForEmailLoginForm(page: any, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.#isEmailLoginFormPresent(page)) return true;
      await this.#delay(300);
    }
    return false;
  }

  async #clickContinueWithEmail(page: any, timeoutMs = 12000) {
    if (await this.#isEmailLoginFormPresent(page)) return true;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const frame of page.frames()) {
        try {
          const clicked = await frame.evaluate(() => {
            const nodes = Array.from(
              document.querySelectorAll(
                ".lv_new_third_part_sign_in_expand-button, .lv_new_third_part_sign_in_expand-wrapper .lv_new_third_part_sign_in_expand-button"
              )
            );
            const target = nodes.find((node) => {
              const text = (node.textContent || "").trim().toLowerCase();
              if (!text || !text.includes("email")) return false;
              const element = node as HTMLElement;
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
            }) as HTMLElement | undefined;
            target?.click();
            return !!target;
          });

          if (clicked) {
            await this.#delay(500);
            if (await this.#waitForEmailLoginForm(page, 4000)) return true;
          }
        } catch {
          // ignore
        }
      }

      const clickedByText = await this.#clickByTextDeep(
        page,
        ["Continue with email", "Continue With Email", "Email", "邮箱", "使用邮箱"],
        1500
      );
      if (clickedByText) {
        if (await this.#waitForEmailLoginForm(page, 4000)) return true;
      }

      await this.#delay(300);
    }

    return this.#isEmailLoginFormPresent(page);
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

  async #clickVisibleSelectorsDeep(page: any, selectors: string[], timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const frame of page.frames()) {
        for (const selector of selectors) {
          try {
            if (!(await this.#hasVisibleSelector(frame, selector))) continue;
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
            await this.#delay(250);
            return true;
          } catch {
            // ignore
          }
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
        'input[name="username"]',
        'input[autocomplete="email"]',
        'input[autocomplete="username"]',
        'input[placeholder*="mail"]',
        'input[type="password"]',
        '.lv_new_sign_in_panel_wide-form-email input',
        '.lv_new_sign_in_panel_wide-form-password input',
        '.lv_new_third_part_sign_in_expand-button',
        '.lv_new_sign_in_panel_wide-detail',
        '.lv_new_sign_in_panel_wide_new_base_page',
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

  async #openLoginUi(
    browser: any,
    page: any,
    proxyAuth: { username: string; password: string } | null
  ) {
    if (await this.#waitForLoginUi(page, 1000)) return page;

    await this.#acceptPrivacyConsent(page);

    let popup = null;
    const selectorPopup = this.#waitForPopup(browser, proxyAuth, 4000);
    await this.#clickVisibleSelectorsDeep(
      page,
      [".login-button-MoeK5r", ".sign-up-btn", "#SiderMenuLogin"],
      5000
    );
    popup = await selectorPopup;
    if (popup) {
      try {
        await popup.bringToFront();
      } catch {
        // ignore
      }
      page = popup;
    }

    await this.#waitForLoginUi(page, 5000);
    if (!(await this.#isLoginUiPresent(page))) {
      const textPopup = this.#waitForPopup(browser, proxyAuth, 4000);
      await this.#clickByTextDeep(page, ["Sign in", "Log in", "登录"], 6000);
      popup = await textPopup;
      if (popup) {
        try {
          await popup.bringToFront();
        } catch {
          // ignore
        }
        page = popup;
      }
      await this.#waitForLoginUi(page, 10000);
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
    const { browser, proxyAuth, maskedProxy } = await this.#launchBrowser(account.proxy);
    const context = await browser.createBrowserContext();
    let page = await context.newPage();

    try {
      await this.#applyProxyAuth(page, proxyAuth);
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
      );
      if (maskedProxy) {
        push(`启用登录代理 ${maskedProxy}`);
      }

      push(`访问 Dreamina 登录页 (${maskedEmail})`);
      await page.goto("https://dreamina.capcut.com/ai-tool/login", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      push("打开登录界面");
      page = await this.#openLoginUi(browser, page, proxyAuth);
      if (!(await this.#isLoginUiPresent(page))) {
        await this.#captureDebugArtifacts(page, "login_ui_not_found");
        throw new Error("未成功打开 Dreamina 登录界面");
      }

      push("切换到邮箱登录");
      const switchedToEmail = await this.#clickContinueWithEmail(page, 12000);
      if (!switchedToEmail) {
        await this.#captureDebugArtifacts(page, "email_login_ui_not_found");
        throw new Error("未成功切换到邮箱登录");
      }

      push("填写邮箱");
      const emailFilled = await this.#fillInputDeep(
        page,
        [
          'input[type="email"]',
          'input[name="email"]',
          'input[name="username"]',
          'input[autocomplete="email"]',
          'input[autocomplete="username"]',
          'input[autocomplete="on"]',
          'input[placeholder*="mail"]',
          'input[placeholder*="邮箱"]',
          '.lv_new_sign_in_panel_wide-form-email input',
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
        ['input[type="password"]', 'input[name="password"]', '.lv_new_sign_in_panel_wide-form-password input'],
        password,
        5000
      );
      if (!passwordFilled) {
        await this.#clickByTextDeep(page, ["Continue", "Next", "继续", "下一步"], 5000);
        passwordFilled = await this.#fillInputDeep(
          page,
          ['input[type="password"]', 'input[name="password"]', '.lv_new_sign_in_panel_wide-form-password input'],
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

      const regionPrefix = await this.#detectRegionPrefix(page);
      if (regionPrefix) {
        push(`识别 Dreamina 区域前缀: ${regionPrefix}`);
      } else {
        logger.warn(`[号池登录] ${account.email}: 未识别到 Dreamina 区域前缀，将保留原始 sessionid`);
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
          sessionid: this.#prefixSessionToken(cookies.sessionid, regionPrefix),
          sessionid_ss: this.#prefixSessionToken(cookies.sessionid_ss, regionPrefix),
          sid_tt: this.#prefixSessionToken(cookies.sid_tt, regionPrefix),
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
      try {
        await browser.close();
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
