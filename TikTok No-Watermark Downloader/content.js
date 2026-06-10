// content.js v2.2.0 - TikTok 无水印下载
// 基于抖音 v4.1 的下载架构 + TikTok 视频/音频分离处理
//
// v2.2.0 变更：
//   1. 移除页面悬浮按钮，下载入口改为扩展弹窗 UI + 快捷键
//      （页内 Shift+D 保留；新增 commands 全局快捷键，默认 Alt+D 可自定义）
//   2. blob URL 延迟 5 分钟再 revoke（30 秒太短，用户在 Save As 弹框里
//      停留超时会导致下载失败）
//   3. MP4 尾部 moov 检测改为字节签名搜索（原实现从任意偏移按 box 结构
//      解析，起点几乎必然落在 mdat 中间，立即失败）
//
// 视频处理策略：
//   1. TikTok 高画质（如 1080p）通常是 DASH adapt 流 - 纯视频，无音频
//      此时 music.playUrl 提供独立音频，需要分别下载
//   2. 普通画质（normal_*）是合成流，含音频
//   3. 用户可在 popup 切换：split=两个文件 / merged=单文件（不要 adapt）
(function () {
    'use strict';

    // ===== 默认配置 =====
    const DEFAULTS = Object.freeze({
        filenameTpl: '{title}@{author}',
        videoMode: 'split',          // 'split' = 视频+音频两文件 / 'merged' = 单文件含音频
        quality: 'best',              // best | second | lowest
        debug: false,
    });

    let CFG = { ...DEFAULTS };

    function loadConfig() {
        return new Promise(resolve => {
            chrome.storage.sync.get(DEFAULTS, items => {
                CFG = { ...DEFAULTS, ...items };
                resolve();
            });
        });
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        for (const k of Object.keys(changes)) {
            if (k in CFG) CFG[k] = changes[k].newValue ?? DEFAULTS[k];
        }
    });

    function log(...args) { if (CFG.debug) console.log('[TT-DL]', ...args); }
    function warn(...args) { console.warn('[TT-DL]', ...args); }

    // ===== 工具 =====

    function showToast(msg, duration = 3000) {
        document.querySelectorAll('.tt-dl-toast').forEach(el => el.remove());
        const el = document.createElement('div');
        el.className = 'tt-dl-toast';
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, duration);
    }

    const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
    function sanitize(name) {
        if (!name) return '';
        let s = name.replace(/[\\/:*?"<>|\n\r\t]/g, '_');
        const chars = Array.from(s);
        if (chars.length > 60) s = chars.slice(0, 60).join('');
        s = s.replace(/[.\s]+$/, '').trim();
        if (RESERVED.test(s)) s = '_' + s;
        return s;
    }

    function toFullUrl(p) {
        if (!p || typeof p !== 'string') return null;
        if (p.startsWith('http')) return p;
        if (p.startsWith('//')) return 'https:' + p;
        if (p.startsWith('/')) return 'https://www.tiktok.com' + p;
        return null;
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function todayStr() {
        const d = new Date();
        const z = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}`;
    }

    // ===== 数据缓存 =====

    const videoDataMap = new Map();

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (event.data?.type === '__TT_DL_VIDEO_DATA__' && event.data.data) {
            const d = event.data.data;
            if (!d.awemeId) return;
            if (videoDataMap.has(d.awemeId)) videoDataMap.delete(d.awemeId);
            else if (videoDataMap.size >= 300) {
                videoDataMap.delete(videoDataMap.keys().next().value);
            }
            videoDataMap.set(d.awemeId, d);

            if (CFG.debug) {
                if (d.type === 'image') {
                    const label = d.subType === 'video_collection' ? 'video collection'
                        : d.subType === 'mixed' ? 'mixed' : 'image post';
                    log(`✓ ${label}:`, d.awemeId,
                        `images:${d.images?.length || 0}`,
                        `videos:${d.clipVideos?.length || 0}`,
                        d.desc?.substring(0, 25));
                } else {
                    const adaptCount = (d.bitRateList || []).filter(br => br.isAdapt).length;
                    const normalCount = (d.bitRateList || []).filter(br => !br.isAdapt).length;
                    log('✓ video:', d.awemeId,
                        `qualities: ${normalCount} normal + ${adaptCount} adapt`,
                        `audio: ${d.audioUrl ? 'yes' : 'no'}`,
                        d.desc?.substring(0, 25));
                }
            }
        }
    });

    // ===== URL 收集与画质选择 =====

    // 把所有候选 URL 展开并去重，保持原数组顺序
    function expandUrls(brList) {
        const seen = new Set();
        const out = [];
        for (const br of brList) {
            if (br.playApi) {
                const u = toFullUrl(br.playApi);
                if (u && !seen.has(u)) { seen.add(u); out.push(u); }
            }
            for (const alt of (br.allUrls || [])) {
                const u = toFullUrl(alt);
                if (u && !seen.has(u)) { seen.add(u); out.push(u); }
            }
        }
        return out;
    }

    // 按 quality 偏好挑选起点索引
    function pickQualityIndex(list) {
        if (!list || list.length === 0) return -1;
        if (CFG.quality === 'lowest') return list.length - 1;
        if (CFG.quality === 'second' && list.length >= 2) return 1;
        return 0;
    }

    // 把一个 bitRate 列表按"从偏好画质开始，绕一圈"展开成候选 URL
    function urlsByQualityPref(brList) {
        if (!brList || brList.length === 0) return [];
        const start = pickQualityIndex(brList);
        const ordered = [...brList.slice(start), ...brList.slice(0, start)];
        return expandUrls(ordered);
    }

    // 从 data.bitRateList 里挑出符合模式的 URL 候选
    // mode = 'merged' → 只要 normal；'adapt' → 只要 adapt
    function getVideoCandidates(data, mode) {
        const list = data?.bitRateList || [];
        const filtered = list.filter(br => mode === 'adapt' ? br.isAdapt : !br.isAdapt);
        const urls = urlsByQualityPref(filtered);

        // 如果是 merged 模式且没有 normal，可以兜底用 data.playApi（通常等价于第一个 normal）
        if (mode === 'merged' && urls.length === 0 && data?.playApi) {
            const u = toFullUrl(data.playApi);
            if (u) urls.push(u);
        }
        return urls;
    }

    // ===== 当前作品识别（与抖音版基本一致，URL 模式不同） =====

    function getVidFromUrl() {
        // tiktok.com/@user/video/12345 或 tiktok.com/@user/photo/12345
        let m = location.href.match(/\/(?:video|photo|note)\/(\d+)/);
        if (m) return m[1];
        m = location.href.match(/[?&]item_id=(\d+)/);
        if (m) return m[1];
        return null;
    }

    function findActiveVideo() {
        const videos = document.querySelectorAll('video');
        let best = null, bestArea = 0;
        for (const v of videos) {
            const r = v.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0))
                * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
            if (area > bestArea) { bestArea = area; best = v; }
        }
        return best;
    }

    function findVideoContainer(videoEl) {
        let el = videoEl;
        for (let i = 0; i < 15 && el; i++) {
            el = el.parentElement;
            if (!el) break;
            const id = el.getAttribute('data-aweme-id') || el.dataset?.awemeId;
            if (id) return { awemeId: id };
            const link = el.querySelector('a[href*="/video/"], a[href*="/photo/"]');
            if (link) {
                const m = link.href.match(/\/(?:video|photo)\/(\d+)/);
                if (m) return { awemeId: m[1] };
            }
        }
        return { awemeId: null };
    }

    function findByVisibleText() {
        const selectors = [
            '[data-e2e="browse-video-desc"]',
            '[data-e2e="video-desc"]',
            '[class*="DivVideoDesc"]',
            '[class*="VideoDesc"]',
        ];
        for (const sel of selectors) {
            for (const el of document.querySelectorAll(sel)) {
                const r = el.getBoundingClientRect();
                if (r.top < innerHeight && r.bottom > 0 && r.width > 0) {
                    const text = el.textContent?.trim();
                    if (text?.length > 3) {
                        for (const [, data] of videoDataMap) {
                            if (!data.desc || data.desc.length < 5) continue;
                            if (text.includes(data.desc) || data.desc.includes(text)) return data;
                            const parts = data.desc.split(/[#@\s,.!?，。！？]+/).filter(p => p.length >= 4);
                            let score = 0;
                            for (const p of parts) { if (text.includes(p)) score += p.length; }
                            if (score >= 10) return data;
                        }
                    }
                }
            }
        }
        return null;
    }

    function queryInject(awemeId) {
        return new Promise((resolve) => {
            const handler = (event) => {
                if (event.data?.type === '__TT_DL_QUERY_RESP__') {
                    window.removeEventListener('message', handler);
                    clearTimeout(timer);
                    resolve(event.data);
                }
            };
            window.addEventListener('message', handler);
            const timer = setTimeout(() => {
                window.removeEventListener('message', handler);
                resolve(null);
            }, 500);
            window.postMessage({ type: '__TT_DL_QUERY__', awemeId: awemeId || '' }, '*');
        });
    }

    async function getCurrentData() {
        const vid = getVidFromUrl();
        log('--- start ---', 'URL id:', vid || 'none', '| cache:', videoDataMap.size);

        if (vid && videoDataMap.has(vid)) { log('✓ URL id hit'); return videoDataMap.get(vid); }

        const activeVideo = findActiveVideo();
        if (activeVideo) {
            const { awemeId } = findVideoContainer(activeVideo);
            if (awemeId && videoDataMap.has(awemeId)) { log('✓ DOM id:', awemeId); return videoDataMap.get(awemeId); }
        }

        const textMatch = findByVisibleText();
        if (textMatch) { log('✓ text match'); return textMatch; }

        const resp = await queryInject(vid);
        if (resp?.data) { log('✓ via inject'); return resp.data; }

        // 最后兜底：让 inject 重新扫一次页面，再查一次
        window.postMessage({ type: '__TT_DL_RESCAN__' }, '*');
        await sleep(800);
        const resp2 = await queryInject(vid);
        if (resp2?.data) { log('✓ via inject (after rescan)'); return resp2.data; }

        return null;
    }

    // ===== background 通信（带超时） =====

    function sendMessage(payload, timeout = 20000) {
        return new Promise(resolve => {
            let done = false;
            const finish = v => { if (done) return; done = true; resolve(v); };
            const timer = setTimeout(() => finish({ ok: false, error: 'background no response' }), timeout);
            try {
                chrome.runtime.sendMessage(payload, res => {
                    clearTimeout(timer);
                    if (chrome.runtime.lastError) finish({ ok: false, error: chrome.runtime.lastError.message });
                    else finish(res || { ok: false, error: 'empty response' });
                });
            } catch (e) {
                clearTimeout(timer);
                finish({ ok: false, error: e.message });
            }
        });
    }

    function resolveUrl(url) {
        return sendMessage({ action: 'resolve_url', url }, 18000);
    }

    // ===== 下载触发（fetch + blob + <a download>） =====

    function triggerBrowserDownload(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        // 注意：必须给用户在 Save As 弹框里挑目录留足时间。
        // 30 秒太短——弹框未确认前 revoke 会让下载直接失败。
        setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(a.href);
        }, 5 * 60 * 1000);
    }

    // 流式 fetch
    // opts.credentials: 'include' (默认，TikTok 视频/音频可能要 cookie) | 'omit' (图片 CDN，避免 CORS 通配符冲突)
    async function fetchWithProgress(url, onProgress, opts = {}) {
        const credentials = opts.credentials || 'include';
        const ctrl = new AbortController();
        const res = await fetch(url, {
            credentials,
            cache: 'no-store',
            signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const ct = res.headers.get('Content-Type') || '';
        if (ct.includes('text/html') || ct.includes('application/json')) {
            throw new Error(`non-media response (${ct})`);
        }

        const total = parseInt(res.headers.get('Content-Length') || '0', 10);

        if (!res.body || !res.body.getReader) {
            const blob = await res.blob();
            if (onProgress) onProgress(blob.size, blob.size);
            return { blob, total: blob.size, contentType: ct };
        }

        const reader = res.body.getReader();
        const chunks = [];
        let loaded = 0;
        let lastTick = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            const now = Date.now();
            if (onProgress && now - lastTick > 200) {
                onProgress(loaded, total);
                lastTick = now;
            }
        }
        if (onProgress) onProgress(loaded, total);
        const blob = new Blob(chunks, { type: ct || 'application/octet-stream' });
        return { blob, total: loaded, contentType: ct };
    }

    // 通过 background service worker fetch（绕过 CORS）
    // 用于 tiktokcdn.com 等不返回 CORS 头的 CDN
    async function bgFetchBlob(url, opts = {}) {
        const res = await sendMessage({
            action: 'fetch_blob',
            url,
            credentials: opts.credentials || 'include',
        }, 70000);
        if (!res?.ok) throw new Error(res?.error || 'background fetch failed');
        return {
            blob: new Blob([res.buffer], { type: res.contentType || 'application/octet-stream' }),
            total: res.size,
            contentType: res.contentType,
        };
    }

    // ===== MP4 解析：检测是否含音频轨 =====
    // MP4 由嵌套的 boxes 组成。我们要找 moov box 里的 trak/mdia/hdlr，
    // 看 handler type 是不是 'soun'。
    //
    // Box 格式: [4B size][4B type][payload...]
    //   - size = 1 时，后续 8B 是真正的 64-bit size（极大文件）
    //   - size = 0 时，box 一直延伸到文件末尾
    //
    // 返回:
    //   true  = 包含音频轨
    //   false = 找到 moov 但没有音频轨（纯视频）
    //   null  = 没找到 moov（可能在文件末尾），无法判断

    async function detectMp4HasAudio(blob) {
        // moov 通常在开头（fast-start mp4）或末尾（默认 ffmpeg 输出）
        // 先读开头 2MB
        const HEAD_SIZE = Math.min(blob.size, 2 * 1024 * 1024);
        try {
            const headBuf = await blob.slice(0, HEAD_SIZE).arrayBuffer();
            const result = scanForAudioTrack(new DataView(headBuf), 0, headBuf.byteLength);
            if (result !== null) return result;
        } catch (e) {
            warn('detectMp4HasAudio: head parse failed:', e.message);
            return null;
        }

        // 兜底：moov 可能在末尾（ffmpeg 默认输出）。读末尾 4MB。
        // 注意：尾部 buffer 的起点几乎必然落在 mdat 数据中间，不能从偏移 0
        // 按 box 结构解析（前 8 字节是视频数据，type 检查立即失败）。
        // 正确做法：搜索 'moov' 字节签名（0x6d 0x6f 0x6f 0x76），向前回看
        // 4B size 验证合法后，再从该 box 起点开始 walk。
        if (blob.size > HEAD_SIZE) {
            try {
                const tailStart = Math.max(0, blob.size - 4 * 1024 * 1024);
                const tailBuf = await blob.slice(tailStart).arrayBuffer();
                const bytes = new Uint8Array(tailBuf);
                const view = new DataView(tailBuf);
                for (let i = 4; i + 4 <= bytes.length; i++) {
                    if (bytes[i] === 0x6d && bytes[i + 1] === 0x6f
                        && bytes[i + 2] === 0x6f && bytes[i + 3] === 0x76) {
                        const boxStart = i - 4;
                        const size = view.getUint32(boxStart, false);
                        // size 合法性：至少容纳 header，且不应远超 buffer 剩余长度
                        if (size >= 8 && boxStart + size <= tailBuf.byteLength + 1024) {
                            const result = scanForAudioTrack(
                                view, boxStart, Math.min(boxStart + size, tailBuf.byteLength));
                            if (result !== null) return result;
                        }
                    }
                }
            } catch (e) {
                warn('detectMp4HasAudio: tail parse failed:', e.message);
            }
        }
        return null;
    }

    // 在给定 DataView 的范围内扫描 boxes，找 moov，找 hdlr 中是否有 soun
    // 直接做递归下钻；遇到大 box 跳过非容器类型加速
    function scanForAudioTrack(view, offset, end) {
        // 容器类型 box：里面是嵌套 boxes
        const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'moof', 'traf']);
        let foundMoov = false;
        let foundSound = false;

        function read32(off) {
            return view.getUint32(off, false);
        }
        function readType(off) {
            return String.fromCharCode(view.getUint8(off), view.getUint8(off + 1),
                                       view.getUint8(off + 2), view.getUint8(off + 3));
        }

        function walk(start, finish, inMoov) {
            let pos = start;
            while (pos + 8 <= finish) {
                let size, type, headerLen;
                try {
                    size = read32(pos);
                    type = readType(pos + 4);
                    headerLen = 8;
                } catch (e) { return; }

                // 检查 type 是否是合法 ASCII（前 4 字节都是可打印字符），不是则停止
                if (!/^[\x20-\x7e]{4}$/.test(type)) return;

                if (size === 1) {
                    // 64-bit size
                    if (pos + 16 > finish) return;
                    const hi = read32(pos + 8), lo = read32(pos + 12);
                    size = hi * 0x100000000 + lo;
                    headerLen = 16;
                } else if (size === 0) {
                    // 延伸到末尾
                    size = finish - pos;
                }

                if (size < headerLen || pos + size > finish + 1024) {
                    // size 异常，可能 buffer 不完整。停止
                    return;
                }

                if (type === 'moov') foundMoov = true;
                if (type === 'hdlr' && inMoov) {
                    // hdlr 格式: 4B version+flags, 4B pre_defined, 4B handler_type, ...
                    // handler_type 在 box payload 偏移 8
                    const handlerOff = pos + headerLen + 8;
                    if (handlerOff + 4 <= finish) {
                        try {
                            const handlerType = readType(handlerOff);
                            if (handlerType === 'soun') {
                                foundSound = true;
                                return;   // 提前结束
                            }
                        } catch (e) { /* ignore */ }
                    }
                }

                if (CONTAINERS.has(type) && size > headerLen) {
                    const childEnd = Math.min(pos + size, finish);
                    walk(pos + headerLen, childEnd, inMoov || type === 'moov');
                    if (foundSound) return;
                }

                // size===0 的情况已在前面改写为 finish - pos，这里 size 必然 > 0
                pos += size;
            }
        }

        walk(offset, end, false);

        if (!foundMoov) return null;        // 还没找到 moov，可能在另一端
        return foundSound;                   // moov 找到了，结果可信
    }

    // ===== 下载主流程 =====

    // 只 fetch 拿到 blob，不触发保存。含 CORS fallback。
    // opts.credentials: 透传给 fetchWithProgress（默认 include）
    // opts.bgCredentials: 透传给 background fetch（默认跟 credentials 一致，若不同需显式传）
    async function fetchOne(cdnUrl, label, opts = {}) {
        try {
            return await fetchWithProgress(cdnUrl, (loaded, total) => {
                const mb = (loaded / 1048576).toFixed(1);
                if (total > 0) {
                    const pct = Math.round((loaded / total) * 100);
                    const totalMB = (total / 1048576).toFixed(1);
                    showToast(`⏬ ${label} ${pct}% (${mb}/${totalMB}MB)`, 2000);
                } else {
                    showToast(`⏬ ${label} ${mb}MB`, 2000);
                }
            }, opts);
        } catch (err) {
            const msg = err?.message || '';
            const isCorsLikely = msg.includes('Failed to fetch') || msg.includes('CORS') || msg.includes('NetworkError');
            if (!isCorsLikely) {
                warn(`${label} fetch failed:`, msg);
                return null;
            }
            log(`${label}: direct fetch blocked (likely CORS), retrying via background...`);
            showToast(`⏬ ${label} retrying via background...`, 2000);
            try {
                return await bgFetchBlob(cdnUrl, { credentials: opts.bgCredentials || opts.credentials || 'include' });
            } catch (err2) {
                warn(`${label} background fetch also failed:`, err2.message);
                return null;
            }
        }
    }

    function validateBlobSize(blob, filename, label) {
        const isVideo = filename.endsWith('.mp4');
        const isAudio = /\.(m4a|mp3|aac)$/i.test(filename);
        const minSize = isVideo ? 10000 : (isAudio ? 5000 : 1000);
        if (blob.size < minSize) {
            warn(`${label}: file too small (${blob.size}B), likely failed`);
            return false;
        }
        return true;
    }

    // 兼容旧调用：fetch + 保存。仍然用于图片/音频。
    async function downloadOne(cdnUrl, filename, label, opts = {}) {
        const result = await fetchOne(cdnUrl, label, opts);
        if (!result) return false;
        if (!validateBlobSize(result.blob, filename, label)) return false;
        triggerBrowserDownload(result.blob, filename);
        log(`✅ ${filename} ${(result.blob.size / 1048576).toFixed(1)}MB`);
        return true;
    }

    // ===== 视频下载：多 URL fallback =====

    async function downloadVideoFromUrls(urls, filename, label) {
        if (urls.length === 0) {
            showToast(`❌ ${label}: no URL`);
            return false;
        }
        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            showToast(`⏬ ${label} resolving${i > 0 ? ` (retry ${i})` : ''}...`);
            const res = await resolveUrl(url);
            if (res?.ok && res.cdnUrl) {
                const sizeMB = (res.contentLength / 1048576).toFixed(1);
                log(`${label}: ${sizeMB}MB`, res.cdnUrl.substring(0, 80));
                const ok = await downloadOne(res.cdnUrl, filename, label);
                if (ok) return true;
            } else {
                warn(`${label} resolve failed:`, res?.error);
            }
        }
        showToast(`❌ ${label}: all URLs failed`);
        return false;
    }

    // 类似 downloadVideoFromUrls，但只 fetch 拿 blob，不触发保存
    // 返回 { blob, ... } 或 null
    async function fetchVideoFromUrls(urls, label) {
        if (urls.length === 0) return null;
        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            showToast(`⏬ ${label} resolving${i > 0 ? ` (retry ${i})` : ''}...`);
            const res = await resolveUrl(url);
            if (res?.ok && res.cdnUrl) {
                const sizeMB = (res.contentLength / 1048576).toFixed(1);
                log(`${label}: ${sizeMB}MB`, res.cdnUrl.substring(0, 80));
                const result = await fetchOne(res.cdnUrl, label);
                if (result && validateBlobSize(result.blob, 'placeholder.mp4', label)) {
                    return result;
                }
            } else {
                warn(`${label} resolve failed:`, res?.error);
            }
        }
        return null;
    }

    // ===== 单视频/音视频分离的核心逻辑 =====

    function audioExtension(audioUrl) {
        const u = audioUrl.toLowerCase();
        if (u.includes('.m4a')) return '.m4a';
        if (u.includes('.mp3')) return '.mp3';
        if (u.includes('.aac')) return '.aac';
        return '.m4a';   // TikTok 通常是 m4a
    }

    // 核心下载策略
    // 返回 { ok, files: [文件名...] }
    async function downloadVideoSmart(data, prefix, label = 'video') {
        const hasAudio = !!data?.audioUrl;
        const adaptUrls = getVideoCandidates(data, 'adapt');
        const normalUrls = getVideoCandidates(data, 'merged');

        log(`mode=${CFG.videoMode}`, `normal=${normalUrls.length}`, `adapt=${adaptUrls.length}`, `audio=${hasAudio}`);

        // === merged 模式：只下含音频的合并流 ===
        if (CFG.videoMode === 'merged') {
            if (normalUrls.length > 0) {
                const fn = `${prefix}.mp4`;
                const ok = await downloadVideoFromUrls(normalUrls, fn, label);
                return { ok, files: ok ? [fn] : [] };
            }
            // 没 normal 流时只能退而求其次：用 adapt + 单独 audio（事实上变成 split）
            if (adaptUrls.length > 0 && hasAudio) {
                showToast('⚠️ no merged stream, falling back to split');
                log('merged mode: no normal stream, falling back to split');
                return downloadSplit(data, adaptUrls, prefix, label);
            }
            // 实在没办法，下 adapt 单文件（无音频）
            if (adaptUrls.length > 0) {
                const fn = `${prefix}_noaudio.mp4`;
                showToast('⚠️ only adapt stream available; downloading without audio');
                const ok = await downloadVideoFromUrls(adaptUrls, fn, label);
                return { ok, files: ok ? [fn] : [] };
            }
            showToast(`❌ ${label}: no URL`);
            return { ok: false, files: [] };
        }

        // === split 模式（默认）：高清视频 + 智能补音频 ===
        if (adaptUrls.length > 0 && hasAudio) {
            return downloadSplit(data, adaptUrls, prefix, label);
        }
        if (normalUrls.length > 0) {
            const fn = `${prefix}.mp4`;
            const ok = await downloadVideoFromUrls(normalUrls, fn, label);
            return { ok, files: ok ? [fn] : [] };
        }
        if (adaptUrls.length > 0) {
            const fn = `${prefix}_noaudio.mp4`;
            showToast('⚠️ no audio URL found; downloading video only');
            const ok = await downloadVideoFromUrls(adaptUrls, fn, label);
            return { ok, files: ok ? [fn] : [] };
        }
        showToast(`❌ ${label}: no URL`);
        return { ok: false, files: [] };
    }

    // split 模式：
    //   1) fetch 高清视频拿 blob
    //   2) 解析 mp4 检测是否已含音频
    //   3) 含音频 → 只保存视频（避免冗余音频文件 + 避免触发"多文件下载"提示）
    //      不含音频 → fetch + 保存音频
    //   4) 最后一起触发保存
    async function downloadSplit(data, adaptUrls, prefix, label) {
        const files = [];

        // 1) fetch 视频（不保存）
        showToast(`⏬ ${label}: HD video...`);
        const videoResult = await fetchVideoFromUrls(adaptUrls, `${label} (video)`);
        if (!videoResult) {
            showToast(`❌ ${label}: video fetch failed`);
            return { ok: false, files: [] };
        }
        const videoBlob = videoResult.blob;
        const videoFn = `${prefix}.mp4`;

        // 2) 检测音频轨
        showToast(`🔍 ${label}: checking audio track...`, 1500);
        const hasAudioTrack = await detectMp4HasAudio(videoBlob);

        if (hasAudioTrack === true) {
            log(`${label}: video already contains audio track, skipping separate audio download`);
        } else if (hasAudioTrack === false) {
            log(`${label}: video has no audio track, will download separate audio`);
        } else {
            log(`${label}: cannot determine audio (moov not found in head/tail), will download separate audio as fallback`);
        }

        // 3) 决定是否下音频
        let audioBlob = null;
        let audioFn = null;
        if (hasAudioTrack !== true) {
            const audioUrl = toFullUrl(data.audioUrl);
            if (audioUrl) {
                audioFn = `${prefix}${audioExtension(audioUrl)}`;
                showToast(`⏬ ${label}: audio...`);
                const res = await resolveUrl(audioUrl);
                const finalAudioUrl = (res?.ok && res.cdnUrl) ? res.cdnUrl : audioUrl;
                const audioResult = await fetchOne(finalAudioUrl, `${label} (audio)`);
                if (audioResult && validateBlobSize(audioResult.blob, audioFn, `${label} (audio)`)) {
                    audioBlob = audioResult.blob;
                } else {
                    warn(`${label}: audio fetch failed`);
                }
            }
        }

        // 4) 触发保存
        triggerBrowserDownload(videoBlob, videoFn);
        files.push(videoFn);
        log(`✅ ${videoFn} ${(videoBlob.size / 1048576).toFixed(1)}MB`);

        if (audioBlob) {
            // 视频和音频之间留点时间，避免 Chrome 把后者也看成"自动"下载提前合并提示
            await sleep(100);
            triggerBrowserDownload(audioBlob, audioFn);
            files.push(audioFn);
            log(`✅ ${audioFn} ${(audioBlob.size / 1048576).toFixed(1)}MB`);
        }

        if (audioBlob) {
            showToast(`✅ ${label}: video + audio saved`);
        } else if (hasAudioTrack === true) {
            showToast(`✅ ${label}: video saved (already includes audio)`);
        } else if (hasAudioTrack === false) {
            showToast(`⚠️ ${label}: video saved, audio failed`);
        } else {
            // hasAudioTrack 不确定，尝试了音频但失败了
            showToast(`⚠️ ${label}: video saved, audio could not be fetched`);
        }

        return { ok: true, files };
    }

    // ===== 顶层下载入口 =====

    async function triggerDownload() {
        showToast('⏬ Fetching post info...');
        const data = await getCurrentData();
        if (!data) { showToast('❌ Post not detected; wait and retry'); return; }

        const prefix = makePrefix(data);
        log('filename prefix:', prefix);

        if (data.type === 'image') {
            const clipVideos = data.clipVideos || [];
            const images = data.images || [];
            if (clipVideos.length > 0) {
                await downloadCollection(clipVideos, images, prefix);
            } else if (images.length > 0) {
                await downloadPureImages(images, prefix);
            } else {
                showToast('❌ no image or video data');
            }
        } else {
            const { ok, files } = await downloadVideoSmart(data, prefix);
            if (ok && files.length > 0) log('saved:', files.join(', '));
        }
    }

    async function downloadCollection(clipVideos, images, prefix) {
        const total = clipVideos.length + images.length;
        showToast(`⏬ ${clipVideos.length} video(s)${images.length > 0 ? ` + ${images.length} image(s)` : ''}`);
        let ok = 0;
        let idx = 0;

        for (let i = 0; i < clipVideos.length; i++) {
            idx++;
            const clip = clipVideos[i];
            const sub = `${prefix}_${String(idx).padStart(2, '0')}`;
            const { ok: success } = await downloadVideoSmart(clip, sub, `clip ${idx}/${total}`);
            if (success) ok++;
            if (i < clipVideos.length - 1 || images.length > 0) await sleep(500);
        }

        for (let i = 0; i < images.length; i++) {
            idx++;
            const img = images[i];
            const url = toFullUrl(img.url);
            if (!url) continue;
            const ext = guessImageExt(url);
            const filename = `${prefix}_${String(idx).padStart(2, '0')}${ext}`;
            const allUrls = (img.allUrls || []).map(toFullUrl).filter(Boolean);
            const success = await downloadImage(url, allUrls, filename, `image ${idx}/${total}`);
            if (success) ok++;
            if (i < images.length - 1) await sleep(300);
        }
        showToast(ok > 0 ? `✅ done: ${ok}/${total}` : '❌ all failed');
    }

    async function downloadPureImages(images, prefix) {
        showToast(`⏬ ${images.length} image(s)...`);
        let ok = 0;
        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            const url = toFullUrl(img.url);
            if (!url) continue;
            const ext = guessImageExt(url);
            const filename = `${prefix}_${String(i + 1).padStart(2, '0')}${ext}`;
            const allUrls = (img.allUrls || []).map(toFullUrl).filter(Boolean);
            const success = await downloadImage(url, allUrls, filename, `image ${i + 1}/${images.length}`);
            if (success) ok++;
            if (i < images.length - 1) await sleep(300);
        }
        showToast(ok > 0 ? `✅ done: ${ok}/${images.length}` : '❌ all failed');
    }

    function guessImageExt(url) {
        if (/\.webp(\?|$)|format=webp/i.test(url)) return '.webp';
        if (/\.png(\?|$)|format=png/i.test(url)) return '.png';
        if (/\.gif(\?|$)/i.test(url)) return '.gif';
        return '.jpg';
    }

    // 图片下载：尝试 url + 所有备选 URL（TikTok 图集 url_list 通常有多个 CDN）
    // 用 credentials: 'omit' 避免 CORS 通配符冲突（图片 CDN 返回 ACAO: *，
    // 与 credentials: 'include' 冲突，浏览器会拒绝）
    async function downloadImage(primaryUrl, allUrls, filename, label) {
        const candidates = [primaryUrl];
        for (const u of allUrls) {
            if (!candidates.includes(u)) candidates.push(u);
        }
        for (const url of candidates) {
            const res = await resolveUrl(url);
            const finalUrl = (res?.ok && res.cdnUrl) ? res.cdnUrl : url;
            const ok = await downloadOne(finalUrl, filename, label, { credentials: 'omit' });
            if (ok) return true;
        }
        return false;
    }

    // ===== 文件名生成 =====

    function makePrefix(data) {
        const tpl = CFG.filenameTpl || DEFAULTS.filenameTpl;
        const title = sanitize(data.desc) || 'TikTok';
        const author = sanitize(data.author) || '';
        const id = data.awemeId || '';
        const date = todayStr();

        let s = tpl
            .replace(/\{title\}/g, title)
            .replace(/\{author\}/g, author)
            .replace(/\{id\}/g, id)
            .replace(/\{date\}/g, date);

        s = s.replace(/@(?=[\/_\-.\s]|$)/g, '')
             .replace(/[_\-]{2,}/g, '_')
             .replace(/^[_\-@.\s]+|[_\-@.\s]+$/g, '');
        return s || 'TikTok';
    }

    // ===== 下载入口：弹窗 UI / 全局快捷键 / 页内快捷键 =====
    // v2.2.0 起不再有页面悬浮按钮，触发路径：
    //   1) popup「下载当前作品」按钮 → trigger_download 消息
    //   2) commands 全局快捷键（默认 Alt+D，chrome://extensions/shortcuts 可改）
    //      → background → trigger_download 消息
    //   3) 页内 Shift+D（仅页面聚焦时有效）

    let downloading = false;

    function safeTriggerDownload() {
        if (downloading) { showToast('⏳ 正在下载中…'); return; }
        downloading = true;
        triggerDownload()
            .catch(err => { warn('exception:', err); showToast('❌ ' + err.message); })
            .finally(() => { downloading = false; });
    }

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg?.action === 'trigger_download') {
            safeTriggerDownload();
            sendResponse({ ok: true });
            return false;
        }
        // popup 打开时查询当前作品信息，用于预览
        if (msg?.action === 'get_post_info') {
            getCurrentData().then(data => {
                if (!data) { sendResponse({ ok: false }); return; }
                sendResponse({
                    ok: true,
                    info: {
                        awemeId: data.awemeId,
                        type: data.type,
                        subType: data.subType || null,
                        desc: data.desc || '',
                        author: data.author || '',
                        imageCount: data.images?.length || 0,
                        clipCount: data.clipVideos?.length || 0,
                        normalCount: (data.bitRateList || []).filter(br => !br.isAdapt).length,
                        adaptCount: (data.bitRateList || []).filter(br => br.isAdapt).length,
                        hasAudio: !!data.audioUrl,
                    },
                });
            }).catch(() => sendResponse({ ok: false }));
            return true;   // 异步 sendResponse
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.shiftKey && (e.key === 'D' || e.key === 'd')) {
            const t = document.activeElement?.tagName?.toLowerCase();
            if (t === 'input' || t === 'textarea' || document.activeElement?.contentEditable === 'true') return;
            e.preventDefault();
            safeTriggerDownload();
        }
    });

    async function init() {
        await loadConfig();
        log('v2.2.0 loaded | config:', CFG);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        window.addEventListener('DOMContentLoaded', init);
    }
})();
