# 音色按角色：角色文件声明 voice，TTS 服务按请求选参考音频

状态：accepted · 2026-10-24

每个角色在 front matter 里写 `voice: <id>`（必填）。`services/tts` 启动时从 `TTS_VOICES_DIR` 读入所有 `<id>.wav` 作为可选音色，`POST /tts` 带 `voice` 选参考音频，不带则用 `TTS_DEFAULT_VOICE`。预录语气词按音色分目录 `assets/fillers/<id>/`，Agent 播放这通电话角色音色的那一套。模型仍只加载一份：换音色只是换 `infer()` 的参考音频路径，不增加显存。

原因：角色在拨号时就定了（ADR 0007），音色是角色的一部分，跟人设写在同一个文件里，新增角色时不会漏配。参考音频是 Windows 本机文件、不进仓库，所以服务端按 id 管理，Agent 只传 id。语气词和正式回复必须是同一个声音，否则听起来像另一个人先接了一句；某个音色还没录语气词时，这通电话就不播语气词，而不是用别的声音代替。

## 换音色的开销

IndexTTS2 只缓存最近一次参考音频的说话人特征（按路径），换音色后的第一句要重新提取。为了不让第一句回复承担这部分耗时，Agent 在通话开始时调用 `POST /warm {voice}`：服务器已经加载的就是这个音色时直接返回，否则在 GPU 队列里合成一句丢弃的短句。一通电话只用一个音色，所以只有前后两通电话角色音色不同时才会真正预热。预热实际耗时要在 Windows 本机测（`services/tts` 日志的 `warmed voice`、Agent 日志的 `tts voice ready`）。

## Considered Options

- **每个音色单独起一个 TTS 进程**：切换没有开销，但每份 IndexTTS2 约 5GB 显存，16GB 卡放不下第二份。
- **服务端预先把所有音色的说话人特征算好、放进多份缓存**：切换零开销，但要改 IndexTTS2 内部的缓存字段（`cache_spk_cond`、`cache_s2mel_style` 等），本机用的是非官方分支，没有稳定接口。等实测预热耗时不能接受时再考虑。
- **音色配置放在 Agent 的环境变量里（角色 id → 参考音频）**：角色和音色分在两个地方维护；而且参考音频在服务端，Agent 无从校验。
- **`voice` 可选、缺省用服务端默认音色**：新增角色时容易忘了配，而且语气词无法知道该用哪一套。

## Consequences

- 部署：Windows 上建一个音色目录（如 `D:\Development\IndexTTS\prompts\voices\`），每个音色一个 `<id>.wav`，TTS 服务入口脚本设置 `TTS_VOICES_DIR` 和 `TTS_DEFAULT_VOICE`。只设置 `TTS_REF_AUDIO` 时音色 id 是它的文件名（不含扩展名），和角色文件里的 `voice:` 对不上的话，`/tts` 会返回 `422 unknown_voice`。
- 新增音色：放入 `<id>.wav` 后重启 TTS 服务；用 `services/fillers/generate.py --voice <id>` 生成这个音色的语气词并提交；然后在角色文件里写 `voice: <id>`。单测会检查仓库里每个角色的音色都有一套语气词。
- `TTS_BACKEND=gradio`（阶段 1）不支持按角色切换音色，所有角色都用 Agent 的 `TTS_REF_AUDIO`，Agent 启动通话时会记一条警告。
- ADR 0007 中“所有角色共用同一个音色”的那一条由本 ADR 取代。
