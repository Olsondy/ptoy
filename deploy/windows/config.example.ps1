# ptoy Windows deploy config.
# Copy this file to config.ps1 (git-ignored) and edit the paths for this machine:
#   Copy-Item deploy\windows\config.example.ps1 deploy\windows\config.ps1
# Every deploy\windows\*.ps1 script dot-sources config.ps1 and reads $Ptoy.

$Ptoy = @{
    # LAN address of this Windows host (used for HTTPS certs, LiveKit node IP and the printed URLs).
    LanIp               = '192.168.31.82'

    # ---- conda ----
    # Root of the conda install (the folder that contains shell\condabin\conda-hook.ps1).
    CondaRoot           = 'D:\Resources\MyWorkspace\ai\conda'

    # ---- IndexTTS2 WebUI (Gradio, GPU) :7860 ----
    # Must be up BEFORE llama-server (see docs/decisions/0005).
    IndexTtsDir         = 'D:\path\to\index-tts'
    IndexTtsEnv         = 'indextts'
    # Command run inside IndexTtsDir with the conda env active. Adjust to how this fork is started.
    IndexTtsCommand     = 'python'
    IndexTtsArgs        = @('webui.py', '--host', '0.0.0.0', '--port', '7860')
    IndexTtsPort        = 7860
    # Seconds to wait for the WebUI to load its models (first start can be slow).
    IndexTtsTimeoutSec  = 600

    # ---- llama-server (llama.cpp, GPU) :8080 ----
    LlamaServerExe      = 'D:\path\to\llama.cpp\llama-server.exe'
    LlamaModel          = 'D:\path\to\models\Qwen3-8B-Q5_K_M.gguf'
    LlamaPort           = 8080
    # Expected value of "offloaded N/N layers to GPU" for Qwen3-8B.
    LlamaExpectedLayers = 37
    LlamaTimeoutSec     = 300

    # ---- ASR (SenseVoice-Small, CPU) :8100 ----
    # Name of the conda env that has services\asr installed (use your existing env if you already have one).
    AsrEnv              = 'ptoy-asr'
    # Local SenseVoice model directory. '' = let funasr download iic/SenseVoiceSmall on first start.
    AsrModel            = ''
    AsrPort             = 8100
    AsrTimeoutSec       = 300

    # ---- LiveKit Server :7880 (TCP), :7881 (TCP), :7882 (UDP) ----
    LiveKitExe          = 'C:\livekit\livekit-server.exe'
    # Pin the IP LiveKit advertises to browsers. Set to '' to let LiveKit pick
    # (it may pick a Hyper-V / WSL / VPN adapter on machines with several NICs).
    LiveKitNodeIp       = '192.168.31.82'

    # ---- Token server (apps/agent) :8787 and agent worker health :8081 ----
    TokenPort           = 8787
    AgentHealthPort     = 8081

    # ---- Web (apps/web) ----
    # 'preview' = production build served by `vite preview` (recommended on this host)
    # 'dev'     = Vite dev server with hot reload
    WebMode             = 'preview'
    WebPreviewPort      = 4173
    WebDevPort          = 5173

    # ---- Optional HTTPS for phones / other LAN devices (Caddy reverse proxy) ----
    EnableHttps         = $false
    CaddyExe            = 'C:\caddy\caddy.exe'
    HttpsWebPort        = 5443
    HttpsLiveKitPort    = 7443

    # ---- Proxy handling ----
    # Hosts that must never go through an HTTP proxy. Set as NO_PROXY/no_proxy in every service window.
    # Setting it also stops Python from picking up the Windows system proxy (e.g. Clash "system proxy"),
    # which breaks Gradio's localhost self-check.
    NoProxy             = 'localhost,127.0.0.1,::1,192.168.31.82'
    # $true removes HTTP_PROXY / HTTPS_PROXY / ALL_PROXY from the service windows entirely.
    ClearProxyEnv       = $false
}
