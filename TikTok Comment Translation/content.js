// TikTok Comment Translator (Multi-Provider)
// 基于 DuckCIT/TikTok-Comment-Translator (MIT)
//
// 主要改动:
//   1. 翻译走 window.TTCTProviders 抽象,支持 Google/Gemini/OpenAI 兼容/Anthropic
//   2. 移除"每条评论一次 Google 语言检测"——按钮直接显示,LLM prompt 已要求
//      "原文已是目标语言则原样返回",成本省一大半
//   3. 换语言不再需要 F5——按钮文案、缓存 key 都跟随 settings 实时变
//   4. 每次翻译请求带超时 (默认 20s,AbortController)
//   5. LRU 缓存上限 1000 条,避免长时间使用内存涨
//   6. 全局并发上限 3,避免快速点击触发 429
//   7. 4xx (auth/配置错) 不降级到 Google,让用户看到真实错误
//   8. 翻译结果不再用 innerHTML 写入,改用 textContent + <br> 元素,避免 XSS

(function () {
	'use strict';

	// ===== 配置 =====
	const REQUEST_TIMEOUT_MS = 20000;
	const CACHE_MAX_SIZE = 1000;
	const MAX_CONCURRENT = 3;
	const DEFAULT_SETTINGS = {
		targetLanguage: 'zh',
		provider: 'google',
		geminiApiKey: '',
		geminiModel: 'gemini-2.5-flash',
		openaiApiKey: '',
		openaiEndpoint: 'https://api.openai.com/v1',
		openaiModel: 'gpt-4o-mini',
		anthropicApiKey: '',
		anthropicModel: 'claude-haiku-4-5-20251001',
		llmFallbackToGoogle: true, // 5xx/网络错时降级到 Google
	};

	// ===== 状态 =====
	let translations = {};
	const settings = { ...DEFAULT_SETTINGS };
	const { PROVIDERS, ProviderError } = window.TTCTProviders;

	// LRU 缓存 (利用 Map 的插入顺序保证最近访问的在末尾)
	const translationCache = new Map();
	function cacheGet(key) {
		if (!translationCache.has(key)) return undefined;
		const v = translationCache.get(key);
		// 重新插入,更新顺序
		translationCache.delete(key);
		translationCache.set(key, v);
		return v;
	}
	function cacheSet(key, value) {
		if (translationCache.has(key)) translationCache.delete(key);
		translationCache.set(key, value);
		while (translationCache.size > CACHE_MAX_SIZE) {
			const firstKey = translationCache.keys().next().value;
			translationCache.delete(firstKey);
		}
	}

	// 简单并发队列
	let inflight = 0;
	const waitQueue = [];
	function acquireSlot() {
		return new Promise(resolve => {
			if (inflight < MAX_CONCURRENT) {
				inflight++;
				resolve();
			} else {
				waitQueue.push(resolve);
			}
		});
	}
	function releaseSlot() {
		inflight--;
		const next = waitQueue.shift();
		if (next) {
			inflight++;
			next();
		}
	}

	// ===== 初始化 =====

	// storage 分两块: local 存 key (敏感,不跨设备同步),sync 存偏好
	function loadSettings() {
		return new Promise(resolve => {
			chrome.storage.sync.get(
				{
					targetLanguage: DEFAULT_SETTINGS.targetLanguage,
					provider: DEFAULT_SETTINGS.provider,
					geminiModel: DEFAULT_SETTINGS.geminiModel,
					openaiEndpoint: DEFAULT_SETTINGS.openaiEndpoint,
					openaiModel: DEFAULT_SETTINGS.openaiModel,
					anthropicModel: DEFAULT_SETTINGS.anthropicModel,
					llmFallbackToGoogle: DEFAULT_SETTINGS.llmFallbackToGoogle,
				},
				syncResult => {
					chrome.storage.local.get(
						{
							geminiApiKey: '',
							openaiApiKey: '',
							anthropicApiKey: '',
						},
						localResult => {
							Object.assign(settings, syncResult, localResult);
							resolve();
						}
					);
				}
			);
		});
	}

	fetch(chrome.runtime.getURL('data/languages.json'))
		.then(r => r.json())
		.then(data => {
			translations = data;
			return loadSettings();
		})
		.then(() => {
			processExistingComments();
			startObserver();
		})
		.catch(err => console.error('[ttct] init failed:', err));

	chrome.storage.onChanged.addListener((changes, area) => {
		let invalidateCache = false;
		for (const [k, v] of Object.entries(changes)) {
			if (k in settings) {
				settings[k] = v.newValue;
				// provider 切换 / key 变化 / model 变化 / 目标语言变化 都让缓存失效
				if (['provider', 'targetLanguage', 'geminiApiKey', 'geminiModel',
					'openaiApiKey', 'openaiEndpoint', 'openaiModel',
					'anthropicApiKey', 'anthropicModel'].includes(k)) {
					invalidateCache = true;
				}
			}
		}
		if (invalidateCache) translationCache.clear();

		// 目标语言变了,刷新所有已添加按钮的文案
		if (changes.targetLanguage) refreshAllButtonLabels();
	});

	// ===== 翻译核心 =====

	function getTexts() {
		return translations[settings.targetLanguage]?.content
			|| translations.en?.content
			|| { translate: 'Translate', original: 'Original', translating: '...', errors: {} };
	}

	function getTargetLangName() {
		const def = translations[settings.targetLanguage];
		return def?.geminiName || def?.popup?.languageNames?.[settings.targetLanguage] || settings.targetLanguage;
	}

	async function translateText(text) {
		const cacheKey = `${settings.provider}::${settings.targetLanguage}::${text}`;
		const cached = cacheGet(cacheKey);
		if (cached !== undefined) return cached;

		await acquireSlot();
		try {
			const result = await doTranslate(text);
			cacheSet(cacheKey, result);
			return result;
		} finally {
			releaseSlot();
		}
	}

	async function doTranslate(text) {
		const providerId = settings.provider || 'google';
		const provider = PROVIDERS[providerId] || PROVIDERS.google;

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		try {
			// Google 用语言码,LLM 用语言名
			const target = providerId === 'google' ? settings.targetLanguage : getTargetLangName();
			return await provider.translate(text, target, { signal: controller.signal, settings });
		} catch (err) {
			// 是否降级到 Google?
			//   - 当前已经是 Google: 不降级
			//   - auth 错误 (4xx): 不降级 (让用户看到 key 配错了)
			//   - 用户关闭了降级: 不降级
			//   - 其它 (网络/超时/server/safety): 降级
			const isAuthError = err instanceof ProviderError && err.kind === 'auth';
			const shouldFallback = providerId !== 'google'
				&& !isAuthError
				&& settings.llmFallbackToGoogle;

			if (shouldFallback) {
				console.warn(`[ttct] ${providerId} failed, falling back to Google:`, err.message);
				const fallbackController = new AbortController();
				const fallbackTimeout = setTimeout(() => fallbackController.abort(), REQUEST_TIMEOUT_MS);
				try {
					return await PROVIDERS.google.translate(text, settings.targetLanguage, {
						signal: fallbackController.signal,
						settings,
					});
				} finally {
					clearTimeout(fallbackTimeout);
				}
			}
			throw err;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	// ===== DOM 注入 =====

	// 把翻译结果安全地写入 DOM (避免 innerHTML XSS)
	function setTextWithLineBreaks(element, text) {
		element.textContent = '';
		const lines = text.split('\n');
		lines.forEach((line, i) => {
			if (i > 0) element.appendChild(document.createElement('br'));
			element.appendChild(document.createTextNode(line));
		});
	}

	// 记录所有已添加的按钮,方便目标语言变化时刷新文案
	const buttonRegistry = new Set();

	function refreshAllButtonLabels() {
		const texts = getTexts();
		buttonRegistry.forEach(entry => {
			// 评论被 TikTok 从 DOM 移除时(滚动很多内容),顺手清理
			if (!entry.button.isConnected) {
				buttonRegistry.delete(entry);
				return;
			}
			entry.button.innerText = entry.isTranslated ? texts.original : texts.translate;
		});
	}

	// 把"返信"按钮的实际渲染样式复制到自己的按钮上,确保视觉对齐。
	// 一级 / 二级评论 DOM 结构不同,要分别找到真正承载文字的那个元素。
	function matchReplyButtonStyle(myButton, replyEl) {
		if (!replyEl) return;

		// 找到"返信"里真正显示文字的那个 element
		//   一级评论: replyEl 本身就是 <p class="TUXText...">,直接用
		//   二级评论: replyEl 是 <button>,文字在内层的 <div class="tux-web-canary P1-Semibold">
		let textEl = replyEl;
		if (replyEl.tagName === 'BUTTON') {
			// 优先找带 P1-* 或 tux-web-canary class 的内层 div (新 TUX 设计系统)
			textEl = replyEl.querySelector('[class*="P1-"], .tux-web-canary, [class*="text-container"] div, [class*="tux-button__text"]')
				|| replyEl;
		}

		function apply() {
			const cs = window.getComputedStyle(textEl);
			// 只抄文字相关的属性,布局相关的让 CSS 处理 (margin/align-self 还在 .ttct-translate-button 里)
			myButton.style.fontSize = cs.fontSize;
			myButton.style.fontWeight = cs.fontWeight;
			myButton.style.lineHeight = cs.lineHeight;
			myButton.style.letterSpacing = cs.letterSpacing;
			myButton.style.fontFamily = cs.fontFamily;
		}

		// 同步抄一次 (textEl 一般已经渲染过了)
		apply();
		// rAF 再抄一次兜底——万一 React 后续 patch 了样式,这一次能纠正过来,
		// 同时也避免出现"按钮先用默认字号闪一下再变"的视觉跳变。
		requestAnimationFrame(apply);
	}


	function addTranslateButton(comment, container, commentTextElement, originalText) {
		if (!originalText || comment.dataset.translateButtonAdded) return;

		// 立即打标记,防止 Observer 在异步过程中重复处理同一条评论
		comment.dataset.translateButtonAdded = 'true';

		const texts = getTexts();
		const originalLines = commentTextElement.textContent.split('\n');

		const translateButton = document.createElement('span');
		translateButton.innerText = texts.translate;
		translateButton.classList.add('ttct-translate-button', 'translate-button');

		const replyButton = container.querySelector('[data-e2e^="comment-reply-"]');
		if (replyButton) {
			// 原项目踩过的坑: 把按钮插在 DivReplyTriggerWrapper 之后,而不是 replyButton 之后
			const replyWrapper = replyButton.closest('[class*="DivReplyTriggerWrapper"]');
			(replyWrapper || replyButton).insertAdjacentElement('afterend', translateButton);
		} else {
			container.appendChild(translateButton);
		}

		// 关键: 探测同评论里"返信"按钮的实际渲染样式,照抄
		// 一级评论的"返信"是 <p class="TUXText"> (13.125px / weight 500),
		// 二级评论的"返信"是 <button> 内嵌 <div class="tux-web-canary P1-Semibold"> (14px / weight 600),
		// 两种结构 font-size/weight 都不同。靠 CSS 继承对不齐,直接抄它的 computed style 最稳。
		matchReplyButtonStyle(translateButton, replyButton);

		const entry = { button: translateButton, isTranslated: false };
		buttonRegistry.add(entry);

		translateButton.addEventListener('click', async () => {
			const curTexts = getTexts();
			if (!entry.isTranslated) {
				translateButton.innerText = curTexts.translating;
				try {
					const translated = await translateText(originalText);
					setTextWithLineBreaks(commentTextElement, translated);
					translateButton.innerText = curTexts.original;
					entry.isTranslated = true;
				} catch (err) {
					console.error('[ttct] translate error:', err);
					// 把错误信息显示出来,带 provider 上下文
					const msg = err instanceof ProviderError
						? `[${err.kind}] ${err.message}`
						: (err?.message || String(err));
					setTextWithLineBreaks(commentTextElement, `⚠ ${msg}`);
					// 3 秒后恢复原文,让用户能再试
					setTimeout(() => {
						setTextWithLineBreaks(commentTextElement, originalLines.join('\n'));
						translateButton.innerText = getTexts().translate;
					}, 3000);
				}
			} else {
				setTextWithLineBreaks(commentTextElement, originalLines.join('\n'));
				translateButton.innerText = curTexts.translate;
				entry.isTranslated = false;
			}
		});
	}

	// ===== 评论扫描 =====

	function tryAddButton(comment) {
		if (comment.dataset.translateButtonAdded) return;
		const container = comment.closest('div')?.querySelector('[data-e2e^="comment-reply-"]')?.parentElement
			|| comment.closest('div');
		if (!container) return;
		const commentTextElement = comment.querySelector('span, p') || comment;
		const originalText = commentTextElement.textContent.trim();
		addTranslateButton(comment, container, commentTextElement, originalText);
	}

	function processExistingComments() {
		document.querySelectorAll('[data-e2e^="comment-level-"]').forEach(tryAddButton);
	}

	function startObserver() {
		const observer = new MutationObserver(mutations => {
			for (const mutation of mutations) {
				for (const node of mutation.addedNodes) {
					if (node.nodeType !== 1) continue;
					if (node.matches?.('[data-e2e^="comment-level-"]')) {
						tryAddButton(node);
					}
					node.querySelectorAll?.('[data-e2e^="comment-level-"]').forEach(tryAddButton);
				}
			}
		});

		const commentSection =
			document.querySelector('[class*="DivCommentItemContainer"]') ||
			document.querySelector('[class*="DivCommentObjectWrapper"]') ||
			document.body;
		observer.observe(commentSection, { childList: true, subtree: true });
	}
})();
