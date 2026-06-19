// popup.js v2.5
// 新增：
// 1. OpenAI 兼容端点：可自定义 Endpoint（中转站 / one-api / vLLM / Ollama 等），
//    自定义域名通过 optional_host_permissions 动态授权（必须在 popup 的用户手势里
//    调 chrome.permissions.request，service worker 里调不了）
// 2. "测试连接"按钮：授权 + 发一句 Hello 验证 key/endpoint/模型配置
// 3. 显示模式选择：双语替换 / 原字幕下方（继承样式）

const DEFAULT_MODELS = {
  gemini: 'gemini-3.1-flash-lite',
  openai: 'gpt-4o-mini',
  claude: 'claude-haiku-4-5-20251001'
};

const BUILTIN_ORIGINS = [
  'https://translate.googleapis.com',
  'https://generativelanguage.googleapis.com',
  'https://api.anthropic.com',
  'https://api.openai.com'
];

document.addEventListener('DOMContentLoaded', async () => {
  const $ = (id) => document.getElementById(id);
  const elements = {
    enableToggle: $('enableToggle'),
    apiProvider: $('apiProvider'),
    apiKey: $('apiKey'),
    apiKeyGroup: $('apiKeyGroup'),
    customModel: $('customModel'),
    customModelGroup: $('customModelGroup'),
    modelHint: $('modelHint'),
    endpointGroup: $('endpointGroup'),
    openaiEndpoint: $('openaiEndpoint'),
    testGroup: $('testGroup'),
    testBtn: $('testBtn'),
    testResult: $('testResult'),
    displayMode: $('displayMode'),
    targetLang: $('targetLang'),
    subPosition: $('subPosition'),
    positionValue: $('positionValue'),
    contextWindow: $('contextWindow'),
    contextValue: $('contextValue')
  };

  // 内存中的 per-provider 数据
  let apiKeys = {};
  let customModels = {};

  function currentProvider() {
    return elements.apiProvider.value;
  }

  function refreshProviderFields() {
    const provider = currentProvider();
    const isAI = provider !== 'google';
    elements.apiKeyGroup.style.display = isAI ? 'block' : 'none';
    elements.customModelGroup.style.display = isAI ? 'block' : 'none';
    elements.endpointGroup.style.display = provider === 'openai' ? 'block' : 'none';
    elements.testGroup.style.display = isAI ? 'block' : 'none';
    elements.testResult.textContent = '';
    if (isAI) {
      elements.apiKey.value = apiKeys[provider] || '';
      elements.customModel.value = customModels[provider] || '';
      elements.customModel.placeholder = `默认: ${DEFAULT_MODELS[provider]}`;
      elements.modelHint.textContent = provider === 'openai'
        ? `留空使用 ${DEFAULT_MODELS.openai}；自定义端点请填该端点支持的模型名`
        : `留空使用默认模型 ${DEFAULT_MODELS[provider]}`;
    }
  }

  // 输入时实时写回内存对象
  elements.apiKey.addEventListener('input', () => {
    apiKeys[currentProvider()] = elements.apiKey.value.trim();
  });
  elements.customModel.addEventListener('input', () => {
    const v = elements.customModel.value.trim();
    if (v) customModels[currentProvider()] = v;
    else delete customModels[currentProvider()];
  });

  elements.subPosition.addEventListener('input', () => {
    elements.positionValue.textContent = elements.subPosition.value;
  });

  elements.contextWindow.addEventListener('input', () => {
    elements.contextValue.textContent = elements.contextWindow.value;
  });

  elements.apiProvider.addEventListener('change', refreshProviderFields);

  function gatherSettings() {
    return {
      enabled: elements.enableToggle.checked,
      apiProvider: elements.apiProvider.value,
      apiKeys,
      customModels,
      openaiEndpoint: elements.openaiEndpoint.value.trim(),
      displayMode: elements.displayMode.value,
      targetLang: elements.targetLang.value,
      subPosition: parseInt(elements.subPosition.value, 10),
      contextWindow: parseInt(elements.contextWindow.value, 10)
    };
  }

  // ===== 测试连接（含自定义端点动态授权） =====
  elements.testBtn.addEventListener('click', async () => {
    elements.testResult.textContent = '测试中...';
    elements.testResult.style.color = '#888';
    const settings = gatherSettings();

    // 自定义 OpenAI 端点：先确保 host 权限。
    // permissions.request 必须发生在用户手势调用栈里，所以放在 popup 而不是 background。
    if (settings.apiProvider === 'openai' && settings.openaiEndpoint) {
      let origin;
      try {
        origin = new URL(settings.openaiEndpoint).origin;
      } catch (e) {
        elements.testResult.textContent = '❌ Endpoint 不是合法 URL（需带 http:// 或 https://）';
        elements.testResult.style.color = '#e87c7c';
        return;
      }
      if (!BUILTIN_ORIGINS.includes(origin)) {
        try {
          const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
          if (!granted) {
            elements.testResult.textContent = `❌ 未授权访问 ${origin}`;
            elements.testResult.style.color = '#e87c7c';
            return;
          }
        } catch (e) {
          elements.testResult.textContent = `❌ 授权失败: ${e.message}`;
          elements.testResult.style.color = '#e87c7c';
          return;
        }
      }
    }

    try {
      const resp = await chrome.runtime.sendMessage({ action: 'test', settings });
      if (resp?.ok) {
        elements.testResult.textContent = `✅ 连接成功，返回: ${(resp.result || '').slice(0, 50)}`;
        elements.testResult.style.color = '#7ce87c';
      } else {
        elements.testResult.textContent = `❌ ${resp?.error || '未知错误'}`;
        elements.testResult.style.color = '#e87c7c';
      }
    } catch (e) {
      elements.testResult.textContent = `❌ ${e.message}`;
      elements.testResult.style.color = '#e87c7c';
    }
  });

  // ===== 加载设置（含 sync → local 迁移） =====
  let data = await chrome.storage.local.get(
    ['enabled', 'apiProvider', 'apiKeys', 'customModels', 'openaiEndpoint',
     'displayMode', 'targetLang', 'subPosition', 'contextWindow']
  );

  if (data.apiProvider === undefined && data.enabled === undefined) {
    // local 是空的，尝试迁移旧的 sync 数据
    try {
      const old = await chrome.storage.sync.get(
        ['enabled', 'apiProvider', 'apiKey', 'targetLang', 'subPosition', 'batchSize']
      );
      if (old.apiProvider !== undefined || old.enabled !== undefined) {
        data = {
          enabled: old.enabled,
          apiProvider: old.apiProvider,
          targetLang: old.targetLang,
          subPosition: old.subPosition,
          apiKeys: {}
        };
        if (old.apiKey && old.apiProvider && old.apiProvider !== 'google') {
          data.apiKeys[old.apiProvider] = old.apiKey;
        }
        await chrome.storage.local.set(data);
        console.log('[AI翻译 popup] 已从 storage.sync 迁移设置');
      }
    } catch (e) { /* 忽略 */ }
  }

  elements.enableToggle.checked = data.enabled || false;
  elements.apiProvider.value = data.apiProvider || 'gemini';
  apiKeys = data.apiKeys || {};
  customModels = data.customModels || {};
  elements.openaiEndpoint.value = data.openaiEndpoint || '';
  elements.displayMode.value = data.displayMode || 'overlay';
  elements.targetLang.value = data.targetLang || 'zh';

  const pos = parseInt(data.subPosition, 10) || 10;
  elements.subPosition.value = pos;
  elements.positionValue.textContent = pos;

  const ctx = Number.isFinite(parseInt(data.contextWindow, 10)) ? parseInt(data.contextWindow, 10) : 3;
  elements.contextWindow.value = ctx;
  elements.contextValue.textContent = ctx;

  refreshProviderFields();

  // ===== 保存设置 =====
  document.getElementById('saveBtn').addEventListener('click', () => {
    const settings = gatherSettings();

    chrome.storage.local.set(settings, () => {
      const btn = document.getElementById('saveBtn');
      btn.textContent = '✅ 已保存！';
      setTimeout(() => btn.textContent = '💾 保存设置', 1500);

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          // 非 Netflix 页面没有 content script，会报 "Receiving end does not exist"
          // 属正常情况，吞掉即可（下次进入 Netflix 时 bridge 会自己从 storage 读取）
          chrome.tabs.sendMessage(tabs[0].id, { action: "updateSettings", settings })
            .catch(() => {});
        }
      });
    });
  });
});
