# skm — 轻量跨 agent 技能管理器

一个单文件、零依赖的 Node CLI，用于在多个 coding agent（Claude Code、WorkBuddy、CodeBuddy、Codex CLI……）之间**集中管理技能**：所有技能只存一份于中心存储，各 agent 的 skills 目录通过链接按需接入。

```
~/.agents/skills/            ← 中心存储（唯一真身，按合集组织）
  ├── mattpocock-skills/
  │     ├── tdd/             ← 技能 = 含 SKILL.md 的文件夹
  │     └── code-review/
  └── vercel-labs-skills/
        └── drawio-skill/

~/.claude/skills/tdd      → 链接到 ~/.agents/skills/mattpocock-skills/tdd
~/.cursor/skills/tdd      → 链接到同一份真身（cursor 需先 skm agent add 注册）
```

设计决策见 `CONTEXT.md`（术语表）与 `docs/adr/0001-0004`，完整规格见 `.scratch/skm-mvp/spec.md`。

## 环境要求

- **Node.js ≥ 18**（无任何 npm 依赖）
- **git**（仅 `add`/`update` GitHub 来源时需要）
- Windows 上链接使用 junction（无需管理员/开发者模式）；macOS/Linux 使用符号链接

## 安装（Windows 11 + PowerShell 7）

**前置检查**：先确认 Node 和 git 都已就绪（Node ≥ 18；git 仅 `add`/`update` GitHub 来源时才需要）：

```powershell
node --version   # 应输出 v18 或更高，例如 v24.21.0；未装则到 nodejs.org 下载 LTS 安装包
git --version    # 应输出版本号；未装则 winget install --id Git.Git
```

**第 1 步 — 放置脚本**：把 `skm.mjs` 放到一个固定位置（推荐 `~\.skm\`，之后不要挪动）：

```powershell
New-Item -ItemType Directory -Force "$HOME\.skm" | Out-Null   # 创建 ~\.skm 目录（-Force：已存在也不报错）
Copy-Item <你的 skm.mjs 所在路径>\skm.mjs "$HOME\.skm\"        # 复制脚本进去；例如 D:\repos\skills-manager\skm.mjs
```

**第 2 步 — 定义 `skm` 命令**：写进 pwsh7 的用户配置文件，所有终端窗口永久生效。注意要用**函数**而不是 `Set-Alias`——alias 无法固定附带参数（`node 脚本路径`），函数可以：

```powershell
# 若从未改过配置文件，先创建它（$PROFILE 是 pwsh7 的用户配置文件路径，通常是 ~\Documents\PowerShell\Microsoft.PowerShell_profile.ps1）
if (!(Test-Path $PROFILE)) { New-Item -ItemType File -Force $PROFILE | Out-Null }

# 追加 skm 函数定义：@args 会把 skm 后面的所有参数原样转交给 node 脚本
Add-Content $PROFILE 'function skm { node "$HOME\.skm\skm.mjs" @args }'
```

**第 3 步 — 允许配置文件被执行**：若之前从未用过 `$PROFILE`，脚本可能因执行策略被拦截（报错含 `running scripts is disabled`），给当前用户放开即可（pwsh7 常见的一次性设置）：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned   # RemoteSigned：本地脚本可直接跑，网上下载的需签名
```

**第 4 步 — 生效并验证**：重开一个 pwsh7 窗口（或当前窗口执行 `. $PROFILE` 重新加载），然后：

```powershell
skm help    # 输出命令总览即为安装成功
skm list    # 查看当前 agent 与合集状态（首次运行会自动初始化 ~/.agents/）
```

> 提示：`$PROFILE` 若位于被 OneDrive 重定向的「文档」目录属正常现象，不影响使用；换机器时按同样步骤重装即可。

## 迁移到新电脑（Windows 11 → Windows 11，pwsh7）

**可行，且只需三步。** 核心原则：**搬数据，不搬链接**——链接是绝对路径绑死旧机器的，新机器上由 `skm link` 一键重建。

1. **旧机器**：打包中心存储与两份元数据（**不要**打包任何 agent 目录，里面的链接到新机器上全是死路径）：

   ```powershell
   # 把中心存储 skills 文件夹 + 配置 + 锁文件打包成 zip，放到桌面
   # Compress-Archive 会以各项的「末级名字」存入压缩包根目录：skills\...、skm.config.json、skm.lock.json
   Compress-Archive `
     -Path "$HOME\.agents\skills", "$HOME\.agents\skm.config.json", "$HOME\.agents\skm.lock.json" `
     -DestinationPath "$HOME\Desktop\skm-backup.zip" -Force   # -Force：同名包已存在则覆盖
   ```

   用 U 盘、网盘等任意方式把 `skm-backup.zip` 传到新机器。

