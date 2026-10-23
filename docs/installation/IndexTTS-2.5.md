# IndexTTS 2.5 下载与安装

用于按参考音色合成语音。运行配置统一见 [架构部署基线](../architecture/server.md#本机部署基线)，安装完成后回到 [总览](../deployment-overview.md) 启动。本页主模型和辅助模型清单来自已核对的本机部署资料。

## 下载地址

- [官方模型仓库](https://huggingface.co/IndexTeam/IndexTTS-2.5)
- [官方文件列表](https://huggingface.co/IndexTeam/IndexTTS-2.5/tree/main)
- [官方程序仓库](https://github.com/index-tts/index-tts)

官方主仓库约 5.49 GB，另外还需要下方列出的辅助权重。模型是 `.pth`、`.pt`、`.safetensors` 等文件的组合，使用 Python/PyTorch 推理。

### 主模型文件

下列 8 个文件直接放入 `D:\Resources\MyWorkspace\ai\models\IndexTTS-2.5`。可将整段直链复制到 Motrix：

```text
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/codec.pth
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/config.yaml
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/feat1.pt
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/feat2.pt
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/gpt.pth
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/multilingual_zh_ja_yue_char_del.tiktoken
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/s2mel.pth
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/wav2vec2bert_stats.pt
```

### QwenEmotion 文件

以下文件全部放在模型目录下的 `qwen0.6bemo4-merge` 子目录。本机已下载，当前为节省显存而不加载；文字描述情绪功能需要启用该模块。情绪滑块和情感参考音频仍可使用。

```text
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/qwen0.6bemo4-merge/Modelfile
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/qwen0.6bemo4-merge/added_tokens.json
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/qwen0.6bemo4-merge/chat_template.jinja
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/qwen0.6bemo4-merge/config.json
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/qwen0.6bemo4-merge/generation_config.json
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/qwen0.6bemo4-merge/merges.txt
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/qwen0.6bemo4-merge/model.safetensors
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/qwen0.6bemo4-merge/special_tokens_map.json
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/qwen0.6bemo4-merge/tokenizer.json
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/qwen0.6bemo4-merge/tokenizer_config.json
https://huggingface.co/IndexTeam/IndexTTS-2.5/resolve/main/qwen0.6bemo4-merge/vocab.json
```

### 辅助权重

保存位置均相对于 `D:\Resources\MyWorkspace\ai\models\IndexTTS-2.5`：

| 保存位置 | 下载地址 |
|---|---|
| `hf_cache/w2v-bert-2.0/model.safetensors` | [下载](https://huggingface.co/facebook/w2v-bert-2.0/resolve/main/model.safetensors) |
| `hf_cache/w2v-bert-2.0/config.json` | [下载](https://huggingface.co/facebook/w2v-bert-2.0/resolve/main/config.json) |
| `hf_cache/w2v-bert-2.0/preprocessor_config.json` | [下载](https://huggingface.co/facebook/w2v-bert-2.0/resolve/main/preprocessor_config.json) |
| `hf_cache/campplus_cn_common.bin` | [下载](https://huggingface.co/funasr/campplus/resolve/main/campplus_cn_common.bin) |
| `hf_cache/bigvgan/config.json` | [下载](https://huggingface.co/nvidia/bigvgan_v2_22khz_80band_256x/resolve/main/config.json) |
| `hf_cache/bigvgan/bigvgan_generator.pt` | [下载](https://huggingface.co/nvidia/bigvgan_v2_22khz_80band_256x/resolve/main/bigvgan_generator.pt) |

本机 IndexTTS 2.5 的语义编解码器使用主目录的 `codec.pth`；当前推理路径不需要另下 MaskGCT 的旧版语义编解码器权重。辅助文件下载方式可参考本机 [download-aux-local.py](D:/Development/IndexTTS/download-aux-local.py)。

各子目录中存在同名的 `config.json`、`model.safetensors`，不要混到同一个目录。若下载器把文件保存成哈希名称，应核对完整性后恢复以上文件名；存在 `.aria2` 时先等待下载完成。

## 安装程序和独立环境

已有 `D:\Development\IndexTTS` 和 `indextts` 环境时跳过创建步骤。新机器先恢复本地定制文件备份；程序可从官方仓库取回与本机一致的源码基线：

```powershell
git clone https://github.com/index-tts/index-tts.git 'D:\Development\IndexTTS'
git -C 'D:\Development\IndexTTS' checkout d9e41aac89fd00b3d71497fddb287b7f24613712
conda create --prefix 'D:\Resources\MyWorkspace\ai\conda\envs\indextts' python=3.11 pip -y
& 'D:\Resources\MyWorkspace\ai\conda\envs\indextts\python.exe' -m pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
```

安装 WebUI 依赖。以下命令基于该版本 `pyproject.toml`，不安装可选的 DeepSpeed、accel 和 torch_compile：

```powershell
Push-Location 'D:\Development\IndexTTS'
try {
    & 'D:\Resources\MyWorkspace\ai\conda\envs\indextts\python.exe' -m pip install -e '.[webui]'
    & 'D:\Resources\MyWorkspace\ai\conda\envs\indextts\python.exe' -m pip check
} finally {
    Pop-Location
}
```

依赖安装命令是按当前项目声明整理的重装步骤，本次没有重建环境。上游部分依赖使用范围版本；需要精确恢复现有环境时，先导出其 `pip freeze` 清单并保存源码版本及本地修改，再按清单安装验证。不要默认未来新解析的环境已经通过本机验证。

## 恢复本地调整与音频

当前官方源码的 `webui.py` 有本地调整，支持启动脚本使用的 `--no_qwen_emo`、`--reference_audio` 等设置，并调整默认值。新机器要恢复这份修改，以及 `start-local.ps1`、`download-aux-local.py`；仅克隆上游后直接执行现有入口并不完整。相关备份清单见 [安装说明](README.md#新机器恢复时需要保留的本地文件)。

模型目录入口为：

```text
D:\Resources\MyWorkspace\ai\models\IndexTTS-2.5\Start-IndexTTS.ps1
```

它调用 `D:\Development\IndexTTS\start-local.ps1`，后者直接使用独立环境的 Python。恢复后检查程序、模型、环境、FFmpeg 和 `NLTK_DATA` 的路径；本机 NLTK 数据目录是 `D:\Resources\MyWorkspace\ai\cache\nltk_data`，迁移时一起保留已有数据。

`Start-IndexTTS.ps1` 的入口内容如下：

```powershell
$ErrorActionPreference = 'Stop'
Write-Host 'IndexTTS code: D:\Development\IndexTTS'
Write-Host 'Model weights: D:\Resources\MyWorkspace\ai\models\IndexTTS-2.5'
Push-Location
try {
    & 'D:\Development\IndexTTS\start-local.ps1'
}
finally {
    Pop-Location
}
```

`start-local.ps1` 内部需要在代码目录运行 `webui.py`，应使用 `Push-Location -LiteralPath $PSScriptRoot`，并把后续启动逻辑放在 `try { ... } finally { Pop-Location }` 中，避免直接使用 `Set-Location` 后不恢复目录。

参考音频原件为 `F:\ALL\vo-10s.wav`；启动脚本使用的副本是：

```text
D:\Development\IndexTTS\prompts\vo-10s.wav
```

保持音频文件可读。用 WebUI 时，ptoy Agent 还要在 `.env` 设置自己的 `TTS_REF_AUDIO`（所有角色共用这一个音色）；用下面的 API 服务时音色由服务端的音色目录提供，Agent 只按角色传音色 id。

## ptoy 使用的 API 服务

ptoy 默认用仓库里的 `services/tts/server.py`（:8002）代替 WebUI：同一套模型和参考音频，常驻加载，直接返回 PCM，打断时能取消合成。它和 WebUI 不能同时运行。服务的环境变量见 [services/tts/README.md](../../services/tts/README.md)。

在模型目录新建入口 `D:\Resources\MyWorkspace\ai\models\IndexTTS-2.5\Start-IndexTTS-API.ps1`（与 `Start-IndexTTS.ps1` 并列，不入库）：

```powershell
$ErrorActionPreference = 'Stop'
$envRoot = 'D:\Resources\MyWorkspace\ai\conda\envs\indextts'
$env:PATH = "$envRoot;$envRoot\Library\bin;$envRoot\Scripts;D:\Development\ffmpeg-7.1.1-full_build\bin;$env:PATH"
$env:NLTK_DATA = 'D:\Resources\MyWorkspace\ai\cache\nltk_data'
$env:NO_PROXY = 'localhost,127.0.0.1'

$env:INDEXTTS_DIR  = 'D:\Development\IndexTTS'
$env:TTS_MODEL_DIR = 'D:\Resources\MyWorkspace\ai\models\IndexTTS-2.5'
$env:TTS_VOICES_DIR    = 'D:\Development\IndexTTS\prompts\voices'
$env:TTS_DEFAULT_VOICE = 'default-relaxing'

Write-Host "IndexTTS code: $env:INDEXTTS_DIR"
Write-Host "Model weights: $env:TTS_MODEL_DIR"
Write-Host "Voice files:   $env:TTS_VOICES_DIR"
Push-Location
try {
    & "$envRoot\python.exe" 'D:\Resources\MyWorkspace\ai\ptoy\services\tts\server.py'
}
finally {
    Pop-Location
}
```

两个入口脚本都在退出时恢复调用前的 PowerShell 目录，包括正常退出、启动报错和 Ctrl+C 中断（强制关闭整个进程除外）。

启动脚本所在目录不决定模型或代码的位置。`INDEXTTS_DIR` 指向执行推理的程序，`TTS_MODEL_DIR` 指向模型权重；启动模型就是由程序读取权重并执行推理。API 日志中的 `loading IndexTTS2 from ...` 表示代码目录，后面的 `model dir ...` 才表示权重目录。服务为兼容模型代码里的相对路径，会切换 Python 子进程的工作目录，这不会改变外层 PowerShell 的目录。

`voices` 目录里每个音色一个 `<id>.wav`，id 要和角色文件（`apps/agent/prompts/characters/*.md`）的 `voice:` 一致，当前是 `default-relaxing.wav`（小悠，素材包“治愈放松女声”截到 12.3s）和 `gentle.wav`（知夏）。增删音色后重启服务（ADR 0008）。

服务默认与当前 WebUI 配置一致：v2.5、半精度（BF16）、不加载 QwenEmotion、`num_beams=1`。`TTS_MODEL_DIR` 必须指向上面的模型目录；不设置时会去 `<INDEXTTS_DIR>\checkpoints` 找 `config.yaml`。

## 安装后检查

API 服务（ptoy 默认）：

```powershell
Invoke-RestMethod 'http://127.0.0.1:8002/health' -NoProxy
python 'D:\Resources\MyWorkspace\ai\ptoy\services\tts\bench.py' --save-wavs bench_out
```

`health` 应返回 `status: ok`；`bench.py` 输出各长度句子的合成耗时，`--save-wavs` 保存的音频播放确认有声音、音色正确。

WebUI：

```powershell
(Invoke-RestMethod 'http://127.0.0.1:7860/gradio_api/info' -NoProxy).named_endpoints.'/gen_single'
```

应能看到 `/gen_single` 的参数说明，再在网页合成一句中文试听。

两种方式都是整句生成后返回，应用通过分段合成衔接播放；不要把它当作原生流式 TTS。
