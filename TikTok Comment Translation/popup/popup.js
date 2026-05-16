// Popup 逻辑
// 设计要点:
//   - 偏好 (provider/语言/model/endpoint/降级开关) -> chrome.storage.sync
//   - 敏感 Key -> chrome.storage.local (不跨设备)
//   - 字段按 provider 动态显示/隐藏
//   - 输入实时保存 (debounce)
//   - 测试连接按钮: 直接调 provider.translate 试一句

document.addEventListener('DOMContentLoaded', () => {
	const { PROVIDERS, ProviderError } = window.TTCTProviders;

	// === DOM 引用 ===
	const $ = id => document.getElementById(id);
	const mainHeading = $('mainHeading');
	const refreshHint = $('refreshHint');
	const languageSelect = $('languageSelect');
	const providerSelect = $('providerSelect');

	const geminiConfig = $('geminiConfig');
	const geminiKeyInput = $('geminiKeyInput');
	const geminiModelInput = $('geminiModelInput');

	const openaiConfig = $('openaiConfig');
	const openaiEndpointInput = $('openaiEndpointInput');
	const openaiModelInput = $('openaiModelInput');
	const openaiKeyInput = $('openaiKeyInput');

	const anthropicConfig = $('anthropicConfig');
	const anthropicKeyInput = $('anthropicKeyInput');
	const anthropicModelInput = $('anthropicModelInput');

	const testRow = $('testRow');
	const testButton = $('testButton');
	const testStatus = $('testStatus');

	const fallbackField = $('fallbackField');
	const fallbackCheckbox = $('fallbackCheckbox');

	let translations = {};

	// === 加载 ===
	const SYNC_DEFAULTS = {
		targetLanguage: 'zh',
		provider: 'google',
		geminiModel: 'gemini-2.5-flash',
		openaiEndpoint: 'https://api.openai.com/v1',
		openaiModel: 'gpt-4o-mini',
		anthropicModel: 'claude-haiku-4-5-20251001',
		llmFallbackToGoogle: true,
	};
	const LOCAL_DEFAULTS = {
		geminiApiKey: '',
		openaiApiKey: '',
		anthropicApiKey: '',
	};

	fetch(chrome.runtime.getURL('data/languages.json'))
		.then(r => r.json())
		.then(data => {
			translations = data;
			chrome.storage.sync.get(SYNC_DEFAULTS, syncRes => {
				chrome.storage.local.get(LOCAL_DEFAULTS, localRes => {
					languageSelect.value = syncRes.targetLanguage;
					providerSelect.value = syncRes.provider;
					geminiModelInput.value = syncRes.geminiModel;
					openaiEndpointInput.value = syncRes.openaiEndpoint;
					openaiModelInput.value = syncRes.openaiModel;
					anthropicModelInput.value = syncRes.anthropicModel;
					fallbackCheckbox.checked = syncRes.llmFallbackToGoogle;

					geminiKeyInput.value = localRes.geminiApiKey;
					openaiKeyInput.value = localRes.openaiApiKey;
					anthropicKeyInput.value = localRes.anthropicApiKey;

					updateUI();
					updateProviderVisibility();
				});
			});
		});

	// === UI 文案 ===
	function updateUI() {
		const lang = languageSelect.value;
		const trans = translations[lang]?.popup;
		// fallback 中文
		const fb = translations.zh.popup;
		const t = key => trans?.[key] || fb[key];

		mainHeading.firstChild.nodeValue = t('mainHeading');
		refreshHint.textContent = t('refreshHint');

		// 语言选项的文案
		const langNames = trans?.languageNames || fb.languageNames;
		for (const opt of languageSelect.options) {
			const code = opt.value;
			const name = langNames[code] || code;
			opt.textContent = name;
		}

		// provider 文案
		$('providerLabel').textContent = t('providerLabel');
		$('providerOptionGoogle').textContent = t('engineGoogle');
		$('providerOptionGemini').textContent = t('engineGemini');
		$('providerOptionOpenAI').textContent = t('engineOpenAI');
		$('providerOptionAnthropic').textContent = t('engineAnthropic');

		// 提示文案
		$('geminiKeyHint').textContent = t('geminiKeyHint');
		$('openaiKeyHint').textContent = t('openaiKeyHint');
		$('anthropicKeyHint').textContent = t('anthropicKeyHint');
		$('globalKeyHint').textContent = t('apiKeyHint');
		$('fallbackLabel').textContent = t('fallbackLabel');
		testButton.textContent = t('testButton');
	}

	function updateProviderVisibility() {
		const provider = providerSelect.value;
		geminiConfig.classList.toggle('hidden', provider !== 'gemini');
		openaiConfig.classList.toggle('hidden', provider !== 'openai');
		anthropicConfig.classList.toggle('hidden', provider !== 'anthropic');
		// 测试连接和降级选项: 只在 LLM provider 下显示
		const isLLM = provider !== 'google';
		testRow.classList.toggle('hidden', !isLLM);
		fallbackField.classList.toggle('hidden', !isLLM);
		// 切 provider 清空测试状态
		testStatus.textContent = '';
		testStatus.className = 'test-status';
	}

	// === 保存 (debounced) ===
	function debounce(fn, ms) {
		let timer;
		return (...args) => {
			clearTimeout(timer);
			timer = setTimeout(() => fn(...args), ms);
		};
	}

	const saveSync = debounce(payload => chrome.storage.sync.set(payload), 300);
	const saveLocal = debounce(payload => chrome.storage.local.set(payload), 300);

	languageSelect.addEventListener('change', () => {
		saveSync({ targetLanguage: languageSelect.value });
		updateUI();
	});

	providerSelect.addEventListener('change', () => {
		saveSync({ provider: providerSelect.value });
		updateProviderVisibility();
	});

	geminiModelInput.addEventListener('input', () => saveSync({ geminiModel: geminiModelInput.value.trim() }));
	openaiEndpointInput.addEventListener('input', () => saveSync({ openaiEndpoint: openaiEndpointInput.value.trim() }));
	openaiModelInput.addEventListener('input', () => saveSync({ openaiModel: openaiModelInput.value.trim() }));
	anthropicModelInput.addEventListener('input', () => saveSync({ anthropicModel: anthropicModelInput.value.trim() }));
	fallbackCheckbox.addEventListener('change', () => saveSync({ llmFallbackToGoogle: fallbackCheckbox.checked }));

	geminiKeyInput.addEventListener('input', () => saveLocal({ geminiApiKey: geminiKeyInput.value.trim() }));
	openaiKeyInput.addEventListener('input', () => saveLocal({ openaiApiKey: openaiKeyInput.value.trim() }));
	anthropicKeyInput.addEventListener('input', () => saveLocal({ anthropicApiKey: anthropicKeyInput.value.trim() }));

	// === 测试连接 ===
	testButton.addEventListener('click', async () => {
		const providerId = providerSelect.value;
		const provider = PROVIDERS[providerId];
		if (!provider) return;

		const lang = languageSelect.value;
		const target = translations[lang]?.geminiName || 'English';
		const fb = translations.zh.popup;
		const t = key => translations[lang]?.popup?.[key] || fb[key];

		testButton.disabled = true;
		testStatus.textContent = t('testing');
		testStatus.className = 'test-status';

		// 用当前输入构造临时 settings (不依赖已保存的值,因为可能还在 debounce 中)
		const tempSettings = {
			geminiApiKey: geminiKeyInput.value.trim(),
			geminiModel: geminiModelInput.value.trim() || 'gemini-2.5-flash',
			openaiApiKey: openaiKeyInput.value.trim(),
			openaiEndpoint: openaiEndpointInput.value.trim(),
			openaiModel: openaiModelInput.value.trim(),
			anthropicApiKey: anthropicKeyInput.value.trim(),
			anthropicModel: anthropicModelInput.value.trim() || 'claude-haiku-4-5-20251001',
		};

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15000);

		try {
			const result = await provider.translate('Hello!', target, {
				signal: controller.signal,
				settings: tempSettings,
			});
			testStatus.textContent = `${t('testSuccess')}: ${result.slice(0, 30)}`;
			testStatus.className = 'test-status ok';
		} catch (err) {
			const msg = err instanceof ProviderError
				? `${err.kind}: ${err.message}`
				: (err?.message || String(err));
			testStatus.textContent = `${t('testFailed')}: ${msg.slice(0, 80)}`;
			testStatus.className = 'test-status err';
		} finally {
			clearTimeout(timeout);
			testButton.disabled = false;
		}
	});
});