2. **新机器**：装好 Node 与 git，按上面「安装」一节把 `skm` 命令配置好，然后解压备份到相同位置：

   ```powershell
   New-Item -ItemType Directory -Force "$HOME\.agents" | Out-Null          # 确保 ~/.agents 目录存在
   Expand-Archive -Path "C:\path\to\skm-backup.zip" -DestinationPath "$HOME\.agents" -Force
   # 解压后：~\.agents\skills\（全部技能真身）+ skm.config.json（agent 注册表与启用清单）+ skm.lock.json
   ```

3. **新机器**：重建全部链接：

   ```powershell
   skm link    # 按启用清单为所有 agent 重建链接；agent 目录不存在会自动创建
   skm list    # 核对各 agent 与合集状态，与旧机器一致即迁移完成
   ```

   若新旧机器的 agent 集合不同（比如新机器没有 codex），用 `skm agent remove codex` 注销、`skm agent add <名字> <路径>` 添加（等价于改 `~\.agents\skm.config.json` 的 `agents` 段），改完再跑一次 `skm link`。

> 从「第三方工具管理的旧机器」迁移？无需手工打包——新机器上把旧 `~/.agents` 原样复制过去后，**首次运行任意命令会自动检测旧 v3 锁文件**：备份之、按来源把平铺技能重组进合集、按现存链接重建启用清单。之后照常 `skm link`。

## 常用命令（日常 90% 场景）

```bash
skm add https://github.com/user/some-skills --enable claude,cursor
#        ↑ 装 GitHub 合集并一步启用给指定 agent；本地路径同样适用：
skm add D:\my-skills --enable claude
#        ↑ 不带 --enable 时（交互终端）会列出全部 agent 供你勾选启用

skm enable some-skills cursor       # 把合集启用给某 agent（立即建链接）
skm enable some-skills              # 交互式：列出全部 agent 勾选（已启用的会标注）
skm disable some-skills cursor      # 禁用（立即删链接）
skm disable some-skills             # 交互式：只列出已启用该合集的 agent 勾选

skm list                            # 查看全部合集、技能、各 agent 启用状态
skm update                          # 一键更新所有合集（上游默认分支 HEAD）

skm agent add cursor .cursor/skills # 注册新 agent（默认只内置 claude，其余按需添加）
skm agent list                      # 查看已注册 agent 及其启用情况
skm agent remove cursor             # 注销 agent（清理其链接与启用记录）

skm help                            # 查看命令总览；skm help add 看单命令详情
```

## 全部命令参考

### `skm add <来源> [选项]`

安装一个来源（GitHub 仓库或本地文件夹）为合集。递归发现来源内所有含 `SKILL.md` 的文件夹；仓库内部分类层级会被压平。默认对所有 agent 不启用（opt-in）。

| 选项 | 说明 |
|---|---|
| `--skill <名,名>` | 只安装指定技能 |
| `--enable <agent,agent>` | 安装后立即启用给指定 agent（先验证冲突再落盘，原子生效） |
| `--no-enable` | 只安装不启用，跳过交互询问（适合脚本） |
| `--dry-run` | 只列出将安装什么，不做任何改动 |

- 来源支持三种写法：本地路径（`D:\my-skills`，含 `.git` 时按 git 仓库克隆以保真内容）、`owner/repo`、完整 GitHub URL。
- **启用给谁**：不传 `--enable`/`--no-enable` 时，交互终端会列出全部 agent 供多选（输入编号，`a`=全部，回车=不启用）；非交互模式（脚本/管道）下会报错，必须显式传 `--enable` 或 `--no-enable`。
- 本地来源为**拷贝语义**：之后原路径的修改需 `update` 才会进入中心存储。
- 合集内或与已启用合集之间存在同名技能 → 当场报错，不自动改名。

### `skm list`

列出全部 agent 目标（路径、启用的合集及排除项）与全部合集（来源、技能数量、技能清单、启用者）。终端（TTY）下以单线边框与颜色渲染；管道或被程序调用时自动输出无边框纯文本。颜色可用 `NO_COLOR=1` 关闭、`FORCE_COLOR=1` 强制开启。

### `skm enable <合集> [agent[,agent...]] [--exclude <技能名>]`

启用合集：立即为指定 agent 创建全部技能链接。省略 agent 时（交互终端）列出全部 agent 供多选，已启用该合集的会标注；非交互模式必须显式指定。`--exclude` 排除个别技能（记录在启用清单中，之后 update 新增技能仍自动跟随）。未知 agent、跨合集同名冲突会在**落盘前**整体验证。

### `skm disable <合集> [agent[,agent...]]`

禁用合集：立即移除该 agent 下对应链接，保留中心存储数据。省略 agent 时（交互终端）只列出当前已启用该合集的 agent 供多选；非交互模式必须显式指定。

### `skm update [合集...] [--force]`

从来源拉取默认分支 HEAD 并更新。无参数时更新全部合集。

