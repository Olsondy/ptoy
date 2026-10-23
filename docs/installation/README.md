# 安装资料

本目录保存三个模型的下载与安装步骤。[部署总览](../deployment-overview.md) 串起安装、手动启动和应用连接；架构、服务参数和性能数据统一维护在 [服务端架构](../architecture/server.md)。

## 安装顺序

1. 准备 Windows 上的 Git、PowerShell 7、Conda 和可用的 NVIDIA 驱动，确认 `nvidia-smi` 能识别显卡。IndexTTS 与 SenseVoice 各自使用 Python 3.11 环境。
2. 按 [IndexTTS 2.5](IndexTTS-2.5.md) 准备程序、主权重、辅助权重和参考音频。
3. 按 [Huihui Qwen3 8B](Huihui-Qwen3-8B-abliterated-v2.Q5_K_M.md) 准备 llama.cpp、GGUF 和对话模板。
4. 按 [SenseVoiceSmall](SenseVoiceSmall.md) 准备权重、FunASR 环境和本地 API 封装。
5. 安装 Node.js 22 或更新版本、pnpm 10.18.0 以及 [LiveKit Server](https://github.com/livekit/livekit/releases)，然后回到总览配置 ptoy。

现有机器已完成模型安装，不要重复创建环境、克隆目录或覆盖配置。仓库的 Node/pnpm 要求来自根目录 `package.json`。FFmpeg 可执行程序当前放在 `D:\Development\ffmpeg-7.1.1-full_build\bin`；这是外部程序，安装 Python 的 `ffmpeg-python` 不会提供它。

## 三类目录分别保存什么

| 目录 | 内容 |
|---|---|
| `D:\Resources\MyWorkspace\ai\models\<模型名>` | 权重、模型说明、唯一的 `Start-*.ps1` 入口 |
| `D:\Development\<程序名>` | 推理代码、实际启动脚本、参考音频、运行日志 |
| `D:\Resources\MyWorkspace\ai\conda\envs\<环境名>` | Python、PyTorch 和各模型的依赖 |

模型入口脚本只转调程序目录脚本；移动权重时要改实际脚本的模型路径，移动程序时还要改入口脚本的目标路径。

## 新机器恢复时需要保留的本地文件

Hugging Face 提供的是模型文件，不包含这台机器的 HTTP 服务和启动脚本。ptoy 通过 HTTP 使用它们，也不会通过 `pnpm install` 自动安装它们。迁移前保存：

- 三个模型目录的 `Start-*.ps1`。
- llama.cpp 的 `llama-8b.ps1` 和 `templates/huihui-qwen3-8b-v2.jinja`。
- IndexTTS 的本地 `webui.py` 修改、`start-local.ps1`、`download-aux-local.py` 和参考音频；辅助模型也要保留。
- SenseVoice 的 `server.py`、`start-local.ps1` 和 `requirements-lock.txt`。

这些本地定制文件当前位于仓库外，新机器不能只克隆 ptoy 就获得它们。复制后逐项修改路径并检查依赖；不要直接搬移 Conda 环境目录。安装文档中的环境创建命令面向新环境，日常启动不需要激活 Conda。

## 下载检查

使用 Motrix 时按各模型清单保存原始文件名和子目录。同名 `config.json` 不属于同一个模型时不能互相覆盖。`.aria2` 文件仍存在时先确认下载完成；预分配后的文件大小不能单独证明下载成功。主权重可用 `Get-FileHash -Algorithm SHA256` 与模型安装页的校验值对照。
