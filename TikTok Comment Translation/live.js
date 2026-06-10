// TikTok Comment Translator - 直播间聊天翻译模块
//
// 和视频评论 (content.js) 的交互模型完全不同,所以独立成文件:
//   - 视频评论: 用户逐条点击翻译,结果替换原文
//   - 直播聊天: 流式刷屏,总开关自动翻译,结果以小字 append 在原消息下方
//     (不替换原文——直播 DOM 重渲染频繁,改 TikTok 的文本节点必和 React 打架)
//
// 关键设计:
//   1. 虚拟列表节点回收: chat-message 的 DOM 节点会被复用换上新内容,
//      不能打一次 dataset 标记就认为处理过——用"内容指纹" (username+text hash)
//      判断节点当前承载的是不是已处理的那条消息。
//   2. 不逐 mutation 跟踪,改为 1.5s 定时扫描可见行 + 指纹比对。
//      可见行只有几十个,扫描成本可忽略,且对虚拟列表的任何更新方式免疫。
//   3. 批量翻译: 每个 tick 把窗口内未翻译的消息合成一个请求 (去重后最多 30 条),
//      LLM 走 JSON 数组进出,Google 走换行拼接。逐条请求会烧爆 token 和速率。
//   4. 本地语言过滤: 自动模式下大部分消息可能本来就是目标语言,
//      用文字系统启发式 (CJK/假名/谚文/西里尔占比) 零成本跳过,不发请求。
//   5. 背压: 最多 2 个批量请求在途;翻不过来宁可漏翻旧消息,绝不让队列无限堆积。

