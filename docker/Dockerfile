# ARL 运行时镜像：一份 Dockerfile，一个角色一个 target。在仓库根目录执行（根目录也是构建上下文）：
#
#   docker build -f docker/Dockerfile --target worker    -t arl-paseo:worker    .
#   docker build -f docker/Dockerfile --target validator -t arl-paseo:validator .
#
# 两个 target 都基于官方 Paseo 镜像，只补角色需要的东西：ARL checkout、该角色固定的 agent CLI、以及把 `.aris/` 和角色技能装进项目目录的入口脚本。

# cc-switch：worker 的协议转换器。Claude Code 只会发 Anthropic Messages；
# 用户选 OpenAI / OpenAI-compatible 供应商时，由容器内的 cc-switch 转成
# OpenAI Chat Completions 再发往上游。版本与校验和同 backend 的 Dockerfile.task。
ARG DOCKERHUB_REGISTRY=""
FROM ${DOCKERHUB_REGISTRY}curlimages/curl:8.16.0 AS cc-switch-runtime

USER root
ARG TARGETARCH=amd64
ARG CC_SWITCH_VERSION=5.10.1
ARG CC_SWITCH_RELEASE_BASE=https://github.com/SaladDay/cc-switch-cli/releases/download
RUN case "${TARGETARCH}" in \
      amd64) CC_SWITCH_ARCH=x64; CC_SWITCH_SHA256=be6836eb42cf6747b3830b15d87902fc6a1331c35263aa7590ed0a37a4430790 ;; \
      arm64) CC_SWITCH_ARCH=arm64; CC_SWITCH_SHA256=10277f9e7aa76125ab4035e08ac15a52bc43d2c485f677b5ffec2055436d59e5 ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && CC_SWITCH_ARCHIVE="cc-switch-cli-v${CC_SWITCH_VERSION}-linux-${CC_SWITCH_ARCH}-musl.tar.gz" \
    && curl -fL --retry 3 \
      "${CC_SWITCH_RELEASE_BASE}/v${CC_SWITCH_VERSION}/${CC_SWITCH_ARCHIVE}" \
      -o /tmp/cc-switch.tar.gz \
    && echo "${CC_SWITCH_SHA256}  /tmp/cc-switch.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/cc-switch.tar.gz -C /tmp \
    && install -m 0755 /tmp/cc-switch /usr/local/bin/cc-switch

FROM ghcr.io/getpaseo/paseo:0.11.2 AS base

# 基座自带 Node 22.23.3，满足 ARL 的 22.12 下限；ripgrep 供 agent 搜索文件。
# 基座已有：tar, gzip, curl, grep, sed, awk, ps。补充 agent 常用的其他工具。
USER root
# 国内构建可加 --build-arg APT_MIRROR=mirrors.aliyun.com 替换 Debian 软件源
ARG APT_MIRROR=""

RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s@deb.debian.org@${APT_MIRROR}@g" /etc/apt/sources.list.d/debian.sources && \
      sed -i "s@security.debian.org@${APT_MIRROR}@g" /etc/apt/sources.list.d/debian.sources; \
    fi

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     # 搜索和文本处理
     ripgrep \
     jq \
     # 压缩工具（基座已有 tar, gzip）
     zip \
     unzip \
     bzip2 \
     xz-utils \
     # 网络工具（基座已有 curl）
     wget \
     ca-certificates \
     # 编辑器和查看工具
     vim \
     nano \
     less \
     # 构建工具（某些 npm 原生模块需要）
     build-essential \
     python3.11 \
     python3.11-venv \
     python3.11-distutils \
     python3-pip \
     # 文件同步
     rsync \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
  && ln -sf /usr/bin/python3.11 /usr/bin/python \
  && rm -f /usr/lib/python3.*/EXTERNALLY-MANAGED \
  && python3.11 -m pip install --no-cache-dir --upgrade pip setuptools wheel


WORKDIR /opt/arl
COPY . .

# `prepare` 钩子是 `lefthook install`，要往 `.git/hooks/` 写文件，所以先建个临时仓库让它跑通；装完就删，运行期那份仓库由 entrypoint 自己建。
RUN git init -q -b main \
  && npm ci --no-audit --no-fund \
  && npm run build \
  && rm -rf .git

COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/arl-role-entrypoint
COPY --chmod=0755 docker/protocol-adapter.sh /usr/local/bin/arl-protocol-adapter

ENV ARL_CHECKOUT=/opt/arl
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/arl-role-entrypoint"]

# worker：Claude Code（thinking `ultracode`），技能在 .claude/skills/，指令在 CLAUDE.md。
FROM base AS worker
ENV ARL_ROLE=worker \
    ARL_PROJECT_DIR=/workspace/worker
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code \
  && claude --version \
  && chown -R 1000:1000 /opt/arl /workspace
COPY --from=cc-switch-runtime /usr/local/bin/cc-switch /usr/local/bin/cc-switch
COPY docker/CC-SWITCH-LICENSE /usr/share/licenses/cc-switch/LICENSE
RUN cc-switch --version

# validator：Codex（thinking `max`），技能在 .agents/skills/，指令在 AGENTS.md。
# 你的 benchmark 依赖装在这里，例如 `RUN pip3 install -r requirements.txt`。
FROM base AS validator
ENV ARL_ROLE=validator \
    ARL_PROJECT_DIR=/workspace/validator
RUN npm install -g --no-audit --no-fund @openai/codex \
  && codex --version \
  && chown -R 1000:1000 /opt/arl /workspace
