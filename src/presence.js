'use strict';

// 通过 Steam 客户端协议上报“正在玩什么”。
// 原理：ClientGamesPlayedWithDataBlob。传字符串时 steam-user 会把它编码成
// 非 Steam 游戏（game_id = 15190414816125648896），和 Steam 客户端里
// “添加非 Steam 游戏”后启动的效果一致：好友列表显示“正在玩 <名字>”。

const EventEmitter = require('events');
const SteamUser = require('steam-user');
const { loadToken, saveToken } = require('./token-store');

const NON_STEAM_GAME_ID = '15190414816125648896';

const PERSONA_STATES = {
  offline: SteamUser.EPersonaState.Offline,
  online: SteamUser.EPersonaState.Online,
  busy: SteamUser.EPersonaState.Busy,
  away: SteamUser.EPersonaState.Away,
  snooze: SteamUser.EPersonaState.Snooze,
  invisible: SteamUser.EPersonaState.Invisible,
};

class SteamPresence extends EventEmitter {
  constructor(steamCfg, log) {
    super();
    this.cfg = steamCfg;
    this.log = log;
    this.client = null;
    this.ready = false;
    this.current = null;
    this.lastPayloadKey = null;
    this.wasBlocked = false;
    this.retryTimer = null;
    this.loginTimer = null;
    this.reconnectTimer = null;
    this.reassertTimer = null;
    this.loginFailures = 0;
    this.stopped = false;
    this.tokenFile = steamCfg.tokenFile;
    this.token = process.env.STEAM_REFRESH_TOKEN || loadToken(this.tokenFile);
  }

  start() {
    if (!this.token) {
      this.log(
        '未找到 Steam refresh token。请先运行 `npm run login` 完成一次交互式登录（会生成 data/steam-token.json）。',
      );
      return false;
    }
    this._connect();
    return true;
  }

  _connect() {
    const client = new SteamUser({ autoRelogin: true });
    this.client = client;

    client.on('loggedOn', () => {
      const id = client.steamID ? client.steamID.getSteamID64() : '未知';
      this.log(`已登录 Steam（${id}）`);

      const stateName = this.cfg.personaState;
      if (stateName && PERSONA_STATES[stateName] != null) {
        client.setPersona(PERSONA_STATES[stateName]);
        if (stateName === 'invisible') {
          this.log('注意：personaState = invisible 时好友看不到游戏状态。');
        }
      }

      this.ready = true;
      this.loginFailures = 0;
      this._clearLoginTimer();
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      this._startReassert();
      this.lastPayloadKey = null;
      this.emit('ready');
      // 重连后立刻恢复当前游戏
      if (this.current) this.setGame(this.current);
    });

    client.on('refreshToken', (token) => {
      this.token = token;
      try {
        saveToken(token, this.tokenFile, { accountName: this.cfg.accountName });
      } catch (err) {
        this.log(`保存 refresh token 失败：${err.message}`);
      }
    });

    client.on('disconnected', (eresult, msg) => {
      this.ready = false;
      this.lastPayloadKey = null;
      this._clearReassert();
      this.log(`与 Steam 断开（${msg || eresult}），等待自动重连…`);
      // autoRelogin 自己会重连，但如果它也卡住，90 秒后强制重建会话
      this._armLoginWatchdog(client, 90000);
    });

    client.on('error', (err) => {
      this.ready = false;
      this.lastPayloadKey = null;
      this._clearLoginTimer();
      this._clearReassert();
      this.log(`Steam 错误：${err.message}`);

      const fatal = [
        SteamUser.EResult.InvalidPassword,
        SteamUser.EResult.AccessDenied,
        SteamUser.EResult.Revoked,
      ];
      if (fatal.includes(err.eresult)) {
        this.emit('fatal', err);
        return;
      }
      // 限流、CM 繁忙之类的错误不会触发 autoRelogin，自己稍后重试
      this._scheduleRetry();
    });

    client.on('playingState', (blocked, playingApp) => {
      if (blocked) {
        this.wasBlocked = true;
        this.log(
          `Steam 账号正在别处玩游戏（appid ${playingApp}），本会话上报的状态会被 Steam 忽略；等那边退出后会自动补报。`,
        );
        return;
      }
      // 从“被别处占用”恢复：Steam 可能丢弃了之前的上报，需要重发一次。
      // 只在 wasBlocked 时重发，避免自己的 gamesPlayed 又触发本事件造成循环。
      if (this.wasBlocked) {
        this.wasBlocked = false;
        this.lastPayloadKey = null;
        if (this.current) this.setGame(this.current);
      }
    });

    client.on('steamGuard', (domain, callback) => {
      const code = process.env.STEAM_GUARD_CODE;
      if (code) {
        this.log('使用 STEAM_GUARD_CODE 提交 Steam Guard 验证码。');
        callback(code);
        return;
      }
      this.log(
        `Steam 要求 ${domain ? `邮箱验证码（${domain}）` : '手机令牌验证码'}。守护进程无法交互输入，请重新运行 npm run login。`,
      );
      this.emit('fatal', new Error('STEAM_GUARD_REQUIRED'));
    });

    this.log('正在连接 Steam…');
    client.logOn({
      refreshToken: this.token,
      machineName: this.cfg.machineName || 'Steam 状态显示',
    });
    this._armLoginWatchdog(client, 60000);
  }

