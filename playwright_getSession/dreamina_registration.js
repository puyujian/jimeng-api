const axios = require('axios');
const { chromium } = require('playwright');

// Mail.tm API 辅助类
class MailTm {
  constructor() {
    this.baseUrl = 'https://api.mail.tm';
    this.token = null;
    this.email = null;
    this.password = null;
  }

  async createAccount() {
    // 获取可用域名
    const domainsRes = await axios.get(`${this.baseUrl}/domains`);
    const domains = domainsRes.data['hydra:member'];
    if (!domains || domains.length === 0) throw new Error('没有可用的域名');
    
    // 选择第一个域名
    const domain = domains[0].domain;
    
    // 生成随机凭证
    const randomStr = Math.random().toString(36).substring(7);
    this.email = `user_${randomStr}@${domain}`;
    this.password = `Pwd_${randomStr}!`;

    try {
      await axios.post(`${this.baseUrl}/accounts`, {
        address: this.email,
        password: this.password
      });
    } catch (e) {
      console.error('创建邮箱账户失败:', e.response?.data || e.message);
      throw e;
    }

    // 登录以获取 token
    const tokenRes = await axios.post(`${this.baseUrl}/token`, {
      address: this.email,
      password: this.password
    });
    this.token = tokenRes.data.token;
    
    console.log(`[MailTm] 已创建临时邮箱: ${this.email}`);
    return this.email;
  }

