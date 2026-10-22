# ASR 服务（SenseVoice-Small，CPU）

独立的 HTTP 服务：收一段 VAD 切好的 16kHz 单声道语音，返回转写文本、情绪和音频事件。模型 `iic/SenseVoiceSmall` 经 `funasr` 跑在 **CPU** 上，不占显存（ADR 0003）。

## 接口

### `POST /asr`

请求体就是音频本身（不用 multipart、不用 base64），用 `Content-Type` 区分格式：

| Content-Type | 内容 |
|---|---|
| `audio/pcm`（推荐；也接受 `audio/L16`、`application/octet-stream`） | 无文件头的 16-bit 有符号小端 PCM，16000Hz，单声道。可带 `;rate=16000;channels=1` 参数，带了就会校验 |
| `audio/wav`（也接受 `audio/wave`、`audio/x-wav`） | WAV 文件，PCM 16-bit，16000Hz，单声道 |

服务端不做重采样或混音：采样率、声道或位深不对直接返回 422。

Node 客户端示例（`pcm` 是 16kHz 单声道 `Int16Array`）：

```ts
const res = await fetch(`${ASR_URL}/asr`, {
  method: "POST",
  headers: { "Content-Type": "audio/pcm;rate=16000;channels=1" },
  body: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
});
const { text, emotion, events, duration_ms } = await res.json();
```

成功（200）：

```json
{ "text": "今天天气怎么样，我们出去走走吧。", "emotion": "neutral", "events": ["speech"], "duration_ms": 87 }
```

| 字段 | 说明 |
|---|---|
| `text` | 转写文本（开启 ITN，带标点）。所有 `<\|...\|>` 特殊标签都已去掉，不会转成 emoji。没识别到语音时为 `""` |
| `emotion` | 固定取值之一：`neutral` `happy` `sad` `angry` `fearful` `disgusted` `surprised` `unknown`。对应 SenseVoice 的 `NEUTRAL/HAPPY/SAD/ANGRY/FEARFUL/DISGUSTED/SURPRISED/EMO_UNKNOWN`；缺失时为 `unknown` |
| `events` | 取值子集：`speech` `bgm` `applause` `laughter` `cry` `sneeze` `breath` `cough`，去重、按出现顺序。`Event_UNK` 等未知标签直接丢弃，可能为空数组 |
| `duration_ms` | 服务端推理耗时（整数毫秒），不含网络和解码 |

失败：`{ "error": "<code>", "message": "<说明>" }`

| 状态码 | `error` |
|---|---|
| 400 | `empty_body`、`empty_audio` |
| 413 | `audio_too_long`（超过 `ASR_MAX_SECONDS`） |
| 415 | `unsupported_media_type`（缺少或不支持的 `Content-Type`） |
| 422 | `invalid_wav`、`invalid_pcm`、`unsupported_sample_rate`、`unsupported_channels`、`unsupported_sample_width` |
| 500 | `inference_failed` |

推理按请求串行执行（一个模型实例，加锁）；半双工场景下同一时刻只有一句话在识别。

### `GET /health`

`{ "status": "ok", "model": "iic/SenseVoiceSmall" }`。模型在启动时加载并预热，端口开始监听即表示可用。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ASR_HOST` | `0.0.0.0` | 监听地址 |
| `ASR_PORT` | `8100` | 监听端口 |
| `ASR_MODEL` | `iic/SenseVoiceSmall` | ModelScope 模型 ID 或本地模型目录 |
| `ASR_LANGUAGE` | `auto` | `auto` / `zh` / `en` / `yue` / `ja` / `ko` |
| `ASR_THREADS` | `4` | CPU 推理线程数 |
| `ASR_MAX_SECONDS` | `30` | 单次请求音频时长上限 |
| `ASR_LOG_LEVEL` | `info` | 日志级别 |

## Windows 部署

需要 Miniconda/Anaconda。以下命令在 “Anaconda Prompt” 中执行，工作目录为仓库下的 `services\asr`。

```bat
conda create -n ptoy-asr python=3.11 -y
conda activate ptoy-asr

:: 只装 CPU 版 torch：不带 CUDA，不会占用显存
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt -r requirements-test.txt
```

确认装的是 CPU 版（应输出 `False`）：

```bat
python -c "import torch; print(torch.cuda.is_available())"
```

启动：

```bat
set ASR_PORT=8100
python -m asr_service
```

- 首次启动会从 ModelScope 下载模型（约 900MB，缓存到 `%USERPROFILE%\.cache\modelscope`），之后离线可用。
- 看到 `model ready` 和 `Uvicorn running on http://0.0.0.0:8100` 即就绪。
- 用 `nvidia-smi` 对比启动前后的显存，应当没有变化。

防火墙放行入站端口（管理员命令行执行一次；Agent 在 Mac 上开发时需要）：

```bat
netsh advfirewall firewall add rule name="ptoy ASR 8100" dir=in action=allow protocol=TCP localport=8100
```

冒烟测试（另开一个窗口）：

```bat
curl http://localhost:8100/health
curl -X POST -H "Content-Type: audio/wav" --data-binary @tests\fixtures\zh_weather_3s.wav http://localhost:8100/asr
```

## 测试

```bat
:: 单元测试 + HTTP 接口测试（模型用假实现替换，不需要下载模型）
python -m pytest

:: 加上真实模型的集成测试（首次会下载模型）
set ASR_INTEGRATION=1
python -m pytest -s
```

`tests/fixtures/zh_weather_3s.wav`：macOS `say -v Ting-Ting` 合成的“今天天气怎么样，我们出去走走吧。”，16kHz 单声道 16-bit，约 3.8 秒。

## Mac 开发

`asr_service.engine` 只在真正加载模型时才 import `torch`/`funasr`，所以假模型测试只需要轻量依赖：

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-test.txt
.venv/bin/python -m pytest
```

需要在 Mac 上跑真实模型时，用单独的 conda 环境（Intel Mac 上 torch 最高 2.2.2，所以要固定版本）：

```sh
conda create -n ptoy-asr python=3.11 -y
conda run -n ptoy-asr pip install "torch==2.2.2" "torchaudio==2.2.2"
conda run -n ptoy-asr pip install -r requirements.txt -r requirements-test.txt "numba==0.60.0" "llvmlite==0.43.0"
ASR_INTEGRATION=1 conda run -n ptoy-asr python -m pytest -s
```

Intel Mac 上新版 `llvmlite`（`librosa` → `numba` 的依赖）没有预编译 wheel，所以要固定 `numba==0.60.0` / `llvmlite==0.43.0`；Windows 不需要。

Mac 实测（i7-6820HQ，4 线程，仅供参考，以 Windows 本机数据为准）：3.8 秒语音推理 220–300ms，10.4 秒语音 580–690ms。
