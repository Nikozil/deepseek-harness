# Agent Note: 作曲器内的本地语音听写麦克风席位

Status: implemented

[English](2026-09-16-composer-voice-dictation.md) | 中文

## 问题

Web GUI 的输入框此前只接受键入内容。标准的语音识别路线与客户端栈"音频永不抵达 Host"的隐私规则冲突：Web Speech API 会把麦克风音频上传到浏览器厂商的语音服务，而 Host 侧转写路线则会把原始音频送上 dsh 线路，并为一段仅仅停留在草稿阶段的文本引入 Host 平面服务。

## 决策

`packages/client/ui-voice-input` 以纯客户端表面插件的形式为输入框添加麦克风席位。浏览器半侧通过 `ctx.slots.inject` 等待 ui-conversation 声明 `conversation.input.left` 列表席位，注册 `voice` 语言字典并挂载 `VoiceButton`；节点半侧是有意为之的空操作。

识别完全在浏览器内完成。`getUserMedia` 与 `AudioContext` 通过以源码文本形式发布的 AudioWorklet 采集 16 kHz 单声道音频；一个由 Blob URL 启动的模块 Worker 动态导入来自 jsDelivr 的固定版本 `@huggingface/transformers@3.8.1`，运行量化 ONNX Whisper 检查点（`Xenova/whisper-tiny`/`-base`/`-small`），后续运行由浏览器缓存供给。采集模块与 Worker 均以源码文本发布，使插件包保持零依赖。RMS 静音门负责结束自动发送的录音：在检测到至少 300 ms 语音后，尾随静音超过配置窗口（可选 0.5–5 s，持久化值收敛到 0.3–10 s）即停止并转写本次录音，录音上限两分钟。转写文本通过 `inputActions.setDraft` 追加进草稿，自动发送时经 `inputActions.submit()` 提交，因此输入框状态机保有草稿的完整权威，任何内容都不会在正常发送路径之外变为模型可见；不新增 session 事件。模型、语言、自动发送与静音时长偏好持久化在 localStorage 的 `dsh.ui-voice-input` 键下，加载时逐字段收敛。

## 曾考虑的替代方案

**Web Speech API（`SpeechRecognition`）。** 否决：Chrome 的实现会把音频发送到 Google 的语音服务，其他引擎缺失或行为不一致，而一个保持音频本地的听写席位不能依赖其中任何一点。

**Host 侧或服务器侧 Whisper。** 就本能力而言否决：原始音频会抵达 Host 进程，并且为了产出客户端独自就能完成的草稿编辑，该特性还要新增 Host 服务、传输与持久化面。

**将 transformers.js 打包为包依赖。** 否决：运行时及其 ONNX 工具链会使动态客户端包膨胀，并为一个仅在 Worker 内使用的库增加 module-graph 行。固定版本的 CDN 导入保持插件包零依赖；代价是首次使用需要一次网络下载。

**经训练的语音活动检测模型（如 Silero VAD）。** 否决：RMS 门已经能为按键说话与自动发送区分语音和尾随静音，第二个模型会使首次下载体积翻倍。

## 后果

首次使用需要网络下载运行时与检查点，之后由浏览器缓存供给。推理是在无 cross-origin isolation 下的单线程 WASM，长录音转写缓慢，且转写不产生中间结果。Worker 以源码文本发布，因此包规范固定其源码，并覆盖席位生命周期、语言字典与设置往返；真实转写依赖浏览器、麦克风与 CDN，不在自动化覆盖范围内。
