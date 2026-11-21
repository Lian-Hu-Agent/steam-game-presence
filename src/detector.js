'use strict';

// Linux /proc 进程扫描与匹配。
// 只依赖 /proc，不需要额外权限（同一用户自己的进程可读；读不到的进程会被跳过）。

const fs = require('fs');

function basename(p) {
  if (!p) return '';
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return cut === -1 ? p : p.slice(cut + 1);
}

function stripDeleted(p) {
  return p.endsWith(' (deleted)') ? p.slice(0, -' (deleted)'.length) : p;
}

function listProcesses() {
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return [];
  }

  const procs = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;

    let exe = '';
    try {
      exe = stripDeleted(fs.readlinkSync(`/proc/${pid}/exe`));
    } catch {
      // 内核线程或无权读取
    }

    let raw;
    try {
      raw = fs.readFileSync(`/proc/${pid}/cmdline`);
    } catch {
      continue;
    }
    if (!raw.length) continue; // 内核线程

    const argv = raw.toString('utf8').split('\0').filter(Boolean);
    if (!argv.length && !exe) continue;

    procs.push({ pid, exe, argv, cmdline: argv.join(' ') });
  }
  return procs;
}

// 把配置里的 match 规则编译一次，避免每轮都重新构造正则。
function compileGame(game) {
  const exact = new Set();
  const regexes = [];

  for (const m of game.match) {
    if (typeof m !== 'string' || !m.length) {
      throw new Error(`游戏 ${game.name} 的 match 里存在非法条目：${JSON.stringify(m)}`);
    }
    if (m.startsWith('re:')) {
      regexes.push(new RegExp(m.slice(3), 'i'));
    } else {
      exact.add(m.toLowerCase());
    }
  }

  return {
    name: game.name,
    appId: game.appId ?? null,
    exact,
    regexes,
    cmdlineRegex: game.cmdlineRegex ? new RegExp(game.cmdlineRegex, 'i') : null,
    exclude: new Set((game.exclude || []).map((s) => s.toLowerCase())),
  };
}

function matches(compiled, proc) {
  if (compiled.cmdlineRegex && !compiled.cmdlineRegex.test(proc.cmdline)) return false;

  const names = new Set();
  for (const token of [proc.exe, ...proc.argv]) {
    const b = basename(token).toLowerCase();
    if (b) names.add(b);
  }

  for (const ex of compiled.exclude) {
    if (names.has(ex)) return false;
  }
  for (const name of compiled.exact) {
    if (names.has(name)) return true;
  }
  for (const re of compiled.regexes) {
    if (re.test(proc.cmdline)) return true;
  }
  return false;
}

module.exports = { listProcesses, compileGame, matches, basename };