- 技能文件夹被本地修改过（内容 hash 与安装时不符）→ **跳过并警告**；`--force` 丢弃本地修改、恢复上游版本。
- 上游新增技能：自动装入；已启用该合集的 agent 立即获得链接（无需重新 enable）。
- 上游删除的技能：保留在本机（不做自动删除）。

### `skm agent <add|remove|list>`

维护 agent 注册表（`~/.agents/skm.config.json` 的 `agents` 段：名称 → 技能目录）。注册表此前只能手改配置文件，现在命令行即可维护。

**默认只内置 claude 一个**，其余 agent（workbuddy、codebuddy、codex、cursor…）按需 `skm agent add` 添加后才能 `enable`。默认项只影响首次生成的配置文件——已存在的配置不会被自动裁剪，想精简请自行 `skm agent remove`。

| 子命令 | 说明 |
|---|---|
| `skm agent add <名字> <路径>` | 注册 agent。路径相对 HOME 存储（也接受 `~` 开头与绝对路径，如 `D:/tools/windsurf/skills`） |
| `skm agent remove <名字> [--force]` | 注销 agent：移除注册项、启用记录，以及该目录下所有指向中心存储的链接 |
| `skm agent list` | 列出已注册 agent 及其启用情况（不带子命令的 `skm agent` 同此） |

```bash
skm agent add cursor .cursor/skills     # 注册并创建该目录
skm enable some-skills cursor           # 之后照常启用合集
skm agent remove cursor --force         # 注销：链接与启用记录一并清除
```

- **名称**只允许字母、数字、`.` `_` `-`；已注册的名称需先 `remove` 才能改路径。
- **路径安全约束**：不得是 HOME 本身、中心存储（`~/.agents/skills`）内部或其父目录——这类位置会让 `skm link` 的清理逻辑误伤中心存储；也不得与其他 agent 的路径重复（两个 agent 共用同一目录会互相覆盖链接）。
- 注销**只删链接**，agent 目录里 agent 自己的原生真实技能目录一律保留。交互终端下需确认，非交互（脚本）必须 `--force`。
- 注册项若为相对路径，换机器/换用户名后仍可直接沿用；绝对路径会原样保留。

### `skm remove <合集> [--force]`

一步删净：中心存储目录 + 所有 agent 中的对应链接 + 锁条目 + 启用清单条目。交互终端下会确认；非交互（脚本）必须 `--force`。

### `skm link`

幂等全量同步：按启用清单重建/修复/清理所有 agent 的链接。迁移后、手改配置后、任何不确定的时刻跑它都安全。永不触碰 agent 目录中的原生真实目录（非链接条目），同名时跳过并报告。

### `skm help [命令]`

查看帮助文档，两种用法：

- **`skm help`**（或无参数运行 `skm`）：命令总览——全部命令及各自的一句话作用说明。
- **`skm help <命令>`**：单个命令的详细文档——用法、参数含义与示例，例如 `skm help add`。

另外任意命令后跟 `--help` / `-h` 也可直达该命令详情（如 `skm add --help`），不必先记 help 命令本身。未知命令会提示可用的命令列表。

## 文件布局与数据归属

| 位置 | 归属 | 说明 |
|---|---|---|
| `~/.agents/skills/` | 工具管理 | 中心存储（唯一真身） |
| `~/.agents/skm.config.json` | **用户可手改**（推荐用 `skm agent` 维护） | agent 注册表（`agents`）+ 启用清单（`enablement`） |
| `~/.agents/skm.lock.json` | 工具专用 | 各合集来源、技能 hash、时间戳 |
| `~/.<agent>/skills/` | 混合 | 链接（工具管理）+ 原生真实目录（agent 自己的，工具永不触碰） |

启用清单条目两种写法（等价）：`"coll"` 或 `{ "collection": "coll", "exclude": ["skill"] }`。

## 故障排查

- **`[跳过] <agent>/<技能>：同名原生技能已存在`** —— 该 agent 目录下有 agent 自己装的同名技能，工具不覆盖。想用中心版本就先删原生目录。
- **`同名冲突：技能 "x" 同时来自已启用合集 A 和 B`** —— 二选一：`disable` 其中一个合集。
- **Windows 上链接创建失败** —— 正常不会发生（junction 免特权）；若 agent 目录在网络盘等不支持 junction 的位置，把该 agent 的 `skillsDir` 改到本地盘。
- **`git clone 失败`** —— 检查网络/仓库权限；私有仓库需已配置 git 凭据。
- 想在隔离环境试用（不影响真实目录）——pwsh7 写法：

  ```powershell
  $env:SKM_HOME = "$env:TEMP\skm-try"   # 把数据根临时指到一个 TEMP 下的沙箱目录，仅当前窗口有效
  skm list                              # 观察输出；真实 ~/.agents 完全不受影响
  Remove-Item Env:SKM_HOME              # 试用完移除该环境变量，恢复默认
  ```
