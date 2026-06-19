// bridge.js v3.7 — ISOLATED world content script
// ============================================================================
// 重大重构：字幕数据层从「单一全局数组」改为「以轨道为单位的隔离模型」
//
// 解决的问题（见与用户的讨论）：
//   1. 初始化前重复处理字幕：generation token + 有效 videoId 前只缓存 payload
//   2. 异轨混入主时间轴（广告/预览/多语言轨被拍平）：每轨独立 cues[]，永不跨轨 merge
//   3. 并发计数膨胀：进度按 trackKey 隔离，旧 generation 回调丢弃
//   4. 源/目标语言切换：sourceTrackKey 管身份，translationKey 管译文
//
// 标识模型（双层）：
//   resourceKey      = hash(canonicalizeCdnUrl(url))   // 会话内归并 CDN 分片
//                      （依赖不透明令牌 t 在多个 range 请求间一致）
//   sourceTrackKey   = videoId:identityFingerprint    // 轨道成熟后的稳定身份(冻结)
//   translationKey   层级 = translations[sourceTrackKey][targetLang][cueKey]
//   cueKey           = hash(round(start)+round(end)+normalizeText(text))
//
// 分级翻译（方案 A+）：
//   provisional 轨：只翻当前 cue 附近窗口（前后各 N 条），不全量
//   confirmed   轨：continuousActiveMs>=30s 或 coverageRatio>=0.8 时全量预翻译
//   广告轨通常短，到不了 confirmed；若广告有原生字幕会被锚定并翻译（A+ 接受此成本）
//
// 保留自 v2.6：显示模式 overlay/below、样式继承、原生字幕位置锚定、SPA 导航
// ============================================================================

const PROMPT_VERSION = 'v2'; // 与 background.js 一致；v2=引入滑动窗口上下文，旧缓存失效
const WINDOW_RADIUS = 5;       // 窗口翻译：当前 cue 前后各 N 条预热翻译
const DEFAULT_CONTEXT_RADIUS = 3; // 上下文（方案 A）默认前后各 N 条；可被 settings.contextWindow 覆盖
const PER_TRACK_CONCURRENCY = 1; // 非激活轨 bulk 只保留极低带宽
const GLOBAL_CONCURRENCY = 4;
const BULK_CONCURRENCY = 2;      // 后台预翻译最多 2 个在途请求
const MAX_BULK_QUEUE_PER_TRACK = 32; // 有界流水线，避免一次创建数千个任务闭包
const MAX_TOTAL_BULK_QUEUE = 64;     // 多轨/切语言后的全局 bulk 队列上限
const URGENT_RESERVED = 2;     // 给 urgent 永久预留的槽：bulk 最多占 GLOBAL-URGENT_RESERVED

function contextRadius() {
  const v = parseInt(settings?.contextWindow, 10);
  return (Number.isFinite(v) && v >= 0) ? v : DEFAULT_CONTEXT_RADIUS;
}
const CONFIRM_ACTIVE_MS = 30000;
const CONFIRM_COVERAGE = 0.8;
const ACTIVE_GRACE_MS = 4000; // 短暂无字幕的宽限，超过才重置连续激活计时

let settings = null;            // null = 尚未加载完成
let customSubContainer = null;
let animFrameId = null;
let currentVideoId = getVideoId();

let earlyMessages = [];         // settings 加载前缓冲的字幕消息

// ============================================================================
// 工具函数
// ============================================================================

function normText(t) {
  // 文本规范化：HTML/TTML 标签、换行、连续空格、全角空格、Unicode 标点差异
  return (t || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\u3000/g, ' ')        // 全角空格 → 半角
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // 零宽字符
    .replace(/\s+/g, ' ')
    .trim();
}

function roundTime(t) {
  return Math.round(t * 10) / 10; // 0.1s 精度，吸收分片边界的微小差异
}

// 轻量字符串 hash（FNV-1a 32bit），用于 resourceKey / cueKey / identityFingerprint
function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

function cueKeyOf(cue) {
  return hashStr(`${roundTime(cue.start)}|${roundTime(cue.end)}|${normText(cue.text)}`);
}

function isBelowMode() {
  return settings?.displayMode === 'below';
}

function getVideoId() {
  // /watch/{id} 是当前导航的真实目标，优先用它。
  // （播放器 data-videoid 在启动瞬间可能还是上一部影片的残留，会触发多余 reset）
  const m = location.pathname.match(/^\/watch\/(\d+)/);
  if (m) return m[1];
  // 非 watch 路径（理论上 content script 不该在此运行）：退化用播放器属性
  const player = document.querySelector('[data-uia="player"][data-videoid]');
  if (player?.dataset?.videoid) return player.dataset.videoid;
  return null;
}

// CDN URL 规范化：去 /range/start-end、去分片参数 sc、保留不透明令牌 t
// 关键：初始请求路径是 /，range 请求是 /range/1538-105397，必须归一到同一形态，
// 否则同一资源的首块和后续 range 会被拆成两个 resourceKey（实测踩过的坑）
function canonicalizeCdnUrl(url) {
  try {
    const u = new URL(url, location.href);
    // 把 /range/数字-数字 段整体删除（而非改写成 /range），与无 range 的初始请求对齐
    let path = u.pathname.replace(/\/range\/\d+-\d+\/?/i, '/');
    path = path.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    const keep = [];
    // 只保留对「资源身份」稳定的参数；t 是关键（同资源多 range 一致）
    for (const k of ['o', 'v', 'e', 't']) {
      const val = u.searchParams.get(k);
      if (val !== null) keep.push(`${k}=${val}`);
    }
    return `${u.origin}${path}?${keep.join('&')}`;
  } catch (e) {
    return url.replace(/\/range\/\d+-\d+\/?/i, '/').replace(/\/+(\?|$)/, '$1').split('#')[0];
  }
}

// ============================================================================
// TrackManager —— 字幕轨道隔离与生命周期
// ============================================================================

// ============================================================================
// TranslationScheduler —— 两级优先队列（urgent/bulk），每 generation 独立实例
// ============================================================================
// urgent：当前激活轨的窗口翻译（用户正在看的）
// bulk：  全量预翻译（后台慢慢补）
// 排空顺序：urgent → 当前激活轨 bulk → 非激活轨 bulk
// 预留槽：全局 GLOBAL_CONCURRENCY，bulk 最多占 (GLOBAL - URGENT_RESERVED)，
//         给 urgent 永久留 URGENT_RESERVED 个，避免慢 bulk 占满后 urgent 等 15s
// 非激活轨 bulk 受 PER_TRACK_CONCURRENCY 约束（不独占后台）；urgent 不受限
// 层内不再重试（重试只在 background 做，最坏 4 次而非 16）；结构化响应 {ok,...}
class TranslationScheduler {
  constructor(generation) {
    this.generation = generation;
    this.urgent = [];   // [{taskKey, text, context, trackKey, onDone}]
    this.bulk = [];
    this.queuedKeys = new Map();   // taskKey -> 'urgent' | 'bulk'
    this.inFlightKeys = new Set();
    this.inFlight = 0;             // 总在途
    this.bulkInFlight = 0;         // bulk 在途（受预留槽限制）
    this.bulkInFlightByTrack = new Map(); // trackKey -> 数量（非激活轨约束）
    this.disposed = false;
    this._pumpScheduled = false;
  }

  // tier: 'urgent' | 'bulk'。已在 bulk 的任务再以 urgent 入队会被提升
  enqueue(task, tier) {
    if (this.disposed) return;
    task.tier = tier;

    const existing = this.queuedKeys.get(task.taskKey);
    if (existing === 'urgent') return;                 // 已在 urgent，无需动
    if (existing === 'bulk') {
      if (tier === 'urgent') {
        // 提升：从 bulk 移到 urgent（补四点之 1）
        const i = this.bulk.findIndex(t => t.taskKey === task.taskKey);
        if (i >= 0) {
          const [t] = this.bulk.splice(i, 1);
          t.tier = 'urgent';
          this.urgent.push(t);
          this.queuedKeys.set(task.taskKey, 'urgent');
          this.pump();
        }
      }
      return;
    }
    if (this.inFlightKeys.has(task.taskKey)) return;   // 正在翻，不重复

    (tier === 'urgent' ? this.urgent : this.bulk).push(task);
    this.queuedKeys.set(task.taskKey, tier);
    this.pump();
  }

  // 切轨：把某轨的 urgent 任务降级为 bulk（旧轨不再抢 urgent 槽）
  demoteUrgentOfTrack(trackKey) {
    if (this.disposed) return;
    const moved = [];
    this.urgent = this.urgent.filter(t => {
      if (t.trackKey === trackKey) { t.tier = 'bulk'; moved.push(t); return false; }
      return true;
    });
    for (const t of moved) {
      this.bulk.push(t);
      this.queuedKeys.set(t.taskKey, 'bulk');
    }
  }

  // 提升已在 bulk 队列的任务到 urgent（P1-2 真正生效的提升入口）。
  // 只动队列中的任务；已 in-flight 的不改 tier，否则完成时会错误释放 bulk 计数。
  promote(taskKey) {
    if (this.disposed) return;
    if (this.queuedKeys.get(taskKey) !== 'bulk') return; // 不在 bulk 队列（已 urgent / in-flight / 不存在）
    const i = this.bulk.findIndex(t => t.taskKey === taskKey);
    if (i < 0) return;
    const [t] = this.bulk.splice(i, 1);
    t.tier = 'urgent';
    this.urgent.push(t);
    this.queuedKeys.set(taskKey, 'urgent');
    this.pump();
  }

