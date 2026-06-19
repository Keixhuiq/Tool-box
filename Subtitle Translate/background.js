// background.js — Service Worker v3.7
// 本轮改动（配合 bridge v3.2 的调度重构）：
// 1. 结构化响应：translate 返回 {ok, text, code, retriable}，
//    取代用 result.startsWith("[") 判错（会误伤 [Music]/[Door opens] 等合法译文）
// 2. 滑动窗口上下文（方案 A）：prompt 带当前 cue 前后各 N 条作参考，
//    但明确「只翻译 CURRENT」。缓存键含上下文 hash，避免同台词不同上下文复用错译
// 3. 15s 超时：所有 fetch 加 AbortController，超时算 retriable，不再永久占槽
// 4. promptVersion → v2（prompt 结构变了，旧缓存失效）
// 5. 内存缓存上限 6000；session 仅持久化最近 2000，降低序列化峰值
// 6. Scheduler 层重试已在 bridge 关闭，重试只在这里做（最坏 4 次，不再 16 次）

const LANG_NAMES = {
  zh: '简体中文',
  en: '英语 (English)',
  ja: '日语 (日本語)'
};

const DEFAULT_MODELS = {
  gemini: 'gemini-3.1-flash-lite',
  openai: 'gpt-4o-mini',
  claude: 'claude-haiku-4-5-20251001'
};

const PROMPT_VERSION = 'v2'; // 与 bridge.js 的 PROMPT_VERSION 保持一致
const FETCH_TIMEOUT_MS = 15000;
const CACHE_CAP = 6000;
const CACHE_PERSIST_CAP = 2000; // session 序列化只保留最近条目，避免复制整个内存缓存

// ========== 缓存（带 session 持久化） ==========

let translationCache = new Map();
let cacheSaveTimer = null;

const cacheReady = chrome.storage.session.get('translationCache')
  .then((data) => {
    if (data && data.translationCache) {
      try {
        const entries = Object.entries(data.translationCache).slice(-CACHE_CAP);
        translationCache = new Map(entries);
        console.log(`[AI翻译] 从 session 恢复缓存 ${translationCache.size} 条`);
      } catch (e) { /* 忽略损坏的缓存 */ }
    }
  })
  .catch(() => {});

function scheduleCacheSave() {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    const recentEntries = [];
    let skip = Math.max(0, translationCache.size - CACHE_PERSIST_CAP);
    for (const entry of translationCache) {
      if (skip > 0) { skip--; continue; }
      recentEntries.push(entry);
    }
    chrome.storage.session
      .set({ translationCache: Object.fromEntries(recentEntries) })
      .catch(() => {});
  }, 3000);
}

function cachePut(key, value) {
  translationCache.set(key, value);
  if (translationCache.size > CACHE_CAP) {
    const firstKey = translationCache.keys().next().value;
    translationCache.delete(firstKey);
  }
  scheduleCacheSave();
}

// 轻量 hash（与 bridge 的 FNV-1a 一致），用于上下文指纹
function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

