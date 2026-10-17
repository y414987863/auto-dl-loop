# Auto Research Loop（ARL）架构

ARL 是可独立安装、配合官方 Paseo 使用的两机研究任务包。保留 ARIS 技能名称和数据路径。安装包不包含 Paseo，也不向全局目录或 agents 目录复制定义。具体怎么用看各技能的 `SKILL.md`，路由索引见 [AGENT_GUIDE.md](AGENT_GUIDE.md)，两台机器的部署见 [SETUP_GUIDE_CN.md](SETUP_GUIDE_CN.md)。

## 一、出发点

前沿模型拿到任务和环境后，已经能自己规划、写代码、训练、调试、派子 agent。以前 ARIS 把一轮研究写死成"想法 → 实现 → 测试 → 审计 → 评审 → 停止门"的流水线，这层脚手架现在成了上限，所以删掉了。

模型还做不好的一件事，是给自己的成果下结论：同一个 agent 写的评测，评出来的结果不可信。ARIS 现在只解决这一件事，做法是把"做"和"判"放到两台互相看不见的机器上：

- **worker** 只管做。它是 Paseo 中 thinking 为 `ultracode` 的 Claude Code，拿到 `task.md`，用自己的环境和 wiki 交付一个 zip。
- **validator** 只管测，并且和 worker 对抗。它持有 worker 看不到、只增不改的 benchmark，为每次提交启动一个 thinking 为 `max` 的 Codex agent，在 `task.md` 范围内尽可能多地找出交付物的真实问题，围绕已有测试项派生新的相似场景测试项，给出结论、测试项通过数和只讲问题、不讲用例的反馈。提交次数用完，任务结束。

角色在安装时确定（`--role worker|validator`），同时固定 agent、技能目录和指令文件，更新时不能更换。

## 二、两台机器之间只有一条通道

```
worker 机器                                   validator 机器
┌───────────────────────┐                     ┌──────────────────────────────────┐
│ Paseo                 │                     │ Paseo                            │
│  └ worker agent       │  MCP: submit/query  │  ├ aris-validation 服务脚本       │
│     task.md           │ ──────────────────▶ │  │   .aris/validation/            │
│     research-wiki/    │  curl.exe -T x.zip  │  └ 每次提交一个 validator agent  │
│     .mcp.json         │ ──────────────────▶ │      .aris/tester-config.json     │
└───────────────────────┘                     └──────────────────────────────────┘
```

两边不共享磁盘、不共享仓库、不互发消息。worker 能拿到的只有 `query` 返回的内容：服务状态、剩余次数，以及某次提交的状态、结论、测试项总数与通过数和反馈。这样防作弊就不靠规则约束 agent，而是靠物理隔离：worker 根本读不到 benchmark。

验证机器不断网，因为有些任务的验证本身要联网（下载依赖、调用外部服务）。防作弊靠的是 validator agent 检查交付内容，而不是切断网络。

## 三、一次提交怎么走

1. worker 调 `submit`，拿到一次性上传地址，用 `curl.exe --fail-with-body -T` 把 zip 直接传到验证机器。
2. 服务端算 sha256，安全解压（拒绝 `../` 路径，限制总大小和文件数），检查根目录有没有 `USAGE.md`。格式不对就拒收，**不计次数**——格式错误不该消耗 worker 的机会。
3. 服务通过本机 `paseo run` 为这次提交新建一个 validator agent。它出现在验证机器的 Paseo 前端里，提示词只给提交编号和目录。
4. validator agent 按 `validation-review` 技能逐步执行：先读验证端 wiki 里仍未解决的问题，读代码找作弊迹象，再照 `USAGE.md` 写调用适配器，把 benchmark 现有的每一层都跑一遍（回归）。然后分析失败和勉强通过的测试项，必要时调研外部测试方法，围绕已有测试项派生相似场景的新测试项，登记成新的一层并在这次提交上跑完。最后写出结论（`valid` / `cheating` / `unusable`）和反馈。
5. 反馈先交给另一个独立的泄漏审查 agent 交叉检查，通过后 `finalize` 才发布结果，worker 的 `query` 才能看到。validator agent 再用已发布的结论、测试项计数和通过审查的反馈，把这次提交解决了哪些问题、哪些仍存在记入 wiki。

