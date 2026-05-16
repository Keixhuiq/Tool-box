# TikTok Comment Translation

为 TikTok 网页端评论添加翻译按钮。基于 [DuckCIT/TikTok-Comment-Translator](https://github.com/DuckCIT/TikTok-Comment-Translator) 的修改版。

## 支持的翻译服务商

- **Google 翻译**：免费，无需配置
- **Gemini**：需自填 key，默认 `gemini-2.5-flash`
- **OpenAI 兼容**：自填 endpoint + model + key，覆盖 OpenAI 官方 / DeepSeek / OpenRouter / SiliconFlow / 自部署 vLLM / Ollama 等所有 OpenAI 协议端点
- **Anthropic Claude**：需自填 key，默认 `claude-haiku-4-5-20251001`

## 相对原版的改动

### 翻译质量与扩展性
- Provider 抽象层，加新服务商只需在 `providers.js` 加一个对象
- LLM provider 共用同一份 prompt 模板，保证风格一致
- 温度调到 0.2，减少同一句话每次翻译不一样的情况

### 性能与稳定性
- **移除每条评论一次的语言检测请求**——原版每加载一条评论都会调一次 Google API 来判断"是否已是目标语言"，现在按钮直接显示，LLM prompt 自带"原文已是目标语言则原样返回"逻辑
- 请求超时（默认 20s，可避免 hang 死）
- 全局并发上限 3，避免快速点击触发 429
- LRU 缓存上限 1000 条，长时间使用不会持续吃内存
- 4xx 错误（key 配错、模型名不存在等）不会无声降级到 Google，会显示真实错误

### 体验
- **切换设置无需 F5**：换 provider、换语言、换 key 都实时生效
- popup 加"测试连接"按钮，配完 key 立刻能验证
- popup 切 provider 时，对应字段动态显示/隐藏
- "降级到 Google"做成可选开关，自费 key 用户可以关掉

### 安全
- API Key 从 `chrome.storage.sync` 挪到 `chrome.storage.local`，不再随 Google 账号同步到其它设备
- Gemini 和 Anthropic 的 key 通过 HTTP header 传递（不再拼在 URL query string 里）
- 翻译结果用 `textContent` + `<br>` 元素写入 DOM，不用 `innerHTML`，避免 XSS

### UI
- 默认中文界面（也保留了英文、日韩越俄西法切换）
- 新增日语 / 韩语作为目标语言选项

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
