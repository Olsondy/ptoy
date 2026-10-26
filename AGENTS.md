# ptoy · 实时语音通话 MVP

浏览器语音通话：通话开关 + 声波球体 + 字幕。级联架构（半双工、可打断），模型全部跑在本地 Windows GPU 主机。

架构详情（组件、选型、配置、实测数据、延迟预算）只记录在 `docs/architecture/server.md`，改架构先改那里。

## 目录
- `apps/web`：前端（React）
- `apps/agent`：Voice Agent（LiveKit Agents, Node/TS）
- `services/fillers/`：预录语气词生成工具
- `services/ambience/`：背景音素材转换工具（素材不进仓库）
- `services/tts/`：IndexTTS FastAPI 服务（Windows GPU 主机上运行，替代 WebUI）
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
- `README.md` 只做项目简介（是什么、目录导航、如何启动）。禁止在做功能或改文档时顺手往 README 里追加功能说明、配置细节、部署记录、实测数据等内容；这些写进对应的独立文档（`docs/architecture/`、`docs/roadmap/`、`docs/decisions/`、各服务目录下的文档等），README 至多加一行链接。只有项目定位、目录结构或启动方式本身变了，才改 README 正文
- 这个`D:\Resources\MyWorkspace\ai\ptoy\apps\agent\prompts\characters`目录中除了`_rules.md`文件以外,其他文件都不需要你读取内容.务必遵守这个规则

## 前端 UI 组件约定

- 通用交互组件统一使用 **shadcn/ui**，当前基于 Radix + Tailwind CSS v4；配置以 `apps/web/components.json` 为准。不要随意引入其他组件库、混用另一套基础组件或为相同交互另写一套组件。
- 添加组件：在 `apps/web` 中执行 `pnpm exec shadcn add <component>`，使用官方 registry，按需添加。新增第三方组件或动效库必须有明确需求，优先组合已有 shadcn 组件，不为视觉效果增加依赖。
- 基础组件源码放在 `apps/web/src/components/ui/`，工具函数放在 `src/lib/`，通过 `@/components/ui/…` 引用；业务组合（通话控制、角色选择、字幕）留在业务组件中。更新 registry 代码前检查本地定制，不直接覆盖。
- 按钮使用 `Button`，字幕开关使用 `Toggle`，角色选择使用 `DropdownMenu` 的单选项，图标提示使用 `Tooltip`。图标统一使用已安装的 `lucide-react`，不再添加图标库。
- 颜色、圆角、字体等统一维护在 `src/styles.css` 的语义变量中，布局可组合 Tailwind 与业务 CSS。保留组件的键盘操作、焦点恢复、无障碍名称和状态；图标按钮提供中文名称，触摸热区至少 44px，尊重 reduced-motion。
- 现有 Canvas 球体和 LiveKit 音频逻辑属于业务能力，保持独立。过渡动画优先 CSS；未经明确需求，不引入 Motion、GSAP 或另一套通话 UI。
- 通话 UI 验收覆盖：连接/挂断、实时字幕及其开关、隐藏字幕时的错误提示、角色菜单键盘操作，以及手机窄屏布局。

## Agent skills

### Issue tracker

Issue 存放在 GitHub Issues（`gh` CLI）。见 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认 5 个标签（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：根目录一个 `CONTEXT.md` + `docs/decisions/`（本仓库的 ADR 目录，不用 `docs/adr/`）。见 `docs/agents/domain.md`。
