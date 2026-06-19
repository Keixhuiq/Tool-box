// interceptor.js v2.4 — MAIN world
// 改动：
// 1. fetch 拦截改为"首块嗅探"：先读响应流的第一个 chunk 判断是否像字幕，
//    不像就立刻 cancel。之前的写法会把每个命中 URL 规则的视频/音频分片
//    整个 clone + arrayBuffer + 解码一遍，播放全程持续浪费内存和 CPU。
// 2. content-type 为 video/* 或 audio/* 的响应直接跳过。
// 3. 超过 10MB 的响应中途放弃（字幕文件不可能这么大）。

(function() {
  'use strict';

  const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;

  function isSubtitleUrl(url) {
    if (typeof url !== 'string') return false;
    return (
      (url.includes('?o=') && url.includes('nflxvideo.net')) ||
      url.includes('/timedtext')
    );
  }

  function looksLikeSubtitleHead(headText) {
    if (!headText) return false;
    const head = headText.substring(0, 600).toLowerCase();
    return head.includes('<?xml') || head.includes('<tt') ||
           head.includes('webvtt') || head.includes('<body') ||
           head.includes('<p ') || head.includes('</p>');
  }

  function isSubtitleContent(text) {
    if (!text || text.length < 50) return false;
    return looksLikeSubtitleHead(text);
  }

  function decodeBuffer(buffer) {
    try { return new TextDecoder('utf-8').decode(buffer); }
    catch (e) {
      try { return new TextDecoder('iso-8859-1').decode(buffer); }
      catch (e2) { return null; }
    }
  }

  function dispatchSubtitle(url, text) {
    if (!isSubtitleContent(text)) return;
    console.log('[AI翻译] ✅ 有效字幕，长度:', text.length);
    window.postMessage({
      type: '__nf_ai_subtitle__',
      url: url,
      text: text
    }, '*');
  }

  // 流式读取：第一个 chunk 不像字幕就立刻放弃，避免吞下整个视频分片
  async function readIfSubtitle(response) {
    if (!response.body) return null;

    const ct = (response.headers.get('content-type') || '').toLowerCase();
    if (ct.startsWith('video/') || ct.startsWith('audio/')) return null;

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let checkedHead = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;

        if (!checkedHead) {
          checkedHead = true;
          const head = new TextDecoder('utf-8', { fatal: false })
            .decode(value.subarray(0, Math.min(value.length, 1024)));
          if (!looksLikeSubtitleHead(head)) {
            reader.cancel().catch(() => {});
            return null;
          }
        }

        if (total > MAX_SUBTITLE_BYTES) {
          reader.cancel().catch(() => {});
          return null;
        }
      }
    } catch (e) {
      return null;
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return decodeBuffer(merged);
  }

  // ===== Patch fetch =====
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    const response = await originalFetch.apply(this, args);

    if (isSubtitleUrl(url)) {
      // 异步处理 clone，不阻塞页面拿到原始 response
      (async () => {
        try {
          const text = await readIfSubtitle(response.clone());
          if (text) dispatchSubtitle(url, text);
        } catch (e) { /* 静默 */ }
      })();
    }
    return response;
  };

  // ===== Patch XMLHttpRequest =====
  const xhrProto = XMLHttpRequest.prototype;
  const originalOpen = xhrProto.open;
  const originalSend = xhrProto.send;

  xhrProto.open = function(method, url) {
    this._nfSubUrl = (typeof url === 'string' && isSubtitleUrl(url)) ? url : null;
    return originalOpen.apply(this, arguments);
  };

  xhrProto.send = function() {
    if (this._nfSubUrl) {
      const xhr = this;
      const url = this._nfSubUrl;

      xhr.addEventListener('loadend', function onDone() {
        xhr.removeEventListener('loadend', onDone);
        if (xhr.status < 200 || xhr.status >= 300) return;

        // XHR 响应已经在内存里了，这里只能事后过滤
        const ct = (xhr.getResponseHeader('content-type') || '').toLowerCase();
        if (ct.startsWith('video/') || ct.startsWith('audio/')) return;

        try {
          let text = null;
          const rtype = xhr.responseType;

          if (rtype === 'arraybuffer' && xhr.response) {
            if (xhr.response.byteLength > MAX_SUBTITLE_BYTES) return;
            text = decodeBuffer(new Uint8Array(xhr.response));
          } else if (rtype === 'blob' && xhr.response) {
            if (xhr.response.size > MAX_SUBTITLE_BYTES) return;
            const reader = new FileReader();
            reader.onload = () => dispatchSubtitle(url, reader.result);
            reader.readAsText(xhr.response);
            return;
          } else if (rtype === '' || rtype === 'text') {
            try { text = xhr.responseText; } catch (e) {}
          }

          if (text) dispatchSubtitle(url, text);
        } catch (e) { /* 静默 */ }
      });
    }
    return originalSend.apply(this, arguments);
  };

  console.log('[AI翻译] 字幕拦截器已加载 v2.4');
})();
