# ptoy · 实时语音通话 MVP

浏览器语音通话：通话开关 + 声波球体 + 字幕。级联架构（半双工、可打断），模型全部跑在本地 Windows GPU 主机。

架构详情（组件、选型、配置、实测数据、延迟预算）只记录在 `docs/architecture/server.md`，改架构先改那里。

## 目录
- `apps/web`：前端（React）
- `apps/agent`：Voice Agent（LiveKit Agents, Node/TS）
- `services/fillers/`：预录语气词生成工具
- `bench/`：GPU 链路压测
- `docs/architecture/`：架构详情
- `docs/roadmap/`：功能路线图（当前：`mvp-v1.md`）
- `docs/decisions/`：ADR，命名 `NNNN-<决策名>.md`（4 位编号 + kebab-case 英文决策名）

## 开发流程
- Mac 开发；开发期 Agent 在 Mac 运行，经局域网调用 Windows 服务；上线部署到 Windows。两台机器经 GitHub 同步。
- 每个需求：`to-spec` → `to-tickets`（端到端可验证的切片）→ 实现（纯逻辑用 `tdd`）→ 压测或真实通话验证
- 里程碑与验收标准见 `docs/roadmap/mvp-v1.md`
- 包管理：pnpm workspace

## 规则
- 新增或替换 GPU 上的模型前，先用 `bench/bench_gpu.py` 在 Windows 本机重新压测（显存只剩约 2.5GB 余量）
- 压测以 Windows 本机数据为准，Mac 经 Wi-Fi 的数据不作数
- 提交说明和 PR 描述不加任何 AI 署名（不加 `Co-Authored-By: Claude ...`，也不加 "Generated with Claude Code"）；派生的子 Agent 同样适用
- 所有提交（包括合并提交）都用本机 git 身份（`user.name` / `user.email`）。合并 PR 在本地 `git merge --no-ff` 后推送，不用 `gh pr merge` 或网页按钮（那样作者会变成 GitHub 账号的显示名）

## Agent skills

### Issue tracker

Issue 存放在 GitHub Issues（`gh` CLI）。见 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认 5 个标签（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：根目录一个 `CONTEXT.md` + `docs/decisions/`（本仓库的 ADR 目录，不用 `docs/adr/`）。见 `docs/agents/domain.md`。
