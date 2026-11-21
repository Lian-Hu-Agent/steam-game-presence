'use strict';

const fs = require('fs');
const path = require('path');

function loadToken(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof data.refreshToken === 'string' && data.refreshToken ? data.refreshToken : null;
  } catch {
    return null;
  }
}

function saveToken(refreshToken, file, extra = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify(
    { refreshToken, ...extra, updatedAt: new Date().toISOString() },
    null,
    2,
  );
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 忽略：某些文件系统不支持 chmod
  }
}

function readAccountName(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data.accountName || null;
  } catch {
    return null;
  }
}

module.exports = { loadToken, saveToken, readAccountName };
