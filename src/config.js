'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  // 扫描 /proc 的间隔
  pollIntervalMs: 3000,
  // 进程连续存在多久才认为“真的在玩”（过滤启动器、瞬时子进程）
  confirmMs: 5000,
  // 进程消失后多久才清掉状态（避免切换场景/重启游戏时闪烁）
  exitGraceMs: 10000,
  steam: {
    tokenFile: path.join(ROOT, 'data', 'steam-token.json'),
    personaState: 'online',
    machineName: 'Steam 状态显示',
    // 为 true 时，如果账号正在别处玩游戏，会踢掉那边再上报（一般不要开）
    force: false,
  },
  games: [],
};

function loadConfig(explicitPath) {
  const file = explicitPath || process.env.PRESENCE_CONFIG || path.join(ROOT, 'config.json');

  let user = {};
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`配置文件不是合法 JSON：${file}\n${err.message}`);
    }
  } else if (explicitPath || process.env.PRESENCE_CONFIG) {
    throw new Error(`找不到配置文件：${file}`);
  }

  const cfg = {
    ...DEFAULTS,
    ...user,
    steam: { ...DEFAULTS.steam, ...(user.steam || {}) },
    games: Array.isArray(user.games) ? user.games : [],
  };

  if (!cfg.games.length) {
    throw new Error(`配置里没有任何游戏：${file}\n请先复制 config.example.json 为 config.json 并填写游戏。`);
  }

  const seenNames = new Set();
  cfg.games.forEach((g, i) => {
    if (!g.name || typeof g.name !== 'string') throw new Error(`games[${i}] 缺少 name`);
    if (seenNames.has(g.name)) throw new Error(`游戏名重复：${g.name}`);
    seenNames.add(g.name);
    if (!Array.isArray(g.match) || !g.match.length) {
      throw new Error(`games[${i}] (${g.name}) 缺少非空的 match 数组`);
    }
    if (g.appId != null && !Number.isInteger(g.appId)) {
      throw new Error(`games[${i}] (${g.name}) 的 appId 必须是整数，留空则按非 Steam 游戏处理`);
    }
  });

  if (cfg.steam.tokenFile && !path.isAbsolute(cfg.steam.tokenFile)) {
    cfg.steam.tokenFile = path.join(ROOT, cfg.steam.tokenFile);
  }

  cfg.sourceFile = file;
  return cfg;
}

module.exports = { loadConfig, ROOT, DEFAULTS };
