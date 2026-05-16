# TikTok Comment Translation

为 TikTok 网页端评论添加翻译按钮。基于 [DuckCIT/TikTok-Comment-Translator](https://github.com/DuckCIT/TikTok-Comment-Translator) 的修改版。

## 支持的翻译服务商

- **Google 翻译**：免费，无需配置
- **Gemini**：需自填 key，默认 `gemini-2.5-flash`
- **OpenAI 兼容**：自填 endpoint + model + key，覆盖 OpenAI 官方 / DeepSeek / OpenRouter / SiliconFlow / 自部署 vLLM / Ollama 等所有 OpenAI 协议端点
- **Anthropic Claude**：需自填 key，默认 `claude-haiku-4-5-20251001`

## 与原版的主要区别

对比基准：原项目 `DuckCIT/TikTok-Comment-Translator`，`manifest.json` 版本 `1.0.1`。

### 架构与权限

- 原版只有 Google 翻译，核心逻辑集中在 `content.js`；本版新增 `providers.js`，把 Google、Gemini、OpenAI 兼容端点和 Anthropic Claude 抽象成统一 provider。
- 原版包含 `background.js`，用于检查 GitHub 上的 `data/version.json` 并通过 `notifications` 提醒更新；本版移除了后台更新检查，因此也不再需要 `tabs` / `notifications` 权限。
- 原版只有一个 `icons/icon.png`；本版提供 `16 / 32 / 48 / 128` 多尺寸图标。
- 本版新增 `content.css`，把注入到 TikTok 页面里的按钮样式从 JS 中拆出来。

### 翻译服务

- 原版只调用 Google Translate 的公开接口，免费且无需配置。
- 本版保留 Google 翻译，并新增 Gemini、OpenAI 兼容端点、Anthropic Claude。
- Gemini / OpenAI 兼容 / Anthropic 都需要用户自己填写 key；插件不内置任何 API key。
- OpenAI 兼容模式接受自定义 endpoint、model 和 key，可用于 OpenAI 官方、DeepSeek、OpenRouter、SiliconFlow、自部署 vLLM / Ollama 等兼容 OpenAI Chat Completions 协议的服务。
- LLM provider 共用同一套翻译 prompt，要求保留 emoji、@用户名、#标签，并在原文已经是目标语言时原样返回。

### 评论处理逻辑

- 原版在给每条评论添加按钮前，会先请求一次 Google 接口，借返回值里的语言字段判断原文是否已经是目标语言；如果相同就不显示翻译按钮。
- 本版移除了这个预检测请求，评论按钮直接显示，减少滚动评论区时的额外 Google 请求。
- 由于不再预检测，使用 Google provider 时，用户点击按钮后仍会由 Google 自动翻译；使用 LLM provider 时，prompt 会要求“原文已是目标语言则原样返回”。
- 原版切换目标语言后需要刷新 TikTok 页面才能让 content script 重新读取设置；本版监听 `chrome.storage.onChanged`，切换语言、provider、model、endpoint 或 key 后会实时更新设置并清理缓存。

### 性能与错误处理

- 原版缓存是普通 `Map`，没有容量上限；本版改为最多 1000 条的 LRU 缓存。
- 本版增加全局并发上限 3，避免连续点击大量评论时同时打出太多请求。
- 本版每次翻译请求使用 `AbortController`，默认 20 秒超时。
- 本版提供“LLM 失败时自动降级到 Google 翻译”开关。
- 认证/配置类错误（例如缺 key、缺 endpoint、缺 model、401/403）不会自动降级；网络错误、超时、服务端错误等非认证错误会按降级开关处理。部分 provider 返回的 400/429 会被归类为非认证错误，因此在开启降级时可能会回退到 Google。

### Popup 与设置

- 原版 popup 只有目标语言下拉框。
- 本版 popup 增加 provider 选择、不同 provider 的 key/model/endpoint 配置、测试连接按钮和降级开关。
- 原版默认目标语言是越南语；本版默认目标语言是中文。
- 原版目标语言包括越南语、英语、中文、俄语、西班牙语、法语；本版在此基础上新增日语和韩语。
- 普通偏好保存在 `chrome.storage.sync`；API key 保存在 `chrome.storage.local`，不会随 Google 账号同步到其它设备。

### DOM 写入与样式

- 原版用 `innerHTML` 写入翻译结果和恢复原文。
- 本版改用 `textContent` 加 `<br>` 节点写入多行文本，避免把翻译结果当 HTML 解析。
- 本版会读取同一条评论里“回复”按钮的实际渲染样式，并应用到翻译按钮上，让一级/二级评论里的按钮更贴近 TikTok 原生样式。

## 安装

1. 打开 `chrome://extensions/`（或 Edge 的扩展页）
2. 打开"开发者模式"
3. 选"加载已解压的扩展程序"，选这个文件夹

## 文件结构

```
manifest.json
providers.js        # provider 抽象层
content.js          # 评论页注入逻辑
content.css         # 按钮样式
popup/
  popup.html
  popup.js
data/
  languages.json    # UI 文案
screenshots/
  demo.gif
  language-select.png
```

## 许可

MIT（继承自原项目）。
