# TikTok No-Watermark Downloader（v2.1.0）

在 TikTok 网页版下载无水印的视频、图集和视频集。Chrome / Edge Manifest V3 扩展。

姊妹扩展：[Douyin-No-Watermark-Download](../Douyin-No-Watermark-Download) — 共用同一套架构，差异只在数据提取逻辑与 CDN 域。

## 功能

- **无水印**：从 TikTok 返回的接口数据中提取原始资源（视频走 `playAddr`，图片走 TikTok 的 `imageURL.urlList` 中非 watermark 的项），并通过 declarativeNetRequest 重写 Referer，绕过 CDN 403。
- **画质分级 + 智能音频检测**：TikTok 把高清版（如 1080p H.265）做成 `adapt_*` 流，把含音频的合成版做成较低画质的 `normal_*` 流（如 720p H.264）。下载时可选：
  - 「高清」模式（默认）：下 `adapt_*` 流，**自动解析 mp4 box 检测是否含音频轨**——含音频则只下一个 mp4 文件；不含音频则额外下一个 `.m4a` 文件
  - 「兼容」模式：直接下 `normal_*` 合成流，单文件含音频，画质较低
- **三种内容**：单视频、图集（多图）、视频集（图集里内嵌视频）都支持，混合作品也能下。
- **画质选择**：可选最高 / 次高 / 最低画质；最高画质链接失效时会自动降级重试。
- **可拖动悬浮按钮**：右下角的下载按钮可以拖到任意位置，位置会被记住；不喜欢可直接关掉。
- **快捷键**：`Shift + D` 触发下载；可在 `chrome://extensions/shortcuts` 配置全局快捷键。
- **文件名模板**：支持 `{title} {author} {id} {date}` 占位符。
- **保存位置**：用浏览器原生下载触发（`<a download>`），Save As 弹框会自动记住上次保存位置。

## 安装

1. 下载本仓库（Code → Download ZIP，或 `git clone`）。
2. 打开 `chrome://extensions/`，右上角打开「开发者模式」。
3. 点「加载已解压的扩展程序」，选这个文件夹。

更新：把仓库覆盖到原目录，在扩展页点一下扩展卡片右下角的刷新图标即可。

## 使用

打开任意 TikTok 视频/图集页面，按 `Shift + D` 或点右下角按钮即可下载。

按右上角扩展图标可以打开设置面板。

### 视频下载模式

| 模式 | 行为 | 结果 |
| --- | --- | --- |
| **高清**（默认） | 下 `adapt_*` 高清流 → 解析 mp4 → 含音频则只保留视频；不含音频则补下 `.m4a` | 1 个 mp4（多数情况）或 1 个 mp4 + 1 个 m4a |
| **兼容** | 直接下 TikTok 的 `normal_*` 合成流 | 单个含音频的 mp4，画质较低 |

如果遇到分离的两个文件，合并命令：
```bash
ffmpeg -i video.mp4 -i audio.m4a -c copy output.mp4
```

`-c copy` 不重新编码，几秒钟完成，画质零损失。

**关于文件大小**：高清模式的 `.mp4` 可能比兼容模式的 `.mp4` **更小**，但这不代表画质更低——高清版常用 H.265 编码，压缩效率比 720p 用的 H.264 高约 30-50%。所以同样肉眼分辨率下，1080p H.265 的文件可以比 720p H.264 还小。要看真实画质，分辨率/编码器才是准。

**关于 mp4 音频检测**：扩展会在内存里解析下载到的 mp4 头部（前 2 MB）和尾部（末 4 MB），查找 `moov/trak/mdia/hdlr` box 的 handler type 是否为 `soun`。如果找到则跳过音频下载，避免冗余文件。极少数情况（moov 在文件正中间且超大）可能检测不到，此时保守起见仍会下载独立音频。

## 工作原理（简述）

| 文件 | 作用 |
| --- | --- |
| `inject.js` | MAIN world 注入。hook `JSON.parse` + `Response.prototype.json` + `fetch`，扫描 `__UNIVERSAL_DATA_FOR_REHYDRATION__` / `SIGI_STATE` / `__NEXT_DATA__`。提取 `bitrateInfo`（标记是否为 adapt 流）和 `music.playUrl`。 |
| `content.js` | ISOLATED world。负责 UI、当前作品识别、下载调度。视频模式分流（split/merged）+ 多 URL fallback + CORS fallback。 |
| `background.js` | service worker。用 `declarativeNetRequest` 给 TikTok CDN 域的请求改写 Referer；提供 `fetch` 解析 CDN 重定向；为 CORS 受限的 CDN（如音频）代取 ArrayBuffer。下载本身由 content.js 用 fetch+blob+`<a download>` 触发，Save As 弹框会记住上次位置。 |
| `popup.html/css/js` | 设置面板。 |

## 隐私

- 不收集任何数据。
- 所有偏好仅存在你自己的 Chrome 同步存储中。
- `credentials: 'include'` 用于访问 TikTok CDN（某些节点要求登录态），cookie 不会发往其他地方。

## 已知限制

- 信息流（For You / 推荐）滚动时，"当前正在播放的视频"识别可能不准。建议先点开作品再下载。
- **分离模式首次下载时**，浏览器会弹出"tiktok.com 想要下载多个文件，是否允许"——必须点允许，否则后续的音频文件会被静默拦截，只下到视频。这个提示是 Chrome 的安全机制，每个站点只问一次，记住选择。如果误选了"阻止"，可以在地址栏左侧的锁图标里重置。
- **音频是从 `music.playUrl` 取的，可能是原声也可能是配乐**：
  - 如果作品用了自己录制的视频（`music.original = true`），音频与视频画面同步
  - 如果作品用了别人的 BGM，那个 BGM URL 就是音频文件，**这种情况下 BGM 替代了用户原音**——这是 TikTok 数据本身的限制，无法绕过
- TikTok 偶尔会更新接口结构；如果某天突然识别不到，多半是字段路径变了。
- 仅在 TikTok 网页版（`www.tiktok.com`）测试过。

## 开发

代码无构建步骤，纯原生 JS。直接改完在扩展页刷新即可。
打开设置里的「调试日志」可在 Console 看到详细解析过程。
