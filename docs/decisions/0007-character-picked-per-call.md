# 角色按通话选择：prompt 目录 + token 里的参与者属性

状态：accepted · 2026-10-24

角色从单个 `character.md` 改成一个目录 `apps/agent/prompts/characters/`：每个角色一个 `<id>.md`（front matter 写 `name`、`description`，正文是人设），所有角色共用的通话规则放在同目录的 `_rules.md`，拼在人设后面组成 system prompt。页面在拨号前选角色，选择随 `POST /api/token` 交给 token 服务；token 服务校验后把角色 id 写进来电者的参与者属性 `ptoy.character`，Agent 在来电者入房时读取，整通电话固定用这个角色。

原因：一通电话本来就是一个新房间、一个新会话（ADR 0002），角色在拨号时决定最自然；token 是浏览器和 Agent 之间唯一由服务端签名的通道，角色 id 放在里面不用新增信令，Agent 一进房就能拿到，不会出现“先用默认角色开口、再切换”的窗口。通话规则（字数、语气词衔接、情绪标签，ADR 0004 / 0006）是链路契约而不是人设，单独一份，新增角色不会漏掉或改坏它们。

## Considered Options

- **通话中切换角色**（数据通道发消息，Agent 调 `updateInstructions`）：历史里前一个角色的话会让新角色说话混乱，还要处理正在播放的回复；当前没有这个需求。
- **Agent dispatch metadata / 房间 metadata**：要么改成显式 dispatch，要么要用房间管理 API 先建房间，都比在已有的 token 上加一个属性复杂。
- **每个角色一份完整 prompt**（不拆 `_rules.md`）：最直观，但情绪标签规则要在每个文件里同步维护；`emotion:compliance` 的实测结论也只对一份规则成立。

## Consequences

- 所有角色共用同一个音色（`TTS_REF_AUDIO` / `services/tts` 的参考音频）和同一套预录语气词，人设要写成这个声音能说的样子。按角色切换音色要让 TTS 服务支持按请求选参考音频、语气词按音色分组，届时另开 ADR。
- 新增角色：在目录里放一个 `<id>.md` 即可，下一通电话生效，不用重启；`DEFAULT_CHARACTER`（默认 `xiaoyou`）是页面没选、或选的角色已被删掉时的兜底。
- 改人设或通话规则后，用 `pnpm --filter @ptoy/agent emotion:compliance -- --character <id>` 在真实 LLM 上复测情绪标签遵守率。
- 小悠的 prompt 拆分后内容不变，只是原来“说话方式”里的链路规则移到了 `_rules.md` 的“通话规则”标题下。