### validator 和 worker 是对抗的

validator 的目标不是给出一个分数，而是在 `task.md` 的范围内尽可能多地找出交付物的真实问题，并确认 worker 声称修好的问题是真的修好了，而不是只针对暴露它的那几个测试项打了补丁。为此它可以使用或自己编写任何工具：现成的评测框架、fuzz 和扰动工具、从网上调研来的测试方法、自己写的生成器和检查器。

但它不能凭空编造测试项。每个新测试项都必须从 benchmark 里已有的测试项派生，写明来源（`derived_from`）、改动了什么场景（`variation`）、参考答案怎么核实（`reference_check`）。外部方法只能用来生成这样的派生项，不能引入 benchmark 里本来没有的题型。`extend` 登记时 helper 会检查每个来源都是这次评审已经跑过的测试项，单次评审新增的数量也有上限。

### 测试结果为什么不由 agent 来报

agent 的结论只决定"算不算数"，每个测试项通过与否由 helper 从各层 runner 的逐样本输出里，按 setup 时冻结的通过规则（某个逐样本指标和阈值的比较）算出来：每层的样本必须正好覆盖该层登记的测试项，交付物答错或崩溃的测试项算失败。发布的只有测试项总数、通过数和失败数，不发布分数，也不比较不同提交的结果——benchmark 一直在长，数字本身没有意义，有意义的是还剩哪些问题。

结论是 `cheating` 时所有测试结果作废。

### 反馈为什么要交叉检查

反馈必须写出实际问题：交付物错在哪里、违反了 `task.md` 的哪项要求、大致多常见、多严重，以及上次的问题哪些解决了、哪些还在。但它不能透露测试用例：输入、参考答案、样本或测试项 id、单项结果、各层题量和构造方式、隐藏路径都不能写。

这种判断脚本做不了，所以由 `leak-review` 另起一个没有写作上下文的 agent，拿着反馈快照和全部隐藏测试逐条比对，结论写进 `result.json`。审查绑定反馈文本的摘要，改过反馈就必须重审；`finalize` 只认对当前反馈判为通过的审查。判为泄漏就退回重写，重写次数用完就只发布计数，不发反馈。宁可少给信息，也不能把测试集漏给 worker。

## 四、只增不改与停止

- **benchmark 只增不改。** setup 时由用户确认 base 层 benchmark 的来源、数据版本、切分、完整样本数和逐样本通过规则，算出摘要写进 `.aris/validation/config.json`，依赖的文件记下哈希。之后新增的层放在只由 helper 提交的 git 仓库 `.aris/validation/benchmark/` 里：空的根提交之后，每次 `extend` 是一个只新增文件的提交（`layers/<id>/` 加 `registry/<id>.json`），每次 `retire` 也只新增一个 `registry/<id>.retired.json`。helper 每次检查都逐个提交核对“只增不改”，并核对 head 和它自己记在 `.aris/validation/benchmark-head` 的一致、已登记文件没有被改；任何一条不满足，服务就停止。所以“增量”这个动作本身是机械可查的。每次运行都从提交里把该层取到这次运行自己的目录，runner 在副本里随便写都不影响已登记的层。错了的层只能 `retire`（注明原因，不再计数），不能修改；要改 base 层或通过规则只能开一个新的 validator 项目。
- **次数有上限。** 计次的只有真正走完审查的提交（已测试、作弊、无法运行）；上传超时、格式错误、本方故障都不计。
- **唯一的停止条件是次数用完。** 计次提交用完、在审的也都结束后，服务进入 `closed`，不再接收新提交，worker 看到后就停。通过全部现有测试项不会结束任务，因为 validator 还会继续加测试项。

## 五、谁写哪个文件

每个事实只有一个写入方，其他人只读：

