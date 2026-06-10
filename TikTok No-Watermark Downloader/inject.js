// inject.js v2.2.0 - TikTok 无水印下载 (MAIN world)
// v2.2.0 变更：
//   1. 移除 window.fetch hook：JSON.parse hook 覆盖 text()+parse 与 XHR 路径，
//      Response.prototype.json hook 覆盖 .json() 路径，三者重叠导致同一响应被
//      扫描 2-3 遍且每个 API 响应都被 clone 一份。如果某些页面检测回归，
//      可考虑按 URL 白名单恢复 fetch hook。
//   2. message 监听补 event.source !== window 检查
//   3. SPA 路由检测：300ms setInterval 轮询 → hook history.pushState/replaceState + popstate
//
// TikTok 数据结构：
//   视频: itemStruct.video.{playAddr, downloadAddr, bitrateInfo, bitrate}
//   图集: itemStruct.imagePost.images[].imageURL.urlList
//   音频: itemStruct.music.playUrl
//   作者: itemStruct.author.{uniqueId, nickname}
//   ID:   itemStruct.id
(function () {
    'use strict';

    const STORE_MAX = 300;
    const SCAN_MAX_DEPTH = 6;

    const videoStore = new Map();
    let latestId = '';
    const _parse = JSON.parse;
    const _respJson = Response.prototype.json;

    function storeSet(id, data) {
        if (videoStore.has(id)) videoStore.delete(id);
        else if (videoStore.size >= STORE_MAX) {
            const first = videoStore.keys().next().value;
            videoStore.delete(first);
        }
        videoStore.set(id, data);
        latestId = id;
    }

    // ===== 视频 URL 提取 =====

    function getPlayUrl(video) {
        if (!video) return '';
        // TikTok: playAddr 通常是无水印，downloadAddr 通常带水印
        if (video.playAddr) return video.playAddr;
        if (video.downloadAddr) return video.downloadAddr;
        if (video.play_addr && video.play_addr.url_list && video.play_addr.url_list.length > 0) {
            return video.play_addr.url_list[0];
        }
        return '';
    }

    // 一条 bitRate 是否属于 adapt（自适应/DASH 纯视频，无音频）
    function isAdaptQuality(q) {
        return typeof q === 'string' && q.toLowerCase().indexOf('adapt') !== -1;
    }

    function getBitRates(video) {
        // TikTok 的 bitrateInfo（大写）和抖音的 bit_rate（小写）都可能出现
        const list = video.bitrateInfo || video.bitRateList || video.bit_rate || [];
        const result = [];

        for (const br of list) {
            let urls = [];
            let bitrate = 0;
            let quality = '';
            let w = 0, h = 0;

            // TikTok 格式（大写字段名）
            if (br.PlayAddr && br.PlayAddr.UrlList) {
                urls = br.PlayAddr.UrlList;
                bitrate = br.Bitrate || br.BitRate || 0;
                quality = br.GearName || br.QualityType || '';
                w = br.PlayAddr.Width || 0;
                h = br.PlayAddr.Height || 0;
            }
            // 备选：小写字段名
            else if (br.play_addr && br.play_addr.url_list) {
                urls = br.play_addr.url_list;
                bitrate = br.bit_rate || br.bitrate || 0;
                quality = br.quality_type || br.gear_name || '';
                w = br.play_addr.width || 0;
                h = br.play_addr.height || 0;
            }
            // 字符串 url
            else if (br.playApi || br.playAddr) {
                urls = [br.playApi || br.playAddr];
                bitrate = br.bitrate || br.bit_rate || 0;
                quality = br.qualityType || br.quality_type || '';
            }

            if (urls.length > 0) {
                // 优先含 unwatermarked 的 URL
                let bestUrl = urls[urls.length - 1];
                for (const u of urls) {
                    if (u && u.indexOf('unwatermarked') !== -1) { bestUrl = u; break; }
                }
                result.push({
                    playApi: bestUrl,
                    allUrls: urls.slice(),
                    quality,
                    isAdapt: isAdaptQuality(quality),
                    bitRate: bitrate,
                    width: w,
                    height: h,
                    pixels: w * h,
                });
            }
        }

        // 默认排序：normal 优先于 adapt，同类按 bitRate 降序
        // 这样调用方拿到的"第一个"是含音频的合成流（如果存在），更直观
        result.sort((a, b) => {
            const aA = a.isAdapt ? 1 : 0, bA = b.isAdapt ? 1 : 0;
            if (aA !== bA) return aA - bA;
            if (a.bitRate !== b.bitRate) return b.bitRate - a.bitRate;
            return b.pixels - a.pixels;
        });
        return result;
    }

    // ===== 图集提取 =====

    function pickBestImageUrl(img) {
        // TikTok 格式
        if (img.imageURL && img.imageURL.urlList && img.imageURL.urlList.length > 0) {
            const urlList = img.imageURL.urlList;
            for (const u of urlList) {
                if (u && u.indexOf('watermark') === -1) return u;
            }
            return urlList[urlList.length - 1];
        }
        // 通用兜底
        const uList = img.url_list || [];
        const dlList = img.download_url_list || [];
        for (const u of uList) { if (u && u.indexOf('watermark') === -1) return u; }
        if (uList.length > 0) return uList[uList.length - 1];
        if (dlList.length > 0) return dlList[dlList.length - 1];
        return '';
    }

    function getAllImageUrls(img) {
        const urls = [];
        if (img.imageURL && img.imageURL.urlList) urls.push(...img.imageURL.urlList);
        if (img.url_list) urls.push(...img.url_list);
        if (img.download_url_list) urls.push(...img.download_url_list);
        return urls;
    }

    function extractImagePost(item) {
        const result = { images: [], clipVideos: [] };

        let imgSources = null;
        if (item.imagePost && item.imagePost.images) imgSources = item.imagePost.images;
        else if (Array.isArray(item.imagePost)) imgSources = item.imagePost;
        else if (item.images) imgSources = item.images;
        else if (item.image_post_info && item.image_post_info.images) imgSources = item.image_post_info.images;

        if (!imgSources || imgSources.length === 0) return result;

        for (let i = 0; i < imgSources.length; i++) {
            const img = imgSources[i];
            if (!img) continue;

            const embeddedVideo = img.video || (img.clip && img.clip.video) || null;
            if (embeddedVideo && (embeddedVideo.playAddr || embeddedVideo.downloadAddr || embeddedVideo.play_addr || embeddedVideo.bitrateInfo)) {
                result.clipVideos.push({
                    index: i,
                    playApi: getPlayUrl(embeddedVideo),
                    bitRateList: getBitRates(embeddedVideo),
                    coverUrl: pickBestImageUrl(img),
                    width: embeddedVideo.width || 0,
                    height: embeddedVideo.height || 0,
                });
            } else {
                const url = pickBestImageUrl(img);
                if (url) {
                    result.images.push({
                        index: i,
                        url,
                        allUrls: getAllImageUrls(img),
                        width: img.imageWidth || img.width || 0,
                        height: img.imageHeight || img.height || 0,
                    });
                }
            }
        }
        return result;
    }

    // ===== 音频提取 =====

    function extractAudio(item) {
        // TikTok: item.music.playUrl（也可能是数组）
        if (!item.music) return null;
        let url = item.music.playUrl || item.music.play_url || '';
        if (Array.isArray(url)) url = url[0] || '';
        if (!url) return null;
        return {
            url,
            title: item.music.title || '',
            author: item.music.author || item.music.authorName || '',
            // music.original 用于判断是否为原声（用户自己的视频音轨）
            // 如果是原声，与视频内的音频更接近一致；如果是 BGM，则可能只是配乐
            isOriginal: !!(item.music.original || item.music.isOriginal),
        };
    }

    // ===== 类型识别 + 主处理 =====

    function getPostType(item) {
        if (item.imagePost) return 'image';
        if (item.images && item.images.length > 0) return 'image';
        if (item.image_post_info) return 'image';
        const t = item.type || item.aweme_type;
        if (t === 150 || t === 68) return 'image';
        return 'video';
    }

    function processItem(item) {
        if (!item) return;
        const id = String(item.id || item.aweme_id || item.awemeId || '');
        if (!id) return;
        if (!item.video && !item.imagePost && !item.images && !item.image_post_info) return;

        const type = getPostType(item);
        const data = {
            awemeId: id,
            type,
            desc: item.desc || '',
            author: (item.author && (item.author.nickname || item.author.uniqueId)) || '',
        };

        if (type === 'image') {
            const extracted = extractImagePost(item);
            data.images = extracted.images;
            data.clipVideos = extracted.clipVideos;
            if (extracted.clipVideos.length > 0 && extracted.images.length === 0) {
                data.subType = 'video_collection';
            } else if (extracted.clipVideos.length > 0 && extracted.images.length > 0) {
                data.subType = 'mixed';
            } else {
                data.subType = 'pure_image';
            }
            if (item.video) {
                data.playApi = getPlayUrl(item.video);
                data.bitRateList = getBitRates(item.video);
            }
        } else {
            data.playApi = getPlayUrl(item.video);
            data.bitRateList = getBitRates(item.video);
        }

        // 音频
        const audio = extractAudio(item);
        if (audio) {
            data.audioUrl = audio.url;
            data.audioTitle = audio.title;
            data.audioAuthor = audio.author;
            data.audioIsOriginal = audio.isOriginal;
        }

        storeSet(id, data);
        window.postMessage({ type: '__TT_DL_VIDEO_DATA__', data }, '*');
    }

    function scanForItems(obj, depth) {
        if (depth > SCAN_MAX_DEPTH || !obj || typeof obj !== 'object') return;

        // TikTok 特有的容器
        if (obj.itemInfo && obj.itemInfo.itemStruct) processItem(obj.itemInfo.itemStruct);
        if (obj.itemStruct) processItem(obj.itemStruct);

        // 通用：自身就是 item
        if ((obj.video || obj.imagePost || obj.images || obj.image_post_info)
            && (obj.id || obj.aweme_id || obj.awemeId)) {
            processItem(obj);
            return;
        }

        if (Array.isArray(obj.itemList)) {
            for (const it of obj.itemList) processItem(it);
        }
        if (Array.isArray(obj.aweme_list)) {
            for (const it of obj.aweme_list) processItem(it);
        }
        if (obj.aweme_detail) processItem(obj.aweme_detail);

        // 递归
        const iter = Array.isArray(obj) ? obj : Object.keys(obj);
        for (let k = 0; k < iter.length; k++) {
            const key = Array.isArray(obj) ? k : iter[k];
            try {
                const val = obj[key];
                if (val && typeof val === 'object') scanForItems(val, depth + 1);
            } catch (e) { /* getter errors */ }
        }
    }

    // Hook JSON.parse
    JSON.parse = function () {
        const result = _parse.apply(this, arguments);
        try {
            if (result && typeof result === 'object') scanForItems(result, 0);
        } catch (e) { /* swallow */ }
        return result;
    };

    // Hook Response.prototype.json
    Response.prototype.json = function () {
        return _respJson.call(this).then(data => {
            try {
                if (data && typeof data === 'object') scanForItems(data, 0);
            } catch (e) { /* swallow */ }
            return data;
        });
    };

    // 查询接口
    window.addEventListener('message', (e) => {
        if (e.source !== window || !e.data) return;
        if (e.data.type === '__TT_DL_QUERY__') {
            const tid = e.data.awemeId || '';
            let result = null;
            if (tid && videoStore.has(tid)) result = videoStore.get(tid);
            else if (latestId && videoStore.has(latestId)) result = videoStore.get(latestId);
            window.postMessage({
                type: '__TT_DL_QUERY_RESP__',
                data: result,
                storeSize: videoStore.size,
                latestId,
            }, '*');
        }
        if (e.data.type === '__TT_DL_RESCAN__') {
            scanRehydrationData();
        }
    });

    // 扫描页面内嵌数据
    function scanRehydrationData() {
        try {
            const el = document.querySelector('script#__UNIVERSAL_DATA_FOR_REHYDRATION__');
            if (el) {
                const data = _parse(el.textContent);
                if (data) {
                    if (data.__DEFAULT_SCOPE__) scanForItems(data.__DEFAULT_SCOPE__, 0);
                    scanForItems(data, 0);
                }
            }
            const el2 = document.querySelector('script#SIGI_STATE');
            if (el2) {
                const data2 = _parse(el2.textContent);
                if (data2) scanForItems(data2, 0);
            }
            const el3 = document.querySelector('script#__NEXT_DATA__');
            if (el3) {
                const data3 = _parse(el3.textContent);
                if (data3 && data3.props && data3.props.pageProps) {
                    scanForItems(data3.props.pageProps, 0);
                }
            }
        } catch (e) { /* swallow */ }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(scanRehydrationData, 300));
    } else {
        setTimeout(scanRehydrationData, 300);
    }

    // SPA 路由变化 → 重新扫页面内嵌数据
    // hook history API + popstate，替代 setInterval 轮询
    function onRouteChange() {
        setTimeout(scanRehydrationData, 500);
        setTimeout(scanRehydrationData, 1500);
    }
    const _pushState = history.pushState;
    const _replaceState = history.replaceState;
    history.pushState = function () {
        const r = _pushState.apply(this, arguments);
        onRouteChange();
        return r;
    };
    history.replaceState = function () {
        const r = _replaceState.apply(this, arguments);
        onRouteChange();
        return r;
    };
    window.addEventListener('popstate', onRouteChange);

    console.log('[TT-DL] inject.js v2.2.0 loaded');
})();
