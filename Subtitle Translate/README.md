# Subtitle Translate

Chrome / Edge Manifest V3 扩展，用于在 Netflix 网页端翻译字幕并显示双语字幕。插件会拦截 Netflix 的字幕文件，提前调度翻译任务，尽量在字幕出现前完成译文，减少播放时等待。

## 功能

- 支持 Netflix 网页端字幕翻译。
- 支持 Gemini、Google 免费翻译、OpenAI 兼容端点和 Anthropic Claude。
- OpenAI 兼容端点可填写官方 API、中转站、one-api、vLLM、Ollama 等兼容 Chat Completions 的基础 URL。
- 支持目标语言：中文、English、日本語。
- 支持两种显示模式：
  - 双语替换：隐藏 Netflix 原字幕，插件自绘双语字幕。
  - 原字幕下方：保留 Netflix 原字幕，在原字幕附近显示译文，并继承原字幕样式。
- 支持字幕位置调整。
- 支持上下文窗口：翻译当前字幕时附带前后若干句作为参考，提升指代、语气和剧情连贯性。
- 支持连接测试和自定义 OpenAI 端点动态授权。
- 翻译结果会缓存到 `chrome.storage.session`，同一会话内重复字幕可直接复用。

## 工作方式

插件由两层 content script 组成：

- `interceptor.js` 运行在页面主世界，拦截 `fetch` / `XMLHttpRequest` 中的 Netflix 字幕响应，只读取像字幕的数据，跳过视频和音频分片。
- `bridge.js` 运行在扩展隔离世界，解析 TTML / WebVTT 字幕，管理字幕轨道、调度翻译任务和渲染双语字幕。
- `background.js` 作为 Service Worker 负责实际翻译请求、超时、重试、缓存和自定义端点权限检查。

## 翻译调度

- 当前播放附近的字幕会以 urgent 队列优先翻译。
- 完整字幕轨道稳定后会进行后台预翻译。
- 每个字幕轨道独立管理，避免广告、预览或多语言轨道混入主时间轴。
- 翻译请求使用结构化结果，避免把 `[Music]`、`[Door opens]` 等合法字幕误判为错误。
- 所有网络请求带 15 秒超时，限流、过载、超时和网络错误会在后台做有限重试。

## 设置

打开扩展弹窗可以配置：

- 是否开启翻译。
- API 提供商。
- API Key。
- 自定义模型名。
- OpenAI 兼容 endpoint。
- 目标语言。
- 字幕显示模式。
- 上下文窗口大小。
- 双语替换模式下的字幕位置。

API Key 保存在 `chrome.storage.local`，不会同步到其它设备。

## 安装

1. 下载 Release ZIP 并解压。
2. 打开 `chrome://extensions/` 或 Edge 扩展管理页。
3. 开启“开发者模式”。
4. 选择“加载已解压的扩展程序”。
5. 选择解压后的 `Subtitle Translate` 文件夹。

## 文件结构

```text
manifest.json      # Manifest V3 配置
interceptor.js     # 字幕请求拦截，运行在 MAIN world
bridge.js          # 字幕解析、调度、渲染
background.js      # 翻译请求、缓存、重试、端点权限检查
popup.html         # 设置弹窗
popup.js           # 设置读写、连接测试、动态授权
```

## 注意

- 需要先在 Netflix 播放页开启可用字幕，插件才能捕获并翻译字幕轨道。
- Google 免费翻译使用非官方接口，可能随时失效。
- 使用 Gemini、OpenAI 兼容端点或 Claude 时，请注意 API 用量和费用。
- 自定义 OpenAI endpoint 首次使用前需要在弹窗中点击“测试连接”完成域名授权。
