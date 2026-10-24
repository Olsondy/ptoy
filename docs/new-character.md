# 新增角色与音色

一个角色由三部分组成，用同一个音色 id（下文写作 `<id>`，如 `moli`）串起来：

| 部分 | 位置 | 进仓库 |
|---|---|---|
| 参考音频 | TTS 服务的音色目录 `TTS_VOICES_DIR`（如 `D:\Development\IndexTTS\prompts\voices\<id>.wav`） | 否 |
| 语气词 | `assets/fillers/<id>/` | 是 |
| 角色文件 | `apps/agent/prompts/characters/<角色id>.md`，`voice: <id>` | 是 |

背景见 ADR 0008（音色按角色）、ADR 0009（按角色调语速和停顿）。

## 1. 挑参考音频

- 一段**连续**、**没剪辑**的录音，6–15 秒，单人，纯中文，没有背景音乐和混响。
- 语气就是角色平时说话的样子。参考音频是什么语气，所有回复（包括平静句）就是什么语气：撒娇的参考音频念什么都像在撒娇，朗读腔念聊天内容会生硬。
- 避开：广告口播、旁白朗读、拼接出来的片段（停顿处是完全的数字静音）、压缩很重的配音（每秒响度几乎一样）、夹英文单词。
- 语速太慢的录音克隆出来也慢，后面要靠 `tts_speed` 补。

## 2. 转成 wav 放进音色目录

```powershell
ffmpeg -i 原始音频.mp3 -ac 1 D:\Development\IndexTTS\prompts\voices\<id>.wav
```

- 文件名（不含 `.wav`）就是音色 id，用英文小写和连字符。
- 只认音色目录第一层的 `.wav`。
- 放好后重启 TTS 服务（`Start-IndexTTS-API.ps1`），确认音色已加载：

```powershell
(Invoke-RestMethod 'http://127.0.0.1:8002/health' -NoProxy).voices
```

## 3. 试听，定语速和停顿

```bash
python bench/compare_ref_audio.py --backend fastapi --tts-url http://127.0.0.1:8002 \
    --voices <id> --sweep speed=1.0,1.1,1.2 --sweep max_pause_ms=300
```

打开 `bench/out/ref-ab/index.html`，**听“分段”版本**（和通话一样逐段合成）。同样的参数每次合成都会有差别，每档至少听两遍再下结论。选定的 `speed` 和 `max_pause_ms` 写进第 5 步的角色文件。

## 4. 生成语气词

```bash
python3 -m venv .venv && .venv/bin/pip install -r services/fillers/requirements.txt   # 第一次
.venv/bin/python services/fillers/generate.py --backend fastapi --tts-url http://127.0.0.1:8002 \
    --voice <id> --speed <第 3 步的 speed> --max-pause-ms 300
```

- 产物在 `assets/fillers/<id>/`。逐条听一遍，念错或多出音节的（比如“好的，”念成“好的好的”），用 `--only <filler id>` 单独重做。
- 提交 `assets/fillers/<id>/`。没有语气词的音色，通话时不播语气词；单测要求仓库里每个角色的音色都有一套。
- 以后改了 `tts_speed`，要重新生成这个音色的语气词。

## 5. 写角色文件

`apps/agent/prompts/characters/<角色id>.md`，文件名就是角色 id：

```markdown
---
name: 茉莉
description: 角色菜单里显示的一句话介绍
voice: <id>
tts_speed: 1.1
tts_max_pause_ms: 300
---
你叫茉莉，是……（人设：身份、性格、说话方式）
```

- `name`、`voice` 必填，人设不能为空；front matter 只支持一行一个 `key: value`。
- `tts_speed`：0.8–1.5，缺省 1.0；`tts_max_pause_ms`：100–1000，缺省用 TTS 服务的设置（400）。
- 情绪标签、字数等通话规则在 `_rules.md`，会自动拼在人设后面，人设里不用写。
- 改人设后可以用 `pnpm --filter @ptoy/agent chat -- --character <角色id>` 打字试聊（发给 LLM 的内容和通话一致），`emotion:compliance` 复测情绪标签遵守率（ADR 0007）。

## 6. 上线

提交并推送角色文件和语气词，运行 Agent 的机器 `git pull` 后重启 Agent（`pnpm app`）。页面角色菜单里就能选到新角色，打一通电话确认语速、语气和语气词。

## 调整与删除

- **只改语速或停顿**：改角色文件的 `tts_speed` / `tts_max_pause_ms`，重新生成语气词（第 4 步），重启 Agent。TTS 服务不用重启。
- **换参考音频**：覆盖 `<id>.wav`，重启 TTS 服务，重做第 3、4 步。
- **删除音色**：删掉角色文件、`assets/fillers/<id>/` 和 `<id>.wav`，重启 TTS 服务和 Agent。先确认没有其他角色还在用这个 `voice`。