  _clearLoginTimer() {
    if (this.loginTimer) {
      clearTimeout(this.loginTimer);
      this.loginTimer = null;
    }
  }

  _armLoginWatchdog(client, ms) {
    this._clearLoginTimer();
    this.loginTimer = setTimeout(() => {
      this.loginTimer = null;
      if (this.stopped || this.ready || this.client !== client) return;
      this.loginFailures += 1;
      const delay = Math.min(60000 * 2 ** (this.loginFailures - 1), 1800000);
      this.log(
        `登录 Steam 超时（${Math.round(ms / 1000)} 秒，第 ${this.loginFailures} 次），` +
          `${Math.round(delay / 1000)} 秒后重建会话；若持续失败请重新 npm run login（可能是 token 失效或 Steam 限流）`,
      );
      this._reconnect(delay);
    }, ms);
  }

  _startReassert() {
    if (this.reassertTimer) return;
    // Steam 客户端或服务器偶尔会清掉上报状态，每 3 分钟静默重发一次
    this.reassertTimer = setInterval(() => {
      if (!this.ready || !this.current) return;
      this.lastPayloadKey = null;
      this.setGame(this.current, { quiet: true });
    }, 180000);
    this.reassertTimer.unref?.();
  }

  _clearReassert() {
    if (this.reassertTimer) {
      clearInterval(this.reassertTimer);
      this.reassertTimer = null;
    }
  }

  _reconnect(delayMs = 2000) {
    if (this.stopped || this.reconnectTimer) return;
    this.ready = false;
    this.lastPayloadKey = null;
    this._clearLoginTimer();
    this._clearReassert();

    const old = this.client;
    this.client = null;
    if (old) {
      try {
        old.removeAllListeners();
      } catch {
        // 忽略
      }
      try {
        old.logOff();
      } catch {
        // 忽略
      }
      try {
        old.disconnect?.();
      } catch {
        // 忽略
      }
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this._connect();
    }, delayMs);
  }

  _scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped || this.ready) return;
      this.log('重新尝试登录 Steam…');
      try {
        this.client.logOn({
          refreshToken: this.token,
          machineName: this.cfg.machineName || 'Steam 状态显示',
        });
        this._armLoginWatchdog(this.client, 60000);
      } catch (err) {
        this.log(`重新登录失败：${err.message}`);
        this._scheduleRetry();
      }
    }, 30000);
  }

  // game: { name, appId } 或 null
  setGame(game, opts = {}) {
    this.current = game;
    if (!this.ready) return;

    const payload = game
      ? [
          game.appId != null
            ? { game_id: game.appId, game_extra_info: game.name }
            : { game_id: NON_STEAM_GAME_ID, game_extra_info: game.name },
        ]
      : [];

    const key = JSON.stringify(payload);
    if (key === this.lastPayloadKey) return;
    this.lastPayloadKey = key;

    this.client.gamesPlayed(payload, Boolean(this.cfg.force));
    if (opts.quiet) return;
    if (game) {
      this.log(`Steam 状态 → 正在玩「${game.name}」`);
    } else {
      this.log('Steam 状态 → 已清除');
    }
  }

  stop() {
    this.stopped = true;
    this._clearLoginTimer();
    this._clearReassert();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.client) return;
    try {
      if (this.ready) this.client.gamesPlayed([]);
    } catch {
      // 忽略
    }
    setTimeout(() => {
      try {
        this.client.logOff();
      } catch {
        // 忽略
      }
    }, 300).unref();
  }
}

module.exports = { SteamPresence, PERSONA_STATES };
