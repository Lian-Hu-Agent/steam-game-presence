# Steam 游戏状态自动显示

监测本机游戏进程，启动游戏后自动把 Steam 好友列表状态改成「正在玩 <游戏名>」，退出后自动清除。

适用于 Linux（通过 `/proc` 扫描进程），原生游戏和 Proton/Wine 游戏都能识别。

---

## 先选方案

| | 方案 A：本守护进程 | 方案 B：非 Steam 快捷方式 |
|---|---|---|
| 原理 | 用 `steam-user` 登录你的账号，直接向 Steam 上报“正在玩 X” | 在 Steam 里「添加非 Steam 游戏」，始终从 Steam 启动 |
| 能否监测任意启动方式 | ✅ 双击、终端、启动器都行 | ❌ 必须由 Steam 启动 |
| 是否需要登录凭据 | 需要一次交互式登录（之后用 token） | 不需要 |
| 官方支持 | 第三方客户端协议，灰色地带 | 100% 官方行为 |
| 计入游戏时长 | ❌ | ✅（非 Steam 游戏也会计时） |
| 好友点开游戏 | 显示名字，非商店页 | 同上 |

**推荐**：想要“自动监测”就用方案 A；只玩固定几个游戏、且愿意从 Steam 启动，用方案 B 更稳。

<details>
<summary>方案 B 的具体做法（不用装本工具）</summary>

1. Steam 左下角「添加游戏」→「添加非 Steam 游戏」→ 选中游戏的 exe（Proton 游戏选 `steamapps/compatdata` 外的启动器或 `.exe`）。
2. 以后统一从 Steam 库启动它。
3. 好友列表会显示「正在玩 <你起的名字>」，并统计时长。

Lutris、Heroic、BoilR 之类的启动器可以直接批量导入。
</details>

---

## 方案 A：快速开始

```bash
npm install
cp config.example.json config.json   # 改成你自己的游戏
npm run login                        # 一次性：输入账号、密码、Steam 令牌
npm run dry-run                      # 另开终端启动游戏，验证能否识别
npm start                            # 正式运行
```

`npm run login` 成功后会把 refresh token 写到 `data/steam-token.json`（权限 600），之后启动不需要密码。

验证配置里的进程名对不对：

```bash
node src/index.js --scan
```

会列出每个游戏当前是否在运行，以及命中的进程 pid 和路径。

---

## 配置说明

```jsonc
{
  "pollIntervalMs": 3000,   // 扫描 /proc 的间隔
  "confirmMs": 5000,        // 进程持续存在多久才算“真的在玩”（过滤启动器、瞬时子进程）
  "exitGraceMs": 10000,     // 进程消失后多久清除状态（避免重启游戏时状态闪烁）
  "steam": {
    "personaState": "online",       // online / away / busy / invisible；invisible 时好友看不到
    "machineName": "Steam 状态显示", // 在 Steam 设备列表里显示的名字
    "force": false                  // true = 别处正在玩游戏时强行抢状态，一般不要开
  },
  "games": [
    {
      "name": "原神",                          // 好友看到的名字
      "appId": null,                           // 可选。填真实 Steam appid 会显示为那个游戏
      "match": ["GenshinImpact.exe"],          // 必填，任一命中即可
      "cmdlineRegex": null,                    // 可选，完整命令行必须匹配这个正则
      "exclude": []                            // 可选，命中这些进程名就忽略
    }
  ]
}
```

### match 规则

- 普通字符串：与**进程名**比较，大小写不敏感。进程名取 `exe` 和命令行每个参数的 basename，`/` 和 `\` 都会处理，所以 `GenshinImpact.exe` 能匹配 `Z:\Games\Genshin\GenshinImpact.exe`。
- `"re:xxx"`：对完整命令行做正则匹配，例如 `"re:minecraft.*fabric"`。

### 多个游戏同时运行

按 `games` 数组顺序取第一个已确认运行的游戏。把优先级高的放前面。

### 怎么找进程名

```bash
ps -eo pid,comm,args | grep -i 关键词
```

或者先随便填一个，用 `--scan` 看有没有命中。

Proton / Wine 游戏的进程名通常是 exe 文件名（如 `GenshinImpact.exe`、`StarRail.exe`），不是 `wine`。

---

## 常驻运行（systemd 用户服务）

```bash
./install-systemd.sh            # 安装 unit、enable、启动
./install-systemd.sh --linger   # 顺带开启 linger（未登录图形界面也运行）
./install-systemd.sh --status   # 看状态 + 最近日志
./install-systemd.sh --uninstall
```

脚本会按项目实际位置生成 unit，不用手改路径。检测不到 Steam token 时只写 unit、不启用，避免服务反复重启；先 `npm run login` 再跑一次即可。

<details>
<summary>手动安装</summary>

```bash
mkdir -p ~/.config/systemd/user
cp systemd/steam-game-presence.service ~/.config/systemd/user/
# 按注释改 WorkingDirectory / ExecStart 里的路径
systemctl --user daemon-reload
systemctl --user enable --now steam-game-presence
journalctl --user -u steam-game-presence -f
```
</details>

开机自启（未登录图形界面也能跑）：

```bash
loginctl enable-linger $USER
```

---

## 排障

**好友看不到状态**

1. `personaState` 不能是 `invisible`。
2. 看日志有没有「Steam 账号正在别处玩游戏」：如果 Steam 客户端正在玩另一个游戏，以客户端为准，本工具会被忽略。
3. Steam 客户端里「好友列表 → 你的名字」应该显示游戏名；手机端可能有延迟。

**日志说连接失败 / 需要验证码**

refresh token 失效（改过密码、撤销过授权）。重新 `npm run login`。

**游戏没被识别**

先 `--scan`；没命中就 `ps -eo pid,args | grep -i 游戏` 看真实进程名，填进 `match`。

**状态切换太慢 / 太灵敏**

调 `confirmMs`（确认时间）和 `exitGraceMs`（退出宽限）。

**Steam 客户端需要关掉吗**

不用。守护进程是独立会话，可以和客户端共存。客户端可能会提示“正在另一台设备上玩游戏”，属正常现象。

---

## 安全与风险

- `data/steam-token.json` 等同于登录凭据，权限已设为 600；不要提交、不要外传。`.gitignore` 已排除 `data/` 和 `config.json`。
- 第三方客户端登录（`steam-user`）不是 Valve 官方支持的方式。社区大量工具这么用，但没有官方保证；介意的话用方案 B。
- 本工具只上报“正在玩”，不碰库存、交易、市场。

---

## 文件结构

```
src/index.js       主循环：扫描进程 → 状态机 → 上报
src/detector.js    /proc 扫描与匹配
src/presence.js    steam-user 登录与 gamesPlayed 上报
src/login.js       一次性交互登录，保存 refresh token
src/config.js      配置加载与校验
src/token-store.js token 读写（0600）
install-systemd.sh 一键安装 / 卸载 systemd 用户服务
config.example.json
systemd/steam-game-presence.service
```

---

## License

MIT © 2026 Lian-Hu-Agent，详见 [LICENSE](LICENSE)。
