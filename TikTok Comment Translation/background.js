// TikTok Comment Translator - Background Service Worker
//
// 为什么需要这一层:
//   MV3 里 content script 的跨域 fetch 不享受 host_permissions,走的是页面 CORS。
//   之前能跑通纯属四个官方端点都恰好开了 CORS;用户自填的 OpenAI 兼容端点
//   (中转站 / 自建 one-api / 内网 vLLM) 大多不返回 CORS 头,直接 Failed to fetch。
//   把所有 API 调用收到 service worker 里,host_permissions / 动态授权的
//   optional_host_permissions 才真正生效,CORS 不再是问题。
//
// 消息协议 (chrome.runtime.sendMessage):
//   { type: 'ttct.translate', text, providerId, targetLangCode, targetLangName, settings }
//     -> { ok: true, result, via }          via: 实际使用的 provider (降级时是 'google')
//     -> { ok: false, error: { kind, message, status } }
//   { type: 'ttct.test', providerId, targetLangName, settings }
//     -> 同上,不走降级

importScripts('providers.js');

const { PROVIDERS, ProviderError } = globalThis.TTCTProviders;

const REQUEST_TIMEOUT_MS = 20000;

// 这些 origin 已在 manifest host_permissions 里,无需动态授权
const BUILTIN_ORIGINS = [
	'https://translate.googleapis.com',
	'https://generativelanguage.googleapis.com',
	'https://api.anthropic.com',
	'https://api.openai.com',
];

function toPlainError(err) {
	if (err instanceof ProviderError) {
		return { kind: err.kind, message: err.message, status: err.status };
	}
	if (err?.name === 'AbortError') {
		return { kind: 'network', message: '请求超时', status: 0 };
	}
	return { kind: 'network', message: err?.message || String(err), status: 0 };
}

// 自定义 endpoint 缺少 host 权限时,fetch 会以 TypeError 失败且信息毫无指向性。
// 这里把它翻译成可操作的提示。
async function checkEndpointPermission(providerId, settings) {
	if (providerId !== 'openai') return null;
	let origin;
	try {
		origin = new URL((settings.openaiEndpoint || '').trim()).origin;
	} catch {
		return { kind: 'config', message: 'Endpoint 不是合法 URL', status: 0 };
	}
	if (BUILTIN_ORIGINS.includes(origin)) return null;
	const granted = await chrome.permissions.contains({ origins: [origin + '/*'] });
	if (!granted) {
		return {
			kind: 'permission',
			message: `未授权访问 ${origin},请打开扩展弹窗点击"测试连接"完成授权`,
			status: 0,
		};
	}
	return null;
}

async function callProvider(providerId, text, target, settings) {
	const provider = PROVIDERS[providerId] || PROVIDERS.google;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await provider.translate(text, target, { signal: controller.signal, settings });
	} finally {
		clearTimeout(timeoutId);
	}
}

async function handleTranslate({ text, providerId, targetLangCode, targetLangName, settings }) {
	providerId = providerId || 'google';
	const target = providerId === 'google' ? targetLangCode : targetLangName;

	const permErr = await checkEndpointPermission(providerId, settings);
	if (permErr) return { ok: false, error: permErr };

	try {
		const result = await callProvider(providerId, text, target, settings);
		return { ok: true, result, via: providerId };
	} catch (err) {
		const plain = toPlainError(err);
		// 是否降级到 Google?
		//   - 当前已经是 Google: 不降级
		//   - auth (key 错) / config (模型名等配错): 不降级,让用户看到真实错误
		//   - 用户关闭了降级: 不降级
		//   - 其它 (网络/超时/server/rate_limit/safety): 降级
		const shouldFallback = providerId !== 'google'
			&& plain.kind !== 'auth'
			&& plain.kind !== 'config'
			&& settings.llmFallbackToGoogle;

		if (shouldFallback) {
			console.warn(`[ttct] ${providerId} failed, falling back to Google:`, plain.message);
			try {
				const result = await callProvider('google', text, targetLangCode, settings);
				return { ok: true, result, via: 'google' };
			} catch (fbErr) {
				return { ok: false, error: toPlainError(fbErr) };
			}
		}
		return { ok: false, error: plain };
	}
}

async function handleTest({ providerId, targetLangName, settings }) {
	const permErr = await checkEndpointPermission(providerId, settings);
	if (permErr) return { ok: false, error: permErr };
	try {
		const target = providerId === 'google' ? 'en' : targetLangName;
		const result = await callProvider(providerId, 'Hello!', target, settings);
		return { ok: true, result, via: providerId };
	} catch (err) {
		return { ok: false, error: toPlainError(err) };
	}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (msg?.type === 'ttct.translate') {
		handleTranslate(msg).then(sendResponse);
		return true; // 异步响应
	}
	if (msg?.type === 'ttct.test') {
		handleTest(msg).then(sendResponse);
		return true;
	}
});
