# IndexTTS FastAPI 服务

阶段 2 的 TTS 服务（ADR 0006、`docs/architecture/server.md` §8）：在 Windows GPU 主机上**替代** IndexTTS WebUI。启动时只加载一次 IndexTTS2 并预热（音色参考音频的特征按路径缓存在模型里），之后每个请求直接返回 PCM，没有 Gradio 的上传、排队、SSE 和文件下载开销；请求可按 ID 取消。

**WebUI 和本服务不能同时运行**：两份模型放不进 16GB 显存。

## 启动（Windows）

在 IndexTTS 的 conda 环境里运行。服务从 `INDEXTTS_DIR` 导入 `indextts`（和 `webui.py` 一样把该目录加入 `sys.path`，并切换到该目录，因为模型里有相对路径）。

```powershell
# 1. 先停掉 WebUI（关掉它的窗口或 Ctrl+C），确认 nvidia-smi 里显存已释放
conda activate <IndexTTS 的环境名>
# gradio 已依赖 fastapi/uvicorn，一般不用装；下面这条报错时再装 requirements.txt
python -c "import fastapi, uvicorn"

# 2. 启动（在 ptoy 仓库根目录）
$env:INDEXTTS_DIR = "D:\index-tts"
$env:TTS_REF_AUDIO = "D:\voice\ref.wav"
python services\tts\server.py
```

看到 `warm-up done ... (output via memory|file, 22050 Hz)` 和 `serving on http://0.0.0.0:8002` 即就绪。启动顺序同 §5：先启动本服务，再启动 llama-server。

Mac 开发期经局域网访问时，防火墙放行 TCP 8002（替代原来的 7860）。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `INDEXTTS_DIR` | 当前目录 | IndexTTS 安装根目录（`webui.py` 所在目录） |
| `TTS_REF_AUDIO` | 必填 | 角色音色参考 wav（本机路径）。所有请求都用这一个路径，命中模型内部的音色缓存 |
| `TTS_MODEL_DIR` | `$INDEXTTS_DIR\checkpoints` | 同 WebUI `--model_dir` |
| `TTS_MODEL_VERSION` | `2.5` | 同 WebUI `--version`（`2` / `2.5`） |
| `TTS_HALF` | `1` | 半精度：v2.5 用 BF16（设备不支持时回退 FP32，同 WebUI），v2 用 FP16 |
| `TTS_QWEN_EMO` | `0` | 是否加载 QwenEmotion（情感描述文本控制）。我们只用情感向量，关掉省显存；WebUI 在 ≥10GB 显卡上默认会加载它 |
| `TTS_DEEPSPEED` / `TTS_CUDA_KERNEL` / `TTS_ACCEL` / `TTS_TORCH_COMPILE` | `0` | 同 WebUI `--deepspeed` / `--cuda_kernel` / `--accel` / `--torch_compile`（后两个要装对应 extra） |
| `TTS_DIFFUSION_STEPS` / `TTS_CFG_RATE` | 不覆盖 | s2mel 扩散步数 / CFG 强度，见下文 |
| `TTS_TOP_P` `TTS_TOP_K` `TTS_TEMPERATURE` `TTS_DO_SAMPLE` `TTS_NUM_BEAMS` `TTS_REPETITION_PENALTY` `TTS_LENGTH_PENALTY` `TTS_MAX_MEL_TOKENS` | WebUI 默认（0.8 / 30 / 0.8 / 1 / 1 / 10.0 / 0.0 / 1500） | GPT 采样参数 |
| `TTS_MAX_TEXT_TOKENS_PER_SEGMENT` | `120` | 同 WebUI「分句最大Token数」 |
| `TTS_LANGUAGE` / `TTS_DURATION_FACTOR` | `ZH` / `1.0` | 仅 v2.5 |
| `TTS_EMO_ALPHA` | `0.65` | 情感向量强度（请求未带 `emo_alpha` 时用；与 WebUI 默认 `emo_weight` 相同） |
| `TTS_OUTPUT_MODE` | `auto` | `auto`：预热时试 `infer(output_path=None)`，能拿到 `(采样率, 数组)` 就在内存里返回，否则写临时 wav；`memory` / `file` 强制 |
| `TTS_ABORT_RUNNING` | `1` | 取消时在下一个阶段边界中止进行中的合成（见“取消”） |
| `TTS_HOST` / `TTS_PORT` | `0.0.0.0` / `8002` | 监听地址 |
| `TTS_MAX_TEXT_CHARS` / `TTS_MAX_QUEUE` | `300` / `8` | 单次文本上限 / 排队上限（超出返回 503） |
| `LOG_LEVEL` | `INFO` | |