  pump() {
    if (this.disposed) return;
    if (this._pumpScheduled) return;
    this._pumpScheduled = true;
    Promise.resolve().then(() => { this._pumpScheduled = false; this._drain(); });
  }

  _drain() {
    if (this.disposed) return;
    const now = Date.now();
    const bulkCap = Math.min(BULK_CONCURRENCY, Math.max(0, GLOBAL_CONCURRENCY - URGENT_RESERVED));

    // 1) urgent 优先，吃满到全局上限
    let i = 0;
    while (i < this.urgent.length && this.inFlight < GLOBAL_CONCURRENCY) {
      const task = this.urgent[i];
      if (task.notBefore && task.notBefore > now) { i++; continue; }
      this.urgent.splice(i, 1);
      this._dispatch(task);
    }

    // 2) bulk：队列本身有界，直接分两轮扫描，避免每完成一条都复制并排序整个队列
    const activeKey = TM.activeSourceTrackKey;
    while (this.inFlight < GLOBAL_CONCURRENCY && this.bulkInFlight < bulkCap) {
      let selectedIndex = -1;

      // 先找激活轨，保持原队列 FIFO
      for (let j = 0; j < this.bulk.length; j++) {
        const task = this.bulk[j];
        if (task.trackKey !== activeKey) continue;
        if (task.notBefore && task.notBefore > now) continue;
        selectedIndex = j;
        break;
      }

      // 激活轨没有可运行任务时，再给非激活轨极低带宽
      if (selectedIndex < 0) {
        for (let j = 0; j < this.bulk.length; j++) {
          const task = this.bulk[j];
          if (task.trackKey === activeKey) continue;
          if (task.notBefore && task.notBefore > now) continue;
          const cnt = this.bulkInFlightByTrack.get(task.trackKey) || 0;
          if (cnt >= PER_TRACK_CONCURRENCY) continue;
          selectedIndex = j;
          break;
        }
      }

      if (selectedIndex < 0) break;
      const [task] = this.bulk.splice(selectedIndex, 1);
      this._dispatch(task);
    }

    // 还有被 notBefore 卡住的任务且有空槽：安排唤醒（补四点之 wake 修复）
    this._scheduleWake(now);
  }

  _scheduleWake(now) {
    if (this._wakeTimer) { clearTimeout(this._wakeTimer); this._wakeTimer = null; }
    if (this.inFlight >= GLOBAL_CONCURRENCY) return;
    let soonest = Infinity;
    for (const task of this.urgent) {
      if (task.notBefore && task.notBefore > now) soonest = Math.min(soonest, task.notBefore);
    }
    for (const task of this.bulk) {
      if (task.notBefore && task.notBefore > now) soonest = Math.min(soonest, task.notBefore);
    }
    if (!Number.isFinite(soonest)) return;
    this._wakeTimer = setTimeout(() => { this._wakeTimer = null; this.pump(); }, Math.max(50, soonest - now));
  }

  bulkQueuedCount(trackKey, targetLang) {
    let count = 0;
    for (const task of this.bulk) {
      if (task.trackKey === trackKey && task.targetLang === targetLang) count++;
    }
    return count;
  }

  _dispatch(task) {
    this.queuedKeys.delete(task.taskKey);
    this.inFlightKeys.add(task.taskKey);
    this.inFlight++;
    if (task.tier === 'bulk') {
      this.bulkInFlight++;
      this.bulkInFlightByTrack.set(task.trackKey, (this.bulkInFlightByTrack.get(task.trackKey) || 0) + 1);
    }
    this._run(task);
  }

  async _run(task) {
    let res = null;
    try {
      res = await sendTranslate(task.text, task.context);
    } catch (e) {
      res = { ok: false, retriable: false };
    } finally {
      // 先在自己实例释放计数（即使 disposed）
      this.inFlight--;
      this.inFlightKeys.delete(task.taskKey);
      if (task.tier === 'bulk') {
        this.bulkInFlight = Math.max(0, this.bulkInFlight - 1);
        const c = (this.bulkInFlightByTrack.get(task.trackKey) || 1) - 1;
        if (c <= 0) this.bulkInFlightByTrack.delete(task.trackKey);
        else this.bulkInFlightByTrack.set(task.trackKey, c);
      }

      if (!this.disposed) {
        // 结构化响应；background 已做退避重试，这里不再重试（避免双层放大）
        if (res && res.ok) task.onDone(res.text);
        else task.onDone(null, res);  // 第二参带错误信息供 failedUntil 决策
        this.pump();
      }
      // disposed：不 commit、不 pump
    }
  }

  dispose() {
    this.disposed = true;
    this.urgent = [];
    this.bulk = [];
    this.queuedKeys.clear();
    if (this._wakeTimer) { clearTimeout(this._wakeTimer); this._wakeTimer = null; }
  }

  stats() {
    return { urgent: this.urgent.length, bulk: this.bulk.length, inFlight: this.inFlight, bulkInFlight: this.bulkInFlight };
  }
}

// 发翻译请求给 background（结构化响应 {ok,text,code,retriable}）
function sendTranslate(text, context) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'translate', text, context, settings }, (response) => {
      if (chrome.runtime.lastError) { resolve({ ok: false, retriable: true, code: 'msg_error' }); return; }
      resolve(response || { ok: false, retriable: false, code: 'no_response' });
    });
  });
}

// ============================================================================
// TrackManager —— 字幕轨道隔离与生命周期
// ============================================================================

