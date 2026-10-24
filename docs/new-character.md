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

- 产物在 `assets/fillers/<id>/`。逐条听一遍，念错或多出音节的（比如“好的，”念成“好的好的”），用 `--only <filler id>` 单独重做；每次合成都不一样，同一条可以重做几遍，留念得对、又最短的那一遍。
- 一两个字的短文本单独合成时，IndexTTS2 容易拖长或念走样（“我想想”“让我想想啊”拖到 1.5s 以上，“啊，这样啊”念成别的音），参考音频本身慢、`speed` 调得高时更明显。重做几遍仍不行，可以先接受（通话可以关掉语气词：Agent `.env` 的 `FILLERS_ENABLED=false`），之后再改进生成方式。
- 提交 `assets/fillers/<id>/`。没有语气词的音色，通话时不播语气词；单测要求仓库里每个角色的音色都有一套。
- 以后改了 `tts_speed`，要重新生成这个音色的语气词。

## 5. 建角色

### 5.1 新建角色文件

`apps/agent/prompts/characters/<角色id>.md`，文件名就是角色 id（英文小写），和音色 id 可以不同：

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
- `tts_speed`：0.8–1.5，缺省 1.0；`tts_max_pause_ms`：100–1000，缺省用 TTS 服务的设置（400）；`tts_emo_weight`：0–1，带情绪标签的句子的情绪强度，缺省用 `TTS_EMO_WEIGHT`（0.6）。情绪太重（比如“哀”像要哭）就调低，先试听 0.6 / 0.5 / 0.4 / 0.3 几档再定。
- `tts_backends`：角色适用的 TTS 后端，逗号分隔，缺省 `gradio, fastapi`（IndexTTS）。只用 Fish 音色的角色写 `openrouter`，页面只列出与当前 `TTS_BACKEND` 匹配的角色。`tts_style`：仅 `openrouter` 后端使用，每句前加的语气提示，如 `亲密中文耳语，轻声性感`。
- 情绪标签、字数等通话规则在 `_rules.md`，会自动拼在人设后面，人设里不用写。

### 5.2 写人设

照现有角色（`xiaoyou.md`、`zhixia.md`）的结构写，三块内容：

1. **一句话身份**：“你叫……，是用户的……，这会儿正和对方打语音电话。”说清和用户的关系、通话的场景。
2. **你是什么样的人**：性格（3–5 条，写成具体的表现，如“会认真接住对方的情绪，说说自己的感受”，而不只是“温柔”）；明确“你是朋友，不是助手、客服或心理咨询师”，不说“有什么可以帮你”，不说自己是 AI；给一点自己的生活和爱好，聊到时能主动分享。
3. **说话方式**：口语、语气词用多少、句子长短；列出不要说的套话。

注意：

- 性格要和参考音频的语气一致：活泼的人设配撒娇或低沉的音色，听起来会别扭。
- 人设只写“是谁、怎么说话”。回复几句、情绪标签格式这类链路规则都在 `_rules.md`，不要在人设里重复或改写，否则会和规则冲突。
- 不要写 Markdown、表情、括号注释的示例，回复会被直接念出来。

### 5.3 打字试聊

```bash
pnpm --filter @ptoy/agent chat -- --character <角色id>
```

发给 LLM 的内容和通话完全一致（人设 + `_rules.md`、语气提示、切分方式），输入 `怒:……` 模拟对方生气，每轮会打印回复的分段和情绪标签。看几点：语气像不像这个角色、会不会说成客服腔、标签有没有漏。改完人设再用 `pnpm --filter @ptoy/agent emotion:compliance -- --character <角色id>` 复测情绪标签遵守率（ADR 0007）。不要用网页聊天界面判断，那里的设定方式和采样参数都不一样。

## 6. 上线

提交并推送角色文件和语气词，运行 Agent 的机器 `git pull` 后重启 Agent（`pnpm app`）。页面角色菜单里就能选到新角色，打一通电话确认语速、语气和语气词。

## 调整与删除

- **只改语速或停顿**：改角色文件的 `tts_speed` / `tts_max_pause_ms`，重新生成语气词（第 4 步），重启 Agent。TTS 服务不用重启。
- **换参考音频**：覆盖 `<id>.wav`，重启 TTS 服务，重做第 3、4 步。
- **删除音色**：删掉角色文件、`assets/fillers/<id>/` 和 `<id>.wav`，重启 TTS 服务和 Agent。先确认没有其他角色还在用这个 `voice`。