// ========== 消息入口 ==========

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "translate") {
    // request: { text, context?: {before:[], after:[]}, settings }
    translateWithRetry(request.text, request.context, request.settings)
      .then(res => sendResponse(res))          // {ok, text, code, retriable}
      .catch(error => {
        console.error("[AI翻译] 翻译报错:", error);
        sendResponse({ ok: false, text: '', code: 'exception', retriable: false, error: error.message });
      });
    return true;
  }

  // popup「测试连接」
  if (request.action === "test") {
    translateText("Hello!", null, request.settings, /*skipCache=*/true)
      .then(res => {
        if (res.ok) sendResponse({ ok: true, result: res.text });
        else sendResponse({ ok: false, error: res.error || res.code });
      })
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

// ========== 自定义端点权限检查 ==========

const BUILTIN_ORIGINS = [
  'https://translate.googleapis.com',
  'https://generativelanguage.googleapis.com',
  'https://api.anthropic.com',
  'https://api.openai.com'
];

function normalizeOpenAIEndpoint(endpoint) {
  let url = (endpoint || '').trim().replace(/\/+$/, '');
  if (!url) url = 'https://api.openai.com/v1';
  if (!/\/chat\/completions$/i.test(url)) url += '/chat/completions';
  return url;
}

async function checkEndpointPermission(url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch (e) {
    const err = new Error('Endpoint 不是合法 URL');
    err.code = 'bad_endpoint';
    throw err;
  }
  if (BUILTIN_ORIGINS.includes(origin)) return;
  const granted = await chrome.permissions.contains({ origins: [origin + '/*'] });
  if (!granted) {
    const err = new Error(`未授权访问 ${origin}，请打开扩展弹窗点击"测试连接"完成授权`);
    err.code = 'no_permission';
    throw err;
  }
}

// ========== 带超时的 fetch ==========

async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 判断错误是否可重试（限流/过载/超时/网络）
function isRetriable(err, status) {
  if (status === 429 || status === 503 || status === 529) return true;
  const msg = err?.message || '';
  if (err?.name === 'AbortError') return true; // 超时
  return /429|503|529|rate|overloaded|RESOURCE_EXHAUSTED|network|Failed to fetch|timeout/i.test(msg);
}

// ========== 重试包装（唯一重试层；bridge 层已不再重试） ==========

async function translateWithRetry(text, context, settings, maxRetries = 3) {
  let delay = 1000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await translateText(text, context, settings);
    } catch (e) {
      const retriable = isRetriable(e, e.status);
      if (!retriable || attempt >= maxRetries) {
        return { ok: false, text: '', code: e.code || 'error', retriable, error: e.message };
      }
      console.warn(`[AI翻译] ${e.name === 'AbortError' ? '超时' : '限流/过载'}，${delay}ms 后重试 (${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

// ========== 主翻译逻辑 ==========

function buildContextHash(context) {
  if (!context) return '0';
  const b = (context.before || []).join('|');
  const a = (context.after || []).join('|');
  return hashStr(b + '##' + a);
}

function buildPrompt(text, context, langName) {
  if (!context || ((context.before || []).length === 0 && (context.after || []).length === 0)) {
    // 无上下文：单句
    return `你是一个专业的影视字幕翻译专家。请将以下台词翻译成地道、流畅的${langName}。
要求：
1. 符合口语习惯，绝对不要机翻感。
2. 结合日常语境（例如日语"ムリムリ"应译为"不行不行"或"办不到"）。
3. 绝对只输出最终的翻译结果，不要带引号，不要任何解释。
台词："${text}"`;
  }

  // 有上下文：给出前后台词作参考，但只翻译 CURRENT
  const beforeLines = (context.before || []).map(t => `  - ${t}`).join('\n');
  const afterLines = (context.after || []).map(t => `  - ${t}`).join('\n');
  return `你是一个专业的影视字幕翻译专家。下面是连续的影视字幕片段。请只翻译标记为 CURRENT 的那一句，翻译成地道、流畅的${langName}。
其余台词仅供你理解上下文（人物指代、语气、话题连贯），不要翻译它们。

前文：
${beforeLines || '  （无）'}

CURRENT（只翻译这一句）：
  >>> ${text}

后文：
${afterLines || '  （无）'}

要求：
1. 符合口语习惯，绝对不要机翻感；结合上下文确定指代和语气。
2. 结合日常语境（例如日语"ムリムリ"应译为"不行不行"或"办不到"）。
3. 绝对只输出 CURRENT 那一句的最终译文，不要带引号，不要解释，不要输出其他台词。`;
}

async function translateText(text, context, settings, skipCache = false) {
  const { apiProvider, targetLang } = settings;
  const apiKey = settings.apiKeys?.[apiProvider] || settings.apiKey || '';
  const model = settings.customModels?.[apiProvider] || DEFAULT_MODELS[apiProvider];

  await cacheReady;

  // 缓存键含上下文 hash：同台词在不同上下文下不复用（方案 A 的关键）
  const ctxHash = buildContextHash(context);
  const cacheKey = `${apiProvider}-${model || ''}-${targetLang}-${PROMPT_VERSION}-${ctxHash}-${text}`;
  if (!skipCache && translationCache.has(cacheKey)) {
    return { ok: true, text: translationCache.get(cacheKey), code: 'cache', retriable: false };
  }

  if (apiProvider !== 'google' && !apiKey) {
    return { ok: false, text: '', code: 'no_key', retriable: false, error: `请配置 ${apiProvider} API Key` };
  }

  const langName = LANG_NAMES[targetLang] || targetLang;
  const prompt = buildPrompt(text, context, langName);

  let result = "";
  if (apiProvider === 'gemini') {
    result = await callGemini(prompt, apiKey, model);
  } else if (apiProvider === 'google') {
    result = await callGoogleFree(text, targetLang);
  } else if (apiProvider === 'openai') {
    result = await callOpenAI(prompt, apiKey, model, settings.openaiEndpoint);
  } else if (apiProvider === 'claude') {
    result = await callClaude(prompt, apiKey, model);
  } else {
    return { ok: false, text: '', code: 'bad_provider', retriable: false, error: '未知提供商' };
  }

  result = (result || '').trim();
  if (!result) {
    return { ok: false, text: '', code: 'empty', retriable: true, error: '翻译为空' };
  }

  cachePut(cacheKey, result);
  return { ok: true, text: result, code: 'ok', retriable: false };
}

// ========== 各供应商实现（全部非流式 + 超时） ==========

async function callGemini(prompt, apiKey, model) {
  const isGemini3 = !/^gemini-2\./.test(model);
  const generationConfig = isGemini3
    ? { thinkingConfig: { thinkingLevel: "minimal" } }
    : { temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig })
  });

  if (!response.ok) {
    const errText = await safeErrorText(response);
    const err = new Error(`Gemini ${response.status}${errText}`);
    err.status = response.status;
    throw err;
  }

  const json = await response.json();
  const parts = json.candidates?.[0]?.content?.parts || [];
  return parts.filter(p => !p.thought && p.text).map(p => p.text).join('').trim();
}

async function callOpenAI(prompt, apiKey, model, endpoint) {
  const url = normalizeOpenAIEndpoint(endpoint);
  await checkEndpointPermission(url);

  const isOfficialOpenAI = url.startsWith('https://api.openai.com/');
  const body = { model, messages: [{ role: "user", content: prompt }] };
  if (!isOfficialOpenAI || /^(gpt-4|gpt-3)/.test(model)) body.temperature = 0.2;

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await safeErrorText(response);
    const err = new Error(`OpenAI兼容端点 ${response.status}${errText}`);
    err.status = response.status;
    throw err;
  }

  const json = await response.json();
  let content = (json.choices?.[0]?.message?.content || '').trim();
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return content;
}

async function callClaude(prompt, apiKey, model) {
  const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] })
  });

  if (!response.ok) {
    const errText = await safeErrorText(response);
    const err = new Error(`Claude ${response.status}${errText}`);
    err.status = response.status;
    throw err;
  }

  const json = await response.json();
  return (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

async function callGoogleFree(text, targetLang) {
  // 非官方接口（client=gtx），随时可能失效；目前可用
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    const err = new Error(`Google翻译 ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const data = await response.json();
  let translatedText = "";
  if (data && data[0]) {
    for (let i = 0; i < data[0].length; i++) translatedText += data[0][i][0];
  }
  return translatedText;
}

async function safeErrorText(response) {
  try {
    const t = await response.text();
    return t ? `: ${t.slice(0, 200)}` : '';
  } catch (e) {
    return '';
  }
}