const TM = {
  generation: 0,
  scheduler: null,                // 当前 generation 的 TranslationScheduler
  tracksByResource: new Map(),
  tracksBySource: new Map(),
  aliasResourceToSource: new Map(),
  translations: new Map(),        // [sourceTrackKey][targetLang][cueKey] = {status,text,generation,attempts}
  activeSourceTrackKey: null,
  anchorState: 'uncertain',       // certain | uncertain（空窗超宽限后转 uncertain）

  init() {
    this.scheduler = new TranslationScheduler(this.generation);
  },

  reset() {
    // 先废弃旧 scheduler（旧请求在自己实例上释放计数），再递增 generation 建新实例
    if (this.scheduler) this.scheduler.dispose();
    this.generation++;
    this.tracksByResource.clear();
    this.tracksBySource.clear();
    this.aliasResourceToSource.clear();
    this.translations.clear();
    this.activeSourceTrackKey = null;
    this.anchorState = 'uncertain';
    this.scheduler = new TranslationScheduler(this.generation);
    console.log(`[AI翻译] TrackManager 重置，generation=${this.generation}`);
  },

  _newTrack(resourceKey) {
    return {
      resourceKey,
      sourceTrackKey: null,
      identityFingerprint: null,   // 成熟那刻的内容快照（身份用，冻结）
      contentRevision: null,       // 当前全部 cue 的 hash（可变，仅诊断/校验）
      cueCount: 0,                 // 当前 cue 数（可变，仅诊断）
      status: 'provisional',       // provisional | confirmed
      readyToConfirm: false,       // 满足覆盖率/时长闸门，但需激活后才 confirm
      cues: [],
      cueIndex: new Map(),
      timelineSpan: 0,
      continuousActiveMs: 0,
      lastActiveVideoTime: null,
      emptyStartAt: 0,             // 原生字幕空窗开始时刻（0=非空窗）
      mergeTimer: null,
      pretranslateStartedByKey: new Set(), // `${targetLang}:${PROMPT_VERSION}` 已启动全量
      bulkCursorByKey: new Map(),  // 有界全量流水线：每语言记录下一扫描位置
    };
  },

  ingest(url, rawText, gen) {
    if (gen !== this.generation) return;

    const resourceKey = hashStr(canonicalizeCdnUrl(url));
    let track = this.tracksByResource.get(resourceKey);
    if (!track) {
      track = this._newTrack(resourceKey);
      this.tracksByResource.set(resourceKey, track);
      console.log(`[AI翻译] 新建轨道 resourceKey=${resourceKey}`);
    }

    const entries = parseSubtitleFile(rawText, url);
    if (entries.length === 0) return;

    let added = 0;
    for (const e of entries) {
      const k = cueKeyOf(e);
      if (!track.cueIndex.has(k)) {
        track.cueIndex.set(k, e);
        track.cues.push(e);
        added++;
      }
    }
    if (added === 0) return;

    track.cues.sort((a, b) => a.start - b.start);
    this._recomputeSpan(track);
    track.cueCount = track.cues.length;

    console.log(
      `[AI翻译] 轨道 ${resourceKey}: +${added} cue，共 ${track.cues.length}，` +
      `span=${track.timelineSpan.toFixed(1)}s`
    );

    clearTimeout(track.mergeTimer);
    track.mergeTimer = setTimeout(() => this._onSettle(track, gen), 1000);
  },

  _recomputeSpan(track) {
    if (track.cues.length === 0) { track.timelineSpan = 0; return; }
    let min = Infinity, max = -Infinity;
    for (const c of track.cues) {
      if (c.start < min) min = c.start;
      if (c.end > max) max = c.end;
    }
    track.timelineSpan = max - min;
  },

  // 分片静默后：生成/冻结身份（首次）、更新可变修订号、重评 readyToConfirm
  _onSettle(track, gen) {
    if (gen !== this.generation) return;
    if (track.cues.length === 0) return;

    if (!track.sourceTrackKey) {
      // 首次成熟：生成身份指纹并冻结
      const fp = this._fingerprint(track.cues);
      const sourceTrackKey = `${currentVideoId || 'novid'}:${fp}`;
      track.identityFingerprint = fp;

      if (this.tracksBySource.has(sourceTrackKey)) {
        // 切回旧语言轨：并入已存在轨道，复用其译文缓存，丢弃临时 track
        const existing = this.tracksBySource.get(sourceTrackKey);
        for (const c of track.cues) {
          const k = cueKeyOf(c);
          if (!existing.cueIndex.has(k)) {
            existing.cueIndex.set(k, c);
            existing.cues.push(c);
          }
        }
        existing.cues.sort((a, b) => a.start - b.start);
        this._recomputeSpan(existing);
        existing.cueCount = existing.cues.length;
        existing.contentRevision = this._fingerprint(existing.cues);
        this.aliasResourceToSource.set(track.resourceKey, sourceTrackKey);
        this.tracksByResource.set(track.resourceKey, existing);
        console.log(`[AI翻译] 轨道并入已存在 sourceTrackKey=${sourceTrackKey}`);
        this._markReady(existing);
        return;
      }

      track.sourceTrackKey = sourceTrackKey;
      track.contentRevision = fp;
      this.tracksBySource.set(sourceTrackKey, track);
      this.aliasResourceToSource.set(track.resourceKey, sourceTrackKey);
      if (!this.translations.has(sourceTrackKey)) {
        this.translations.set(sourceTrackKey, new Map());
      }
      console.log(`[AI翻译] 轨道成熟 sourceTrackKey=${sourceTrackKey}（identityFingerprint 已冻结）`);
    } else {
      // P2-6 身份冻结 + 内容生长：sourceTrackKey 不变，只更新可变修订号
      this._recomputeSpan(track);
      track.contentRevision = this._fingerprint(track.cues);
      track.cueCount = track.cues.length;
      // 若已 confirmed，把新增 cue 追加进全量调度（仅当前激活轨）
      if (track.status === 'confirmed' && track.sourceTrackKey === this.activeSourceTrackKey) {
        this._scheduleFullTranslation(track);
      }
    }

    this._markReady(track);

    // 启动边界：Observer 可能先看到字幕、轨道随后才成熟，此时 lastNativeText
    // 已记录会短路掉同一文本。轨道成熟后强制重新处理一次当前原生文本，
    // 触发首条直接激活 + 显示（否则会卡在「字幕已显示但插件认不出」）
    if (typeof onNativeMutation === 'function') onNativeMutation(true);
  },

  // 完整 cues 规范化哈希——比「前后六条」抗碰撞（SDH vs 普通字幕大部分相同）
  _fingerprint(cues) {
    const parts = cues.map(c => `${roundTime(c.start)},${roundTime(c.end)},${normText(c.text)}`);
    return hashStr(parts.join('|')) + ':' + cues.length;
  },

  // 覆盖率/时长闸门：只标记 readyToConfirm，不直接全量（P1-1）
  _markReady(track) {
    if (track.readyToConfirm || track.status === 'confirmed') return;
    const video = document.querySelector('video');
    const dur = video?.duration || 0;
    const coverageRatio = dur > 0 ? track.timelineSpan / dur : 0;
    if (track.continuousActiveMs >= CONFIRM_ACTIVE_MS || coverageRatio >= CONFIRM_COVERAGE) {
      track.readyToConfirm = true;
      console.log(
        `[AI翻译] 轨道 ready ${track.sourceTrackKey}：` +
        `activeMs=${Math.round(track.continuousActiveMs)}, coverage=${(coverageRatio * 100).toFixed(0)}%`
      );
    }
  },

  // 真正确认：必须是当前激活轨（P1-1 核心），再启动全量
  confirm(track) {
    if (track.status === 'confirmed') return;
    if (!track.readyToConfirm) return;
    if (track.sourceTrackKey !== this.activeSourceTrackKey) return; // 非激活轨绝不全量
    track.status = 'confirmed';
    console.log(`[AI翻译] ✅ 轨道确认（已激活）${track.sourceTrackKey}`);
    this._scheduleFullTranslation(track);
  },

  // 全量（bulk 优先级）：按 targetLang+promptVersion 隔离的启动标记（P2-5）
  _scheduleFullTranslation(track) {
    const targetLang = settings.targetLang;
    const startedKey = `${targetLang}:${PROMPT_VERSION}`;
    let state = track.bulkCursorByKey.get(startedKey);
    const contentChanged = !state || state.revision !== track.contentRevision;
    if (!state) {
      state = { cursor: 0, revision: track.contentRevision };
      track.bulkCursorByKey.set(startedKey, state);
    } else if (contentChanged) {
      // cue 后续增长可能插入到任意位置；从头轻量重扫，已译/在途项会被跳过
      state.cursor = 0;
      state.revision = track.contentRevision;
    }

    if (!track.pretranslateStartedByKey.has(startedKey) || contentChanged) {
      console.log(
        `[AI翻译] 全量预翻译启动(有界 bulk) ${track.sourceTrackKey} [${targetLang}]：` +
        `queue<=${MAX_BULK_QUEUE_PER_TRACK}, inFlight<=${BULK_CONCURRENCY}, total=${track.cues.length}`
      );
    }
    track.pretranslateStartedByKey.add(startedKey);
    this._fillBulkQueue(track, targetLang);
  },

  // 不一次性创建几千个任务，只维持固定长度的 bulk 流水线。
  _fillBulkQueue(track, targetLang) {
    if (!this.scheduler || this.scheduler.disposed) return;
    if (track.status !== 'confirmed' || track.sourceTrackKey !== this.activeSourceTrackKey) return;
    if (targetLang !== settings.targetLang) return;

    const startedKey = `${targetLang}:${PROMPT_VERSION}`;
    let state = track.bulkCursorByKey.get(startedKey);
    if (!state) {
      state = { cursor: 0, revision: track.contentRevision };
      track.bulkCursorByKey.set(startedKey, state);
    }

    const queuedForTrack = this.scheduler.bulkQueuedCount(track.sourceTrackKey, targetLang);
    let budget = Math.min(
      MAX_BULK_QUEUE_PER_TRACK - queuedForTrack,
      MAX_TOTAL_BULK_QUEUE - this.scheduler.bulk.length
    );
    if (budget <= 0) return;

    const store = this._cueStore(track.sourceTrackKey, targetLang);
    while (state.cursor < track.cues.length && budget > 0) {
      const idx = state.cursor;
      const c = track.cues[idx];
      state.cursor++;
      const rec = store.get(cueKeyOf(c));
      if (rec && !this._submittable(rec)) continue;
      this._submit(track, c, targetLang, 'bulk', idx);
      budget--;
    }
  },

  // 窗口翻译（urgent 优先级）：当前 cue 前后 WINDOW_RADIUS 条
  // confirmed 和 provisional 都调用，靠同步去重控成本（已翻的不会重复进队）
  translateWindow(track, currentTime) {
    if (!track.sourceTrackKey) return;
    const targetLang = settings.targetLang;
    const store = this._cueStore(track.sourceTrackKey, targetLang);
    let idx = this._indexAt(track, currentTime);
    if (idx < 0) idx = 0;
    const lo = Math.max(0, idx - WINDOW_RADIUS);
    const hi = Math.min(track.cues.length - 1, idx + WINDOW_RADIUS);
    for (let i = lo; i <= hi; i++) {
      const c = track.cues[i];
      const rec = store.get(cueKeyOf(c));
      if (!rec || this._submittable(rec)) {
        this._submit(track, c, targetLang, 'urgent', i);
      } else if (rec.status === 'pending' && rec.tier === 'bulk' && rec.taskKey) {
        // 已在 bulk 队列等待：提升到 urgent（用 record 存的 taskKey，不重算——
        // provisional 内容增长后上下文 hash 可能变，重算 key 对不上原任务）
        this.scheduler.promote(rec.taskKey);
        rec.tier = 'urgent';
      }
    }
  },

  // record 是否可提交：未翻译、未在途、且不在失败退避窗口内（挡 provisional 每帧重提交）
  _submittable(rec) {
    if (rec.status === 'translated' || rec.status === 'pending') return false;
    if (rec.status === 'failed' && rec.failedUntil && Date.now() < rec.failedUntil) return false;
    return true;
  },

  // 构建滑动窗口上下文（方案 A）：当前 cue 前后各 contextRadius() 条原文。
  // idx 可由调用方传入（已知下标时跳过 O(n) indexOf）；缺省或越界时回退查找。
  _buildContext(track, cue, idx) {
    if (!(idx >= 0 && idx < track.cues.length && track.cues[idx] === cue)) {
      idx = track.cues.indexOf(cue);
    }
    if (idx < 0) return null;
    const r = contextRadius();
    if (r === 0) return { before: [], after: [] };
    const before = [];
    for (let i = Math.max(0, idx - r); i < idx; i++) before.push(track.cues[i].text);
    const after = [];
    for (let i = idx + 1; i <= Math.min(track.cues.length - 1, idx + r); i++) after.push(track.cues[i].text);
    return { before, after };
  },

  // 提交单条到调度器（去重/提升在 scheduler 同步完成）
  _submit(track, cue, targetLang, tier, idx) {
    const cueKey = cueKeyOf(cue);
    const context = this._buildContext(track, cue, idx);
    // 缓存键含上下文 hash（与 background 一致），避免同台词不同上下文复用错译
    const ctxHash = hashStr((context?.before || []).join('|') + '##' + (context?.after || []).join('|'));
    const taskKey = `${track.sourceTrackKey}:${targetLang}:${PROMPT_VERSION}:${ctxHash}:${cueKey}`;
    const store = this._cueStore(track.sourceTrackKey, targetLang);
    const sourceTrackKey = track.sourceTrackKey;
    const submittedLang = targetLang;   // 闭包捕获提交时的语言（旧语言回调不得重绘）
    const submittedGen = this.generation;

    let rec = store.get(cueKey);
    if (rec && !this._submittable(rec)) return;
    rec = rec || { status: 'idle', text: '', generation: submittedGen, attempts: 0, failedUntil: 0, code: null };
    rec.status = 'pending';
    rec.generation = submittedGen;
    rec.taskKey = taskKey;   // 存下供 promote 使用（不重算）
    rec.tier = tier;
    store.set(cueKey, rec);
    updateProgressUI();

    this.scheduler.enqueue({
      taskKey,
      text: cue.text,
      context,
      trackKey: sourceTrackKey,
      targetLang: submittedLang,
      onDone: (text, errRes) => {
        if (rec.generation !== submittedGen || submittedGen !== this.generation) return; // 旧 generation 丢弃
        if (text) {
          rec.status = 'translated';
          rec.text = text;
          rec.failedUntil = 0;
          rec.code = 'ok';
          // 三重校验后重绘（P1-2 + P1-3）：语言一致 + 激活轨 + 正显示这条
          maybeRedrawCurrent(submittedLang, sourceTrackKey, cueKey, text);
        } else {
          rec.status = 'failed';
          rec.attempts = (rec.attempts || 0) + 1;
          rec.code = (errRes && errRes.code) || 'error';
          // 退避：可重试错误指数增长并设上限（网络长断不持续轰炸）；
          // 不可重试（配置类）退避很久，等 updateSettings 重置
          const nonRetriable = errRes && errRes.retriable === false;
          if (nonRetriable) {
            rec.failedUntil = Date.now() + 10 * 60 * 1000; // 10 分钟（实际靠设置变化重置）
          } else {
            const backoff = Math.min(5000 * Math.pow(2, rec.attempts - 1), 5 * 60 * 1000); // 上限 5 分钟
            rec.failedUntil = Date.now() + backoff;
          }
        }
        store.set(cueKey, rec);
        updateProgressUI();
        // bulk 完成一条再补一条，始终保持有界，不制造整轨任务闭包。
        this._fillBulkQueue(track, submittedLang);
      }
    }, tier);
  },

  // 失败恢复重扫（P1-5）：每 2 秒由 tick 触发，每次最多恢复 N 条退避到期的可重试失败
  rescanFailures(maxRecover = 2) {
    const track = this.getActiveTrack();
    if (!track || track.status !== 'confirmed' || !track.sourceTrackKey) return;
    const targetLang = settings.targetLang;
    if (this.scheduler.bulk.length >= MAX_TOTAL_BULK_QUEUE) return;
    const available = Math.min(
      maxRecover,
      MAX_BULK_QUEUE_PER_TRACK - this.scheduler.bulkQueuedCount(track.sourceTrackKey, targetLang),
      MAX_TOTAL_BULK_QUEUE - this.scheduler.bulk.length
    );
    if (available <= 0) return;
    const store = this._cueStore(track.sourceTrackKey, targetLang);
    const now = Date.now();
    let recovered = 0;
    for (const c of track.cues) {
      if (recovered >= available) break;
      const rec = store.get(cueKeyOf(c));
      if (!rec || rec.status !== 'failed') continue;
      // 配置类错误（no_key 等）等设置变化重置，不在这里自动恢复
      if (['no_key', 'no_permission', 'bad_endpoint', 'bad_provider'].includes(rec.code)) continue;
      if (rec.failedUntil && now < rec.failedUntil) continue; // 退避未到期
      this._submit(track, c, targetLang, 'bulk');
      recovered++;
    }
    if (recovered > 0) console.log(`[AI翻译] 失败重扫：恢复 ${recovered} 条`);
  },

  // 设置变化（语言/key/endpoint）后清掉配置类失败态，使其可重新提交
  clearConfigFailures() {
    const CONFIG_CODES = ['no_key', 'no_permission', 'bad_endpoint', 'bad_provider'];
    for (const [sourceTrackKey, byLang] of this.translations) {
      let cleared = false;
      for (const store of byLang.values()) {
        for (const rec of store.values()) {
          if (rec.status === 'failed' && CONFIG_CODES.includes(rec.code)) {
            rec.status = 'idle';
            rec.failedUntil = 0;
            rec.code = null;
            cleared = true;
          }
        }
      }
      // 关键修复：被清掉的失败 cue 多半落在 bulk cursor 后方。若不回退 cursor，
      // _fillBulkQueue 只从 cursor 往后扫，永远不会回头重提交它们——改对 key 后
      // 只有当前播放窗口（urgent）能自动恢复，已扫过的整段积压会一直停在 idle。
      // 把该轨各语言的 bulk cursor 归零，下一帧 tick 的 _fillBulkQueue 会从头重扫，
      // 已译/在途的 cue 被 _submittable 跳过，重扫成本极低。
      if (cleared) {
        const track = this.tracksBySource.get(sourceTrackKey);
        if (track) {
          for (const state of track.bulkCursorByKey.values()) state.cursor = 0;
        }
      }
    }
  },

  _indexAt(track, time) {
    let lo = 0, hi = track.cues.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (track.cues[mid].start <= time + 0.001) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  },

  _cueStore(sourceTrackKey, targetLang) {
    if (!this.translations.has(sourceTrackKey)) this.translations.set(sourceTrackKey, new Map());
    const byLang = this.translations.get(sourceTrackKey);
    if (!byLang.has(targetLang)) byLang.set(targetLang, new Map());
    return byLang.get(targetLang);
  },

  getTranslation(sourceTrackKey, targetLang, cue) {
    const byLang = this.translations.get(sourceTrackKey);
    if (!byLang) return null;
    const store = byLang.get(targetLang);
    if (!store) return null;
    const rec = store.get(cueKeyOf(cue));
    return rec && rec.status === 'translated' ? rec.text : null;
  },

  progressFor(sourceTrackKey, targetLang) {
    const track = this.tracksBySource.get(sourceTrackKey);
    if (!track) return null;
    const store = this._cueStore(sourceTrackKey, targetLang);
    let done = 0, pending = 0;
    for (const c of track.cues) {
      const rec = store.get(cueKeyOf(c));
      if (rec?.status === 'translated') done++;
      else if (rec?.status === 'pending') pending++;
    }
    return { total: track.cues.length, done, pending, status: track.status };
  },

  getActiveTrack() {
    if (!this.activeSourceTrackKey) return null;
    return this.tracksBySource.get(this.activeSourceTrackKey) || null;
  },

  // 是否存在 videoId 未就绪时建立的 novid 轨道
  hasNovidTracks() {
    for (const key of this.tracksBySource.keys()) {
      if (key.startsWith('novid:')) return true;
    }
    return false;
  },

  // 首次 null→videoId：用冻结的 identityFingerprint 把 novid:* 轨道 rekey 成 videoId:*
  // 不清空 generation、不丢已收字幕和已生成的译文（adopt 而非 reset）
  adoptVideoId(videoId) {
    const remap = []; // [oldKey, newKey, track]
    for (const [oldKey, track] of this.tracksBySource) {
      if (!oldKey.startsWith('novid:')) continue;
      const fp = track.identityFingerprint;
      const newKey = `${videoId}:${fp}`;
      remap.push([oldKey, newKey, track]);
    }
    if (remap.length === 0) return;

    for (const [oldKey, newKey, track] of remap) {
      track.sourceTrackKey = newKey;
      this.tracksBySource.delete(oldKey);
      this.tracksBySource.set(newKey, track);
      // 迁移译文层
      if (this.translations.has(oldKey)) {
        this.translations.set(newKey, this.translations.get(oldKey));
        this.translations.delete(oldKey);
      }
      // 迁移 alias
      for (const [rk, sk] of this.aliasResourceToSource) {
        if (sk === oldKey) this.aliasResourceToSource.set(rk, newKey);
      }
      if (this.activeSourceTrackKey === oldKey) this.activeSourceTrackKey = newKey;
      console.log(`[AI翻译] adopt videoId: ${oldKey} → ${newKey}`);
    }
  },
};


