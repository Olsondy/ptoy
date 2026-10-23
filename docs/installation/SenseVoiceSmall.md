# SenseVoiceSmall 下载与安装

用于把用户语音转成文字。按仓库 ADR-0003 默认用 CPU；模型文件与 GPU 模式相同。程序和 API 配置见 [架构部署基线](../architecture/server.md#本机部署基线)，日常启动见 [总览](../deployment-overview.md)。

## 1 下载模型文件

- [官方模型仓库](https://huggingface.co/FunAudioLLM/SenseVoiceSmall/tree/main)
- [SenseVoice 源码](https://github.com/QwenAudio/SenseVoice)
- [FunASR 推理框架](https://github.com/modelscope/FunASR)

以下五个文件全部保存到 `D:\Resources\MyWorkspace\ai\models\SenseVoiceSmall`：

```text
https://huggingface.co/FunAudioLLM/SenseVoiceSmall/resolve/main/model.pt
https://huggingface.co/FunAudioLLM/SenseVoiceSmall/resolve/main/config.yaml
https://huggingface.co/FunAudioLLM/SenseVoiceSmall/resolve/main/configuration.json
https://huggingface.co/FunAudioLLM/SenseVoiceSmall/resolve/main/am.mvn
https://huggingface.co/FunAudioLLM/SenseVoiceSmall/resolve/main/chn_jpn_yue_eng_ko_spectok.bpe.model
```

| 文件 | 大小（字节） |
|---|---:|
| `model.pt` | 936,291,369 |
| `config.yaml` | 1,855 |
| `configuration.json` | 396 |
| `am.mvn` | 11,203 |
| `chn_jpn_yue_eng_ko_spectok.bpe.model` | 377,341 |

主权重 SHA-256：

```text
833ca2dcfdf8ec91bd4f31cfac36d6124e0c459074d5e909aec9cabe6204a3ea
```

## 2 新建独立环境

已有环境时跳过。本机基线使用 CUDA 版 PyTorch，在 CPU 模式同样可用，因此以下恢复方式保留 CPU/GPU 切换能力：

```powershell
conda create --prefix 'D:\Resources\MyWorkspace\ai\conda\envs\sensevoice' python=3.11 pip -y
& 'D:\Resources\MyWorkspace\ai\conda\envs\sensevoice\python.exe' -m pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
```

从现有程序备份恢复 `D:\Development\SenseVoice\requirements-lock.txt` 后安装其余依赖：

```powershell
& 'D:\Resources\MyWorkspace\ai\conda\envs\sensevoice\python.exe' -m pip install -r 'D:\Development\SenseVoice\requirements-lock.txt' --extra-index-url https://download.pytorch.org/whl/cu128
& 'D:\Resources\MyWorkspace\ai\conda\envs\sensevoice\python.exe' -m pip check
```

这份锁定清单来自当前环境，包含 FunASR、FastAPI、uvicorn、音频解码/重采样和 multipart 依赖。它位于本机程序目录，不在模型下载仓库中。

## 3 恢复 API 和启动入口

把以下本地文件恢复到原路径，并按新机器路径调整：

- `D:\Development\SenseVoice\server.py`
- `D:\Development\SenseVoice\start-local.ps1`
- `D:\Resources\MyWorkspace\ai\models\SenseVoiceSmall\Start-SenseVoice.ps1`

`server.py` 是当前部署的自定义 HTTP 封装，提供 `/health` 和 `POST /v1/audio/transcriptions`。只下载官方模型或安装 FunASR 不会自动出现这个服务；不能用任意上游示例服务替代而假定接口相同。恢复来源见 [安装目录说明](README.md#新机器恢复时需要保留的本地文件)。

## 4 启动后验收

按总览显式使用 `-Device cpu`，然后执行：

```powershell
Invoke-RestMethod 'http://127.0.0.1:8001/health' -NoProxy
curl.exe --noproxy "*" 'http://127.0.0.1:8001/v1/audio/transcriptions' -F 'file=@D:\Development\IndexTTS\prompts\vo-10s.wav' -F 'language=zh' -F 'model=SenseVoiceSmall'
```

确认设备为 CPU、返回 `text`、`raw_text` 和 `elapsed_seconds`，且识别内容与音频一致。GPU 模式的历史耗时不是 CPU 的验收数据；新机器安装和 CPU 推理要分别验证。
