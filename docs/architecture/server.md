# 服务端架构 v1.0

> 版本：1.0 · 日期：2026-10-23 · 状态：已定稿，进入 M0 开发

## 1. 目标与定位

做一个类似 GPT 语音模式的浏览器通话 MVP：页面只有通话开关、声波球体和字幕，所有模型都跑在本地 Windows GPU 主机上。

**定位：级联式半双工，支持打断。** 它不是真正的全双工：真全双工指模型本身能边听边说（如 Moshi、GPT-4o 原生语音）。本架构由 ASR → LLM → TTS 三段串联而成，打断不会自然发生，必须让链路上每一段都能被取消。

## 2. 对初版架构图的修正

初版设计是“Vue 3 → WebRTC → TS Voice Agent（VAD、ASR、LLM、Segmenter）→ WebSocket → TTS → 播放”。数据流方向是对的，下面这些问题已在 v1.0 中修正：

| # | 初版的问题 | v1.0 的处理 |
|---|---|---|
| 1 | 叫“全双工”，实际是级联架构 | 改称半双工 + 可打断 |
| 2 | 只画了数据流，没有打断控制链路 | 打断后要依次：停止播放 → 中止 LLM → 中止 TTS → 按实际播放位置截断对话历史。这部分由 LiveKit Agents 内置 |
| 3 | 没有考虑回声消除 | 走 WebRTC，浏览器的 AEC 以远端音轨为参考生效 |
| 4 | ASR 没有部署位置（TS 生态里没有可用的中文流式 ASR） | 单独部署 SenseVoice 服务 |
| 5 | LLM 被画在 Agent 进程内部 | Agent 只负责编排；LLM 作为独立的 llama-server 服务 |
| 6 | TTS 输出到播放这条回程没有闭环 | TTS → Agent → WebRTC → 浏览器 |
| 7 | VAD 和 ASR 被画成并列关系 | VAD 决定什么时候送音频给 ASR、什么时候触发打断；轮次结束事件加上 ASR 最终文本才进入 LLM |
| 8 | BGM 分轨 | 不在 MVP 范围内（还会增加回声和误打断） |
| 9 | 没考虑三个模型抢同一块 GPU | 已实测，见第 6 节 |
| 10 | 没考虑浏览器麦克风需要 HTTPS | 非 localhost 访问需要配置 HTTPS |

## 3. 总体架构

```
┌─ 浏览器 · apps/web (React) ─────────────────────────────┐
│ @livekit/components-react：通话开关 · 字幕 · 球体         │
│ 球体音量：听的时候取麦克风电平，说的时候取 Agent 音轨电平     │
└────────────────────────┬───────────────────────────────┘
                         │ WebRTC（音频 + 数据通道）
┌─ LiveKit Server（Windows :7880）─────────────────────────┐
└────────────────────────┬───────────────────────────────┘
┌─ Voice Agent · apps/agent（LiveKit Agents, Node/TS）─────┐
│ 状态：IDLE → LISTENING → THINKING → SPEAKING ─打断→ LISTENING │
│ Silero VAD → 轮次检测 → STT 插件 → LLM(OpenAI 插件) →       │
│ Segmenter（解析情绪标签、切首段）→ TTS 插件 → 音轨            │
│ 内置：打断、AEC、按实际播放位置截断历史、字幕同步             │
│ 附带：token 签发接口、预录语气词                            │
└────────────────────────┬───────────────────────────────┘
                         │ HTTP（局域网 / localhost）
┌─ Windows GPU 主机（16GB）────────────────────────────────┐
│ ASR：SenseVoice-Small :8001（CPU） 输出文本 + 情绪/事件标签 │
│ LLM：llama-server :8080 · Qwen3-8B Q5_K_M · 思考模式关闭    │
│ TTS：IndexTTS2 · 阶段 1 Gradio :7860 / 阶段 2 FastAPI :8002 │
└─────────────────────────────────────────────────────────┘
```

**部署**：开发阶段 Agent 跑在 Mac 上，经局域网调用 Windows 上的服务；上线后 Agent 部署到 Windows，与模型走 localhost，只有浏览器 ↔ LiveKit 这一段经过局域网。

## 4. 关键选型

决策理由详见 `docs/decisions/0001`–`0006`。情绪标签链路的流程图与约定见 `docs/architecture/emotion-pipeline.md`。

| 决策 | 选择 | 理由 |
|---|---|---|
| 传输层 | LiveKit（WebRTC） | 内置打断、AEC、播放位置追踪、字幕同步，不用自己在 Node 里搭 WebRTC |
| 前端 | React + Vite，shadcn/ui（Radix）+ Tailwind CSS v4 | LiveKit hooks 管音轨与字幕；shadcn/ui 管通用控件，组件源码放在 `apps/web/src/components/ui/` |
| ASR | SenseVoice-Small，跑在 CPU 上 | 模型小、非自回归，VAD 切出整句后识别只要几十到一百多毫秒；附带情绪标签；把 GPU 留给 LLM 和 TTS |
| 不用 Gemini Flash 当 ASR | — | 非流式、多一次云端往返（0.5–1.5s+）、可能直接回答而不是转写、境外网络不稳 |
| 不换 Qwen2.5-Omni | — | 能听出语气，但识别粗；发声模块音色固定，没法控制情绪；文本能力比 Qwen3-8B 弱。换来的只有“直接听音频”这一点，不划算 |
| 语气感知 | 情绪标签链路 | SenseVoice 情绪标签写进 prompt → Qwen3-8B 给每句话加情绪标签 → Segmenter 解析 → IndexTTS2 按情绪合成 |
| TTS | IndexTTS2 | 音色克隆加情绪控制。整句合成，不支持流式，首句延迟靠短首段和语气词掩盖 |

### 通话页面 UI

- 深灰中性色、低干扰边界与轻量 CSS 过渡，参考 Agent Wave；保留现有 Canvas 球体及听／想／说状态和音量驱动，不引入额外图形或动效库。
- 角色选择位于右上角，以 shadcn `DropdownMenu` 单选项呈现；拨号后锁定。
- 主页可选择角色并复制固定角色链接 `/?character=<opaque-token>`；链接页面只显示固定角色，不提供切换入口，且不覆盖主页保存的选择。加载或校验失败时禁止拨号，禁止回退默认角色。
- `POST /api/character-link { character }` 生成 AES-256-GCM 加密、Base64URL 编码的角色令牌；`GET /api/characters?characterLink=...` 只返回该角色；`POST /api/token { characterLink }` 在服务端重新校验并写入 `ptoy.character`，不允许同时传明文角色。令牌使用随机 nonce 和版本标识，不设到期时间；角色删除或密钥更换后失效。密钥由 `CHARACTER_LINK_SECRET` 派生，未设置时使用 `LIVEKIT_API_SECRET`，只保留在服务端。主页仍公开可选角色，固定链接不构成角色访问权限控制。
- 本需求按三个可验收切片实现：① 加密链接生成、解析及通话绑定，测试篡改/未知角色/冲突参数；② 主页复制及固定页状态，测试刷新、已保存选择、无效链接与手机布局；③ 回归连接/挂断、字幕开关和键盘选择。
- 底部控制栏为开始／挂断按钮；字幕开关和背景音开关在右上角角色按钮旁。
- 背景音开关默认开启，不记住选择；关闭时只在本浏览器暂停 Agent 的 `background_audio` 音轨（`setEnabled(false)`），Agent 照常播放，重新打开就接上当前档位。
- 字幕默认关闭，打开后显示最近的双方发言，长字幕显示末尾正在说的内容；关闭字幕不停止接收，重新打开时显示最新发言。服务错误独立显示，不因关闭字幕而隐藏。
- UI 组件使用规范以根目录 `AGENTS.md` 为准。