// ============================================================================
// 初始化与设置
// ============================================================================

async function loadSettings() {
  let data = await chrome.storage.local.get(
    ['enabled', 'apiProvider', 'apiKeys', 'customModels', 'openaiEndpoint',
     'displayMode', 'targetLang', 'subPosition', 'contextWindow', 'apiKey']
  );
  if (data.apiProvider === undefined && data.enabled === undefined) {
    try {
      const old = await chrome.storage.sync.get(
        ['enabled', 'apiProvider', 'apiKey', 'targetLang', 'subPosition']
      );
      if (old.apiProvider !== undefined || old.enabled !== undefined) data = old;
    } catch (e) { /* 忽略 */ }
  }
  settings = data;
  console.log('[AI翻译 bridge] 设置已加载, enabled:', settings.enabled);

  if (settings.enabled && currentVideoId) init();

  if (earlyMessages.length > 0) {
    console.log(`[AI翻译 bridge] 处理 ${earlyMessages.length} 条缓冲消息`);
    const buffered = earlyMessages;
    earlyMessages = [];
    for (const msg of buffered) {
      // 缓冲消息用「当前」generation 处理（init 后才有有效 videoId）
      TM.ingest(msg.url, msg.text, TM.generation);
    }
  }
}
TM.init();      // 建立 generation=0 的初始 scheduler 实例
loadSettings();

