# Auto Research Loop（ARL）安装

ARL 使用两台机器：worker 交付 zip，validation 持有只增不改的 benchmark，作为 worker 的对抗方测试每次提交，发布结论、测试项通过数和经泄漏审查的反馈。双方只通过 `submit` 和 `query` MCP 工具交互。规划、编码、调试和委派由 agent 自己完成，不恢复旧的固定研究流水线。

两台机器都使用官方 Paseo 和官方 CLI。ARL 从本地源码仓库安装项目技能、编译好的 Node helper、运行依赖和模板，不需要定制 Paseo。官方 App 可查看 agent 和服务脚本，没有定制版 ARIS 知识图谱标签页；wiki 通过技能和文件读取。

## 安装

准备 Bash、Git、Node.js 22.12+ 和运行中的官方 Paseo（`paseo daemon status`）；worker 机器准备已认证的 Claude Code，验证端准备已认证的 Codex 和 benchmark 所需依赖。Windows 可使用 Git Bash；Node 需在 PATH 中，WSL 则是独立 Linux 环境。

在各机器的本地 `main` 分支 Git 仓库中，先显式准备依赖和编译产物，再按本机角色安装到项目：

```bash
cd /path/to/local/arl-checkout
npm ci
npm run build
bash distribution/install-aris.sh --role worker --project /path/to/project
# 验证端：
bash distribution/install-aris.sh --role validator --project /path/to/project
```

安装脚本只读取已准备好的本地仓库，不执行 Git clone/pull、npm 安装或下载，不需要 tar。缺少依赖或编译产物时直接报错并提示准备步骤。`distribution/install-arl.sh` 是同一流程的别名，旧的 `ARL_ARCHIVE` 和 `ARL_DOWNLOAD_BASE` 环境变量不再使用。可从任意目录通过绝对路径调用脚本，`--dry-run` 不写入目标项目。

若需手动离线分发，可另行执行 `npm run pack:arl` 并传输归档；目标机器无 Git 仓库时，在项目目录之外解压并安装：

```bash
tar -xzf arl-0.1.0.tar.gz
bash arl/install.sh --role worker --project /path/to/project
# 验证端：
bash arl/install.sh --role validator --project /path/to/project
```

角色决定 agent：

| 角色 | Agent | Paseo thinking | 技能目录 | 角色指令 |
| --- | --- | --- | --- | --- |
| worker | Claude Code | `ultracode` | `.claude/skills/` | `CLAUDE.md` |
| validator  | Codex | `max` | `.agents/skills/` | `AGENTS.md` |

setup 写入角色指令，以及 worker 在 `.mcp.json` 中的 `aris-validation` 条目，已有无关条目保留。**Codex 必须信任验证端项目**，然后重新打开会话。

包内包含 `aris-setup`、`validation-review`、`research-wiki`、`browser-act` 四个技能，以及共享参考、helper 和运行依赖闭包。保留 `.aris/` 数据路径，不安装任何子 agent 定义。文献检索、GPU 平台和通知等可选集成留在源码中，不随独立包安装。

## 配置两端

两台机器建立独立项目并加入官方 Paseo，不共享磁盘、仓库或同步目录。项目 `.gitignore` 排除 `.aris/` 和 worker 的 `.mcp.json`，因为它们包含凭据。