启动日志会打印 `IndexTTS2.infer(...)` 的完整签名，以及被忽略的参数（这个非官方版本不接受的 kwargs 会被丢弃并告警，不会报错）。`GET /health` 里也有这些信息和显存。

## API

### `POST /tts`

```json
{ "text": "你好呀，", "emotion": "喜", "emo_alpha": 0.65, "request_id": "8c1f..." }
```

- `text`：必填，去掉首尾空白后非空，最多 `TTS_MAX_TEXT_CHARS` 字
- `emotion`：可选，`喜 怒 哀 惧 厌恶 低落 惊喜 平静` 之一。`平静` 或不填 = 情绪跟随音色参考音频；其余映射为 one-hot 情感向量（下标顺序同 `@ptoy/segmenter` 的 `EMOTION_VECTOR_INDEX`），再经 IndexTTS2 `normalize_emo_vec(apply_bias=True)`，与 WebUI「使用情感向量控制」一致
- `emotion_vector`：可选，8 个 `[0,1]` 的浮点数，和 `emotion` 二选一；全 0 等同跟随参考音频
- `emo_alpha`：可选，`[0,1]`，默认 `TTS_EMO_ALPHA`
- `request_id`：可选，用于取消；不填由服务生成

成功 `200`，body 是裸 PCM：**s16le、单声道**，响应头：

| 头 | 含义 |
|---|---|
| `X-Sample-Rate` | 采样率（IndexTTS2 为 22050） |
| `X-Channels` / `X-Sample-Format` | `1` / `s16le` |
| `X-Request-Id` | 请求 ID |
| `X-Queue-Ms` / `X-Synth-Ms` / `X-Audio-Ms` | 排队耗时 / GPU 合成耗时 / 音频时长 |

错误返回 JSON `{ "error", "detail" }`：`422` 参数不合法，`409 cancelled` 被取消，`409 duplicate_request_id` 同 ID 正在处理，`503 queue_full`，`500 synthesis_failed`。

### `POST /cancel/{request_id}`

返回 `{ "request_id", "state" }`，`state` 是取消时请求所处的状态：
- `queued`：从队列移除，GPU 不会处理它，原请求立即返回 409
- `running`：标记取消，结果丢弃，原请求返回 409；`TTS_ABORT_RUNNING=1` 时合成在下一个阶段边界中止（IndexTTS2 在各阶段调用 `gr_progress` 汇报进度，服务把它换成一个检查取消标志的钩子）
- `unknown`：ID 还没到（客户端在请求到达前就放弃了）或已结束。服务记住这个 ID 60s，之后到达的同 ID 请求直接 409

客户端断开连接（如 Agent 中止 fetch）也按取消处理。

### `GET /health`

`{ status, queued, running, model, precision, sample_rate, output_mode, diffusion, generation, infer, load_ms, warmup_ms, vram_mib }`。

## GPU 串行

所有合成在一个工作线程上逐个执行（GPU 与 LLM 共享），先到先服务。Agent 端的插件本来就串行，这里是第二道保证。

## 扩散步数

上游 IndexTTS2 在 `infer` 内部把 s2mel 的扩散步数写死为 `diffusion_steps = 25`、`inference_cfg_rate = 0.7`，没有暴露参数。服务按以下顺序尝试覆盖 `TTS_DIFFUSION_STEPS` / `TTS_CFG_RATE`：

1. `infer()` 有 `diffusion_steps` 参数：直接传
2. 否则包一层 `tts.s2mel.models['cfm'].inference(..., n_timesteps, inference_cfg_rate=...)`，替换这两个参数
3. 两者都没有：告警并使用模型自带值（`/health` 的 `diffusion.via` 为 `null`）

`/health` 的 `diffusion` 会写明实际生效的值和方式。

## 压测（Windows 本机）

```powershell
# 合成耗时 vs 字数（拟合“固定开销 + 每字耗时”，对比 Gradio 770ms + 89ms/字）、取消、显存
python services\tts\bench.py --url http://127.0.0.1:8002 --json bench_tts.jsonl --label default --save-wavs bench_out\default

# 扩散步数取舍：重启服务换步数后再跑，对比耗时并试听 bench_out\* 里的 wav
$env:TTS_DIFFUSION_STEPS = "10"; python services\tts\server.py
python services\tts\bench.py --json bench_tts.jsonl --label steps10 --save-wavs bench_out\steps10

# 全链路（LLM + TTS 并发、整卡显存峰值），规则要求的 bench_gpu.py
python bench\bench_gpu.py --llm-url http://127.0.0.1:8080 --tts-fastapi-url http://127.0.0.1:8002
```

## 单测

不需要模型和 GPU（模型换成假实现）：

```bash
python3 -m venv .venv && .venv/bin/pip install -r services/tts/requirements-test.txt
cd services/tts && ../../.venv/bin/python -m unittest test_app test_engine
```