let lastTargetLang = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "updateSettings") {
    const prevTarget = settings?.targetLang;
    const prevDisplayMode = settings?.displayMode;
    settings = request.settings;
    initializedVid = null;

    // 设置变化（可能修了 key/endpoint/provider）：清掉配置类失败态，允许重新提交
    TM.clearConfigFailures();

    // 目标语言切换：源 cues 不变，只切换/生成另一套译文缓存。
    if (prevTarget && prevTarget !== settings.targetLang) {
      console.log(`[AI翻译] 目标语言切换 ${prevTarget} → ${settings.targetLang}`);
      clearCurrentDisplay(); // 立即清空旧语言译文，避免短暂残留
      const track = TM.getActiveTrack();
      if (track && track.status === 'confirmed') TM._scheduleFullTranslation(track);
    }

    // 显示模式切换（overlay ⇄ below）：旧自绘内容立即清除并重渲染，
    // 否则旧内容残留到下次 mutation
    if (prevDisplayMode && prevDisplayMode !== settings.displayMode) {
      console.log(`[AI翻译] 显示模式切换 ${prevDisplayMode} → ${settings.displayMode}`);
      // 切到 below：移除 hide style 露出原字幕；切到 overlay：重置 overlayHidden 待下次渲染再隐藏
      document.getElementById('hide-netflix-subs-style')?.remove();
      overlayHidden = false;
      clearCurrentDisplay();
      onNativeMutation(true); // 强制按新模式重渲染当前字幕
    }

    updateSubtitlePosition();
    if (settings.enabled && currentVideoId) init();
    else stop();
    sendResponse({ ok: true });
  }
});

// ========== SPA 导航监听 ==========

let nullStreak = 0;
let initializedVid = null;

setInterval(() => {
  const vid = getVideoId();
  if (vid === currentVideoId) { nullStreak = 0; return; }
  if (vid === null) {
    nullStreak++;
    if (nullStreak < 3) return;
  }
  nullStreak = 0;

  const prevVid = currentVideoId;
  console.log(`[AI翻译 bridge] 检测到导航: ${prevVid} → ${vid}`);
  currentVideoId = vid;
  resetDisplayState();
  if (settings?.enabled) {
    if (vid) {
      // 首次 null→videoId（脚本启动时 videoId 尚未就绪，轨道挂在 novid 名下）：
      // 用冻结的 identityFingerprint 重建 ${videoId}:${fp}，而非 reset 丢弃已收字幕
      if (prevVid === null && TM.hasNovidTracks()) {
        TM.adoptVideoId(vid);
      } else {
        TM.reset();   // 真正换集：generation 递增，旧批次作废
      }
      init();
    } else {
      stop();         // 离开播放页：stop 内部统一 reset
    }
  } else {
    TM.reset();
  }
}, 1000);

function resetDisplayState() {
  initializedVid = null;
  cachedNativeStyle = null;
  displayedCueKey = null;
  displayedTrackKey = null;
  displayedNativeText = null;
  lastNativeText = "";
  nativeMissingSince = 0;
  clearAnchorCandidate();
  if (customSubContainer) customSubContainer.innerHTML = '';
  removeProgressUI(true);
}

// ========== 接收字幕数据（MAIN world via postMessage） ==========

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.type !== '__nf_ai_subtitle__') return;

  if (settings === null) {
    // settings 未加载完：缓冲，绝不丢弃
    earlyMessages.push({ url: event.data.url, text: event.data.text });
    return;
  }
  if (!settings.enabled) return;

  // 关键修复：有效 videoId 之前不启动翻译，只把 payload 交给 TM 归并。
  // TM.ingest 内部按 generation 处理；翻译由 confirmed/window 逻辑驱动，
  // 而非「收到即翻」。
  TM.ingest(event.data.url, event.data.text, TM.generation);
});

// ============================================================================
// 字幕解析（原样保留自 v2.6）
// ============================================================================

function parseSubtitleFile(rawText, url) {
  const trimmed = rawText.trim().substring(0, 200).toLowerCase();
  if (rawText.trim().startsWith('<?xml') || trimmed.includes('<tt')) {
    const entries = parseTTML(rawText);
    if (entries.length > 0) return entries;
  }
  if (trimmed.includes('webvtt')) {
    return parseWebVTT(rawText);
  }
  let entries = parseTTML(rawText);
  if (entries.length === 0) entries = parseWebVTT(rawText);
  return entries;
}

function parseTTML(xml) {
  const entries = [];
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) {
      console.warn('[AI翻译 bridge] TTML XML 解析错误');
      return entries;
    }
    let pElements = doc.querySelectorAll('p[begin]');
    if (pElements.length === 0) {
      const allP = doc.getElementsByTagName('p');
      const filtered = [];
      for (let i = 0; i < allP.length; i++) {
        if (allP[i].getAttribute('begin') || allP[i].getAttributeNS(null, 'begin')) {
          filtered.push(allP[i]);
        }
      }
      pElements = filtered;
    }
    if (pElements.length === 0) {
      pElements = doc.querySelectorAll('span[begin]');
    }
    const pArr = Array.from(pElements);
    for (const p of pArr) {
      const beginStr = p.getAttribute('begin');
      const endStr = p.getAttribute('end');
      const durStr = p.getAttribute('dur');
      const begin = parseTimestamp(beginStr);
      let end = parseTimestamp(endStr);
      if (end === null && durStr) {
        const dur = parseTimestamp(durStr);
        if (dur !== null && begin !== null) end = begin + dur;
      }
      let text = extractText(p);
      text = text.replace(/\s+/g, ' ').trim();
      if (text && begin !== null && end !== null) {
        entries.push({ start: begin, end: end, text: text });
      }
    }
  } catch (e) {
    console.warn('[AI翻译 bridge] TTML 解析异常:', e.message);
  }
  return entries;
}

function extractText(node) {
  let text = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent;
    } else if (child.nodeName.toLowerCase() === 'br') {
      text += ' ';
    } else {
      text += extractText(child);
    }
  }
  return text;
}

function parseWebVTT(vttText) {
  const entries = [];
  const blocks = vttText.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(
        /(\d{1,2}:\d{2}:\d{2}[\.:,]\d{2,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[\.:,]\d{2,3})/
      );
      if (match) {
        const start = parseTimestamp(match[1]);
        const end = parseTimestamp(match[2]);
        const textLines = lines.slice(i + 1).filter(l => l.trim());
        const text = textLines.join(' ').replace(/<[^>]+>/g, '').trim();
        if (text && start !== null && end !== null) {
          entries.push({ start, end, text });
        }
        break;
      }
    }
  }
  return entries;
}

function parseTimestamp(ts) {
  if (!ts) return null;
  const normalized = ts.replace(/,/g, '.');
  const tickMatch = normalized.match(/^(\d+)t$/i);
  if (tickMatch) return parseInt(tickMatch[1]) / 10000000;
  const fullMatch = normalized.match(/^(\d+):(\d+):(\d+)(?:[\.:](\d+))?$/);
  if (fullMatch) {
    const h = parseInt(fullMatch[1]) || 0;
    const m = parseInt(fullMatch[2]) || 0;
    const s = parseInt(fullMatch[3]) || 0;
    let ms = 0;
    if (fullMatch[4]) {
      const frac = fullMatch[4];
      ms = frac.length <= 3
        ? parseInt(frac.padEnd(3, '0')) || 0
        : Math.round((parseInt(frac) / 24) * 1000);
    }
    return h * 3600 + m * 60 + s + ms / 1000;
  }
  const shortMatch = normalized.match(/^(\d+):(\d+)(?:[\.:](\d+))?$/);
  if (shortMatch) {
    const m = parseInt(shortMatch[1]) || 0;
    const s = parseInt(shortMatch[2]) || 0;
    let ms = 0;
    if (shortMatch[3]) ms = parseInt(shortMatch[3].padEnd(3, '0')) || 0;
    return m * 60 + s + ms / 1000;
  }
  return null;
}

// ============================================================================
// 显示层 + 激活轨锚定
// ============================================================================

function init() {
  const vid = getVideoId();
  if (vid && vid === initializedVid && customSubContainer?.isConnected) {
    console.log('[AI翻译 bridge] 已初始化，跳过');
    return;
  }
  initializedVid = vid;

  console.log('[AI翻译 bridge] 初始化... 模式:', isBelowMode() ? 'below' : 'overlay');
  createCustomContainer();
  // overlay 模式不在 init 隐藏原字幕——等自绘首次成功渲染后才隐藏（故障保护）。
  // 这样数据层异常/轨道未成熟时，原生字幕仍可见，不会原文译文一起消失。
  document.getElementById('hide-netflix-subs-style')?.remove();
  overlayHidden = false;
  noActiveSince = 0;
  startTimeSync();
  startNativeObserver();
}

// 激活轨锚定状态（v3.7：沿用「同候选轨稳定 400ms」定时器模型）
let anchorCandidate = null;       // 候选 sourceTrackKey
let anchorSingleSince = 0;        // 候选首次命中时刻
let anchorSwitchTimer = null;     // 可取消的 400ms 切轨定时器
const ANCHOR_STABLE_MS = 400;     // 唯一新轨稳定指向多久即切（中点，滤抖动又不久等）

// 显示时钟状态（v3.3 改为原生字幕 DOM 主时钟）
let displayedCueKey = null;     // 当前显示的 cue
let displayedTrackKey = null;   // 属于哪个轨
let displayedNativeText = null; // 当前显示对应的原生文本（重绘校验用，不再依赖 currentTime）
let lastNativeText = "";

// overlay 故障保护状态（v3.5）——below 模式完全不参与
let overlayHidden = false;          // 原生字幕当前是否被隐藏（自绘是否已接管）
let noActiveSince = 0;              // 持续无激活轨的起始时刻（有 active 时为 0）

