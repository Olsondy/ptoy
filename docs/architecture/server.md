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
│ ASR：SenseVoice-Small :8100（CPU） 输出文本 + 情绪/事件标签 │
│ LLM：llama-server :8080 · Qwen3-8B Q5_K_M · 思考模式关闭    │
│ TTS：IndexTTS2 · 阶段 1 用 Gradio :7860 / 阶段 2 用 FastAPI │
└─────────────────────────────────────────────────────────┘
```

**部署**：开发阶段 Agent 跑在 Mac 上，经局域网调用 Windows 上的服务；上线后 Agent 部署到 Windows，与模型走 localhost，只有浏览器 ↔ LiveKit 这一段经过局域网。

## 4. 关键选型

决策理由详见 `docs/decisions/0001`–`0006`。情绪标签链路的流程图与约定见 `docs/architecture/emotion-pipeline.md`。

| 决策 | 选择 | 理由 |
|---|---|---|
| 传输层 | LiveKit（WebRTC） | 内置打断、AEC、播放位置追踪、字幕同步，不用自己在 Node 里搭 WebRTC |
| 前端 | React | LiveKit 有现成的 React 组件和 hooks |
| ASR | SenseVoice-Small，跑在 CPU 上 | 模型小、非自回归，VAD 切出整句后识别只要几十到一百多毫秒；附带情绪标签；把 GPU 留给 LLM 和 TTS |
| 不用 Gemini Flash 当 ASR | — | 非流式、多一次云端往返（0.5–1.5s+）、可能直接回答而不是转写、境外网络不稳 |
| 不换 Qwen2.5-Omni | — | 能听出语气，但识别粗；发声模块音色固定，没法控制情绪；文本能力比 Qwen3-8B 弱。换来的只有“直接听音频”这一点，不划算 |
| 语气感知 | 情绪标签链路 | SenseVoice 情绪标签写进 prompt → Qwen3-8B 给每句话加情绪标签 → Segmenter 解析 → IndexTTS2 按情绪合成 |
| TTS | IndexTTS2 | 音色克隆加情绪控制。整句合成，不支持流式，首句延迟靠短首段和语气词掩盖 |

## 5. llama-server 配置

```bat
llama-server -m Qwen3-8B-Q5_K_M.gguf --alias qwen3-8b --host 0.0.0.0 --port 8080 ^
  -ngl 99 --fit off -c 8192 -np 1 -fa on --cache-type-k q8_0 --cache-type-v q8_0 ^
  -b 512 -ub 512 -t 8 --cache-ram 512 --jinja --reasoning off --reasoning-budget 0
