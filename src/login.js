'use strict';

// 一次性交互式登录，成功后把 refresh token 写进 data/steam-token.json。
// 之后守护进程用 token 登录，不再需要密码。

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const SteamUser = require('steam-user');
const { saveToken } = require('./token-store');
const { ROOT } = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// 隐藏输入（密码）
function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.resume();
    stdin.setRawMode(true);

    let value = '';
    const finish = (result) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(result);
    };
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(value);
        if (ch === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        value += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

function resolveTokenFile() {
  const file = process.env.PRESENCE_CONFIG || path.join(ROOT, 'config.json');
  let tokenFile = path.join(ROOT, 'data', 'steam-token.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cfg.steam && cfg.steam.tokenFile) tokenFile = path.resolve(ROOT, cfg.steam.tokenFile);
  } catch {
    // 没有 config.json 时用默认路径
  }
  return tokenFile;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('用法：npm run login\n\n按提示输入 Steam 账号、密码和 Steam Guard 验证码。');
    return;
  }

  const tokenFile = resolveTokenFile();
  if (!process.stdin.isTTY) {
    throw new Error('login 需要在终端里交互运行（或者用 STEAM_USERNAME / STEAM_PASSWORD 环境变量）。');
  }
  console.log(`token 将保存到：${tokenFile}\n`);

  const username = process.env.STEAM_USERNAME || (await ask('Steam 账号（用户名，不是昵称）: '));
  if (!username) throw new Error('账号不能为空');
  const password = process.env.STEAM_PASSWORD || (await askHidden('密码（输入时不显示）: '));
  if (!password) throw new Error('密码不能为空');

  const client = new SteamUser({ autoRelogin: false });
  let saved = false;
  let finished = false;

  const finish = (code, message) => {
    if (finished) return;
    finished = true;
    if (message) console.log(message);
    console.log(saved ? '完成。现在可以运行 `npm start` 了。' : '未拿到 refresh token，登录未完成。');
    try {
      client.logOff();
    } catch {
      // 忽略
    }
    setTimeout(() => process.exit(code), 400);
  };

  client.on('refreshToken', (token) => {
    try {
      saveToken(token, tokenFile, { accountName: username });
      saved = true;
      console.log(`✔ refresh token 已保存（权限 600）`);
    } catch (err) {
      console.error(`保存 token 失败：${err.message}`);
    }
  });

  client.on('steamGuard', async (domain, callback, lastCodeWrong) => {
    if (lastCodeWrong) {
      console.log('上一个验证码不对，等待 30 秒后可以重试…');
      await sleep(30000);
    }
    const code = await ask(domain ? `邮箱验证码（${domain}）: ` : '手机令牌验证码: ');
    callback(code.trim());
  });

  client.on('loggedOn', async () => {
    console.log(`✔ 登录成功，SteamID：${client.steamID.getSteamID64()}`);
    if (!saved) {
      console.log('等待 refresh token…');
      await sleep(2500);
    }
    finish(saved ? 0 : 1);
  });

  client.on('error', (err) => {
    console.error(`登录失败：${err.message}`);
    finish(1);
  });

  console.log('正在连接 Steam…');
  client.logOn({ accountName: username, password });

  setTimeout(() => finish(1, '超时：120 秒内没有完成登录。'), 120000).unref();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
