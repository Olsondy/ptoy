# llama-server 用单模型模式，固定全部层放到 GPU 上

状态：accepted · 2026-10-23

llama-server 用 `-m` 加载单个模型，并设置 `-ngl 99 --fit off`；不使用路由模式（`--models-max`），也不使用自动适配显存（`--fit-target`）。原因：LLM 和 IndexTTS 共用 16GB 显卡，自动适配会根据启动时的空闲显存把一部分层悄悄放到 CPU 上；Windows 驱动默认的系统内存回退又会把显存不足掩盖成“变慢”而不报错。固定配置可以让显存问题以启动失败的形式暴露出来。路由模式还有按需加载、空闲卸载的问题，会让通话中出现数秒的停顿。

## Consequences

启动顺序必须是先启动 IndexTTS，再启动 llama-server；NVIDIA 控制面板里的 CUDA 系统内存回退策略要设为“首选无系统内存回退”。完整参数见 `docs/architecture/server.md`。