  async getLatestMessage() {
    if (!this.token) throw new Error('未认证');
    
    const res = await axios.get(`${this.baseUrl}/messages`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    
    const messages = res.data['hydra:member'];
    if (messages && messages.length > 0) {
      // 获取第一条消息详情
      const msgId = messages[0].id;
      const msgDetail = await axios.get(`${this.baseUrl}/messages/${msgId}`, {
        headers: { Authorization: `Bearer ${this.token}` }
      });
      return msgDetail.data;
    }
    return null;
  }

  async waitForVerificationCode(attempts = 20) {
    console.log(`[MailTm] 等待验证邮件...`);
    for (let i = 0; i < attempts; i++) {
      const msg = await this.getLatestMessage();
      if (msg) {
        // 简单的正则匹配 6 位验证码。根据实际邮件内容调整正则。
        // Dreamina 通常发送像 "Your verification code" 这样的主题
        const subject = msg.subject || '';
        const body = msg.text || msg.intro || '';
        
        console.log(`[MailTm] 收到邮件: ${subject}`);
        
        // 查找 6 位数字或字母数字代码
        // Dreamina 可能使用数字或字母
        const codeMatch = body.match(/\b[A-Z0-9]{6}\b/) || subject.match(/\b[A-Z0-9]{6}\b/);
        
        if (codeMatch) {
          console.log(`[MailTm] 找到验证码: ${codeMatch[0]}`);
          return codeMatch[0];
        }
      }
      // 下次轮询前等待 3 秒
      await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error('未在规定时间内收到验证码');
  }
}

(async () => {
  const mailer = new MailTm();
  let browser;

  try {
    // 1. 设置临时邮箱
    await mailer.createAccount();

    // 2. 启动浏览器
    const headless = process.env.PLAYWRIGHT_HEADLESS === '1';
    browser = await chromium.launch({
      headless: false, // 可见模式用于调试
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      ...(headless ? { headless: true } : {}),
    });
    
    const context = await browser.newContext();
    const page = await context.newPage();

    // 3. 导航至 Dreamina
    console.log('[Playwright] 正在导航至 Dreamina...');
    await page.goto('https://dreamina.capcut.com/ai-tool/home');

    // 4. 点击 登录 / 注册 流程
    // 重要：选择器可能会变。这些是基于通用结构/文本的。
    // 尝试先找到 "Sign in" 按钮
    const signInBtn = page.locator('text="Sign in"').first();
    await signInBtn.click();

    // 更新流程：必须先点击 "Continue with email"
    console.log('[Playwright] 点击 "Continue with email"...');
    const continueEmailBtn = page.locator('text="Continue with email"');
    await continueEmailBtn.waitFor({ state: 'visible' });
    await continueEmailBtn.click();
    
    // 在模态框/页面中点击 "Sign up"
    console.log('[Playwright] 切换到注册标签...');
    const signUpLink = page.locator('text="Sign up"');
    await signUpLink.waitFor({ state: 'visible' });
    await signUpLink.click();

    // 5. 填写注册表单
    console.log('[Playwright] 正在填写注册表单...');
    
    // 使用 Codegen 获取的更新选择器
    await page.getByRole('textbox', { name: 'Enter email' }).click();
    await page.getByRole('textbox', { name: 'Enter email' }).fill(mailer.email);
    
    const passwordInput = page.getByRole('textbox', { name: 'Enter password' });
    await passwordInput.click();
    await passwordInput.fill('Dreams123456!');
    
    // 点击继续
    await page.getByRole('button', { name: 'Continue' }).click();

    // 6. 等待验证码步骤
    console.log('[Playwright] 等待验证码输入步骤...');
    
    const code = await mailer.waitForVerificationCode();
    
    // 7. 输入验证码
    console.log('[Playwright] 处理验证码输入...');
    
    // 来自 Codegen: await page.getByRole('textbox').nth(2).fill('DXRTC9');
    // 似乎验证码输入框被识别为页面上的第3个文本框（索引2）
    // 我们将首先尝试这种特定的选择器策略，如果需要则回退到之前的方法。
    try {
        const codeInput = page.getByRole('textbox').nth(2);
        if (await codeInput.isVisible()) {
             console.log('[Playwright] 正在向第3个文本框输入验证码...');
             await codeInput.fill(code);
        } else {
             // 回退到点击数字显示包装器
             console.log('[Playwright] 第3个文本框不可见，尝试点击包装器...');
             await page.locator('.verification_code_input-number').first().click();
             await page.keyboard.type(code, { delay: 100 });
        }
    } catch (e) {
        console.error('[Playwright] 验证码填充失败，尝试全局输入...', e.message);
        await page.locator('.verification_code_input-number').first().click({ force: true });
        await page.keyboard.type(code, { delay: 100 });
    }

    // 8. 处理生日屏幕（如果出现）
    console.log('[Playwright] 检查生日屏幕...');
    try {
        // 稍作等待看生日屏幕是否出现
        const birthdayTitle = page.locator('text="When’s your birthday?"');
        await birthdayTitle.waitFor({ state: 'visible', timeout: 8000 });
        
        if (await birthdayTitle.isVisible()) {
            console.log('[Playwright] 检测到生日屏幕。正在填写详情...');
            
            // 使用 Codegen 选择器
            // 年份
            await page.getByRole('textbox', { name: 'Year' }).click();
            await page.getByRole('textbox', { name: 'Year' }).fill('1995');
            
            // 月份
            await page.getByText('Month').click();
            await page.getByRole('option', { name: 'January' }).click();
            
            // 日期
            await page.getByText('Day', { exact: true }).click();
            await page.getByRole('option', { name: '15', exact: true }).click(); // 选择 15 或 1
            
            // 点击下一步
            console.log('[Playwright] 填写生日后点击下一步...');
            await page.getByRole('button', { name: 'Next', exact: true }).click();
        }
    } catch (e) {
        console.log('[Playwright] 生日屏幕未出现或超时。');
    }

    // 9. 处理生日后流程（确认、角色选择）
    console.log('[Playwright] 处理生日后步骤...');

    // 场景 A: 也就是有时会出现 'OK' 按钮 (例如年龄确认?)
    try {
        const okBtn = page.getByRole('button', { name: 'OK' });
        // 使用短超时检查它是否弹出
        if (await okBtn.isVisible({ timeout: 3000 })) {
             console.log('[Playwright] 检测到 "OK" 按钮。点击中...');
             await okBtn.click();
        }
    } catch (e) {
        // 如果不存在则忽略
    }

    // 场景 B: 角色选择 ("What role best describes you?")
    try {
        const roleOption = page.getByText('Other (please specify)');
        const continueBtn = page.getByRole('button', { name: 'Continue to Dreamina' });
        
        // 稍作等待角色屏幕
        if (await continueBtn.isVisible({ timeout: 5000 }) || await roleOption.isVisible({ timeout: 5000 })) {
             console.log('[Playwright] 检测到角色选择屏幕。');
             
             // 如果选项可见则选择角色
             if (await roleOption.isVisible()) {
                 await roleOption.click();
             } else {
                 // 回退：如果找不到 'Other' 则点击任何可见的角色选项
                 await page.locator('div[class*="role-card"], div[class*="option"]').first().click();
             }
             
             // 点击继续
             console.log('[Playwright] 点击 "Continue to Dreamina"...');
             await continueBtn.click();
        }
    } catch (e) {
        console.log('[Playwright] 未找到或跳过 角色/继续 屏幕。');
    }

    // 10. 验证成功并等待 Session
    console.log('[Playwright] 验证信息/生日信息已提交。稍作等待以完成登录...');
    
    // 简单等待
    await page.waitForTimeout(5000);

    const title = await page.title();
    console.log(`[Playwright] 当前页面标题: ${title}`);

    // 获取并打印 Session ID 以便观察
    const cookies = await context.cookies();
    const sessionCookie = cookies.find(c => c.name === 'sessionid');
    if (sessionCookie) {
        console.log(`[Playwright] 成功获取 Session ID: ${sessionCookie.value}`);
    } else {
        console.warn('[Playwright] 警告: 未找到 Session ID Cookie');
    }

    // 保存存储状态 (Cookies/Headers) 以便复用
    await context.storageState({ path: 'playwrightTest/auth.json' });
    console.log('[Playwright] 认证状态已保存至 auth.json');

  } catch (error) {
    console.error('[错误]', error);
  } finally {
    if (browser) await browser.close();
  }
})();
