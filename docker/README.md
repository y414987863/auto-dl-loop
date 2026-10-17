# 用 Docker 跑 worker 和 validator

`docker/Dockerfile` 一份镜像定义产出两个 target，仓库根目录的 `compose.yml` 起两个独立的 Paseo 服务：

| 服务 | 镜像 | 角色 | Agent | 宿主端口 |
| --- | --- | --- | --- | --- |
| `paseo-worker` | `arl-paseo:worker` | worker | Claude Code（thinking `ultracode`） | 6767 |
| `paseo-validator` | `arl-paseo:validator` | validator | Codex（thinking `max`） | 6768 |

两个服务各自拥有 `/home/paseo`（Paseo 状态 + agent 凭据）和 `/workspace`，**不要共享或同步**这两个目录：worker 环境里不能出现 validator 的冻结 benchmark。两者只通过 validation 服务的 `submit` / `query` MCP 工具交互。

## 启动

```bash
cp .env.docker.example .env         # 至少改掉 PASEO_PASSWORD
docker compose build
docker compose up -d
```

浏览器打开 `http://localhost:6767`（worker）和 `http://localhost:6768`（validator），密码用 `.env` 里的值。桌面端或 `paseo` CLI 连 `127.0.0.1:6767` / `127.0.0.1:6768`。

然后登录一次 agent（凭据落在 `/home/paseo` 卷里，重启不丢）：

```bash
docker compose exec --user paseo paseo-worker claude
docker compose exec --user paseo paseo-validator codex login
```

按官方流程，**先配置 validator 端**：在 validator 的 Codex（`max`）里调用 `$aris-setup` 审阅配置表，起 `aris-validation` 服务，再用私密渠道把它输出的 URL/token 和同一份 `task.md` 交给 worker；在 worker 的 Claude Code（`ultracode`）里调用 `/aris-setup` 填连接。

## 镜像里做了什么

以官方 `ghcr.io/getpaseo/paseo:latest` 为基座（Debian bookworm、Node 22.23.3、`tini` → `paseo-docker-entrypoint`、uid/gid 1000 的 `paseo` 用户、`CLAUDE_CONFIG_DIR` 与 `CODEX_HOME` 已在 `/home/paseo` 下），再分层：

- `arl-builder`：在镜像内执行 `npm ci && npm run build`，因为 `distribution/install-from-repo.mjs` 要求 checkout 已备好依赖和编译产物，且安装过程不下载任何东西。
- `arl-runtime`：把准备好的整份 checkout 放到 `/opt/arl`，然后注入角色入口脚本。
- `worker` / `validator`：`npm install -g` 装上本角色固定的 agent CLI（`@anthropic-ai/claude-code` / `@openai/codex`）。两个 target 都额外装了 `ripgrep`，供 agent 的文件搜索使用。
- 两个镜像都保持 `USER root`：官方 entrypoint 需要 root 来 chown 挂载卷，然后再降权到 `paseo`。

容器启动时 `docker/entrypoint.sh` 会：

1. 建好 `${ARL_PROJECT_DIR}`（默认 `/workspace/worker`、`/workspace/validator`）；
2. 若该项目还没有 `.aris/install.json`，以 `paseo` 身份运行 `distribution/install-aris.sh --role <角色> --project <项目>`，把 `.aris/` 运行库和角色技能装进项目，并 `git init` 一个本地仓库（worker 每次提交前要 commit）；
3. 把 `/opt/arl` 的所有者改成 `paseo` 并给它一个初始 commit —— worker 的经验笔记要写到这份 checkout 的 `experience` 分支上；
4. `exec` 官方 entrypoint，正常启动 daemon。

装完后再重启容器不会重复安装（`.aris/install.json` 已登记角色）。想强制重装：

```bash
ARL_FORCE_INSTALL=1 docker compose up -d paseo-worker
```

也可以进容器手工修：

```bash
docker compose exec --user root paseo-worker \
  bash /opt/arl/distribution/install-aris.sh --role worker --project /workspace/worker
```

## 需要按任务补的东西