// 清除切轨候选与定时器（导航/reset/旧 active 再匹配/候选改变等情形）
function clearAnchorCandidate() {
  anchorCandidate = null;
  anchorSingleSince = 0;
  if (anchorSwitchTimer) { clearTimeout(anchorSwitchTimer); anchorSwitchTimer = null; }
}

// 隐藏原生字幕（仅 overlay；幂等）。自绘首次成功渲染后调用
function hideNativeSubs() {
  if (isBelowMode()) return;       // below 模式保留原字幕
  if (overlayHidden) return;
  injectHideStyle();
  overlayHidden = true;
}

// 恢复原生字幕（仅 overlay；幂等）。自绘失效/无激活轨时兜底
function restoreNativeSubs() {
  if (isBelowMode()) return;
  if (!overlayHidden) return;
  document.getElementById('hide-netflix-subs-style')?.remove();
  overlayHidden = false;
  console.log('[AI翻译] 自绘失效，恢复原生字幕（故障保护）');
}

// 当前显示的 cue 译文刚完成时立即重绘（P1-2 + P1-3）。
// 三重校验：语言一致 + 激活轨 + 正显示这条 cue；直接用保存的 displayedCueKey/
// displayedNativeText 校验，不调 findCueAt（避免把时间轴误差带回）
function maybeRedrawCurrent(submittedLang, sourceTrackKey, cueKey, text) {
  if (submittedLang !== settings.targetLang) return;
  if (sourceTrackKey !== TM.activeSourceTrackKey) return;
  if (cueKey !== displayedCueKey) return;
  renderSubtitles(displayedNativeText || '', text);
}

// 源轨/目标语言切换时立即清空当前显示（避免短暂残留旧译文）。
// 注意：不在此恢复原生字幕——正常字幕空窗也走这里，恢复会导致原字幕在间隙闪现
function clearCurrentDisplay() {
  displayedCueKey = null;
  displayedTrackKey = null;
  displayedNativeText = null;
  if (customSubContainer) customSubContainer.innerHTML = '';
}

function startTimeSync() {
  if (animFrameId) cancelAnimationFrame(animFrameId);

  let lastTickTime = performance.now();
  let lastRescanAt = 0;
  let lastNodeCheckAt = 0;

  function tick() {
    if (customSubContainer && !customSubContainer.isConnected) mountContainer();

    const video = document.querySelector('video');
    const now = performance.now();
    const dtMs = now - lastTickTime;
    lastTickTime = now;

    if (video && settings) {
      const t = video.currentTime;
      const playing = !video.paused && !video.ended;

      updateActiveTiming(playing, dtMs, t);

      const track = TM.getActiveTrack();
      if (track && track.cues.length > 0) {
        // 保当前窗口（urgent）：修复快进/切轨后当前 cue 未翻时的 ⏳
        TM.translateWindow(track, t);
        TM._markReady(track);
        TM.confirm(track);
        if (track.status === 'confirmed') TM._fillBulkQueue(track, settings.targetLang);
      }

      // overlay 故障保护（below 模式 hide/restore 内部 no-op）：
      if (!isBelowMode()) {
        // 维护「持续无激活轨」计时
        if (track) {
          noActiveSince = 0;
        } else if (noActiveSince === 0) {
          noActiveSince = Date.now();
        }
        // 条件1：自绘容器丢失或断开 → 恢复原字幕
        if (!customSubContainer || !customSubContainer.isConnected) {
          restoreNativeSubs();
        }
        // 条件2：持续无激活轨超过 5 秒 → 恢复原字幕（不用「无渲染超时」，
        //        因为长段无对白时无渲染是正常的）
        else if (noActiveSince > 0 && Date.now() - noActiveSince > 5000) {
          restoreNativeSubs();
        }
      }

      // 失败恢复重扫（每 2 秒，每次最多 N 条）—— P1-5
      if (now - lastRescanAt > 2000) {
        lastRescanAt = now;
        TM.rescanFailures(2);
      }

      // 原生字幕节点健康检查（每 500ms）：被 Netflix 替换则重绑 observer —— 时钟 fallback 的结构判据
      if (now - lastNodeCheckAt > 500) {
        lastNodeCheckAt = now;
        ensureNativeObserverBound();
        maybeTimelineFallback(playing, t, track);
      }

      if (isBelowMode()) positionBelowNative();
      else positionOverlayOnNative();
    }
    animFrameId = requestAnimationFrame(tick);
  }
  animFrameId = requestAnimationFrame(tick);
}

// 严格时间轴 fallback（仅结构性故障时启用）：
// 连续 ~1.5s 找不到/绑不上原生字幕节点、且视频在推进，才用 findCueAt 驱动显示。
// 原生节点存在但文本为空时不 fallback（信任空状态——用户可能关了字幕）。
let nativeMissingSince = 0;
function maybeTimelineFallback(playing, t, track) {
  const node = document.querySelector('.player-timedtext');
  const bound = node && node.isConnected && nativeObserverBoundNode === node;
  if (bound) { nativeMissingSince = 0; return; }

  // 节点缺失/未绑定：开始计时
  if (nativeMissingSince === 0) nativeMissingSince = Date.now();
  if (!playing) return;
  if (Date.now() - nativeMissingSince < 1500) return; // 未达阈值，再等

  // 进入时间轴 fallback：用 findCueAt 显示（带 ±0.15 容差，仅 fallback 用）
  if (!track || track.cues.length === 0) return;
  const cue = findCueAt(track, t);
  if (cue) {
    const k = cueKeyOf(cue);
    if (k !== displayedCueKey) {
      displayedCueKey = k;
      displayedTrackKey = track.sourceTrackKey;
      displayedNativeText = cue.text;
      const translated = TM.getTranslation(track.sourceTrackKey, settings.targetLang, cue);
      renderSubtitles(cue.text, translated || "⏳");
    }
  } else if (displayedCueKey !== null) {
    clearCurrentDisplay();
  }
}

// 连续激活计时（P2-4 空窗三态）：
//   播放中且有字幕：用 video.currentTime 推进量累计（快进跳变不计）
//   0–4 秒空窗：保持 active，冻结 continuousActiveMs（不增不减）
//   超过 4 秒空窗：重置 continuousActiveMs，锚定标 uncertain
//   暂停/后台：冻结（恢复后继续）
function updateActiveTiming(playing, dtMs, videoTime) {
  const track = TM.getActiveTrack();
  if (!track) return;

  if (!playing || document.hidden) {
    track.lastActiveVideoTime = videoTime; // 暂停/后台：冻结，记录基准
    return;
  }

  // 空窗判定：emptyStartAt 由原生字幕 Observer 维护（0=当前有字幕）
  if (track.emptyStartAt > 0) {
    const emptyMs = Date.now() - track.emptyStartAt;
    if (emptyMs > ACTIVE_GRACE_MS) {
      // 超宽限：长时间无字幕的播放区间不应帮助达成 30 秒确认
      if (track.continuousActiveMs > 0) {
        console.log(`[AI翻译] 空窗超 ${ACTIVE_GRACE_MS}ms，重置连续计时，锚定转 uncertain`);
      }
      track.continuousActiveMs = 0;
      TM.anchorState = 'uncertain';
    }
    // 宽限内（含超限后）：冻结计时，仅更新基准
    track.lastActiveVideoTime = videoTime;
    return;
  }

  // 有字幕且播放：正常累计
  const vt = videoTime;
  if (track.lastActiveVideoTime !== null) {
    const vdt = (vt - track.lastActiveVideoTime) * 1000;
    if (vdt > 0 && vdt < Math.max(dtMs * 2, 500)) {
      track.continuousActiveMs += vdt;
    }
  }
  track.lastActiveVideoTime = vt;
}

function findCueAt(track, time) {
  let lo = 0, hi = track.cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const e = track.cues[mid];
    if (time < e.start - 0.15) hi = mid - 1;
    else if (time > e.end + 0.15) lo = mid + 1;
    else return e;
  }
  return null;
}

// ========== 原生字幕 Observer：显示主时钟 + 激活轨锚定（v3.3） ==========

let nativeObserver = null;
let nativeRetryTimer = null;
let nativeObserverBoundNode = null; // 当前绑定的 .player-timedtext 节点（健康检查用）

function startNativeObserver() {
  clearTimeout(nativeRetryTimer);
  const targetNode = document.querySelector('.player-timedtext');
  if (!targetNode) {
    nativeObserverBoundNode = null;
    nativeRetryTimer = setTimeout(startNativeObserver, 1000);
    return;
  }
  if (nativeObserver) nativeObserver.disconnect();

  nativeObserver = new MutationObserver(onNativeMutation);
  nativeObserver.observe(targetNode, { childList: true, subtree: true, characterData: true });
  nativeObserverBoundNode = targetNode;
  console.log('[AI翻译] 原生字幕 observer 已绑定');
  // 绑定后立即处理一次当前状态（可能字幕已经在显示）
  onNativeMutation();
}

// Netflix 可能整体替换 .player-timedtext 节点；每 500ms 由 tick 调用检查并重绑
function ensureNativeObserverBound() {
  const node = document.querySelector('.player-timedtext');
  if (node && node !== nativeObserverBoundNode) {
    console.log('[AI翻译] 原生字幕节点被替换，重绑 observer');
    startNativeObserver();
  } else if (!node && nativeObserverBoundNode) {
    nativeObserverBoundNode = null;
  }
}

