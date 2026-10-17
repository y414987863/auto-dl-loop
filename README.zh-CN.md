# Auto Research Loop

[English](README.md)

ARL 把研究任务分到两台机器：worker 交付 zip；validation 持有只增不改的 benchmark，为每次提交启动与 worker 对抗的验证 agent，发布结论、测试项通过数和经泄漏审查的反馈。双方通过 `submit` 和 `query` 两个 MCP 工具交互。

本分支只包含 ARL 源码、技能、测试和独立安装包。两台机器分别安装官方 Paseo；worker 使用 Claude Code（Paseo thinking `ultracode`），validation 使用 Codex（`max`），Paseo 负责执行和监控 agent。

## 功能特性

### 独立、可度量的验证

- **两台机器、两个项目**：worker 构建交付物，validation 持有隐藏 benchmark；双方只通过 `submit` 和 `query` 两个 MCP 工具交互，不共享目录。
- **只增不改的 benchmark**：setup 时固定 base 层 benchmark 的代码、数据版本、切分、样本数、评测设置和逐样本通过规则；validator agent 按层（`inc-001`、…）新增测试项，每项都从已有测试项派生，不凭空编造。新增的层放在只由 helper 提交的 git 仓库里，每个提交只能新增文件，helper 逐个提交检查；错了的层只能 retire、不能修改；固定的文件或这段历史有任何改动，服务就停止。
- **实测测试结果**：每个 benchmark 样本是一个测试项，按冻结的通过规则（`metric`、`op`、`threshold`）根据完整的逐样本 runner 输出判定通过或失败。结果只报告测试项总数和通过数，没有分数，也不比较不同提交的结果；worker 不自报结果。
- **对抗式审查**：validator agent 检查每个交付物，根据 `USAGE.md` 自写 adapter，重跑 benchmark 的每一层，并在 `task.md` 范围内尽可能多地找出真实问题，可以使用任何工具或调研来的测试方法；判定为 `valid`、`cheating` 或 `unusable`，`cheating` 时所有测试结果作废。
- **反馈经泄漏审查**：反馈写出实际问题：交付物错在哪里、违反 `task.md` 的哪项要求、大致多常见、多严重，以及上次的问题哪些解决了、哪些还在；但不透露测试用例。发布前由另一个独立 agent 对照隐藏测试交叉检查；重写次数用完仍泄漏时，只发布结论和测试项计数。
- **明确的停止条件**：唯一的停止条件是计次提交用完（`closed`），通过全部现有测试项不会结束任务；上传、格式和基础设施故障不计入次数。

### 按角色固定 agent

| 角色 | Agent | Paseo thinking | 指令文件 |
| --- | --- | --- | --- |
| worker | Claude Code | `ultracode` | `CLAUDE.md` |
| validator  | Codex | `max` | `AGENTS.md` |

安装参数 `--role` 决定 agent、技能目录和配置；validation 服务启动的每个评审 agent，以及每个反馈泄漏审查 agent，都是 Codex `max`。

### 有记忆的严格迭代

- **编号迭代流程**：worker 的角色指令要求依次完成每一步：读记忆 → 选择问题和未试过的想法 → 在 todo list 中规划 → 运行实验 → commit → submit → 记录结论和测试项计数 → 保存经验。每次提交对应一个 Git commit。
- **必须使用长期记忆**：`research-wiki` 按问题（可以是多个）记录已有工作的调研（survey，来自 arXiv、Semantic Scholar、OpenAlex、Exa 等）、尝试过的想法和实验，以及哪些有效、哪些无效，并用 `supports`、`invalidates`、`solves`、`reproduces` 等证据边关联。
- **精简 query pack**：每轮迭代从不超过 1000 字符的确定性摘要开始。每个未解决问题一行，按节点 id 标出有效（✔）和无效（✘）的尝试，细节见节点页面。
- **验证记忆**：validator 机器有自己的 wiki，记录验证问题，以及每次提交解决了哪些、哪些仍然存在；每次评审都会重新检查并在反馈中说明。
- **短期任务进 todo list**：迭代步骤和每条反馈问题都作为 todo 跟踪，修复进已提交的交付物后才关闭。
- **跨项目经验**：每次得到 validation 结果后，worker 把有证据支持的简短经验提交到 ARL 源码仓库 `experience` 分支的 `Experience.md`；由你发起合并到 `main` 的 PR 审核后，其他项目才会使用。

### 环境技能

setup 在真实机器上写入项目技能 `<项目>-environment`：

- **只记事实**：只记录 agent 无从得知的环境事实，如主机、路径、环境名、资源、指标输出位置和已验证的坑；不写通用工具知识。
- **验证过的脚本**：固定流程写成脚本，如同步代码、启动命名实验、检查状态、取回结果、停止。每次运行有独立名称、日志和结果路径，可以并行运行多个实验。
- **密钥单独存放**：key 和 token 只保存在 `.aris/environment.json`（权限 0600，不进 Git）。

之后发现的新环境事实或重复的手工流程，也按同样规则补进这个技能。

### 本地、按归属管理的安装

安装器从准备好的本地 Git 仓库复制编译好的 helper、四个核心技能（`aris-setup`、`validation-review`、`research-wiki`、`browser-act`）和运行依赖，不下载任何东西。更新只替换 ARL 自己管理的文件，保留任务、wiki、benchmark、提交记录、生成的环境技能和无关配置。

## 安装

需要 Node.js 22.12+、Bash 和 Git。使用本地 `main` 分支源码仓库，先显式准备依赖和编译产物，再按角色安装项目：

```bash
cd /你的本地arl仓库
npm ci
npm run build
bash distribution/install-aris.sh --role worker --project /你的项目目录
# validator 机器使用：
bash distribution/install-aris.sh --role validator --project /你的项目目录
```

安装器仅从准备好的本地仓库复制项目技能、编译好的 helper 和运行依赖，不触发下载；缺少依赖或编译产物时直接报错。角色决定 agent，更新时不可更换。`install-arl.sh` 保留为同一安装流程的别名。Codex 必须信任 validator 项目。

先配置 validator，再把地址和 token 私下交给 worker。完整步骤见[中文部署指南](SETUP_GUIDE_CN.md)。

`/aris-setup` 从安装记录读取角色，最后在本机写入并验证项目环境技能 `<项目>-environment`：只记录 agent 无从得知的环境事实，以及同步代码、启动命名实验、检查、取回结果、停止等固定脚本，worker 可在一轮迭代中并行运行多个实验。`research-wiki` 是角色的长期记忆，记录问题、已有工作调研（survey）、尝试过的想法和实验及其有效性；`browser-act` 访问浏览器。技能变更后提示用户在客户端执行 `reload-skills`。升级或修复继续使用安装脚本。

## 开发

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm run test -- tests/test_setup.ts
npm run pack:arl
```

打包产物及校验文件在 `artifacts/`，用于发布和手动离线分发，本地安装不读取它们。修改交付文件后，把两份文件复制到 `distribution/releases/` 后提交。参见[打包约定](docs/arl-install.md)、[贡献指南](CONTRIBUTING_CN.md)和[架构说明](ARIS_ARCHITECTURE_GUIDE.md)。

## 许可证

[MIT](LICENSE)，保留原 ARIS 作者的版权声明。
