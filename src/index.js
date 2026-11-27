'use strict';

const { loadConfig } = require('./config');
const { listProcesses, compileGame, matches } = require('./detector');
const { SteamPresence } = require('./presence');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(...args) {
  console.log(`[${stamp()}]`, ...args);
}

function parseArgs(argv) {
  const out = { dryRun: false, verbose: false, scan: false, help: false, config: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--scan') out.scan = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--config') out.config = argv[++i] || null;
    else if (a.startsWith('--config=')) out.config = a.slice('--config='.length);
    else {
      console.error(`未知参数：${a}`);
      process.exit(1);
    }
  }
  return out;
}

const HELP = `
用法：node src/index.js [选项]

  --dry-run        只检测进程并打印状态变化，不连接 Steam
  --scan           扫描一次，列出每个游戏当前是否在运行，然后退出
  --verbose, -v    输出更多调试信息
  --config <路径>  指定配置文件（默认 ./config.json）
  --help, -h       显示帮助
`.trim();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  let cfg;
  try {
    cfg = loadConfig(args.config);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  let compiled;
  try {
    compiled = cfg.games.map(compileGame);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (args.scan) {
    const procs = listProcesses();
    for (const game of compiled) {
      const hits = procs.filter((p) => matches(game, p));
      if (!hits.length) {
        console.log(`· ${game.name}：未运行`);
        continue;
      }
      console.log(`✔ ${game.name}：${hits.length} 个进程`);
      for (const h of hits.slice(0, 5)) {
        const detail = h.exe || h.cmdline;
        console.log(`    pid ${h.pid}  ${detail.length > 140 ? `${detail.slice(0, 140)}…` : detail}`);
      }
    }
    return;
  }

  log(`配置文件：${cfg.sourceFile}`);
  log(`监控 ${compiled.length} 个游戏｜扫描间隔 ${cfg.pollIntervalMs}ms｜确认 ${cfg.confirmMs}ms｜退出宽限 ${cfg.exitGraceMs}ms`);

  let presence = null;
  if (args.dryRun) {
    log('dry-run 模式：只检测，不连接 Steam。');
  } else {
    presence = new SteamPresence(cfg.steam, log);
    presence.on('fatal', (err) => {
      log(`致命错误：${err.message}`);
      shutdown(1);
    });
    if (!presence.start()) {
      process.exit(2);
    }
  }

  const seen = new Map(); // index -> { firstSeen, lastSeen }
  let activeIndex = null;
  let lastRunningKey = '';

  function applyActive(next) {
    activeIndex = next;
    const game = next == null ? null : { name: compiled[next].name, appId: compiled[next].appId };
    if (game) {
      log(`▶ 开始玩「${game.name}」`);
    } else {
      log('■ 游戏全部退出');
    }
    if (presence) {
      presence.setGame(game);
    } else {
      log(`[dry-run] Steam 状态 → ${game ? `正在玩「${game.name}」` : '已清除'}`);
    }
  }

  function tick() {
    const now = Date.now();
    let procs;
    try {
      procs = listProcesses();
    } catch (err) {
      log(`扫描进程失败：${err.message}`);
      return;
    }

    const running = new Set();
    for (let i = 0; i < compiled.length; i++) {
      if (procs.some((p) => matches(compiled[i], p))) running.add(i);
    }

    if (args.verbose) {
      const key = [...running].sort().join(',');
      if (key !== lastRunningKey) {
        lastRunningKey = key;
        log(
          key
            ? `本轮命中：${[...running].map((i) => compiled[i].name).join('、')}（共扫描 ${procs.length} 个进程）`
            : `本轮无命中（共扫描 ${procs.length} 个进程）`,
        );
      }
    }

    for (const i of running) {
      const s = seen.get(i);
      if (!s) {
        seen.set(i, { firstSeen: now, lastSeen: now, present: true });
      } else {
        // 中间断过一次就重新计时，避免“每几秒闪一下”的启动器被误判成持续运行
        if (!s.present) {
          s.firstSeen = now;
          s.present = true;
        }
        s.lastSeen = now;
      }
    }

    for (const [i, s] of seen) {
      if (!running.has(i)) {
        s.present = false;
        if (now - s.lastSeen >= cfg.exitGraceMs) seen.delete(i);
        continue;
      }
      // 持续存在足够久才“确认”，之后即使短暂消失也保留到宽限期结束
      if (s.confirmedAt == null && now - s.firstSeen >= cfg.confirmMs) {
        s.confirmedAt = now;
      }
    }

    let next = null;
    for (let i = 0; i < compiled.length; i++) {
      const s = seen.get(i);
      if (s && s.confirmedAt != null) {
        next = i;
        break;
      }
    }

    if (next !== activeIndex) {
      applyActive(next);
    }
  }

  let shuttingDown = false;
  function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    log('正在退出…');
    if (presence) presence.stop();
    setTimeout(() => process.exit(code), 2500);
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('unhandledRejection', (err) => {
    log(`未处理的 Promise 拒绝：${err && err.stack ? err.stack : err}`);
  });

  tick();
  setInterval(tick, cfg.pollIntervalMs);
}

main();