| 文件 | 唯一写入方 |
| --- | --- |
| `.aris/setup-*.json`、`.aris/tester-config.json`、`.aris/environment.json`（环境脚本读取的密钥，唯一的环境配置文件）、`.mcp.json` 和 `paseo.json` 里的 ARIS 条目 | `setup-cli.js` |
| `.aris/validation/` 下的提交记录、发布结果、新增层的 git 仓库 `benchmark/` 及其 head 记录 `benchmark-head` | `validation-cli.js`（服务、`extend`、`retire`、`leak-review`、`finalize`） |
| 提交目录里的 `inspection.md`、`review.json`、`feedback.md`、适配器、新层草稿 | validator agent |
| 提交目录里的 `leak-review/<n>/result.json` | 该次泄漏审查 agent |
| `research-wiki/`（两端各自一份） | `research-wiki.js` |
| 本地 ARL 源码仓库的 `Experience.md`（`main` 为已审核经验，新经验提交到 `experience` 分支） | worker agent 提交到 `experience`，用户经 PR 审核合并到 `main`（仅依据自身过程和已发布结果，精简、去重并保留跨项目经验） |
| 技能目录中的 `<project>-environment/` | 本机角色的 agent，按 `aris-setup` 的环境步骤写入并验证；之后发现新的环境事实或重复流程时同样补充 |

`CLAUDE.md`（worker）或 `AGENTS.md`（validation）里 `ARIS ROLE` 标记之间的角色段由 setup 写入，标记外的内容 setup 不碰。

角色段把记忆分成两层，并要求带编号的流程逐步执行、每次提交前先 commit：

- **长期记忆必须使用。** `research-wiki/` 用 survey（对论文、仓库、文档、博客等已有工作的调研）、idea、experiment、claim、problem 五类节点和证据边，记录针对一个或多个问题已有工作做了什么、迭代和验证做了什么、哪些有效或无效；query pack 不超过 1000 字符并带节点引用，每轮开始先读。验证端的 wiki 记录各次提交暴露的问题、哪些已解决、哪些仍存在，以及调研过的测试方法，同样不得包含测试输入、参考答案、样本或测试项 id 或其摘抄；哪些层针对哪些问题由 benchmark 仓库的 `registry/` 记录，不在 wiki 里重复。环境技能只放 agent 无从得知的环境事实和验证过的固定脚本，每个实验独立命名，worker 可在一轮迭代中并行运行多个实验。
- **短期任务进 todo 列表。** 当前迭代的步骤和反馈里的每个问题，完成后才标记。

worker 每次获得 validation 已发布的最终结论后，按[经验保存约定](skills/shared-references/experience.md)整理 `Experience.md`；validator agent 不参与经验写入，也不增加两机之间的通道。本地源码 checkout 的位置记录在 worker 项目指令的角色段外，源码仓库的 `CLAUDE.md` 指向经验文件。

## 六、Paseo 里能看到什么

- 两台机器各自的 agent：worker agent，以及每次提交对应的一个 validator agent。
- 验证机器工作区的 `aris-validation` 服务脚本，包括端口、运行状态和代理地址。
官方 App 没有定制版 ARIS 知识图谱标签页。通过 `research-wiki` 技能、CLI 或本机 Markdown 查看记录。本仓库只提供研究技能和服务，不包含 Paseo 前端代码。

## 七、保留了什么、删掉了什么

判断标准只有一条：Claude Code agent 自己能做的，ARIS 就不再提供流程。

- **独立包包含**：setup、validation-review、research-wiki、browser-act 四个技能及其 helper 依赖闭包。setup 的环境输出是项目环境技能；安装和升级使用同一安装器。部署和技能重载见 [SETUP_GUIDE_CN.md](SETUP_GUIDE_CN.md)。GPU 平台、文献检索、飞书和 Overleaf 等技能留在源码中，不进入安装包。
- **删除**：研究循环、各类审计和评审技能、子 agent 派发协议、worker manifest、Pipeline/Review 等前端视图，以及环境 PRD、环境配置技能和实验队列。规划、派发、自查和实验调度都是 agent 自己的工作。

## 八、加新功能前先问

1. agent 自己能不能做？能做就不要加技能或 helper。
2. 它会不会让 worker 看到 benchmark、隐藏数据或验证方的中间产物？会的话就不能做。
3. 它是不是在给 worker 自己的结果下结论？结论只能来自验证方。
4. 它新增的状态有没有唯一的写入方？如果某个已有文件因此变得多余，要在同一次改动里删掉。
5. 它在 Windows 上能不能跑？helper 用 Node 写，不调用 shell 脚本；命令用 argv 数组，不拼字符串。
