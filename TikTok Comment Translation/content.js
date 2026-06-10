// TikTok Comment Translator (Multi-Provider)
// 基于 DuckCIT/TikTok-Comment-Translator (MIT)
//
// v1.3 主要改动:
//   1. 翻译请求改走 background service worker (chrome.runtime.sendMessage),
//      content script 不再直接 fetch——自定义端点不再受页面 CORS 限制
//   2. 缓存改存 Promise: 同一文本并发点击只发一个请求 (in-flight 去重)
//   3. 翻译进行中按钮置 data-state="loading" 并拒绝重复点击 (CSS 早就写好了,补上 JS)
//   4. 原文用 innerText 而不是 textContent 读取——<br> 转成 \n,多行评论还原不再丢换行
//   5. MutationObserver 固定挂 document.body——TikTok 是 SPA,挂在具体评论容器上
//      会在切视频时随节点一起被销毁,新页面评论永远不出按钮
//   6. 所有 TikTok DOM 选择器集中到 SELECTORS,改版断了只改一处

(function () {
	'use strict';

	// ===== TikTok DOM 选择器 (改版后在这里统一修) =====
	const SELECTORS = {
		comment: '[data-e2e^="comment-level-"]',
		replyButton: '[data-e2e^="comment-reply-"]',
		replyWrapper: '[class*="DivReplyTriggerWrapper"]',
		replyButtonTextInner: '[class*="P1-"], .tux-web-canary, [class*="text-container"] div, [class*="tux-button__text"]',
		commentTextInner: 'span, p',
	};

	// ===== 配置 =====
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

	// LRU 缓存。value 是 Promise<string>:
	// 并发请求同一文本时第二个调用方直接 await 同一个 Promise,不会重复发请求。
	const translationCache = new Map();
	function cacheGet(key) {
		if (!translationCache.has(key)) return undefined;
		const v = translationCache.get(key);
		// 重新插入,更新 LRU 顺序
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

	// 通过 background SW 翻译。返回 Promise<string>,失败 reject 一个带 kind 的 Error。
	function requestTranslate(text) {
		return new Promise((resolve, reject) => {
			chrome.runtime.sendMessage(
				{
					type: 'ttct.translate',
					text,
					providerId: settings.provider || 'google',
					targetLangCode: settings.targetLanguage,
					targetLangName: getTargetLangName(),
					settings,
				},
				resp => {
					if (chrome.runtime.lastError) {
						reject(new Error(chrome.runtime.lastError.message));
						return;
					}
					if (resp?.ok) {
						resolve(resp.result);
					} else {
						const e = new Error(resp?.error?.message || 'unknown error');
						e.kind = resp?.error?.kind || 'other';
						reject(e);
					}
				}
			);
		});
	}

	function translateText(text) {
		const cacheKey = `${settings.provider}::${settings.targetLanguage}::${text}`;
		const cached = cacheGet(cacheKey);
		if (cached !== undefined) return cached;

		// 立即把 in-flight Promise 放进缓存——并发点击同一条评论只发一个请求
		const promise = (async () => {
			await acquireSlot();
			try {
				return await requestTranslate(text);
			} finally {
				releaseSlot();
			}
		})();

		cacheSet(cacheKey, promise);
		// 失败的 Promise 不留在缓存里,否则错误会被永久缓存,用户没法重试
		promise.catch(() => {
			if (translationCache.get(cacheKey) === promise) {
				translationCache.delete(cacheKey);
			}
		});
		return promise;
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
			textEl = replyEl.querySelector(SELECTORS.replyButtonTextInner) || replyEl;
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
		// innerText 把 <br> 转成 \n;textContent 不会,会丢掉多行评论的换行
		const originalLines = commentTextElement.innerText.split('\n');

		const translateButton = document.createElement('span');
		translateButton.innerText = texts.translate;
		translateButton.classList.add('ttct-translate-button', 'translate-button');

		const replyButton = container.querySelector(SELECTORS.replyButton);
		if (replyButton) {
			// 原项目踩过的坑: 把按钮插在 DivReplyTriggerWrapper 之后,而不是 replyButton 之后
			const replyWrapper = replyButton.closest(SELECTORS.replyWrapper);
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
			// 进行中拒绝重复点击 (配合 content.css 的 [data-state="loading"] 视觉提示)
			if (translateButton.dataset.state === 'loading') return;

			const curTexts = getTexts();
			if (!entry.isTranslated) {
				translateButton.dataset.state = 'loading';
				translateButton.innerText = curTexts.translating;
				try {
					const translated = await translateText(originalText);
					setTextWithLineBreaks(commentTextElement, translated);
					translateButton.innerText = curTexts.original;
					entry.isTranslated = true;
				} catch (err) {
					console.error('[ttct] translate error:', err);
					// 把错误信息显示出来,带 kind 上下文 (auth/config/permission/...)
					const msg = err.kind ? `[${err.kind}] ${err.message}` : (err?.message || String(err));
					setTextWithLineBreaks(commentTextElement, `⚠ ${msg}`);
					// 3 秒后恢复原文,让用户能再试
					setTimeout(() => {
						setTextWithLineBreaks(commentTextElement, originalLines.join('\n'));
						translateButton.innerText = getTexts().translate;
					}, 3000);
				} finally {
					delete translateButton.dataset.state;
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
		const container = comment.closest('div')?.querySelector(SELECTORS.replyButton)?.parentElement
			|| comment.closest('div');
		if (!container) return;
		const commentTextElement = comment.querySelector(SELECTORS.commentTextInner) || comment;
		const originalText = commentTextElement.innerText.trim();
		addTranslateButton(comment, container, commentTextElement, originalText);
	}

	function processExistingComments() {
		document.querySelectorAll(SELECTORS.comment).forEach(tryAddButton);
	}

	function startObserver() {
		const observer = new MutationObserver(mutations => {
			for (const mutation of mutations) {
				for (const node of mutation.addedNodes) {
					if (node.nodeType !== 1) continue;
					if (node.matches?.(SELECTORS.comment)) {
						tryAddButton(node);
					}
					node.querySelectorAll?.(SELECTORS.comment).forEach(tryAddButton);
				}
			}
		});

		// 固定挂 document.body: TikTok 是 SPA,挂在具体评论容器上,
		// 切视频时容器被整个替换,observer 跟着失效,新评论永远不出按钮。
		// body 上的回调有 matches 快速过滤,开销可接受。
		observer.observe(document.body, { childList: true, subtree: true });
	}
})();
