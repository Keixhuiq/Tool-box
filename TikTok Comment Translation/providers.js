// TikTok Comment Translator - Provider 抽象层
// 每个 provider 暴露统一接口: translate(text, targetLangName, { signal, settings }) -> Promise<string>
//
// 设计原则:
//   - LLM provider 共用同一个 prompt 模板,保证翻译风格一致
//   - 所有网络调用都接受 AbortSignal,由调用方控制超时
//   - 错误用 ProviderError 抛出,带 kind: 'auth' | 'rate_limit' | 'server' | 'network' | 'other'
//     调用方据此决定是否降级到 Google
//   - LLM 优先用 header 传 key (api.anthropic.com / OpenAI),Google 系仍走 query string

(function () {
	'use strict';

	const GOOGLE_TRANSLATE_API = 'https://translate.googleapis.com/translate_a/single';
	const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

	class ProviderError extends Error {
		constructor(message, kind, status) {
			super(message);
			this.name = 'ProviderError';
			this.kind = kind || 'other';
			this.status = status || 0;
		}
	}

	// 把 HTTP 状态码归类到 error kind,方便调用方决定是否降级
	function classifyHttpError(status) {
		if (status === 401 || status === 403) return 'auth';
		if (status === 429) return 'rate_limit';
		if (status >= 500) return 'server';
		if (status >= 400) return 'other';
		return 'network';
	}

	// LLM 共用的翻译 prompt。targetLangName 是英文语言名 (如 "Simplified Chinese"),
	// 因为 LLM 对英文指令最稳定。
	function buildSystemPrompt(targetLangName) {
		return `You are a translator for TikTok comments. Translate the user-provided text into ${targetLangName}.

Rules:
- Output ONLY the translation. No explanations, no quotes, no prefixes, no labels.
- Keep emoji, @usernames, and #hashtags exactly as-is.
- Translate internet slang naturally (e.g. "lol", "fr", "ngl", "w", "L", "bro") into the target language's modern equivalent rather than literal word-for-word.
- If the input is already in ${targetLangName}, output it unchanged.
- If the input is pure symbols, links, or unintelligible, output it unchanged.
- Preserve the casual tone and emotional register of the original.`;
	}

	// ===== Google Translate =====
	// 免费、不需要 key、质量一般、风格直译。作为默认和兜底。
	async function googleTranslate(text, targetLangCode, { signal } = {}) {
		// 注意: Google Translate 用语言码 (如 'zh'),不是语言名
		const cleanText = text.replace(/[^\p{L}\p{N}\p{P}\p{Z}\p{S}]/gu, '');
		const MAX = 4000;

		async function once(chunk) {
			const url = `${GOOGLE_TRANSLATE_API}?client=gtx&sl=auto&tl=${targetLangCode}&dt=t&q=${encodeURIComponent(chunk)}`;
			const resp = await fetch(url, { signal });
			if (!resp.ok) {
				throw new ProviderError(`Google HTTP ${resp.status}`, classifyHttpError(resp.status), resp.status);
			}
			const data = await resp.json();
			if (!data || !data[0]) throw new ProviderError('Google: invalid response', 'other');
			return data[0].map(item => item[0]).join('');
		}

		if (cleanText.length <= MAX) return once(cleanText);

		// 超长按行切
		const lines = cleanText.split('\n');
		const out = await Promise.all(lines.map(line => line.trim() ? once(line) : Promise.resolve('')));
		return out.join('\n');
	}

	// ===== Gemini =====
	async function geminiTranslate(text, targetLangName, { signal, settings }) {
		const key = settings.geminiApiKey;
		if (!key) throw new ProviderError('Gemini API Key 未配置', 'auth');

		const model = settings.geminiModel || 'gemini-2.5-flash';
		const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;

		const body = {
			systemInstruction: { parts: [{ text: buildSystemPrompt(targetLangName) }] },
			contents: [{ role: 'user', parts: [{ text }] }],
			generationConfig: { temperature: 0.2 },
		};

		const resp = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-goog-api-key': key,
			},
			body: JSON.stringify(body),
			signal,
		});

		if (!resp.ok) {
			const errText = await resp.text().catch(() => '');
			throw new ProviderError(
				`Gemini HTTP ${resp.status}: ${errText.slice(0, 200)}`,
				classifyHttpError(resp.status),
				resp.status
			);
		}

		const data = await resp.json();
		const result = data?.candidates?.[0]?.content?.parts?.[0]?.text;
		if (!result) {
			// candidates 为空通常是 safety block 或者其它内容审查
			const finishReason = data?.candidates?.[0]?.finishReason;
			throw new ProviderError(`Gemini: 无返回内容 (${finishReason || 'unknown'})`, 'other');
		}
		return result.trim();
	}

	// ===== OpenAI 兼容 =====
	// 用户自填 endpoint + model + key。覆盖 OpenAI 官方、DeepSeek、SiliconFlow、
	// OpenRouter、Groq、本地 vLLM/Ollama (OpenAI 模式) 等所有 OpenAI 兼容服务。
	async function openaiCompatTranslate(text, targetLangName, { signal, settings }) {
		const key = settings.openaiApiKey;
		const endpoint = (settings.openaiEndpoint || '').trim();
		const model = (settings.openaiModel || '').trim();

		if (!key) throw new ProviderError('OpenAI API Key 未配置', 'auth');
		if (!endpoint) throw new ProviderError('OpenAI Endpoint 未配置', 'auth');
		if (!model) throw new ProviderError('OpenAI Model 未配置', 'auth');

		// 接受两种形式: 完整 URL (含 /chat/completions) 或基础 URL (会自动追加)
		let url = endpoint.replace(/\/+$/, '');
		if (!/\/chat\/completions$/i.test(url)) url += '/chat/completions';

		const body = {
			model,
			messages: [
				{ role: 'system', content: buildSystemPrompt(targetLangName) },
				{ role: 'user', content: text },
			],
			temperature: 0.2,
		};

		const resp = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${key}`,
			},
			body: JSON.stringify(body),
			signal,
		});

		if (!resp.ok) {
			const errText = await resp.text().catch(() => '');
			throw new ProviderError(
				`OpenAI HTTP ${resp.status}: ${errText.slice(0, 200)}`,
				classifyHttpError(resp.status),
				resp.status
			);
		}

		const data = await resp.json();
		const result = data?.choices?.[0]?.message?.content;
		if (!result) throw new ProviderError('OpenAI: 无返回内容', 'other');
		return result.trim();
	}

	// ===== Anthropic Claude =====
	// 浏览器扩展用 dangerous-direct-browser-access header 才能跨域调用
	async function anthropicTranslate(text, targetLangName, { signal, settings }) {
		const key = settings.anthropicApiKey;
		if (!key) throw new ProviderError('Anthropic API Key 未配置', 'auth');

		const model = settings.anthropicModel || 'claude-haiku-4-5-20251001';
		const url = 'https://api.anthropic.com/v1/messages';

		const body = {
			model,
			max_tokens: 1024,
			system: buildSystemPrompt(targetLangName),
			messages: [{ role: 'user', content: text }],
			temperature: 0.2,
		};

		const resp = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': key,
				'anthropic-version': '2023-06-01',
				// 必须: 否则会被 Anthropic CORS 阻止 (这是官方文档说明的方式)
				'anthropic-dangerous-direct-browser-access': 'true',
			},
			body: JSON.stringify(body),
			signal,
		});

		if (!resp.ok) {
			const errText = await resp.text().catch(() => '');
			throw new ProviderError(
				`Anthropic HTTP ${resp.status}: ${errText.slice(0, 200)}`,
				classifyHttpError(resp.status),
				resp.status
			);
		}

		const data = await resp.json();
		const result = data?.content?.[0]?.text;
		if (!result) throw new ProviderError('Anthropic: 无返回内容', 'other');
		return result.trim();
	}

	// ===== Provider 注册表 =====
	const PROVIDERS = {
		google: {
			id: 'google',
			name: 'Google 翻译',
			needsKey: false,
			translate: googleTranslate,
		},
		gemini: {
			id: 'gemini',
			name: 'Gemini',
			needsKey: true,
			translate: geminiTranslate,
		},
		openai: {
			id: 'openai',
			name: 'OpenAI 兼容',
			needsKey: true,
			translate: openaiCompatTranslate,
		},
		anthropic: {
			id: 'anthropic',
			name: 'Anthropic Claude',
			needsKey: true,
			translate: anthropicTranslate,
		},
	};

	// 暴露到全局 (content script 和 popup 都通过 window.TTCTProviders 访问)
	window.TTCTProviders = {
		PROVIDERS,
		ProviderError,
		buildSystemPrompt,
	};
})();
