// TikTok Comment Translator - Provider 抽象层
// 每个 provider 暴露统一接口: translate(text, target, { signal, settings }) -> Promise<string>
//
// 设计原则:
//   - 同时运行在 background service worker 和扩展页面里,因此挂在 globalThis 而不是 window
//   - LLM provider 共用同一个 prompt 模板,保证翻译风格一致
//   - 所有网络调用都接受 AbortSignal,由调用方控制超时
//   - 错误用 ProviderError 抛出,带 kind:
//       'auth'       401/403, key 配错        -> 不降级
//       'config'     其它 4xx, 模型名/参数错  -> 不降级 (让用户看到真实错误)
//       'rate_limit' 429                      -> 可降级
//       'server'     5xx                      -> 可降级
//       'network'    fetch 失败/超时          -> 可降级
//       'other'      解析失败/safety block    -> 可降级
//   - LLM 用 header 传 key,Google 系仍走 query string

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

	// 把 HTTP 状态码归类到 error kind,方便调用方决定是否降级。
	// 注意: 400/404/422 等归为 'config' 而不是 'other'——模型名拼错、参数不对
	// 都属于用户配置问题,降级到 Google 会掩盖错误,所以和 auth 一样不降级。
	function classifyHttpError(status) {
		if (status === 401 || status === 403) return 'auth';
		if (status === 429) return 'rate_limit';
		if (status >= 500) return 'server';
		if (status >= 400) return 'config';
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
		// 清洗掉不可见控制字符,但显式保留 \n (Cc 类,不在 L/N/P/Z/S 里,
		// 旧版正则把它洗掉了,导致多行评论变一行 + 分块逻辑永远走不到)
		const cleanText = text.replace(/[^\p{L}\p{N}\p{P}\p{Z}\p{S}\n]/gu, '');

		// 这是 GET 请求,限制要按 *URL 编码后* 的字节数算:
		// CJK 一个字符 encodeURIComponent 后是 9 字节,按原始字符数判断会爆 URL 长度
		const MAX_ENCODED = 6000;

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

		const encLen = s => encodeURIComponent(s).length;

		if (encLen(cleanText) <= MAX_ENCODED) return once(cleanText);

		// 超长: 先按行切,单行仍超限的再硬切
		const pieces = [];
		for (const line of cleanText.split('\n')) {
			if (encLen(line) <= MAX_ENCODED) {
				pieces.push(line);
				continue;
			}
			let rest = line;
			while (rest.length) {
				// 估算: 最坏 9 字节/字符,先取一个保守长度再微调
				let take = Math.max(1, Math.floor(MAX_ENCODED / 9));
				while (take < rest.length && encLen(rest.slice(0, take + 1)) <= MAX_ENCODED) take++;
				pieces.push(rest.slice(0, take));
				rest = rest.slice(take);
			}
		}
		const out = await Promise.all(pieces.map(p => p.trim() ? once(p) : Promise.resolve('')));
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
			generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
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
		const candidate = data?.candidates?.[0];
		const result = candidate?.content?.parts?.[0]?.text;
		if (!result) {
			// candidates 为空通常是 safety block 或者其它内容审查
			const finishReason = candidate?.finishReason;
			throw new ProviderError(`Gemini: 无返回内容 (${finishReason || 'unknown'})`, 'other');
		}
		// 输出被 maxOutputTokens 截断: 抛 'other',让降级逻辑交给 Google 处理长文本
		if (candidate.finishReason === 'MAX_TOKENS') {
			throw new ProviderError('Gemini: 输出超长被截断', 'other');
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
		if (!endpoint) throw new ProviderError('OpenAI Endpoint 未配置', 'config');
		if (!model) throw new ProviderError('OpenAI Model 未配置', 'config');

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
			max_tokens: 2048,
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
		const choice = data?.choices?.[0];
		const result = choice?.message?.content;
		if (!result) throw new ProviderError('OpenAI: 无返回内容', 'other');
		if (choice.finish_reason === 'length') {
			throw new ProviderError('OpenAI: 输出超长被截断', 'other');
		}
		return result.trim();
	}

	// ===== Anthropic Claude =====
	// 浏览器侧直连需要 dangerous-direct-browser-access header (官方文档说明的方式);
	// 现在请求统一从 background service worker 发出,header 保留以防万一。
	async function anthropicTranslate(text, targetLangName, { signal, settings }) {
		const key = settings.anthropicApiKey;
		if (!key) throw new ProviderError('Anthropic API Key 未配置', 'auth');

		const model = settings.anthropicModel || 'claude-haiku-4-5-20251001';
		const url = 'https://api.anthropic.com/v1/messages';

		const body = {
			model,
			max_tokens: 2048,
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
		if (data.stop_reason === 'max_tokens') {
			throw new ProviderError('Anthropic: 输出超长被截断', 'other');
		}
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

	// 挂 globalThis: window (扩展页面) 和 self (service worker) 都能访问
	globalThis.TTCTProviders = {
		PROVIDERS,
		ProviderError,
		buildSystemPrompt,
	};
})();
