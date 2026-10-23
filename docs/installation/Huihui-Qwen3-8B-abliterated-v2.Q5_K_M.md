# Huihui Qwen3 8B Q5_K_M 下载与安装

用于 ptoy 的中文聊天。文件格式为 GGUF，通过原生 llama.cpp CUDA 程序推理，不需要 Python 或 Conda。运行参数统一见 [架构第 5 节](../architecture/server.md#5-llama-server-配置)，安装后回到 [总览第二层](../deployment-overview.md#第二层-启动流程)。

## 1 下载程序和模型

- [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases)：选择适合 Windows x64 和 NVIDIA CUDA 的发布包，按同一发布版本提供的依赖说明解压，保留配套 DLL。程序放到 `D:\Development\llama.cpp`，确认存在 `llama-server.exe`。
- [原模型](https://huggingface.co/huihui-ai/Huihui-Qwen3-8B-abliterated-v2)。
- [本机 GGUF 对应量化仓库](https://huggingface.co/mradermacher/Huihui-Qwen3-8B-abliterated-v2-GGUF/tree/main)。

Motrix 权重直链：

```text
https://huggingface.co/mradermacher/Huihui-Qwen3-8B-abliterated-v2-GGUF/resolve/main/Huihui-Qwen3-8B-abliterated-v2.Q5_K_M.gguf
```

保存到：

```text
D:\Resources\MyWorkspace\ai\models\Huihui-Qwen3-8B-abliterated-v2.Q5_K_M\Huihui-Qwen3-8B-abliterated-v2.Q5_K_M.gguf
```

文件大小为 5,851,109,120 字节（约 5.45 GiB），本机已核对 SHA-256：

```text
2334bb2c7c2dd76cbd48da98a095c269dbe5a449124214a6456d5768f6114159
```

检查命令：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath 'D:\Resources\MyWorkspace\ai\models\Huihui-Qwen3-8B-abliterated-v2.Q5_K_M\Huihui-Qwen3-8B-abliterated-v2.Q5_K_M.gguf'
```

## 2 安装对话模板

下载：

```text
https://huggingface.co/huihui-ai/Huihui-Qwen3-8B-abliterated-v2/resolve/main/chat_template.jinja
```

保存为 `D:\Development\llama.cpp\templates\huihui-qwen3-8b-v2.jinja`。当前关闭思考的配置依赖此模板，不要只复制 GGUF。

## 3 恢复启动文件并检查

保留或从现有部署备份中恢复：

- `D:\Development\llama.cpp\llama-8b.ps1`：实际参数配置。
- `D:\Resources\MyWorkspace\ai\models\Huihui-Qwen3-8B-abliterated-v2.Q5_K_M\Start-Qwen3-8B.ps1`：模型目录唯一入口。

两份脚本是本机文件，Hugging Face 和 llama.cpp 发布包不会提供它们。迁移后检查实际脚本的 `$model`、可执行文件和模板路径；入口负责调用实际脚本。

只检查文件和打印参数，不加载模型：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File 'D:\Resources\MyWorkspace\ai\models\Huihui-Qwen3-8B-abliterated-v2.Q5_K_M\Start-Qwen3-8B.ps1' -DryRun
```

随后按总览启动并发送真实聊天请求。换 llama.cpp 版本后需确认现有参数仍被支持；新增或替换 GPU 模型时遵守仓库压测规则。