## 5. llama-server 配置

```bat
llama-server -m "D:\Resources\MyWorkspace\ai\models\Huihui-Qwen3-8B-abliterated-v2.Q5_K_M\Huihui-Qwen3-8B-abliterated-v2.Q5_K_M.gguf" --alias qwen3-8b --host 0.0.0.0 --port 8080 ^
  -ngl 99 --fit off -c 8192 -np 1 -fa on --cache-type-k q8_0 --cache-type-v q8_0 ^
  -b 512 -ub 512 -t 8 --cache-ram 512 --jinja ^
  --chat-template-file "D:\Development\llama.cpp\templates\huihui-qwen3-8b-v2.jinja" ^
  --reasoning off --reasoning-budget 0 --reasoning-format deepseek
```

- 用单模型模式（`-m`），不用路由模式：不会按需加载或空闲卸载，请求里也不用带 `model` 字段
- 固定 `-ngl 99`，不用自动适配：避免和 IndexTTS 争显存时，部分层被悄悄放到 CPU 上
- 日志里要能看到 `offloaded 37/37 layers to GPU`
- NVIDIA 控制面板里，CUDA 系统内存回退策略设为“首选无系统内存回退”：显存不足时直接报错，而不是悄悄变慢
- 启动顺序：先启动 IndexTTS，再启动 llama-server
- 前缀缓存：system prompt 固定、对话历史只追加不改，可以让每轮的首 token 延迟保持在几十毫秒
- 本机曾在只设置 `--reasoning off --reasoning-budget 0`、使用 GGUF 内置模板时仍输出思考内容；当前同时加载原模型模板并指定 reasoning 格式，已验证直接输出正式回答。
- 换线上模型：改 `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY`（OpenAI 兼容即可）。推理模型的 `reasoning_effort`：不设 `LLM_REASONING_EFFORT` 时，Agent 每个进程查一次 `/models`，用该模型列出的最低档（magpie 列出 `supported_reasoning_levels`；llama-server 没有则不传），设了就用设的值；magpie 的 DeepSeek 不传时会思考，最低档 `none` 首 token 约 0.4–0.8 秒；经本机 magpie 代理接 ChatGPT（`codex/*`）时思考关不掉，最低 `low`，2026-10-24 Mac 实测首 token 约 1–1.5 秒（`none`/`minimal` 不报错但不更快）

### 本机部署基线

安装和操作入口见 [部署总览](../deployment-overview.md)，下载清单集中在 [installation](../installation/README.md)。以下为本机部署配置，不代表服务实时运行状态。

| 服务 | 程序目录 | 模型目录（相对于 `D:\Resources\MyWorkspace\ai\models`） | 运行方式 |
|---|---|---|---|
| Qwen3 8B | `D:\Development\llama.cpp` | `Huihui-Qwen3-8B-abliterated-v2.Q5_K_M` | 原生 CUDA llama-server，无 Conda |
| IndexTTS 2.5 | `D:\Development\IndexTTS`（模型代码）+ ptoy `services\tts`（API 服务 :8002） | `IndexTTS-2.5` | `D:\Resources\MyWorkspace\ai\conda\envs\indextts`，Python 3.11；入口 `Start-IndexTTS-API.ps1`，WebUI 入口 `Start-IndexTTS.ps1` 仅用于试听调参，二者不同时运行 |
| SenseVoiceSmall | `D:\Development\SenseVoice` | `SenseVoiceSmall` | `D:\Resources\MyWorkspace\ai\conda\envs\sensevoice`，Python 3.11 |

每个模型目录只有一个 `Start-*.ps1` 入口，转调程序目录的实际启动脚本；Python 服务脚本直接调用专用环境的 `python.exe` 并设置 PATH，无需手动 `conda activate`。

IndexTTS 使用官方 `index-tts/index-tts` 源码 `d9e41aac89fd00b3d71497fddb287b7f24613712`，本地 `webui.py` 有启动参数和默认值调整。当前配置为 `--version 2.5 --fp16 --no_qwen_emo --gui_seg_tokens 80`、`num_beams=1`；2.5 分支把 `--fp16` 映射为 BF16。未启用 DeepSpeed、定制 CUDA 内核或 torch.compile。参考音频为音色目录 `D:\Development\IndexTTS\prompts\voices\` 下的 `<id>.wav`（ADR 0008）。

SenseVoice 的本地 `server.py` 基于 FunASR 1.4.14 和 PyTorch 2.8.0+cu128，使用 FP32、串行请求和 20 秒固定窗口，无服务端 VAD。按 ADR-0003，应用部署显式传 `-Device cpu`；脚本未传参数时仍默认 GPU，GPU 入口仅作可选测试。此前三模型共用 GPU 的数据不能当作 Windows CPU ASR 的验收结果。

## 6. 实测数据（Windows 本机，`bench/bench_gpu.py`）

| 指标 | 单独运行 | LLM + TTS 并发 |
|---|---|---|
| LLM 首 token | 39ms（命中前缀缓存） | 45ms |
| LLM 生成速度 | 97.6 tok/s | 75.9 tok/s |
| TTS 短句（13 字，音频 2.9s） | 1929ms，RTF 0.66 | 2253ms，RTF 0.72 |
| TTS 中句（33 字，音频 6.7s） | 3713ms，RTF 0.53 | — |
| 显存峰值 | 13.8 / 16GB（余量 2.5GB） | 同左 |

**TTS 耗时模型（Gradio）：合成耗时 ≈ 770ms 固定开销 + 89ms × 字数。**
- RTF 小于 1，第一句播放期间后面的句子能合成完，后续播放不会断档
- 唯一的瓶颈是第一句的延迟，它取决于第一句的长度
- 从 Mac 经 Wi-Fi 调用时，每次都要上传 1.9MB 参考音频，固定开销膨胀到约 4s。所以压测要以 Windows 本机的数据为准

### TTS FastAPI 服务实测（#14）

`services/tts/bench.py`（合成耗时 vs 字数、取消、显存）和 `bench/bench_gpu.py --tts-fastapi-url`（与 LLM 并发）。

2026-10-23 首测：服务端 `X-Synth-Ms`（不含网络），v2.5 BF16、不加载 QwenEmotion、25 步扩散，llama-server 同时加载。单次请求、未跑 `bench.py`，作初步参考。

| 文本 | 参考音频情绪 | 情绪「喜」 | 音频时长 |
|---|---|---|---|
| 3 字 | 1407ms | 1079ms | ~0.9s |
| 10 字 | 1786ms | 1903ms | ~2.4s |
| 25 字 | 2857ms | 3037ms | ~5.0s |

- 拟合约 **1.1s 固定开销 + 73ms/字**，与 Gradio 的 770ms + 89ms/字 相当。**Gradio 的固定开销主要来自模型本身**（自回归语义 token + 25 步扩散 + 声码器），不是 Gradio 的排队和文件读写；换 FastAPI 本身不降延迟
- FastAPI 的实际收益：打断时取消合成、免上传参考音频、内存返回 PCM；显存整卡 13.6 / 16GB（服务约 5.5GB，含 llama-server）
- `/health` 显示该版本 `infer` 支持内存返回（`output_mode: memory`）和 `stream_return`，没有 `diffusion_steps` 参数
- 下一步降延迟的手段：`TTS_ACCEL=1`（GPT 加速，需 accel 可选依赖）、`TTS_DIFFUSION_STEPS`（替换 `s2mel` 的步数）、`stream_return`（只对多段长句有效）
- 2026-10-24 `TTS_DIFFUSION_STEPS=15` 通话实测（voice chunqing、情绪向量）：生效（进度条 15/15），8～9 字 synth 1.3～1.6s、26 字 2.75s，RTF 0.57～0.83（25 步时短句 RTF > 1，后句合成慢于前句播放，句间有停顿）。耗时拆分：GPT 0.75s（短句）～2.0s（26 字）、s2mel ~0.5s、BigVGAN ~0.1s，**剩余大头是 GPT 自回归**，再降步数到 10 只省约 0.15s；下一步是 `TTS_ACCEL`

| 指标 | Gradio（上表） | FastAPI 默认（25 步） | FastAPI 降步数（`TTS_DIFFUSION_STEPS=15`） |
|---|---|---|---|
| 耗时拟合：固定开销 + 每字 | 770ms + 89ms/字 | ~1.1s + 73ms/字（初测） | ~0.65s + 80ms/字（通话实测） |
| 取消 → GPU 空闲 | 不能取消，跑完为止 | 待测 | — |
| 显存（整卡，含 LLM） | 13.8 / 16GB | 13.6 / 16GB | — |
| 音质（试听 `--save-wavs`） | 基准 | 基准 | 待评 |

## 7. 延迟预算

```
              阶段1(Gradio)   FastAPI + 短首段    + 预录语气词
