// popup.js v2.1.0
(function () {
    const DEFAULTS = {
        showFloatBtn: true,
        floatPos: { right: 24, bottom: 80 },
        filenameTpl: '{title}@{author}',
        videoMode: 'split',
        quality: 'best',
        debug: false,
    };

    const $ = id => document.getElementById(id);

    $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

    function checkStatus() {
        const statusEl = $('status');
        const txt = statusEl.querySelector('.status-text');
        chrome.runtime.sendMessage({ action: 'ping' }, res => {
            if (chrome.runtime.lastError || !res?.ok) {
                statusEl.classList.remove('ok'); statusEl.classList.add('err');
                txt.textContent = '后台离线';
            } else {
                statusEl.classList.remove('err'); statusEl.classList.add('ok');
                txt.textContent = '已连接';
            }
        });
    }
    checkStatus();

    // 加载配置
    chrome.storage.sync.get(DEFAULTS, items => {
        const cfg = { ...DEFAULTS, ...items };
        $('showFloatBtn').checked = !!cfg.showFloatBtn;
        $('quality').value = cfg.quality || 'best';
        $('filenameTpl').value = cfg.filenameTpl || DEFAULTS.filenameTpl;
        $('debug').checked = !!cfg.debug;
        setSegmentedValue('videoMode', cfg.videoMode || DEFAULTS.videoMode);
        updatePosInfo(cfg.floatPos);
    });

    function setSegmentedValue(containerId, value) {
        const buttons = document.querySelectorAll(`#${containerId} .seg-btn`);
        buttons.forEach(b => b.classList.toggle('active', b.dataset.value === value));
    }

    // Segmented control 绑定
    document.querySelectorAll('#videoMode .seg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const value = btn.dataset.value;
            setSegmentedValue('videoMode', value);
            chrome.storage.sync.set({ videoMode: value });
        });
    });

    function updatePosInfo(pos) {
        if (!pos || (pos.right === DEFAULTS.floatPos.right && pos.bottom === DEFAULTS.floatPos.bottom)) {
            $('posInfo').textContent = '直接在页面上拖动按钮即可调整';
        } else {
            $('posInfo').textContent = `当前位置：距右 ${Math.round(pos.right)}px，距下 ${Math.round(pos.bottom)}px`;
        }
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (changes.floatPos) updatePosInfo(changes.floatPos.newValue);
    });

    function flashSaved(el) {
        if (!el) return;
        el.classList.add('saved');
        setTimeout(() => el.classList.remove('saved'), 600);
    }

    function bindToggle(id) {
        const el = $(id);
        el.addEventListener('change', () => {
            chrome.storage.sync.set({ [id]: el.checked });
        });
    }
    bindToggle('showFloatBtn');
    bindToggle('debug');

    function debounce(fn, ms) {
        let t;
        return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    }

    function bindText(id, opts = {}) {
        const el = $(id);
        const saver = debounce(() => {
            let v = el.value;
            if (opts.transform) v = opts.transform(v);
            chrome.storage.sync.set({ [id]: v }, () => flashSaved(el));
        }, 400);
        el.addEventListener('input', saver);
    }
    bindText('filenameTpl', {
        transform: v => v.trim() || DEFAULTS.filenameTpl,
    });

    $('quality').addEventListener('change', e => {
        chrome.storage.sync.set({ quality: e.target.value }, () => flashSaved(e.target));
    });

    document.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const tpl = chip.dataset.tpl;
            $('filenameTpl').value = tpl;
            chrome.storage.sync.set({ filenameTpl: tpl }, () => flashSaved($('filenameTpl')));
        });
    });

    $('resetPos').addEventListener('click', () => {
        chrome.storage.sync.set({ floatPos: { ...DEFAULTS.floatPos } });
        updatePosInfo(DEFAULTS.floatPos);
    });

    $('shortcutLink').addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });

    $('chromeDlSettings').addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: 'chrome://settings/downloads' });
    });

    $('resetAll').addEventListener('click', (e) => {
        e.preventDefault();
        if (!confirm('恢复所有设置为默认值？')) return;
        chrome.storage.sync.set(DEFAULTS, () => {
            $('showFloatBtn').checked = DEFAULTS.showFloatBtn;
            $('quality').value = DEFAULTS.quality;
            $('filenameTpl').value = DEFAULTS.filenameTpl;
            $('debug').checked = DEFAULTS.debug;
            setSegmentedValue('videoMode', DEFAULTS.videoMode);
            updatePosInfo(DEFAULTS.floatPos);
        });
    });
})();