// 主时钟：原生字幕出现→显示译文；清空→清显示。译文与原字幕帧级对齐。
// force=true：轨道成熟后强制重新处理当前文本（绕过 lastNativeText 短路）
function onNativeMutation(force = false) {
  const node = nativeObserverBoundNode || document.querySelector('.player-timedtext');
  if (!node) return;
  const nativeText = normText(node.innerText);
  const active = TM.getActiveTrack();

  if (!nativeText) {
    // 立即清译文（与原字幕同步，用户关字幕的场景也正确）。
    // P1 修复：用「容器是否有内容」判断，而非 displayedCueKey——未匹配的占位
    //（原文+⏳）会把 displayedCueKey 设为 null，旧判据漏清，切语言时会残留
    lastNativeText = "";
    if (customSubContainer && customSubContainer.childNodes.length > 0) clearCurrentDisplay();
    // 短空窗内【不清】候选/timer，否则与稳定计时冲突（字幕间隙清零会反复重启 timer）。
    // 候选只在空窗超过 ACTIVE_GRACE_MS 后才清。
    if (active && active.emptyStartAt === 0) active.emptyStartAt = Date.now();
    const emptyMs = active ? Date.now() - active.emptyStartAt : Infinity;
    if (emptyMs > ACTIVE_GRACE_MS) {
      clearAnchorCandidate();
    }
    return;
  }
  if (active) active.emptyStartAt = 0;

  if (!force && nativeText === lastNativeText) return;
  lastNativeText = nativeText;

  // 先锚定（可能切换/首次激活），再用（可能已更新的）激活轨显示
  anchorToNativeText(nativeText);
  displayForNativeText(nativeText);

  // 条件3（overlay 故障保护）：原文非空、走完显示逻辑后自绘容器仍为空，
  // 说明「轨道还在但渲染链断了」。250ms 后复查（避开正常对白间隔 + 渲染的一帧延迟），
  // 仍空且原文仍非空 → 恢复原字幕
  if (!isBelowMode()) {
    scheduleEmptyRenderCheck(nativeText);
  }
}

let emptyRenderCheckTimer = null;
function scheduleEmptyRenderCheck(expectText) {
  if (emptyRenderCheckTimer) clearTimeout(emptyRenderCheckTimer);
  // 自绘当前就有内容：渲染链正常，无需检查
  if (customSubContainer && customSubContainer.childNodes.length > 0) return;
  emptyRenderCheckTimer = setTimeout(() => {
    emptyRenderCheckTimer = null;
    if (isBelowMode()) return;
    const node = nativeObserverBoundNode || document.querySelector('.player-timedtext');
    const stillText = node ? normText(node.innerText) : '';
    // 原文已变/已空：不是渲染链问题，跳过
    if (!stillText || stillText !== expectText) return;
    // 原文仍非空、仍是这条，但自绘还是空 → 渲染链断，恢复原字幕兜底
    if (!customSubContainer || customSubContainer.childNodes.length === 0) {
      restoreNativeSubs();
    }
  }, 250);
}

// 用原生文本在激活轨里匹配 cue 并显示对应译文（主时钟显示入口）
function displayForNativeText(nativeText) {
  const track = TM.getActiveTrack();
  if (!track || track.cues.length === 0) return;
  const video = document.querySelector('video');
  const t = video?.currentTime ?? 0;

  // 在当前时间附近找文本匹配的 cue（±2 条容错；不依赖精确时间）
  const idx = TM._indexAt(track, t);
  let matched = null, matchedIdx = -1;
  for (let i = Math.max(0, idx - 3); i <= Math.min(track.cues.length - 1, idx + 3); i++) {
    if (normText(track.cues[i].text) === nativeText) { matched = track.cues[i]; matchedIdx = i; break; }
  }
  // 附近没匹配上：可能是锚定刚切轨或时间略偏，放宽到全轨找最近的同文本
  if (!matched) {
    for (let i = 0; i < track.cues.length; i++) {
      if (normText(track.cues[i].text) === nativeText) { matched = track.cues[i]; matchedIdx = i; break; }
    }
  }
  if (!matched) {
    // 激活轨里确实没有这条（轨道还没成熟/这条还没解析到）：显示原文 + 占位
    displayedCueKey = null;
    displayedTrackKey = track.sourceTrackKey;
    displayedNativeText = nativeText;
    renderSubtitles(nativeText, "⏳");
    return;
  }

  const cueKey = cueKeyOf(matched);
  displayedCueKey = cueKey;
  displayedTrackKey = track.sourceTrackKey;
  displayedNativeText = nativeText;

  // 立即提升这条到 urgent（若在 bulk 队列等待），并确保已提交翻译
  const store = TM._cueStore(track.sourceTrackKey, settings.targetLang);
  const rec = store.get(cueKey);
  if (!rec || TM._submittable(rec)) {
    TM._submit(track, matched, settings.targetLang, 'urgent', matchedIdx);
  } else if (rec.status === 'pending' && rec.tier === 'bulk' && rec.taskKey) {
    TM.scheduler.promote(rec.taskKey);
    rec.tier = 'urgent';
  }

  const translated = TM.getTranslation(track.sourceTrackKey, settings.targetLang, matched);
  renderSubtitles(matched.text, translated || "⏳");
}

// 在所有成熟轨道里匹配原生文本，返回候选 [{key, cueKey}]（当前时间附近 ±2 条）
function matchTracks(nativeText, t) {
  const matches = [];
  for (const [sourceTrackKey, track] of TM.tracksBySource) {
    const idx = TM._indexAt(track, t);
    for (let i = Math.max(0, idx - 2); i <= Math.min(track.cues.length - 1, idx + 2); i++) {
      if (normText(track.cues[i].text) === nativeText) {
        matches.push({ key: sourceTrackKey, cueKey: cueKeyOf(track.cues[i]) });
        break;
      }
    }
  }
  return matches;
}

// 执行切轨：旧轨 urgent 降级、设新 active、清显示、确认新轨
function performTrackSwitch(newKey) {
  const prev = TM.activeSourceTrackKey;
  if (prev === newKey) return;
  if (prev && TM.scheduler) TM.scheduler.demoteUrgentOfTrack(prev);
  TM.activeSourceTrackKey = newKey;
  TM.anchorState = 'certain';
  clearAnchorCandidate();
  clearCurrentDisplay();
  const video = document.querySelector('video');
  const t = video?.currentTime ?? 0;
  const newTrack = TM.tracksBySource.get(newKey);
  if (newTrack) {
    newTrack.continuousActiveMs = 0;
    newTrack.lastActiveVideoTime = t;
    newTrack.emptyStartAt = 0;
    TM._markReady(newTrack);
    TM.confirm(newTrack);
  }
  console.log(`[AI翻译] 🎯 激活轨切换 ${prev || '∅'} → ${newKey}`);
}

// 400ms 定时器到点：主动重读原字幕复核，仍唯一指向同候选且旧 active 不匹配 → 切
function onAnchorSwitchTimer(candidateKey) {
  anchorSwitchTimer = null;
  if (candidateKey !== anchorCandidate) return; // 候选已变
  const node = nativeObserverBoundNode || document.querySelector('.player-timedtext');
  const nativeText = node ? normText(node.innerText) : '';
  if (!nativeText) return; // 正空窗：不切，不清计时（字幕恢复后下次复核）
  const video = document.querySelector('video');
  const t = video?.currentTime ?? 0;
  const matches = matchTracks(nativeText, t);
  // 旧 active 又匹配上了 → 取消切换
  if (matches.some(m => m.key === TM.activeSourceTrackKey)) { clearAnchorCandidate(); return; }
  // 必须仍是唯一候选且就是它
  if (matches.length === 1 && matches[0].key === candidateKey) {
    performTrackSwitch(candidateKey);
  } else {
    clearAnchorCandidate(); // 歧义/无匹配/换了轨
  }
}

// 用原生字幕当前文本匹配各轨道，决定 activeSourceTrackKey
function anchorToNativeText(nativeText) {
  const video = document.querySelector('video');
  const t = video?.currentTime ?? 0;
  const matches = matchTracks(nativeText, t);

  if (matches.length === 0) {
    clearAnchorCandidate(); // 无匹配：清候选+timer
    return;
  }

  // 当前激活轨也匹配 → 保持，立即取消候选（用户没切，是误判）
  if (matches.some(m => m.key === TM.activeSourceTrackKey)) {
    clearAnchorCandidate();
    TM.anchorState = 'certain';
    return;
  }

  // 冷启动：尚无 active track 且唯一候选 → 首条直接激活（0 延迟，打破死锁）
  if (!TM.activeSourceTrackKey) {
    if (matches.length === 1) {
      TM.activeSourceTrackKey = matches[0].key;
      TM.anchorState = 'certain';
      clearAnchorCandidate();
      const t0 = TM.tracksBySource.get(matches[0].key);
      if (t0) {
        t0.continuousActiveMs = 0;
        t0.lastActiveVideoTime = t;
        t0.emptyStartAt = 0;
        TM._markReady(t0);
        TM.confirm(t0);
      }
      console.log(`[AI翻译] 🎯 首条直接激活 → ${matches[0].key}`);
    }
    // 冷启动多轨歧义：等有区分度的字幕
    return;
  }

  // 多轨歧义且都不是当前轨 → 暂不切，清候选等区分度
  if (matches.length > 1) {
    clearAnchorCandidate();
    return;
  }

  // 唯一新轨（非当前 active）：用「稳定指向 400ms」判定，而非「两条不同 cue」。
  // 关键：启动主动定时器，不依赖下一次 mutation——稀疏对白下同句 DOM 可能稳定数秒
  const only = matches[0];
  if (only.key === anchorCandidate) {
    // 仍指向同候选（同 cue 或新 cue 都算稳定）：计时不重置，timer 继续
  } else {
    // 新候选：记起点，启动可取消的 400ms 定时器
    clearAnchorCandidate();
    anchorCandidate = only.key;
    anchorSingleSince = performance.now();
    anchorSwitchTimer = setTimeout(() => onAnchorSwitchTimer(only.key), ANCHOR_STABLE_MS);
  }
}