(function () {
	'use strict';

	// ===== TikTok 直播 DOM 选择器 (改版后在这里统一修) =====
	const SELECTORS = {
		chatContainer: '[data-e2e="live-chat-container"]',
		chatMessage: '[data-e2e="chat-message"]',
		messageText: '[class~="break-words"][class~="align-middle"]',
		// 礼物 / 进场提示等系统消息,不翻译
		skipInside: '[data-e2e="gift-container"], [data-e2e="enter-message"]',
	};

	// ===== 配置 =====
	const TICK_MS = 1500;            // 扫描 + 攒批周期
	const BATCH_MAX = 30;            // 单次请求最多多少条 (去重后)
	const MAX_INFLIGHT_BATCHES = 2;  // 在途批量请求上限 (背压)
	const CACHE_MAX_SIZE = 2000;     // 文本级缓存 (直播刷屏重复率很高: 666/哈哈哈)
	const RESULT_MAX_LEN = 500;      // 单条消息超长截断保护

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
		llmFallbackToGoogle: true,
		liveTranslateEnabled: false, // popup 总开关,默认关 (持续烧 API,必须用户主动开)
	};

	// ===== 状态 =====
	let translations = {};
	const settings = { ...DEFAULT_SETTINGS };
	let runtimeActive = true;   // 页内开关 (不持久化,每个直播间默认跟随总开关)
	let tickTimer = null;
	let inflightBatches = 0;
	let togglePill = null;
	let currentChatRoot = null;

	// 文本 -> 译文 (或 null 表示"判定为目标语言,跳过") 的 LRU 缓存
	const cache = new Map();
	function cacheGet(key) {
		if (!cache.has(key)) return undefined;
		const v = cache.get(key);
		cache.delete(key);
		cache.set(key, v);
		return v;
	}
	function cacheSet(key, value) {
		if (cache.has(key)) cache.delete(key);
		cache.set(key, value);
		while (cache.size > CACHE_MAX_SIZE) {
			cache.delete(cache.keys().next().value);
		}
	}

	// ===== 设置加载 (和 content.js 同一套 storage 布局) =====
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
					liveTranslateEnabled: DEFAULT_SETTINGS.liveTranslateEnabled,
				},
				syncResult => {
					chrome.storage.local.get(
						{ geminiApiKey: '', openaiApiKey: '', anthropicApiKey: '' },
						localResult => {
							Object.assign(settings, syncResult, localResult);
							resolve();
						}
					);
				}
			);
		});
	}

	chrome.storage.onChanged.addListener(changes => {
		for (const [k, v] of Object.entries(changes)) {
			if (k in settings) settings[k] = v.newValue;
		}
		if (changes.targetLanguage || changes.provider) cache.clear();
		if (changes.liveTranslateEnabled) {
			runtimeActive = !!changes.liveTranslateEnabled.newValue;
			syncPill();
		}
	});

	function getTexts() {
		const c = translations[settings.targetLanguage]?.content || translations.en?.content || {};
		return {
			liveOn: c.liveOn || 'AI Trans ON',
			liveOff: c.liveOff || 'AI Trans OFF',
		};
	}

	function getTargetLangName() {
		const def = translations[settings.targetLanguage];
		return def?.geminiName || def?.popup?.languageNames?.[settings.targetLanguage] || settings.targetLanguage;
	}

	// ===== 本地语言启发式 =====
	// 判断"这条消息大概率已经是目标语言",是则不发请求。
	// 只覆盖能靠文字系统区分的语言;拉丁字母系 (en/es/fr/vi) 互相无法廉价区分,
	// 只跳过完全没有字母的消息 (纯 emoji / 数字 / 符号)。
	function probablyTargetLanguage(text) {
		const letters = text.replace(/[^\p{L}]/gu, '');
		if (!letters) return true; // 纯 emoji/符号/数字,翻了也没意义

		const ratio = re => (letters.match(re) || []).length / letters.length;
		switch (settings.targetLanguage) {
			case 'zh': return ratio(/\p{Script=Han}/gu) > 0.6;
			// ja 只认假名: 直播短消息的日语几乎必含假名,
			// 纯汉字文本更可能是中文,不能用"汉字占比"兜底误跳过
			case 'ja': return ratio(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) > 0.25;
			case 'ko': return ratio(/\p{Script=Hangul}/gu) > 0.6;
			case 'ru': return ratio(/\p{Script=Cyrillic}/gu) > 0.6;
			default: return false;
		}
	}

	// ===== 指纹 =====
	function fingerprint(text) {
		// djb2,够用且快
		let h = 5381;
		for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
		return h.toString(36) + ':' + text.length;
	}

	// ===== 翻译结果写入 =====
	function applyTranslation(row, textEl, key, translated) {
		// 节点可能已被虚拟列表回收换了内容,应用前必须复核指纹
		if (!row.isConnected || row.dataset.ttctKey !== key) return;
		removeAppended(row);
		const span = document.createElement('span');
		span.className = 'ttct-live-trans';
		span.textContent = translated.slice(0, RESULT_MAX_LEN);
		textEl.insertAdjacentElement('afterend', span);
		row.dataset.ttctState = 'done';
	}

	function removeAppended(row) {
		row.querySelectorAll('.ttct-live-trans').forEach(el => el.remove());
	}

	// ===== 扫描 + 攒批 =====
	function scanAndCollect() {
		const pending = []; // { row, textEl, key, text }
		const rows = currentChatRoot.querySelectorAll(SELECTORS.chatMessage);

		for (const row of rows) {
			if (row.querySelector(SELECTORS.skipInside)) continue;
			const textEl = row.querySelector(SELECTORS.messageText);
			if (!textEl) continue;

			const text = textEl.innerText.trim();
			if (!text) continue;
			const key = fingerprint(text);

			// 指纹一致且已处理 -> 跳过;指纹变了 -> 节点被回收,清掉旧译文重处理
			if (row.dataset.ttctKey === key && row.dataset.ttctState) continue;
			if (row.dataset.ttctKey && row.dataset.ttctKey !== key) removeAppended(row);

			row.dataset.ttctKey = key;

			// 命中缓存直接写
			const cached = cacheGet(text);
			if (cached !== undefined) {
				if (cached === null) {
					row.dataset.ttctState = 'skipped';
				} else {
					applyTranslation(row, textEl, key, cached);
				}
				continue;
			}

			// 本地语言过滤
			if (probablyTargetLanguage(text)) {
				cacheSet(text, null);
				row.dataset.ttctState = 'skipped';
				continue;
			}

			row.dataset.ttctState = 'queued';
			pending.push({ row, textEl, key, text });
		}
		return pending;
	}

	async function flushBatch(pending) {
		if (!pending.length) return;
		// 背压: 在途批次满了就放弃这一窗口的消息 (它们几秒后就滚走了,漏翻比堆积好)
		if (inflightBatches >= MAX_INFLIGHT_BATCHES) {
			pending.forEach(p => { delete p.row.dataset.ttctState; });
			return;
		}

		// 文本去重 (刷屏消息重复率高),截断到 BATCH_MAX
		const uniqueTexts = [...new Set(pending.map(p => p.text))].slice(0, BATCH_MAX);
		const inBatch = new Set(uniqueTexts);
		const items = pending.filter(p => inBatch.has(p.text));
		const overflow = pending.filter(p => !inBatch.has(p.text));
		overflow.forEach(p => { delete p.row.dataset.ttctState; }); // 下个 tick 再试

		inflightBatches++;
		try {
			const resp = await chrome.runtime.sendMessage({
				type: 'ttct.translateBatch',
				items: uniqueTexts,
				providerId: settings.provider || 'google',
				targetLangCode: settings.targetLanguage,
				targetLangName: getTargetLangName(),
				settings,
			});

			if (resp?.ok) {
				const map = new Map();
				uniqueTexts.forEach((t, i) => map.set(t, resp.results[i]));
				for (const [t, r] of map) cacheSet(t, r);
				for (const p of items) {
					const r = map.get(p.text);
					if (r !== undefined) applyTranslation(p.row, p.textEl, p.key, r);
				}
			} else {
				console.warn('[ttct-live] batch failed:', resp?.error);
				// auth/config/permission 是配置问题,重试也没用,自动暂停并在按钮上提示
				if (['auth', 'config', 'permission'].includes(resp?.error?.kind)) {
					runtimeActive = false;
					syncPill(`⚠ ${resp.error.kind}`);
				}
				items.forEach(p => { delete p.row.dataset.ttctState; });
			}
		} catch (err) {
			console.warn('[ttct-live] batch error:', err);
			items.forEach(p => { delete p.row.dataset.ttctState; });
		} finally {
			inflightBatches--;
		}
	}

	function tick() {
		// 直播间容器没了 (退出直播 / SPA 跳走): 停摆,等 body observer 再次发现
		if (!currentChatRoot || !currentChatRoot.isConnected) {
			teardown();
			return;
		}
		if (!settings.liveTranslateEnabled || !runtimeActive) return;
		flushBatch(scanAndCollect());
	}

	// ===== 页内开关 =====
	function injectPill(chatRoot) {
		const pill = document.createElement('div');
		pill.className = 'ttct-live-pill';
		pill.addEventListener('click', () => {
			runtimeActive = !runtimeActive;
			syncPill();
		});
		const cs = window.getComputedStyle(chatRoot);
		if (cs.position === 'static') chatRoot.style.position = 'relative';
		chatRoot.appendChild(pill);
		togglePill = pill;
		syncPill();
	}

	function syncPill(suffix) {
		if (!togglePill || !togglePill.isConnected) return;
		const texts = getTexts();
		const on = settings.liveTranslateEnabled && runtimeActive;
		togglePill.textContent = suffix ? `${texts.liveOff} ${suffix}` : (on ? texts.liveOn : texts.liveOff);
		togglePill.classList.toggle('active', on);
		// 总开关关掉时整个隐藏,不打扰没开功能的用户
		togglePill.style.display = settings.liveTranslateEnabled ? '' : 'none';
	}

	// ===== 生命周期 =====
	function setup(chatRoot) {
		currentChatRoot = chatRoot;
		runtimeActive = true;
		injectPill(chatRoot);
		tickTimer = setInterval(tick, TICK_MS);
	}

	function teardown() {
		if (tickTimer) clearInterval(tickTimer);
		tickTimer = null;
		currentChatRoot = null;
		togglePill = null;
	}

	// body 级 observer 只负责发现直播间容器出现 (含 SPA 跳转进直播间)
	function watchForLiveRoom() {
		const tryAttach = () => {
			if (currentChatRoot) return;
			const chatRoot = document.querySelector(SELECTORS.chatContainer);
			if (chatRoot) setup(chatRoot);
		};
		const observer = new MutationObserver(() => tryAttach());
		observer.observe(document.body, { childList: true, subtree: true });
		tryAttach();
	}

	// ===== 启动 =====
	fetch(chrome.runtime.getURL('data/languages.json'))
		.then(r => r.json())
		.then(data => {
			translations = data;
			return loadSettings();
		})
		.then(() => {
			runtimeActive = settings.liveTranslateEnabled;
			watchForLiveRoom();
		})
		.catch(err => console.error('[ttct-live] init failed:', err));
})();