端点静音等待     500ms            500ms              500ms
ASR (CPU)       150ms            150ms              150ms
LLM 首段        150ms            150ms                —
TTS 首段       1300ms            800ms               0ms（直接播放语气词）
──────────────────────────────────────────────────────────
用户说完到听到声音  ~2.1s            ~1.6s             ~0.65s
```

## 8. 分阶段计划

- **阶段 1**：TTS 直接调用 Gradio `/gen_single`，先跑通整条链路和整体体验
- **阶段 2**：IndexTTS 封装成 FastAPI 服务，**替代** WebUI（两者不能同时运行，否则会加载两份模型）。启动时缓存音色特征、开半精度、直接返回 PCM、支持取消。原先预计能省掉约 0.5s 的 Gradio 开销，实测固定开销主要在模型本身（§6），延迟要靠加速选项和降扩散步数
  - 实现：`services/tts`（用法、环境变量、API 见其 README），Agent 侧 `TTS_BACKEND=fastapi` + `TTS_BASE_URL`（`apps/agent/src/tts/fastapi.ts`），插件和 Agent 其余部分不变
  - 模型：进程启动时按 WebUI `build_tts()` 的方式加载一次 IndexTTS2（默认 v2.5、半精度：v2.5 为 BF16，v2 为 FP16；不加载 QwenEmotion，我们只用情感向量），再用默认音色预热一次。音色是 `TTS_VOICES_DIR` 里的 `<id>.wav`（ADR 0008），每个音色固定一个路径；IndexTTS2 只按路径缓存最近一个音色的条件（spk_cond / s2mel style / prompt），同一音色的请求都命中缓存，换音色后第一句重新提取，Agent 在通话开始时用 `/warm` 提前做掉
  - 调用：`tts.infer(...)` 的参数按 `inspect.signature` 过滤（这个非官方版本不接受的参数告警后丢弃）；预热时试 `output_path=None`，能拿到 `(采样率, 数组)` 就内存返回，否则写临时 wav 再读。采样参数默认同 WebUI，可用环境变量改
  - 接口：`POST /tts { text, voice?, emotion?, emotion_vector?, emo_alpha?, request_id? }` → s16le 单声道 PCM（`X-Sample-Rate`），`POST /warm { voice }`，`POST /cancel/{id}`，`GET /health`。情绪名映射为 one-hot 向量再经 `normalize_emo_vec`，`平静` 跟随参考音频
  - 串行与取消：单工作线程逐个合成。取消排队中的请求直接移除；取消进行中的请求丢弃结果，并借 IndexTTS2 的 `gr_progress` 进度回调在下一个阶段边界中止；客户端断开也算取消。Agent 在打断和超时时调用 `/cancel`
  - 扩散步数：上游 `infer` 内部写死 25 步、CFG 0.7。`TTS_DIFFUSION_STEPS` / `TTS_CFG_RATE` 优先作为 `infer` 参数传入，否则替换 `s2mel.models['cfm'].inference` 的 `n_timesteps` / `inference_cfg_rate`；都不存在时告警并保持原值（`/health` 的 `diffusion.via` 显示实际方式）
  - 实测数据见 §6「TTS FastAPI 服务实测」

### Segmenter 规则
- 第一段在第一个逗号处就切，4–8 个字
- 后续段落切到句号、问号、叹号或分号；长句的 RTF 更低，韵律也更自然。不足 10 个实义字的句子不单独成段，和下一句一起合成（Segmenter `minSegmentChars`，Agent 设 10）：每段合成约有 1.3s 固定开销，短段合成比播放还慢，下一段来不及，回复中间就会空等。2026-10-24 sim:call（知夏，speed 1.12，Mac 经 Wi-Fi，只看比例）：改前 3 轮回复中间共空等 4.6s（单处最长 2.3s），改后 4 轮共 1.6s（最长 1.0s），一半的轮次完全没有空等。`emotionScope: "reply"` 下回复中间的情绪标签也不再切段
- 解析每句的情绪标签，字幕中去掉标签；标签缺失或格式错误时按中性情绪处理
- 实现：`packages/segmenter`（`@ptoy/segmenter`，零依赖纯逻辑）。默认阈值与边界规则：
  - 首段：遇到第一个 `，、,` 或句末标点即切；实义字符少于 4 个（如“嗯，”“哈哈，”，Agent 的 `firstSegmentMinChars`，Segmenter 默认 2）不切，并入下一小句。单独合成的短语气词会被拖长：moli 音色 speed 1.4 下“哈哈，”单独 1.2s，放进“哈哈，真的假的？”只占一半左右（单字段落要付 770ms 固定开销，且语气词已覆盖开口）；12 字内无标点则强制切
  - 开头语气词：Agent 开启 `dropLeadingInterjection`，回复开头的“嗯，”“好的，”“这样啊，”等（后面必须跟标点）从 TTS、字幕和历史里去掉；只出现在回复中间的保留，整条回复只有语气词时照常念。提示词也要求不这样开头，但 Qwen3-8B 经常不遵守
  - 后续：按 `。！？；…!?;` 和换行切；超过 40 字仍无句末标点时，优先切在窗口内最后一个逗号，否则硬切（40 字约 4.3s 合成，字幕一行可读）
  - 标点后的连续标点和右引号（`？！`、`。”`）跟随前句，为此最多多等 1 个 token；ASCII `.` `,` 夹在数字之间（`3.14`、`1,000`）不切
  - 情绪按句生效：没有自己标签的句子为平静（可选 `emotionScope: "untilNextTag"` 沿用上一个标签；`"reply"` 整段回复都用第一个标签，Agent 用这个）；标签本身也是分段边界；句中换情绪时先切出已缓冲文本
  - `[`/`【` 在 10 字内闭合即视为标签：合法取对应情绪，非法（如 `[开心]`、`[用户语气:喜]`）丢弃并按平静；10 字内未闭合按普通文本保留；回复结束时残留的半个标签丢弃
  - 切分按字素进行，不会拆开 emoji / 代理对；输出去首尾空白，不含实义字符的段不输出
  - `reset()` 丢弃缓冲和半个标签并恢复首段规则；`end()` 冲刷剩余文本后同样复位
  - 情绪 → IndexTTS2 情绪向量下标：喜 0、怒 1、哀 2、惧 3、厌恶 4、低落 5、惊喜 6、平静 7（`EMOTION_VECTOR_INDEX` / `emotionVector()`）

### 预录语气词
- 每个音色预先合成 5–10 条（“嗯…”“好的，”“我想想”等），按场景选用，避免每句都用而显得机械
- 生成器在 `services/fillers/`，产物（48kHz 单声道 16-bit WAV + `manifest.json`）按音色放在 `assets/fillers/<voice>/`（ADR 0008）；新增或更换音色后用 `--voice <id>` 重新生成
- 接入方式见 §12「语气词」

### 背景音（ADR 0013）
- 角色 front matter 写 `ambience: true`，且 Agent 配了 `AMBIENCE_DIR`（素材和清单，不进 Git，见 `services/ambience/README.md`）时启用；清单生成的档位规则拼在人设后面，与 `_rules.md` 无关
- LLM 在每段回复开头写 `<bg:档位>`；Segmenter 去掉标签，TTS 插件把这段回复的第一个档位报给档位状态机（`apps/agent/src/ambience/`）。回复开始播放（Agent 状态变为 speaking，且不是语气词在播）时才切换，交叉淡化 `fadeMs`；没有标签、档位未知、回复出声前被打断，都保持原档
- 由 `BackgroundAudioPlayer` 发布独立音轨 `background_audio`，浏览器把它当远端 WebRTC 音频播放，在回声消除范围内
- 播放规则：
  - 通话开始时是清单里的第一个档位（`idle`，静音）
  - 当前档位的素材一直循环，与角色是否在说话无关，直到档位变化或挂断；降到 `idle` 时淡出到静音
  - 切档时新旧两档同时交叉淡化 `fadeMs`（默认 1500ms）；淡出还没结束又切回原档，从当时的位置接着淡入，不从头播
  - 读入素材时把最后 50ms 和开头交叉淡化，循环处没有接缝
  - 网页的背景音开关只在本浏览器暂停这条音轨，Agent 照常播放、照常切档
- 发给 LLM 的请求里，历史中的每条 AI 回复前补上它播出后的档位（如 `<bg:mid>…`）。只改这次请求的副本，提交的对话历史和字幕不带标签。不补时，Dolphin 看到自己以前的回复都没有标签，第 2 轮起就不再写（2026-10-27 实测）
- 每轮一条 `ambience` 日志（`tag` / `from` / `to` / `ignored`）

## 9. 运维注意

应用配置按环境保存在 `apps/agent/.env`、`apps/agent/.env.hk` 等文件中；`pnpm app --env hk` 及 Agent/Token 启动命令的 `--env hk` 只加载 `.env.hk`，不叠加或回退到本地 `.env`，进程环境变量仍可显式覆盖配置。省略 `--env` 保持原本地启动方式。当前 HK 配置的 ASR、LLM 与 TTS 均使用 OpenRouter；ASR 为 `https://openrouter.ai/api` 的 `fish-audio/transcribe-1-pro`，已从本地 `.env` 单独同步 ASR 配置到 `.env.hk`；Tailscale 保留用于私网访问，不再是当前 ASR 的必经链路。生产 LiveKit 使用 `LIVEKIT_CONFIG` 指定的配置文件，不能用开发模式启动。真实环境文件不提交，本地 `.env` 保持不变。HK 已上线，当前操作入口为 [HK 部署说明](../../deploy/cloud/hk/README.md)，不使用旧安装器的 `/etc/ptoy/app.env`。

HK 主机 `38.55.199.239` 的基础服务采用独立安装：Tailscale 来自官方 Ubuntu Jammy 稳定源，节点名 `ptoy-hk`，不接管系统 DNS；LiveKit 固定为 `1.13.10`，官方发布包经 SHA-256 校验后安装到 `/usr/local/bin/livekit-server`，由专用 `livekit` 用户及 `livekit-server.service` 运行，配置在 `/etc/livekit/livekit.yaml`，API 凭据与 `.env.hk` 一致。本机信令 `127.0.0.1:7880`，媒体 TCP 7881 / UDP 7882，公网候选地址 `38.55.199.239`，不启用 TURN。保留现有 LiteSpeed、PHP、MariaDB；TLS 反代复用现有 OpenLiteSpeed。此独立服务与原安装器的 `ptoy-livekit.service` 不能同时启动，后续部署应复用已安装服务或显式迁移。

HK 应用部署使用独立 Git 克隆 `/opt/ptoy/source`（GitHub `Olsondy/ptoy`），Node `22.23.4`、pnpm `10.18.0`；当前工作区尚未提交的环境启动改动单独同步，不伪装成已提交版本。`ptoy-token.service` / `ptoy-agent.service` 由专用 `ptoy` 用户运行，调用 `scripts/run-agent.mjs` 的 `--env hk` 入口，读取源码目录中的 `apps/agent/.env.hk`（`root:ptoy`、`0640`）。数据库和角色资源位于 `/var/lib/ptoy`，前端构建产物单独复制至 `/var/www/ptoy/current`。域名确定为 `voice.bocayouth.cn` 与 `rtc.bocayouth.cn`；Cloudflare 代理 HTTPS 到现有 OpenLiteSpeed 的两个新增虚拟主机，复用覆盖这两个子域名的现有 Cloudflare Origin 证书。HK 单元模板见 `deploy/cloud/hk/`，与旧版 `deploy/cloud/install.sh` 的布局不同，不能混用。

2026-10-25 应用上线验证（Git 基线 `ece1377c114a5164d65ef8e9da1d4f1a4d9fd08c`，另含本次未提交改动）：

- Linux 上冻结锁文件安装、4 项环境启动测试、workspace 类型检查、前端构建和原生 VAD 推理均通过。两个应用服务已启用开机启动；维护模式已关闭，模型就绪。
- 两个域名公网 HTTPS 返回 200、证书验证通过；Chrome 已完成邀请码登录。未登录角色 API 返回 401，公网 `/internal/ops/status` 与 `/.env` 返回 403。
- 服务器端模拟客户端经正式 HTTPS/WSS 域名完成邀请码、拨号、真实 Windows ASR、OpenRouter LLM/TTS、音频及字幕、挂断释放：收到 353 帧非静音音频、20 字字幕；单轮日志 ASR 推理 95ms、请求 500ms、LLM 首 token 887ms、TTS 首段 1586ms、停止说话至回复首音 3817ms。这是单次功能验证，不是容量或稳定延迟基准。
- Windows 原生测试客户端的公网 Node fetch 受本机网络/代理路径影响超时；浏览器正常访问并登录。补充测试用临时 SSH 隧道承载 API/信令，媒体仍走 LiveKit 的公网 ICE 候选，完成真实跨机音频往返及 27 字字幕（538 帧非静音音频），随后释放通话。隧道已关闭，正式应用不依赖隧道。未代替真人浏览器麦克风、手机流量或多人容量验收。
- OpenLiteSpeed 增加 `ptoy_voice` / `ptoy_rtc` 两个虚拟主机并优雅重载；旧 HTTPS 监听及站点保留，`smartercable.com` 仍为 200，`stock.bocayouth.cn` 仍为既有 503。原主配置备份为 `/var/backups/ptoy/ols-httpd-before-hk-20261025.conf`。RTC 模板补齐 `docRoot` 后校验无 ERROR/FATAL；该主机原配置的 `lshttpd -t` 也会以警告和退出码 1 结束，不能只按退出码判断。

2026-10-25 基础服务安装阶段验证：Tailscale `1.104.2` 与 LiveKit `1.13.10` 已安装且 systemd 服务开机自启；LiveKit 本机根路径及签名鉴权的 `RoomService/ListRooms` 均返回 200。LiteSpeed / MariaDB 原进程未重启，`smartercable.com` 返回 200；原 `stock.bocayouth.cn` 仍为安装前已有的 503。Tailscale 已授权，服务器地址 `100.88.227.106`；服务器访问 Windows `http://100.90.8.73:8001/health` 连续三次返回 200，请求总耗时分别为 1.251 / 0.934 / 0.939 秒（新建 HTTP 连接）。当次链路经洛杉矶 DERP（`relay "lax"`），Tailscale ping 约 309–612ms，未建立直连；这是网络及健康接口测量，不是 ASR 推理或完整通话延迟。LiveKit 和原 PHP 站点复查均返回 200。

同日直连复查：日志显示先建立 `lax` DERP 连接，约 15 秒后已发现 Windows 公网 UDP 端点并切换直连；两端 `tailscale status` 均确认 `direct`，连续 5 次 ping 为 37–38ms，5 次 ASR 健康请求全部 200，总耗时 0.1136–0.1165 秒。服务器 UDP 可用且 41641 已放行，无需改防火墙。本机启用 `singbox_tun`，本地 CLI `netcheck` 看到代理公网出口、最近 DERP 为 `lax`；本机实际 home relay 也是 `lax`，服务器 home relay 是 `hkg`，因此初始协商阶段会绕行洛杉矶。本次未修改代理或路由配置；中继选择受代理影响的判断来自这些观测，未用停用代理的对照实验验证。初次检查的中继状态不能视为持续无法直连。

邀请访问控制已在正式网页、Token API 和 Agent 中实现并完成本地验证，见 [ADR 0010](../decisions/0010-invite-only-access.md)。支持按人发放可重复使用的邀请码、固定 30 天的浏览器会话，以及每码最多一通拨号或通话。独立交互原型仅供演示，不代表正式服务状态；云端部署与公网媒体、容量验收见[独立云部署方案](cloud-local-models.md)。

Token 服务以本机持久化 SQLite 管理邀请、浏览器会话和通话占用。网页与 API 同源，非本机回环访问要求 HTTPS 与 Secure Cookie。Agent 在双方媒体就绪后、启动通话 pipeline 前完成服务端原子准入：撤销先完成则阻止准入，准入先完成则允许既有通话结束。旧 LiveKit 凭证可能进入空房间，但不能绕过准入启动模型。短暂重连和结束清理期间保留占用；结束事件与服务端对账共同回收，状态不明时暂时拒绝新拨号。本地合成角色与 LiveKit/echo 验证已覆盖重连、API/Agent 重启、准入响应丢失和慢清理；真实公网媒体与实际模型容量仍须按部署环境验收。

应用（LiveKit、token 服务、Agent、网页）用仓库根目录的 `pnpm app` 一条命令启动，见 `README.md`。模型服务由用户自行维护，应用只通过 `apps/agent/.env` 里配置的地址连接它们。

- Windows 主机建议接网线，并关闭睡眠和 Wi-Fi 节能。实测 Wi-Fi 下 ping 在 30–375ms 之间波动，还出现过丢包
- 防火墙需要放行入站端口：LiveKit TCP 7880、7881 和 UDP 7882，网页 4173；Mac 开发期另需 7860（WebUI）或 8002（TTS FastAPI）、8080、8001（ASR）
- 浏览器麦克风只在 localhost 或 HTTPS 下可用；从手机等其他设备访问时，需要给网页和 LiveKit 信令都加上 TLS。现有 Tailscale 操作步骤见根目录 `README.md`。
- `apps/agent/.env` 中的 `APP_ORIGIN` 必须与浏览器实际访问网页的协议、域名和端口一致，不包含路径；它不一定等于 Tailscale 域名或 `LIVEKIT_PUBLIC_URL`。不匹配时邀请码等写请求返回 `403 invalid_origin`。修改后由操作者重新启动应用，使配置生效。

## 10. 待定事项

- IndexTTS 当前为官方源码加本地 `webui.py` 调整；本机已切换到阶段 2 API 服务（:8002），`infer` 支持内存返回和 `stream_return`、没有扩散步数参数（#14）。取消生效时间待 `bench.py` 实测。
- 扩散步数降低后音质和速度的取舍，需要实测（§6「TTS FastAPI 服务实测」）
- 轮次检测模型对中文的效果，需要实测

## 11. 轮次检测与 STT 插件（M1 #8 实测）

**链路**：`inference.VAD`（Silero）切出整句 → `SenseVoiceSTT`（`apps/agent/src/stt/sensevoice.ts`，非流式，框架用 `stt.StreamAdapter` 包装）把 48kHz 帧降到 16kHz 单声道、封成 WAV，以 multipart `file` 发到 ASR 服务的 OpenAI 兼容接口 `POST /v1/audio/transcriptions`（`response_format=json`，返回 `text`、`raw_text`、`elapsed_seconds`；情绪和事件从 `raw_text` 里的 SenseVoice 标签解析） → 最终文本经 LiveKit 标准 `lk.transcription` 文本流（发送者是用户本人）到浏览器，`UserSubtitle` 显示最新一句。VAD 和轮次模型都走 `@livekit/local-inference`，进程内推理，不调 LiveKit Cloud；它有 darwin-x64/arm64、win32-x64 预编译包。`@livekit/agents-plugin-silero` / `-livekit` 依赖 `onnxruntime-node`，后者已不提供 Intel Mac 二进制，所以没用。

**默认参数**（环境变量见 `apps/agent/.env.example`）：

| 参数 | 值 | 说明 |
|---|---|---|
| `TURN_DETECTOR` | `transcript`（#12 起；原为 `vad`） | `vad`：VAD 静音即结束轮次；`transcript`：同 `vad`，但转写停在“没说完”的地方时多等（§11.1）；`eot`：LiveKit 本地音频轮次模型 `turn-detector-v1-mini`（叠加在 VAD 上） |
| `VAD_MIN_SILENCE_MS` | 550 | 静音超过它才切句。它同时决定送 ASR 的音频怎么切 |
| `ENDPOINTING_MIN_DELAY_MS` / `MAX` | 800 / 2000（#12 起；原为 500 / 3000） | 实际等待 = max(VAD 静音 + ASR, minDelay)，从用户最后一个字算起；`transcript` / `eot` 判定“没说完”时等 maxDelay |
| `ASR_TIMEOUT_MS` | 5000 | 单次识别超时 |

**实测**（Mac，`say -v Ting-Ting` 合成 48kHz 语音，经本地 LiveKit 发给 Agent；句中停顿是去掉 TTS 自带尾部静音后插入的纯静音）：

| 句中停顿 | `vad` | `eot`（v1-mini，zh 阈值 0.355） |
|---|---|---|
| 200 / 400 / 600ms | 不切，一整句 | 不切 |
| 900ms | 切成两轮 | 切成两轮（概率 0.356，刚过阈值） |
| 1200ms | 切成两轮 | 合成一轮（0.22） |
| 完整句子的轮次结束延迟 | VAD 结束后约 0.25–0.4s（就是 ASR 耗时） | 5 句里 3 句被判“没说完”（0.13–0.31），要多等约 2.4s |

**结论**（#8 时，已被 §11.1 取代）：默认用 `vad` + 550ms。600ms 以内的句中停顿不会切句；延迟符合 §7 的 500ms 端点预算。`eot` 在合成语音上会把大量完整句子判成“没说完”，直接把延迟拉高到 3s，换来的只是偶尔合并 1s 以上的停顿。合成语音的语调不够自然，结论需要真人麦克风复核：试 `TURN_DETECTOR=eot`，看 `eot prediction` 日志里的 `endOfTurnProbability`。

### 11.1 轮次与打断调优（M2 #12）

**问题**：#8 的结论是在 ASR 跑 Mac CPU（250–460ms）时测的，慢 ASR 顺带拉长了等待。ASR 换到 Windows（约 0.13s）后，实际等待只剩 550ms VAD 静音 + 0.13s，用户句中停顿 0.6s 就被当成说完了。

**轮次结束（`TURN_DETECTOR=transcript`，`apps/agent/src/pipelines/endpointing.ts`）**：一个不调模型的文本“轮次检测器”，实现框架的 `_TurnDetector` 接口。每段 VAD 切出的语音转写完成后，框架会问它一次：转写停在逗号、连接词（然后、但是、因为、所以）、起句词（我觉得、我想、如果…的话）、填充词（那个、呃）或悬空虚词（和、把、的时候）上，就等 `ENDPOINTING_MAX_DELAY_MS`，否则等 `ENDPOINTING_MIN_DELAY_MS`。等待期间用户接着说，就取消这次结束。SenseVoice 会给每段补“。”，所以句末的句号不算数。

实测（`sim:call --fake llm,tts`，真实 ASR 在 Windows 上，Mac 经 Wi-Fi；5 句句中带停顿的话 + 1 句完整的话，停顿在 `say` 两段之间，实际静音约等于停顿 + 100ms）。表中是被误切成两轮的句数，以及完整句子从说完到语气词响起的时间：

| 配置 | 停顿 600ms | 900ms | 1200ms | 说完 → 语气词 |
|---|---|---|---|---|
| `vad` 500（旧默认） | 5/5 | — | — | 约 0.58s |
| `vad` 800 | 0/5 | 4/5 | 4/5 | 约 0.8s |
| `vad` 1000 | 0/5 | 1/5 | 4/5 | 约 1.0s |
| **`transcript` 800 / 2000（新默认）** | 0/5 | 2/5 | 2/5 | 约 0.8s |
| `transcript` 1000 / 2000 | 0/5 | 0/5 | 2/5 | 约 1.0s |
| `eot`（maxDelay 3000） | 0/5 | 0/5 | 1/5 | 6 句里 5 句约 3.0s |

`transcript` 剩下的误切来自两类：前半句本身就完整（“我今天去了超市。”），以及合成语音的“那个”被 ASR 识别成了韩语。`eot` 几乎不切，但会把完整句子判成“没说完”，每句多等约 2.4s，所以不用。**取舍**：新默认让完整句子的感知延迟多了约 0.2s（语气词在轮次结束时播放，能掩盖一部分），换来 0.8s 以内的任何停顿和 2s 以内“没说完”的停顿都不会被切断。说话慢、停顿多的用户可以把 `ENDPOINTING_MIN_DELAY_MS` 调到 1000，代价是每句再多等 0.2s。

**打断**（`listening.ts` / `conversation.ts`）：

| 参数 | 默认 | 理由 |
|---|---|---|
| `INTERRUPTION_MIN_SPEECH_MS` | 150（原 500） | 用户说话满这么久，AI 的声音就**暂停**。这一步可撤销：转写确认后才真正打断，没有转写就恢复。实测从用户开口到收到的 AI 音频停下：500ms 时 618ms、300ms 时 410ms、200ms 时 296ms、150ms 时 239–265ms，约等于阈值 + 100ms（VAD 判定 + 音轨缓冲）。验收要求 300ms 以内，所以取 150 |
| `FALSE_INTERRUPTION_TIMEOUT_MS` | 1000（框架默认 2000） | 暂停后没等到转写（咳嗽、噪声、被丢弃的“嗯”），从 VAD 判定说完（再过 550ms 静音）起再等这么久就恢复播放。要比 ASR 往返长，否则真打断的话会先恢复、再被切 |
| 附和词 | — | AI 有语音在排队、播放或暂停时，只含“嗯、啊、哦、对、是、好的”这类词的转写由 STT 直接丢掉（`backchannel.ts`），不打断 AI，也不算新的一轮。AI 空闲时“嗯”照常作为回答 |
| `VAD_MIN_SILENCE_MS` | 550（不变） | 见 §11 |

短促噪声和咳嗽最多让 AI 停顿约 1.5s（咳嗽 + 550ms + 1000ms），然后接着说，不会丢掉这句回复。阈值小于 150ms 时，一个单字就能让 AI 停下，收益不大。

**语气词之后**：`FillerTurnGuard` 不再按“说话满 500ms”计时，改成在新一轮的第一条转写出来时丢弃还没开播的回复。#11 的两个已知问题因此消失：持续噪声不再丢掉回复；语气词放完、回复还没开播时用户接着说，回复也不会从停顿里漏出 1–2 个字（框架把回复暂停在 `FALSE_INTERRUPTION_TIMEOUT_MS`，直到转写出来）。

**对话历史**：被打断的回复只按实际播放到的位置写进历史（框架按播放位置截断同步字幕；我们插入的 U+FEFF 在写入前去掉）。用假服务测：写进历史的文本就是播放的前缀，比字幕少 0–1 个字（字幕先放出当前这个字），长度和假 TTS 的 100ms/字吻合；开播前被丢掉的回复不写进历史。真实服务测：“给我讲讲你最喜欢的一本书吧”被打断后，历史里是“我最喜欢的是《小”，下一轮回复没有提到没说出口的部分。

**已知问题**：开播前被丢掉的回复偶尔会在字幕里闪一个字（框架打断时会放出同步器里的第一个“词”，按 U+FEFF 切分后就是一个字）；AI 每通电话最前 3s 的语音仍不可打断（框架的 AEC 预热）。

**需要人在扬声器外放下验证**：AI 不会被自己的声音打断（取决于浏览器的 AEC，`sim:call` 是直接收发音轨，测不了）；真人咳嗽、清嗓、“嗯”时 AI 的停顿和恢复是否自然；真人说话时 0.8s / 2s 这组端点等待是否合适。

**情绪/事件**：每条 FINAL_TRANSCRIPT 的 `alternatives[0].metadata` 带 `{ emotion, events, inferenceMs, audioMs }`，用 `asrMetadataOf(ev)` 读取；`SenseVoiceSTT` 的 `onTranscript` 每识别一句回调一次。#13 用它记下每句的情绪，作为 `[用户语气:X]` 交给 LLM（见 §12“情绪链路”和 `docs/architecture/emotion-pipeline.md`）。字幕走 STT 原文，不受影响。

**ASR 故障**：超时、连不上、4xx/5xx、返回格式错误都会抛 `AsrError`（`kind` 取 `timeout` / `unreachable` / `service` / `bad_response`），记 error 日志，同时作为可恢复的 `stt_error` 发出，会话不会关闭。Pipeline 把面向用户的提示写到 Agent 的参与者属性 `ptoy.stt_error`，字幕位置显示；下一句识别成功后清空。

## 12. 对话链路与每轮耗时日志（M1 #10）

**链路**（`AGENT_PIPELINE=conversation`，默认；`apps/agent/src/pipelines/conversation.ts`）：§11 的 VAD + STT → LLM（`@livekit/agents-plugin-openai`，`baseURL` 指向 llama-server，`max_completion_tokens=220`）→ TTS 插件 `IndexTTS`（`apps/agent/src/tts/`）→ Agent 音轨（24kHz）。角色 system prompt 在 `apps/agent/prompts/characters/`：每个角色一个 `<id>.md`（人设）+ 共用的 `_rules.md`（通话规则和情绪标签；`LLM_SHARED_RULES=false` 时不拼，来电者语气前缀也不加，人设要自带说话规则），改文件即可，不用改代码，下一通电话生效。页面拨号前选角色（`GET /api/characters` 列出），经 `POST /api/token` 写进来电者属性 `ptoy.character`，Agent 入房时读取（ADR 0007）。

- **TTS 插件与后端接口**：插件对上层只暴露“文本 + 情绪 → 音频”（`synthesize(text)` 用平静，`synthesizeSegment({ text, emotion })` 带情绪）；后端实现 `TtsBackend.synthesize(segment, signal) → PCM`，由 `TTS_BACKEND` 选择。`fastapi` 见 §8 阶段 2；`gradio`（WebUI `/gen_single`，参数按 `/gradio_api/info` 的默认值补齐，只覆盖情感方式、参考音频、文本、语言）。参考音频每个进程只上传一次，之后复用服务端路径；合成失败后下次重新上传。Gradio 后端只有这一个参考音频，不支持按角色切换音色。返回的 22.05kHz wav 解码后重采样到音轨采样率。
- **云端后端 `openrouter`**（不需要本地 GPU）：`TTS_BACKEND=openrouter`，`POST {TTS_BASE_URL}/audio/speech`（OpenAI 兼容，`TTS_BASE_URL` 默认 `https://openrouter.ai/api/v1`，`TTS_MODEL` 默认 `fish-audio/s2.1-pro`，key 用 `TTS_API_KEY`，没填时用 `OPENROUTER_API_KEY`），`response_format=pcm`，按响应 `Content-Type` 的 `rate` / `channels` 解析 16-bit little-endian PCM，再重采样；不请求该接口不支持的 WAV。角色的 `voice:` 经 `TTS_VOICES` 映射到 Fish 音色 id，没有映射的用模型默认音色。情绪不走向量：非平静句在文本前加 `[开心]` 这类提示，没有强度；角色 front matter 的 `tts_backends`（默认 `gradio, fastapi`）声明适用的后端，Agent 和 token 服务只提供与当前 `TTS_BACKEND` 匹配的角色，`DEFAULT_CHARACTER` 也必须匹配；`CLOUD_MODEL_CHECKS` 不探测 OpenRouter 的 LLM 和 TTS。`tts_style`（如 `亲密中文耳语，轻声性感`）每句都加在最前面，只有这个后端用；`tts_speed` / `tts_max_pause_ms` / `TTS_EMO_WEIGHT` 不生效。打断只断开 HTTP 请求，服务端没有取消接口。预录语气词是 IndexTTS 音色，配 Fish 音色时关掉或重新生成。LLM 是任意 OpenAI 兼容接口，没有 `LLM_BACKEND`，指向 OpenRouter 只改 `LLM_BASE_URL` / `LLM_MODEL`，key 用 `LLM_API_KEY`，没填时用 `OPENROUTER_API_KEY`（只在 openrouter.ai 上生效，本地 llama-server 不需要 key）；ASR 用 `ASR_BACKEND=sensevoice | openrouter` 切换，`ASR_BASE_URL` 是带 `/v1` 的 API base（插件补 `/audio/transcriptions`），默认分别是 `http://127.0.0.1:8001/v1` 和 `https://openrouter.ai/api/v1`；openrouter 需要 `ASR_API_KEY`（没填时用 `OPENROUTER_API_KEY`），`ASR_MODEL` 默认 `fish-audio/transcribe-1-pro`；sensevoice 忽略 key 和 model。旧名 `ASR_URL`、`TTS_GRADIO_URL` / `TTS_FASTAPI_URL` / `TTS_OPENROUTER_*`（现为 `TTS_BASE_URL` / `TTS_API_KEY` / `TTS_MODEL` / `TTS_VOICES`）启动即报错。同一插件发同样的 multipart 请求，返回只有 `text`。没有 `raw_text` 时插件从 `text` 里读方括号提示（Fish：`<|speaker:0|>[高兴]…`），中英文关键词映射为 SenseVoice 的情绪/事件类别，第一个情绪提示生效，提示和说话人标记从文本中去掉；不带提示的模型（如 `qwen/qwen3-asr-1.7b`）情绪为 `unknown`。2026-10-25 Mac 经公网单句约 2.3–2.7s（Qwen3-ASR 4–11s），未压测。全部走 OpenRouter 的取舍见 ADR 0012；走公网的环节首句延迟高于本地，未压测。
- **分段**：插件的 `stream()` 把 LLM 文本流交给 `@ptoy/segmenter`（§8 规则，默认阈值：首段在第一个逗号处切），每段一个 `synthesizeSegment({ text, emotion })` 请求；请求在插件内串行（GPU 共享），不重试。Segmenter 是切分和情绪标签解析的唯一实现。
- **取消**：打断或会话结束时中止请求、丢弃结果。Gradio 的 `/call` 接口不能取消已排队的任务，被取消的句子仍会在 GPU 上跑完；FastAPI 后端会调用 `/cancel/{id}`，服务端移除排队任务或中止进行中的合成。
- **字幕**：用框架内置的播放同步（TTS 对齐的段级时间戳：每段的干净文本挂在该段第一帧上 + 按字速推进），字幕和写入历史的回复都来自这些段文本。框架按空白切词，中文整句会被当成一个词一次性放出，所以 `transcriptionNode` 在每个中日文字符后插入 U+FEFF（会被当作空白、但不显示），字幕就能逐字跟随播放；写入对话历史前会去掉，网页显示前也会去掉。
- **标签**：LLM 输出里的 `[...]` / `【...】` 由 Segmenter 解析（合法情绪传给 TTS，非法丢弃），不进 TTS 文本、字幕和对话历史。LLM 看到的历史里没有标签，模型持续输出标签靠 system prompt 约束。
- **情绪链路**（#13，细节和实测见 `docs/architecture/emotion-pipeline.md`）：`CharacterAgent.llmNode` 只在发给 LLM 的那份上下文里给正在回答的用户消息加 `[用户语气:X]`（`apps/agent/src/emotion/user-tone.ts`，平静不加），历史、字幕和框架的抢先生成都用原文；TTS 默认 `TTS_EMOTION_CONTROL=vector`，非平静句子发 one-hot 情绪向量（`TTS_EMO_WEIGHT=0.6`），平静句子用参考音频；整段回复只用第一个标签的情绪。
- **语气词**（#11，`apps/agent/src/fillers/`）：`FILLERS_ENABLED`（默认开）、`FILLERS_DIR`（默认仓库的 `assets/fillers`）。每通电话加载角色音色的 `<voice>/manifest.json`（每个音色每个进程只解码一次）并重采样到音轨采样率；这个音色没有语气词时这通电话不播。用户一轮结束（`onUserTurnCompleted`，即 EOU 时刻）就用 `session.say('', { audio, addToChatCtx: false })` 排一条语气词在正式回复之前；回复的 LLM/TTS 同时开始，播放在框架的 speech 队列里排在语气词之后，所以不会重叠：回复先好就等语气词放完，语气词先放完就静音等回复。语气词的音频先等 `FILLER_DELAY_MS`（默认 2000，从轮次结束算）：这段时间内回复的第一帧 TTS 音频已经就绪（`CharacterAgent.ttsNode` 的首帧），语气词就零帧结束、不出声，回复直接播；只有回复慢时才放（2026-10-24 起，原先轮次一结束就放，每轮都有，听起来像抢答）。`0` 恢复立即播放。不是每轮都播（`apps/agent/src/fillers/choice.ts`）：明确的诉苦词才用共情组（“啊，这样啊”），ASR 的负面情绪只对陈述句生效；6 字以内的寒暄问句用应答组而不是“让我想想啊”；应答组只在一半的轮次播，和上一轮同组时概率再减半。`FILLERS_ALWAYS=true` 恢复每轮都选语气词（`sim:call --barge-in` 用它，并设 `FILLER_DELAY_MS=0`）。
  - 选组（`chooseFillerGroup`，按用户最终文本 + SenseVoice 情绪）：负面情绪（sad/angry/fearful/disgusted）或倾诉词（累、难过、烦、唉…）→ `empathy`；请求（帮我、能不能、…好不好）→ `ack`；提问（？、句末吗/呢、什么/怎么/为什么…）→ `thinking`；其余 → `ack`。组内随机，绝不与上一轮同一条（组内只剩上一条时换 `ack` 或任意一条）。
  - 不进对话历史、不出字幕（文本为空）：LLM 不知道自己说过“好的，”，偶尔会在回复开头重复一次类似的话。
  - 打断：语气词是普通可打断的 speech，用户开口按框架规则暂停/停止（§11.1）。回复还没开播时用户说了新的话（有转写），排队的回复直接丢弃（`FillerTurnGuard`），否则它会在用户的停顿里冒出半句、随后被新一轮打断。回复已经开始播放时按普通打断处理。框架有 3s 的 AEC 预热，通话中 AI 的前 3s 语音不可打断。
- **故障**：LLM（重试 `LLM_MAX_RETRY` 次后）或 TTS 失败都会记 error 日志，并把提示写到 Agent 的参与者属性 `ptoy.agent_error`，网页在 AI 字幕位置显示；AI 下次开口时清空。`maxUnrecoverableErrors` 设为不限，模型服务挂掉时通话不会断。

**每轮耗时日志**：每轮一条 info 日志，`msg` 为 `turn timing`，字段在 `turn` 对象里（`apps/agent/src/pipelines/turn-timing.ts`）。时长单位都是 ms；`t*` 是相对“用户停止说话”（VAD 判定的语音结束点，不含静音等待）的偏移。

| 字段 | 含义 | 来源 |
|---|---|---|
| `eouDelayMs` | 用户停止说话 → 轮次结束（VAD 静音 + ASR + 端点等待） | `eou_metrics.endOfUtteranceDelayMs` |
| `transcriptionDelayMs` | 用户停止说话 → 拿到最终文本 | `eou_metrics` |
| `asrMs` / `asrInferenceMs` | STT 请求往返 / ASR 服务端推理 | `stt_metrics` / ASR `duration_ms` |
| `llmTtftMs` / `llmDurationMs` / `llmTokens` | LLM 首 token、总耗时、生成 token 数 | `llm_metrics` |
| `ttsFirstMs` / `ttsFirstChars` / `ttsFirstAudioMs` | 第一句：请求到拿到音频（含排队）、字数、音频时长 | 第一条 `tts_metrics` |
| `ttsSegments` / `ttsAudioMs` | 本轮合成句数、音频总时长 | `tts_metrics` 累加 |
| `filler` / `fillerAudioMs` | 本轮语气词 id（manifest）/ 时长 | 语气词选择 |
| `fillerStartMs` | 用户停止说话 → 语气词开始播放 | 语气词的 `agent_state_changed → speaking` |
| `fillerSkipped` | 语气词等待期间回复已就绪，没有播放（此时 `filler` 仍是选中的 id，没有 `fillerStartMs`） | `FILLER_DELAY_MS` 门控 |
| `tLlmFirstToken` / `tTtsFirstAudio` / `tPlayout` | LLM 首 token、第一段音频就绪、正式回复开始播放的时间点 | 由上面的指标和回复消息的 `startedSpeakingAt`（缺失时用 `agent_state_changed → speaking`）推算 |
| `totalMs` | 用户停止说话 → 正式回复的第一帧音频开始播放（= `tPlayout`，在语气词之后） | 同上 |
| `firstAudioMs` | 用户停止说话 → AI 的第一个声音（语气词或回复，取早者）：感知延迟 | `min(fillerStartMs, totalMs)` |
| `interrupted` / `error` | 本轮是否被打断 / 失败的环节（`llm_error`、`tts_error`） | 会话事件 |
| `user` / `reply` | 用户原话 / AI 实际说出的回复 | 转写、对话历史 |

一轮在 AI 回复写入对话历史时结束；没有回复时（LLM 失败、开口前被打断）在下一轮开始或会话关闭时输出。

**文字对话**：`pnpm --filter @ptoy/agent chat -- --character <id>` 在终端里和角色打字聊天，发给 LLM 的内容和通话完全一致（system = 人设 + `_rules.md`，正在回答的那句带 `[用户语气:X]`，历史里 AI 的回复是去掉标签后实际念出的文本，`temperature` / `max_tokens` 取 `.env`），用来调人设；不要用网页聊天界面判断通话效果（它把设定当 user 消息、采样参数和历史都不同）。输入 `怒:…` 模拟来电者语气，`--show-request` 打印每次的请求体，`/history` 看历史。

**模拟通话**：`pnpm --filter @ptoy/agent sim:call -- --turns "你好|..."` 启动 Agent worker，用 macOS `say` 的中文语音当来电者逐轮说话，打印每轮收到的音频（含按静音切开的音频段）、字幕、`ptoy.agent_error` 和 `turn timing`；`--fake asr,llm,tts` 换成进程内假服务，`--fail llm|tts` 验证故障提示，`--barge-in N` 让来电者在倒数第二轮 AI 出声 N ms 后插话（语气词期间、回复中、语气词后回复未开播时配合 `--tts-ms 2500`；最后一轮是“嗯”时测附和），检查从开口到 AI 音频停下不超过 `--max-stop-ms`（300）、来电者说话期间没有漏音、下一轮 LLM 请求里被打断的回复只有播放过的前缀；轮次里的 `~` 是 `--pause-ms` 长的停顿，每轮被拆成多轮会报错；设 `LIVEKIT_SERVER_BIN` 时自带一个临时 LiveKit。每轮检查：字幕不含标签（假 LLM 时与回复逐字相同）、语气词与回复的音频跨度不短于两者之和（无重叠/截断）、语气词不连续重复。

**实测（Mac 经 Wi-Fi 调 Windows 的 LLM 和 TTS，ASR 跑在 Intel Mac CPU 上；按规则这组数据不作数，只用来看各段比例）**，6 轮连续对话，上下文连贯（第 5 轮记得名字，第 6 轮能概括前面聊过的话题）：

| 段 | 范围 | 中位数 |
|---|---|---|
| `eouDelayMs`（550ms 静音 + Mac 上 ASR 250–460ms） | 849–1051 | 896 |
| `llmTtftMs` | 262–350 | 344 |
| `ttsFirstMs`（第一句 5–22 字） | 1406–3294 | 2353 |
| `totalMs` | 2727–4727 | 3815 |

第一句的 TTS 耗时占了大头，并且和第一句字数成正比（5 字约 1.4s，22 字约 3.3s）。在 Windows 本机，ASR 约 0.1s、LLM 首 token 约 40ms，第一句短时能进 2.5s，长时进不了；要稳定达标需要 #11 的短首段和语气词，以及 #14 的 FastAPI。

**#11 实测（同样是 Mac 经 Wi-Fi、ASR 跑在 Mac CPU，只看比例）**，6 轮：`fillerStartMs` 850–1011（中位 ~900，基本等于 `eouDelayMs` + 几 ms），即用户说完到听到声音约 0.9s，其中 550ms 是 VAD 静音、270–410ms 是 Mac 上的 ASR；`totalMs`（正式回复）2481–3496（中位 ~2.9s，#10 为 3.8s），首段 3–10 字、`ttsFirstMs` 1186–2087。语气词结束到回复开始的静音 116–1776ms（中位 ~1.1s）：Gradio 每段约 770ms 固定开销 + Wi-Fi，首段再短也要 1.2s 以上；首段之后的短段同理，段间会有可感知的停顿。Windows 本机（ASR ~0.1s）和 #14 的 FastAPI 后端预计各省 0.3–0.5s，届时复测。