// ========== 样式采样（保留 v2.6 的「最大字号 span + 缓存兜底」） ==========

let cachedNativeStyle = null;
let cachedStyleAt = 0;

function getNativeTextStyle() {
  const container = document.querySelector('.player-timedtext-text-container');
  if (container) {
    try {
      const spans = container.querySelectorAll('span');
      let best = null, bestSize = 0;
      const candidates = spans.length > 0 ? spans : [container];
      for (const el of candidates) {
        const hasDirectText = Array.from(el.childNodes).some(
          n => n.nodeType === Node.TEXT_NODE && n.textContent.trim()
        );
        if (!hasDirectText) continue;
        const cs = getComputedStyle(el);
        const size = parseFloat(cs.fontSize);
        if (size > bestSize) { bestSize = size; best = cs; }
      }
      if (best && bestSize > 10) {
        cachedNativeStyle = {
          fontFamily: best.fontFamily,
          fontSize: best.fontSize,
          fontWeight: best.fontWeight,
          color: best.color,
          textShadow: best.textShadow && best.textShadow !== 'none'
            ? best.textShadow : '2px 2px 4px rgba(0,0,0,0.8)'
        };
        cachedStyleAt = Date.now();
        return cachedNativeStyle;
      }
    } catch (e) { /* 走缓存 */ }
  }
  if (cachedNativeStyle && Date.now() - cachedStyleAt < 5 * 60 * 1000) {
    return cachedNativeStyle;
  }
  return null;
}

function applyTextStyle(div, ns, { color } = {}) {
  div.style.fontFamily = ns.fontFamily;
  div.style.fontSize = ns.fontSize;
  div.style.fontWeight = ns.fontWeight;
  div.style.textShadow = ns.textShadow;
  div.style.color = color || ns.color;
}

function renderSubtitles(original, translated) {
  if (!customSubContainer) return;
  customSubContainer.innerHTML = '';
  const ns = getNativeTextStyle();
  const below = isBelowMode();

  const transDiv = document.createElement('div');
  transDiv.textContent = translated;
  if (ns) {
    applyTextStyle(transDiv, ns, below ? {} : { color: '#ffcc00' });
  } else {
    transDiv.style.cssText = 'font-size: 24px; color: #ffcc00; font-weight: bold;';
  }
  if (!below) transDiv.style.marginBottom = '5px';
  customSubContainer.appendChild(transDiv);

  if (!below) {
    const origDiv = document.createElement('div');
    origDiv.textContent = original;
    if (ns) applyTextStyle(origDiv, ns);
    else origDiv.style.cssText = 'font-size: 18px; color: #ffffff;';
    customSubContainer.appendChild(origDiv);
    positionOverlayOnNative();
  } else {
    positionBelowNative();
  }

  // 自绘成功写入非空内容（含「原文 + ⏳」也算成功，不等译文完成）：
  // 隐藏原生字幕（overlay 故障保护的「确认可用后才隐藏」）
  const wrote = (original && original.length) || (translated && translated.length);
  if (wrote) {
    hideNativeSubs();
  }
}

// ========== 容器与定位（保留 v2.6） ==========

let mountRetryTimer = null;

function createCustomContainer() {
  if (document.getElementById('ai-translator-container')) {
    customSubContainer = document.getElementById('ai-translator-container');
    return;
  }
  customSubContainer = document.createElement('div');
  customSubContainer.id = 'ai-translator-container';
  customSubContainer.style.cssText = `
    position: absolute; width: 100%; text-align: center;
    z-index: 9999; pointer-events: none;
    display: flex; flex-direction: column; align-items: center;
    text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
  `;
  updateSubtitlePosition();
  mountContainer();
}

function mountContainer() {
  if (!customSubContainer) return;
  clearTimeout(mountRetryTimer);
  const vc = document.querySelector('[data-uia="watch-video"]')
    || document.querySelector('.watch-video')
    || document.querySelector('video')?.parentElement;
  if (vc) {
    if (getComputedStyle(vc).position === 'static') vc.style.position = 'relative';
    vc.appendChild(customSubContainer);
    console.log('[AI翻译 bridge] 字幕容器已挂载');
  } else {
    mountRetryTimer = setTimeout(mountContainer, 1000);
  }
}

function updateSubtitlePosition() {
  if (!customSubContainer) return;
  if (isBelowMode()) customSubContainer.style.bottom = 'auto';
}

function injectHideStyle() {
  if (!document.getElementById('hide-netflix-subs-style')) {
    const style = document.createElement('style');
    style.id = 'hide-netflix-subs-style';
    style.textContent = `.player-timedtext-text-container { opacity: 0.001 !important; }`;
    (document.head || document.documentElement).appendChild(style);
  }
}

function positionBelowNative() {
  if (!customSubContainer || !customSubContainer.isConnected) return;
  const native = document.querySelector('.player-timedtext-text-container');
  const video = document.querySelector('video');
  const parent = customSubContainer.parentElement;
  if (!video || !parent || !native || !customSubContainer.firstChild) return;
  const nRect = native.getBoundingClientRect();
  const vRect = video.getBoundingClientRect();
  const pRect = parent.getBoundingClientRect();
  if (nRect.width === 0 && nRect.height === 0) return;
  const gap = 6;
  const h = customSubContainer.offsetHeight || 40;
  let top = nRect.bottom + gap;
  const bottomLimit = Math.min(vRect.bottom, pRect.bottom) - 8;
  if (top + h > bottomLimit) top = nRect.top - h - gap;
  customSubContainer.style.bottom = 'auto';
  customSubContainer.style.top = `${Math.max(0, top - pRect.top)}px`;
}

let lastOverlayAnchorAt = 0;

function positionOverlayOnNative() {
  if (!customSubContainer || !customSubContainer.isConnected) return;
  const parent = customSubContainer.parentElement;
  if (!parent) return;
  const native = document.querySelector('.player-timedtext-text-container');
  if (native) {
    const nRect = native.getBoundingClientRect();
    if (nRect.height > 0) {
      const pRect = parent.getBoundingClientRect();
      const h = customSubContainer.offsetHeight || 0;
      customSubContainer.style.bottom = 'auto';
      customSubContainer.style.top = `${Math.max(0, nRect.bottom - h - pRect.top)}px`;
      lastOverlayAnchorAt = Date.now();
      return;
    }
  }
  if (Date.now() - lastOverlayAnchorAt > 3000) {
    customSubContainer.style.top = 'auto';
    customSubContainer.style.bottom = `${parseInt(settings?.subPosition, 10) || 10}%`;
  }
}

// ========== 进度 UI（按激活轨统计） ==========

let progressDeleteTimer = null;

function updateProgressUI() {
  if (!settings) return;
  const key = TM.activeSourceTrackKey;
  if (!key) return;
  const p = TM.progressFor(key, settings.targetLang);
  if (!p) return;

  // 任何更新都先取消待删除定时器（防止旧定时器删掉刚切轨建立的新进度条）
  if (progressDeleteTimer) { clearTimeout(progressDeleteTimer); progressDeleteTimer = null; }

  let bar = document.getElementById('ai-translate-progress');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'ai-translate-progress';
    bar.style.cssText = `
      position: fixed; top: 10px; right: 10px; z-index: 99999;
      background: rgba(0,0,0,0.85); color: #ffcc00; padding: 10px 16px;
      border-radius: 8px; font-size: 13px; font-family: Arial, sans-serif;
      pointer-events: none;
    `;
    document.body.appendChild(bar);
  }
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  if (p.done >= p.total && p.total > 0) {
    bar.textContent = `✅ 完成 (${p.done} 条)`;
    progressDeleteTimer = setTimeout(() => {
      const b = document.getElementById('ai-translate-progress');
      if (b) b.remove();
      progressDeleteTimer = null;
    }, 3000);
  } else if (p.status === 'provisional') {
    bar.textContent = `🔄 翻译中(窗口) ${p.done}/${p.total}`;
  } else {
    bar.textContent = `🔄 预翻译: ${p.done}/${p.total} (${pct}%)`;
  }
}

function removeProgressUI(immediate = false) {
  if (progressDeleteTimer) { clearTimeout(progressDeleteTimer); progressDeleteTimer = null; }
  const bar = document.getElementById('ai-translate-progress');
  if (bar) {
    if (immediate) bar.remove();
    else progressDeleteTimer = setTimeout(() => {
      const b = document.getElementById('ai-translate-progress');
      if (b) b.remove();
      progressDeleteTimer = null;
    }, 3000);
  }
}

function stop() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  animFrameId = null;
  if (nativeObserver) nativeObserver.disconnect();
  nativeObserver = null;
  nativeObserverBoundNode = null;
  clearTimeout(nativeRetryTimer);
  clearTimeout(mountRetryTimer);
  if (emptyRenderCheckTimer) { clearTimeout(emptyRenderCheckTimer); emptyRenderCheckTimer = null; }
  if (customSubContainer) customSubContainer.remove();
  customSubContainer = null;
  document.getElementById('hide-netflix-subs-style')?.remove();
  document.getElementById('ai-translate-progress')?.remove();
  displayedCueKey = null;
  displayedTrackKey = null;
  displayedNativeText = null;
  lastNativeText = "";
  nativeMissingSince = 0;
  overlayHidden = false;
  noActiveSince = 0;
  clearAnchorCandidate();
  TM.reset();
}