```

- 用单模型模式（`-m`），不用路由模式：不会按需加载或空闲卸载，请求里也不用带 `model` 字段
- 固定 `-ngl 99`，不用自动适配：避免和 IndexTTS 争显存时，部分层被悄悄放到 CPU 上
- 日志里要能看到 `offloaded 37/37 layers to GPU`
- NVIDIA 控制面板里，CUDA 系统内存回退策略设为“首选无系统内存回退”：显存不足时直接报错，而不是悄悄变慢
- 启动顺序：先启动 IndexTTS，再启动 llama-server
- 前缀缓存：system prompt 固定、对话历史只追加不改，可以让每轮的首 token 延迟保持在几十毫秒

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
- **阶段 2**：IndexTTS 封装成 FastAPI 服务，**替代** WebUI（两者不能同时运行，否则会加载两份模型）。启动时缓存音色特征、开 FP16、降低扩散步数、直接返回 PCM、支持取消。预计节省约 0.5s

### Segmenter 规则
- 第一段在第一个逗号处就切，4–8 个字
- 后续段落切到句号、问号、叹号或分号；长句的 RTF 更低，韵律也更自然
- 解析每句的情绪标签，字幕中去掉标签；标签缺失或格式错误时按中性情绪处理
- 实现：`packages/segmenter`（`@ptoy/segmenter`，零依赖纯逻辑）。默认阈值与边界规则：
  - 首段：遇到第一个 `，、,` 或句末标点即切；实义字符少于 2 个（如“嗯，”）不切，并入下一小句（单字段落要付 770ms 固定开销，且语气词已覆盖开口）；12 字内无标点则强制切
  - 后续：按 `。！？；…!?;` 和换行切；超过 40 字仍无句末标点时，优先切在窗口内最后一个逗号，否则硬切（40 字约 4.3s 合成，字幕一行可读）
  - 标点后的连续标点和右引号（`？！`、`。”`）跟随前句，为此最多多等 1 个 token；ASCII `.` `,` 夹在数字之间（`3.14`、`1,000`）不切
  - 情绪按句生效：没有自己标签的句子为平静（可选 `emotionScope: "untilNextTag"` 沿用上一个标签）；标签本身也是分段边界；句中换情绪时先切出已缓冲文本
  - `[`/`【` 在 10 字内闭合即视为标签：合法取对应情绪，非法（如 `[开心]`、`[用户语气:喜]`）丢弃并按平静；10 字内未闭合按普通文本保留；回复结束时残留的半个标签丢弃
  - 切分按字素进行，不会拆开 emoji / 代理对；输出去首尾空白，不含实义字符的段不输出
  - `reset()` 丢弃缓冲和半个标签并恢复首段规则；`end()` 冲刷剩余文本后同样复位
  - 情绪 → IndexTTS2 情绪向量下标：喜 0、怒 1、哀 2、惧 3、厌恶 4、低落 5、惊喜 6、平静 7（`EMOTION_VECTOR_INDEX` / `emotionVector()`）

### 预录语气词
- 用同一个音色预先合成 5–10 条（“嗯…”“好的，”“我想想”等），按场景选用，避免每句都用而显得机械
- 生成器在 `services/fillers/`，产物（48kHz 单声道 16-bit WAV + `manifest.json`）在 `assets/fillers/`；换音色后重新运行生成器即可

## 9. 运维注意

- Windows 主机建议接网线，并关闭睡眠和 Wi-Fi 节能。实测 Wi-Fi 下 ping 在 30–375ms 之间波动，还出现过丢包
- 防火墙需要放行入站端口 7860、7880、8080、8100（ASR）
- 浏览器麦克风在非 localhost 访问时需要 HTTPS（可用 mkcert 或反向代理）

## 10. 待定事项

- IndexTTS 安装的是非官方版本（带语言选择、预设、术语表），阶段 2 需要阅读它的 `webui.py`，找到底层推理调用方式
- 扩散步数降低后音质和速度的取舍，需要实测
- 轮次检测模型对中文的效果，需要实测

## 11. 轮次检测与 STT 插件（M1 #8 实测）

**链路**：`inference.VAD`（Silero）切出整句 → `SenseVoiceSTT`（`apps/agent/src/stt/sensevoice.ts`，非流式，框架用 `stt.StreamAdapter` 包装）把 48kHz 帧降到 16kHz 单声道 s16le 后 `POST /asr` → 最终文本经 LiveKit 标准 `lk.transcription` 文本流（发送者是用户本人）到浏览器，`UserSubtitle` 显示最新一句。VAD 和轮次模型都走 `@livekit/local-inference`，进程内推理，不调 LiveKit Cloud；它有 darwin-x64/arm64、win32-x64 预编译包。`@livekit/agents-plugin-silero` / `-livekit` 依赖 `onnxruntime-node`，后者已不提供 Intel Mac 二进制，所以没用。

**默认参数**（环境变量见 `apps/agent/.env.example`）：

| 参数 | 值 | 说明 |
|---|---|---|
| `TURN_DETECTOR` | `vad` | VAD 静音即结束轮次；`eot` 改用 LiveKit 本地音频轮次模型 `turn-detector-v1-mini`（叠加在 VAD 上） |
| `VAD_MIN_SILENCE_MS` | 550 | 静音超过它才切句。它同时决定送 ASR 的音频怎么切 |
| `ENDPOINTING_MIN_DELAY_MS` / `MAX` | 500 / 3000 | VAD 模式下实际等待 = max(VAD 静音, minDelay)；`eot` 判定“没说完”时等 maxDelay |
| `ASR_TIMEOUT_MS` | 5000 | 单次识别超时 |

**实测**（Mac，`say -v Ting-Ting` 合成 48kHz 语音，经本地 LiveKit 发给 Agent；句中停顿是去掉 TTS 自带尾部静音后插入的纯静音）：

| 句中停顿 | `vad` | `eot`（v1-mini，zh 阈值 0.355） |
|---|---|---|
| 200 / 400 / 600ms | 不切，一整句 | 不切 |
| 900ms | 切成两轮 | 切成两轮（概率 0.356，刚过阈值） |
| 1200ms | 切成两轮 | 合成一轮（0.22） |
| 完整句子的轮次结束延迟 | VAD 结束后约 0.25–0.4s（就是 ASR 耗时） | 5 句里 3 句被判“没说完”（0.13–0.31），要多等约 2.4s |

**结论**：默认用 `vad` + 550ms。600ms 以内的句中停顿不会切句；延迟符合 §7 的 500ms 端点预算。`eot` 在合成语音上会把大量完整句子判成“没说完”，直接把延迟拉高到 3s，换来的只是偶尔合并 1s 以上的停顿。合成语音的语调不够自然，结论需要真人麦克风复核：试 `TURN_DETECTOR=eot`，看 `eot prediction` 日志里的 `endOfTurnProbability`。

**情绪/事件给 #13**：每条 FINAL_TRANSCRIPT 的 `alternatives[0].metadata` 带 `{ emotion, events, inferenceMs, audioMs }`，用 `asrMetadataOf(ev)` 读取；或者给 `SenseVoiceSTT` 传 `onTranscript`，每识别一句回调一次（当前用于日志）。#13 可以记下本轮各句的情绪，在 `Agent.onUserTurnCompleted(chatCtx, newMessage)` 里给 `newMessage` 加 `[用户语气:X]` 前缀。字幕走 STT 原文，不受影响。

**ASR 故障**：超时、连不上、4xx/5xx、返回格式错误都会抛 `AsrError`（`kind` 取 `timeout` / `unreachable` / `service` / `bad_response`），记 error 日志，同时作为可恢复的 `stt_error` 发出，会话不会关闭。Pipeline 把面向用户的提示写到 Agent 的参与者属性 `ptoy.stt_error`，字幕位置显示；下一句识别成功后清空。
