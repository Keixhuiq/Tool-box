// background.js v2.2.0 - TikTok 无水印下载
// 职责：
//   1) 维护 Referer 规则（让 TikTok CDN 域名的请求带正确的 Referer）
//   2) 解析 CDN 重定向（fetch 跟随 302，把短 URL 换成最终 URL）
// 下载本身由 content.js 用 fetch + blob + <a download> 触发，
// Chrome 会把它当作"用户主动下载"，Save As 弹框会记住上次保存位置。

const REFERER = 'https://www.tiktok.com/';
const RULE_IDS = [99999, 99998, 99997, 99996, 99995, 99994, 99993, 99992, 99991, 99990];

const RULE_FILTERS = [
    '*tiktokcdn.com*',
    '*tiktokcdn-us.com*',
    '*tiktokcdn-eu.com*',
    '*tiktokv.com*',
    '*tiktokv-us.com*',
    '*musical.ly*',
    '*ttlivecdn.com*',
    '*tiktok.com/video*',
    '*byteoversea.com*',
    '*bytedance.net*',
];

chrome.runtime.onInstalled.addListener(() => setupRules());
chrome.runtime.onStartup.addListener(() => setupRules());

async function setupRules() {
    try {
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: RULE_IDS,
            addRules: RULE_FILTERS.map((f, i) => makeRule(RULE_IDS[i], f)),
        });
        console.log('[TT-DL BG] Referer 规则已设置:', RULE_FILTERS.length, '条');
    } catch (e) {
        console.warn('[TT-DL BG] 规则设置失败:', e);
    }
}

async function ensureRules() {
    try {
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        const existing = new Set(rules.map(r => r.id));
        const missing = RULE_IDS.some(id => !existing.has(id));
        if (missing) {
            console.log('[TT-DL BG] 检测到规则缺失，重建');
            await setupRules();
        }
    } catch (e) {
        console.warn('[TT-DL BG] 规则检查失败:', e);
    }
}

function makeRule(id, urlFilter) {
    return {
        id, priority: 1,
        action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'Referer', operation: 'set', value: REFERER }]
        },
        condition: {
            urlFilter,
            // 关键：DNR 动态规则是全浏览器生效的。
            // initiatorDomains 把改写范围限定为：
            //   1) tiktok.com 页面（content script 的 fetch 以页面为 initiator）
            //   2) 扩展自身（service worker 的 resolveUrl/fetchBlob，initiator 是 chrome-extension://<id>）
            // 这样用户正常浏览其他 ByteDance 系站点不会被改 Referer。
            initiatorDomains: [chrome.runtime.id, 'tiktok.com'],
            // 不含 main_frame/sub_frame：下载只涉及 XHR/媒体/图片，不应改写页面导航的 Referer
            resourceTypes: ['xmlhttprequest', 'media', 'image', 'other']
        }
    };
}

// ===== 全局快捷键（chrome://extensions/shortcuts 可自定义，默认 Alt+D） =====
chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'download-current') return;
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        // tab.url 仅对持有 host 权限的域可见；非 TikTok 页面时为 undefined，自动跳过
        if (tab?.id && /^https?:\/\/([^/]*\.)?tiktok\.com\//.test(tab.url || '')) {
            chrome.tabs.sendMessage(tab.id, { action: 'trigger_download' }).catch(() => { });
        }
    } catch (e) { /* ignore */ }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'resolve_url') {
        ensureRules().finally(() => resolveUrl(msg.url, sendResponse));
        return true;
    }
    if (msg.action === 'fetch_blob') {
        ensureRules().finally(() => fetchBlob(msg.url, msg.credentials, sendResponse));
        return true;
    }
    if (msg.action === 'ping') {
        sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
        return false;
    }
});

// ===== 跨域 fetch（绕过 CORS） =====
// TikTok 的部分 CDN（如 tiktokcdn.com 上的音频）不返回 CORS 头，
// content script 里直接 fetch 会被浏览器拦截。
// service worker 的 fetch 不受 web 页面的 CORS 限制，所以由这里代取。
// 拿到的 ArrayBuffer 通过 chrome.runtime.sendMessage 的结构化克隆传回 content。
// 注意：消息大小有上限（实测约 64MB），所以这条路径只用于音频等小文件。
async function fetchBlob(url, credentials, sendResponse) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);

    try {
        const res = await fetch(url, {
            headers: { 'Referer': REFERER, 'Accept': '*/*' },
            redirect: 'follow',
            credentials: credentials || 'include',
            cache: 'no-store',
            signal: ctrl.signal,
        });
        if (!res.ok) {
            sendResponse({ ok: false, error: `HTTP ${res.status}` });
            return;
        }
        const ct = res.headers.get('Content-Type') || '';
        if (ct.includes('text/html')) {
            sendResponse({ ok: false, error: `non-media response (${ct})` });
            return;
        }
        const buffer = await res.arrayBuffer();
        if (buffer.byteLength < 100) {
            sendResponse({ ok: false, error: `too small (${buffer.byteLength}B)` });
            return;
        }
        sendResponse({
            ok: true,
            buffer,
            contentType: ct,
            size: buffer.byteLength,
        });
    } catch (err) {
        sendResponse({
            ok: false,
            error: err.name === 'AbortError' ? 'fetch timeout' : err.message,
        });
    } finally {
        clearTimeout(timer);
    }
}

// ===== 解析 CDN 重定向 =====
// TikTok 的 play URL 可能 302 重定向到真实 CDN 地址。
// 注意：credentials: 'include' 是必要的——某些 TikTok CDN 节点会验证登录 cookie。

async function resolveUrl(url, sendResponse) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);

    try {
        const res = await fetch(url, {
            headers: { 'Referer': REFERER, 'Accept': '*/*' },
            redirect: 'follow',
            credentials: 'include',
            cache: 'no-store',
            signal: ctrl.signal,
        });
        const ct = res.headers.get('Content-Type') || '';
        const cl = res.headers.get('Content-Length') || '0';
        const finalUrl = res.url;
        await res.body?.cancel();

        if (!res.ok) {
            sendResponse({ ok: false, error: `HTTP ${res.status}` });
            return;
        }
        if (ct.includes('text/html') || ct.includes('application/json')) {
            sendResponse({ ok: false, error: `非媒体响应 (${ct})` });
            return;
        }
        sendResponse({
            ok: true,
            cdnUrl: finalUrl,
            contentType: ct,
            contentLength: parseInt(cl) || 0,
        });
    } catch (err) {
        sendResponse({
            ok: false,
            error: err.name === 'AbortError' ? '解析超时' : err.message,
        });
    } finally {
        clearTimeout(timer);
    }
}