- **benchmark 依赖**：validator 端要装你自己 benchmark 的依赖（示例模板用 lm-evaluation-harness，见 `.aris/templates/tester-benchmark/`）。在 `docker/Dockerfile` 的 `validator` target 里加 `RUN pip3 install ...` 或 `COPY requirements.txt` 即可。同理，worker 端实验需要的 GPU 驱动、conda、SSH/rsync 等不在 ARL 包内，按需在外层镜像或环境技能脚本里装。
- **网络**：跨机器部署时，验端 `service.host=0.0.0.0`、固定端口（如 8790）、`service.public_url=http://<验证端地址>:8790`，并把端口映射出来；本机 Compose 两个容器在同一 bridge 网络里，可以用服务名互访。
- **反向代理/TLS**：`PASEO_PASSWORD` 只做认证，不加密。公网暴露时前置 TLS，并设置 `PASEO_TRUSTED_PROXIES`；用域名访问要设置 `PASEO_HOSTNAMES`。
- **卷权限**：bind mount 目录属主需为 uid/gid 1000（官方 entrypoint 会尝试 chown，失败时在宿主上执行 `sudo chown -R 1000:1000 docker/worker docker/validator`）。

## 已验证

在本机 Docker Desktop（Linux 容器，29.1.3）上实际跑通过：

- `docker compose build` 两个 target 均构建成功（`arl-paseo:worker`、`arl-paseo:validator`）。
- `docker compose up -d` 后两个容器均为 `healthy`，`/api/health` 都返回 200，web UI 在 6767/6768 上可访问。
- 角色安装确实生效：worker 项目里是 `"role": "worker", "provider": "claude"`、技能落在 `.claude/skills/`（含 `aris-setup`、`validation-review`、`research-wiki`、`browser-act`、`shared-references`）；validator 项目里是 `"role": "validator", "provider": "codex"`、技能落在 `.agents/skills/`；两边 CLI 都在 PATH（`claude 2.1.296`、`codex-cli 0.162.1`）。
- 项目和 `/opt/arl` 的初始仓库都在 `main` 分支上，且已有初始 commit（worker 提交前要 commit，经验笔记要基于 `main` 建 `experience` 分支）。
- `npm run typecheck` 与 `npm run lint` 通过。

**未验证**：agent 尚未登录（`claude` / `codex login` 没跑），因此 `setup` 之后真正的 submit/query 闭环没有端到端跑过；validator 端仍未安装你的 benchmark 依赖。

## 踩过的坑（已在文件里修掉，供排错参考）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `set: pipefail: invalid option name`，安装直接失败 | checkout 在 Windows 上被 CRLF 检出，内核把 shebang 读成 `bash\r`，找不到该解释器就回退到 `/bin/sh`（dash） | `.gitattributes` 用 `* text=auto eol=lf` 让所有平台一律检出 LF，脚本类文件另加显式声明。存量克隆执行一次 `git add --renormalize .` 后重新检出 |
| `npm ci` 报 `lefthook install` 失败 | `prepare` 生命周期钩子（`lefthook install`）要往 `.git/hooks/` 写文件，而构建上下文里没有 `.git` | 构建时先 `git init -q -b main` 让它跑通，`npm ci && npm run build` 之后立刻 `rm -rf .git`，运行期那份仓库仍由 entrypoint 自己建 |
| `COPY --from=arl-builder /src/tests: not found` | `COPY --from=<stage>` 只认该 stage 里真实存在的路径，不会回落到构建上下文 | builder 里一次列全 `skills/`、`templates/`、`tests/`、`distribution/` 和根目录文档 |
| 启动日志 `fatal: detected dubious ownership in repository at '/opt/arl'` | 以 root 在属于 `paseo` 的仓库上跑 git | 先 `chown -R paseo:paseo`，再用 `gosu paseo git`，并给两个用户都加 `safe.directory` |

参考：[Paseo Docker 文档](https://paseo.sh/docs/docker)、[ARL 中文部署指南](../SETUP_GUIDE_CN.md)、[安装与打包说明](../docs/arl-install.md)。