1. 验证端先写 `task.md`，以 thinking `max` 打开 Codex 并调用 `$aris-setup`；角色来自安装记录，无需指定。
2. 一次审阅完整配置表：benchmark 固定源码/数据版本、切分、样本数、runner argv 和指标；逐样本通过规则 `pass_rule`（`metric`、`op` 取 `>=` `>` `<=` `<` `==` 之一、`threshold`），每个样本即一个测试项；adapter 约定；`hidden_paths`，即隐藏样本、标签和参考答案的绝对路径，泄漏审查 agent 对照它们检查反馈；次数、上传、评审超时、`feedback_attempts` 和 `max_new_tests_per_review`（默认 200）等限制；以及服务地址。validator agent 固定为 Codex `max`，配置表只设置其 model 和 mode；服务以 `--provider codex --thinking max` 为每次提交启动一个 agent，`validation-cli leak-review` 以同样的 agent 配置启动独立的反馈泄漏审查 agent。
3. 确认配置摘要后，setup 执行 benchmark 安装、healthcheck 和 smoke，冻结 base 层 benchmark 和通过规则，生成 token，将 `aris-validation` 服务写入 `paseo.json`，并初始化 `research-wiki/` 作为验证端的长期记忆：记录各次提交暴露的问题、哪些已解决、哪些仍存在。从官方 Paseo 启动该服务。benchmark 只增不改：已有提交按 base 层和通过规则测试过后，要改它们只能新建 validator 项目；validator agent 用 `validation-cli extend` 新增 `inc-001` 等层，每个测试项从已有测试项派生；每一层是 helper 自有 git 仓库 `.aris/validation/benchmark/` 里一个只新增文件的提交，head 记录在 `.aris/validation/benchmark-head`，helper 逐个提交检查历史只增不改。已登记的层不能修改，错了的层用 `validation-cli retire` 停用（同样只新增文件）；固定的文件或这段历史有任何改动，服务就停止。
4. 私下把输出的 URL/token 和相同 `task.md` 交给 worker。worker 以 thinking `ultracode` 打开 Claude Code 并运行 `/aris-setup`，在同一配置表中填写连接，以及环境脚本所需的密钥（`environment.secrets`），审阅后确认。setup 把角色段写入 `CLAUDE.md`，把 MCP 条目写入 `.mcp.json`，并初始化 `research-wiki/`。
5. 两端的 setup 最后都写入[环境技能](#环境技能)。用户随后在客户端执行 `reload-skills` 加载技能；客户端没有重载动作时重新打开会话，worker 的 MCP 配置变更也需要新会话。验证 `query` 返回 open，再让 worker 执行任务。唯一的停止条件是计次提交用完（closed）；通过全部现有测试项不会结束任务，因为 validator 会继续增加测试项。

worker 的 `CLAUDE.md` 角色段规定带编号的迭代流程，必须逐步执行：research-wiki 是必须使用的长期记忆，当前迭代的短期任务写入 todo 列表，每次提交前先 commit。角色段同时列出 `submit` / `query`、`research-wiki`、`browser-act` 和环境技能的入口。浏览器 CLI 按需检查或安装。使用前读取对应 skill。

每次提交取得 validation 已发布的最终结论后，worker 将有实际依据、可跨项目复用的经验精简后提交到本地 ARL 源码仓库 `experience` 分支根目录的 `Experience.md`：该分支不存在时从 `main` 新建，存在则直接提交（在独立 worktree 中进行，不切换源码仓库当前分支），合并重复经验，无新经验则不添加；项目细节留在 wiki。worker 不推送也不合并：由你推送 `experience` 并发起合并到 `main` 的 PR，审核通过后其他项目才会读取。setup 在 worker 的 `CLAUDE.md` 中记录源码仓库和 worktree 位置，源码 checkout 需可写，其中的 `CLAUDE.md` 指向 `Experience.md`；安装目录 `.aris/` 不是经验仓库。保存规则见[经验保存约定](skills/shared-references/experience.md)；即使次数耗尽，也应完成经验整理后再结束。

私网/VPN 直连：`host=0.0.0.0`、固定 port（如 8790）、`public_url=http://<验证端地址>:8790`，开放防火墙端口。已有 Paseo service proxy 时可用 `host=127.0.0.1`、port=null 和脚本代理 URL。安装包不配置 DNS/proxy。

Windows 验证端的 `agent.paseo_command` 使用 `["node", "<Paseo install>\\bin\\paseo"]`，不要直接调用 `.cmd` shim。验证端状态：`node .aris/dist/tools/validation-cli.js status --project .`。

## 环境技能

两端的 setup 最后都在真实机器上、本角色的技能目录中写入 `<项目>-environment`。它的 `SKILL.md` 只记录 agent 无从得知的事实（机器和 SSH 别名，代码、数据、结果和日志路径，环境名，资源，指标落在哪里，已验证的特殊情况）和脚本表；`scripts/` 存放固定且验证过的 Bash 流程，例如同步代码、启动命名实验、检查、取回日志和结果、停止。每个实验有独立名称，worker 可在一轮迭代中并行运行多个实验。setup 把每个脚本实际运行一次，失败时如实报告环境步骤未完成。之后发现新的环境事实或重复的手工流程时，agent 按同样方式补充。

唯一的环境配置文件是 `.aris/environment.json`：来自配置表 `environment.secrets` 的密钥和 token，权限 0600；主机、路径和命令写在技能里。脚本用到的 SSH、rsync、conda 或容器等工具不在包内。

## 升级

显式更新本地源码仓库并运行 `npm run build`（锁文件变化时先运行 `npm ci`），再用相同角色运行 `distribution/install-aris.sh --role ... --project ...`，可先加 `--dry-run`。安装器基于当前本地文件生成临时文件包并校验哈希，管理 `.aris/install.json` 中登记的角色和文件，补回缺失文件，删除包内已移除的受管文件，拒绝覆盖本地修改。保存修改后可明确使用 `--force`。任务、wiki、benchmark、提交记录、setup 状态、`.aris/environment.json` 和环境技能不覆盖。已安装项目不能更换角色；没有角色记录的旧安装和旧版本 wiki 不迁移，请安装到新项目并新建 `research-wiki/`。validation 配置 `schema_version` 低于 2（使用分数和目标而非逐样本通过规则）的旧 validator 项目不迁移：还没有计次提交的，在验证端重新运行 `$aris-setup`，配置 `pass_rule` 和 `hidden_paths`；已有计次提交的，需新开一个 validator 项目。

已配置项目升级后执行 `node .aris/dist/tools/setup-cli.js apply --project .` 更新角色段，再执行客户端的 `reload-skills`；MCP 配置变更或客户端无重载动作时重新打开会话，无需重启 daemon。旧定制版安装没有独立包清单，先备份并优先使用新项目，或检查冲突后选择 `--force`；安装器不会删除旧全局链接和用户 agent 文件。

完整字段、网络和故障排查见包内 [英文指南](README.md)。源码阅读时见 [SETUP_GUIDE.md](SETUP_GUIDE.md)。
