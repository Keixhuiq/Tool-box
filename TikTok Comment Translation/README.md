# TikTok Comment Translation

为 TikTok 网页端评论添加翻译按钮。基于 [DuckCIT/TikTok-Comment-Translator](https://github.com/DuckCIT/TikTok-Comment-Translator) 的修改版。

## 支持的翻译服务商

- **Google 翻译**：免费，无需配置
- **Gemini**：需自填 key，默认 `gemini-2.5-flash`
- **OpenAI 兼容**：自填 endpoint + model + key，覆盖 OpenAI 官方 / DeepSeek / OpenRouter / SiliconFlow / 自部署 vLLM / Ollama 等所有 OpenAI 协议端点
- **Anthropic Claude**：需自填 key，默认 `claude-haiku-4-5-20251001`

## v1.3.0 更新

- 所有翻译和连接测试请求改由后台 Service Worker 发起，自定义 OpenAI 兼容端点不再受 TikTok 页面 CORS 限制。
- 自定义 OpenAI endpoint 在点击“测试连接”时按域名申请访问权限；内置官方端点无需额外授权。
- 修复 TikTok 单页应用切换视频后评论翻译按钮不再出现的问题。
- 修复多行评论读取时丢失换行的问题，并改进 Google 翻译对超长文本和中日韩字符 URL 长度的处理。
- 同一条评论的并发翻译请求会复用同一个 Promise，翻译期间按钮进入 loading 状态，避免重复请求。
- 认证错误和配置错误不再静默降级到 Google；限流、服务端、网络、超时或内容安全拦截仍可按设置降级。
- Gemini、OpenAI 兼容和 Anthropic 的最大输出提高到 2048 tokens，并检测输出被截断的情况。
- 集中管理 TikTok DOM 选择器，限制 `languages.json` 仅对 TikTok 页面可访问。

## 与原版的主要区别

对比基准：原项目 `DuckCIT/TikTok-Comment-Translator`，`manifest.json` 版本 `1.0.1`。

### 架构与权限

- 原版只有 Google 翻译，核心逻辑集中在 `content.js`；本版新增 `providers.js`，把 Google、Gemini、OpenAI 兼容端点和 Anthropic Claude 抽象成统一 provider。
- 原版的 `background.js` 用于检查 GitHub 上的 `data/version.json` 并通过通知提醒更新；本版不保留该更新检查，也不需要 `tabs` / `notifications` 权限。
- 本版的 `background.js` 是翻译请求代理：content script 和 popup 通过消息调用后台，由扩展的 host permissions 处理跨域请求。这样自定义 OpenAI 兼容端点无需依赖目标服务器向 TikTok 页面开放 CORS。
- Google、Gemini、Anthropic 和 OpenAI 官方端点预先声明访问权限；其它自定义 OpenAI endpoint 使用可选权限，并在用户点击“测试连接”时按 origin 请求授权。
- `data/languages.json` 仅允许 TikTok 页面访问，不再暴露给所有网页。
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
- 本版用 `innerText` 读取评论，使 TikTok 通过 `<br>` 渲染的多行评论能保留换行。
- 本版把评论区观察器固定在 `document.body`，切换视频并替换评论容器后仍会继续为新评论添加按钮。
- TikTok DOM 选择器集中在 `SELECTORS` 中，网站结构变化时更容易集中维护。

### 性能与错误处理

- 原版缓存是普通 `Map`，没有容量上限；本版改为最多 1000 条的 LRU 缓存，并缓存进行中的 Promise，使同一文本的并发点击只发送一次请求。失败的 Promise 会从缓存删除，允许重试。
- 本版增加全局并发上限 3，避免连续点击大量评论时同时打出太多请求。
- 后台 Service Worker 为每次翻译请求设置 20 秒超时。
- 翻译进行中按钮会进入 loading 状态并拒绝重复点击。
- 本版提供“LLM 失败时自动降级到 Google 翻译”开关。
- 认证/配置类错误（例如缺 key、缺 endpoint、缺 model、401/403、模型名或请求参数错误）不会自动降级，以免隐藏真实配置问题。
- 429 限流、5xx、网络错误、超时、响应解析失败和内容安全拦截会按降级开关回退到 Google。
- Google 翻译按 URL 编码后的长度切分超长文本，避免中日韩字符编码后导致请求 URL 过长。
- Gemini、OpenAI 兼容和 Anthropic 的最大输出为 2048 tokens；检测到输出因 token 上限被截断时，会按降级规则处理。

### Popup 与设置

- 原版 popup 只有目标语言下拉框。
- 本版 popup 增加 provider 选择、不同 provider 的 key/model/endpoint 配置、测试连接按钮和降级开关。
- “测试连接”和正式翻译使用同一条后台请求链路；自定义 OpenAI endpoint 的访问权限也在该按钮的用户操作中申请。
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
background.js       # 跨域翻译请求、超时、错误分类与降级
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
