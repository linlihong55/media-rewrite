// 注入抖音 / 小红书网页的内容脚本：负责识别当前正在播放的视频、把悬浮面板（扩展 iframe）
// 定位到视频旁边，并通过 postMessage 把识别到的链接同步给面板。
// UI 与交互全部在 iframe（content/panel.html）内完成，页面脚本无法干扰其中的输入框和按钮。
(() => {
  const IS_XHS = location.hostname.endsWith("xiaohongshu.com");
  const LOG_PREFIX = IS_XHS ? "[小红书爆款提取]" : "[抖音爆款提取]";
  const SNIFF_EVENT = "__douyin_hit_extractor_aweme__";
  const API_BASE = "http://localhost:3300";
  const PANEL_ORIGIN = new URL(chrome.runtime.getURL("")).origin;

  // ---------- 视频识别 ----------

  const sniffedQueue = [];
  const containerAwemeMap = new WeakMap();
  // aweme_id -> { nickname, followerCount }，来自 page-hook 嗅探或 /api/resolve 兜底
  const authorInfoMap = new Map();
  let sniffedGuessIndex = 0;

  document.addEventListener(SNIFF_EVENT, (e) => {
    const ids = e.detail?.ids || [];
    for (const id of ids) {
      if (sniffedQueue[sniffedQueue.length - 1] !== id) {
        sniffedQueue.push(id);
      }
    }
    for (const info of e.detail?.infos || []) {
      if (info?.id && typeof info.followerCount === "number") {
        authorInfoMap.set(String(info.id), {
          nickname: info.nickname || "",
          followerCount: info.followerCount,
        });
      }
    }
  });

  function extractIdFromHref(href) {
    if (!href) return null;
    let m = href.match(/\/(?:video|note)\/(\d{5,20})/);
    if (m) return m[1];
    m = href.match(/[?&]modal_id=(\d{5,20})/);
    if (m) return m[1];
    return null;
  }

  function extractIdFromLocation() {
    return extractIdFromHref(location.pathname) || extractIdFromHref(location.search);
  }

  function extractIdFromContainer(container) {
    if (!container) return null;
    let node = container;
    for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
      if (node.getAttribute) {
        const id = extractIdFromHref(node.getAttribute("href"));
        if (id) return id;
      }
    }
    const anchors = container.querySelectorAll ? container.querySelectorAll("a[href]") : [];
    for (const a of anchors) {
      const id = extractIdFromHref(a.getAttribute("href"));
      if (id) return id;
    }
    return null;
  }

  function findActiveVideoEl() {
    const marked = document.querySelector('[data-e2e="feed-active-video"] video');
    if (marked) return marked;

    const videos = Array.from(document.querySelectorAll("video"));
    let best = null;
    let bestScore = -1;
    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      const visibleW = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
      const visibleH = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      const area = visibleW * visibleH;
      if (area <= 0) continue;
      const score = area + (!v.paused ? 1e9 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  function findActiveContainer(videoEl) {
    const marked = document.querySelector('[data-e2e="feed-active-video"]');
    if (marked) return marked;
    if (!videoEl) return null;
    let el = videoEl;
    for (let i = 0; i < 6 && el.parentElement; i++) el = el.parentElement;
    return el;
  }

  // ---------- 小红书识别 ----------
  // 笔记链接必须保留 xsec_token 查询参数（服务端解析要用），所以返回完整 URL 而不是纯 ID

  function extractXhsUrlFromHref(href) {
    if (!href) return null;
    const m = href.match(/\/(?:explore|discovery\/item|search_result)\/([0-9a-zA-Z]{15,32})/);
    if (!m) return null;
    try {
      const from = new URL(href, location.origin);
      const url = new URL(`https://www.xiaohongshu.com/explore/${m[1]}`);
      const token = from.searchParams.get("xsec_token");
      if (token) {
        url.searchParams.set("xsec_token", token);
        url.searchParams.set("xsec_source", from.searchParams.get("xsec_source") || "pc_feed");
      }
      return url.href;
    } catch {
      return null;
    }
  }

  function resolveCurrentXhsVideo() {
    const videoEl = findActiveVideoEl();
    // 笔记详情页 / 弹层：地址栏里就是带 xsec_token 的完整链接
    const fromLocation = extractXhsUrlFromHref(location.pathname + location.search);
    if (fromLocation) return { url: fromLocation, source: "location", videoEl };

    // 信息流里正在播放的卡片：从 video 往上找带笔记链接的 <a>
    let node = videoEl;
    for (let i = 0; i < 10 && node; i++, node = node.parentElement) {
      if (node.getAttribute) {
        const url = extractXhsUrlFromHref(node.getAttribute("href"));
        if (url) return { url, source: "dom", videoEl };
      }
    }
    const container = findActiveContainer(videoEl);
    const anchors = container?.querySelectorAll ? container.querySelectorAll("a[href]") : [];
    for (const a of anchors) {
      const url = extractXhsUrlFromHref(a.getAttribute("href"));
      if (url) return { url, source: "dom", videoEl };
    }
    return { url: null, source: "none", videoEl };
  }

  function resolveCurrentVideo() {
    if (IS_XHS) return resolveCurrentXhsVideo();
    const fromLocation = extractIdFromLocation();
    if (fromLocation) {
      return { url: `https://www.douyin.com/video/${fromLocation}`, source: "location" };
    }

    const videoEl = findActiveVideoEl();
    const container = findActiveContainer(videoEl);

    const cached = containerAwemeMap.get(container);
    if (cached) return { url: `https://www.douyin.com/video/${cached}`, source: "cache", videoEl };

    const fromContainer = extractIdFromContainer(container);
    if (fromContainer) {
      containerAwemeMap.set(container, fromContainer);
      return { url: `https://www.douyin.com/video/${fromContainer}`, source: "dom", videoEl };
    }

    if (container && sniffedGuessIndex < sniffedQueue.length) {
      const guess = sniffedQueue[sniffedGuessIndex];
      sniffedGuessIndex++;
      containerAwemeMap.set(container, guess);
      return { url: `https://www.douyin.com/video/${guess}`, source: "sniff-guess", videoEl };
    }

    return { url: null, source: "none", videoEl };
  }

  // ---------- 悬浮面板（扩展 iframe） ----------

  const iframe = document.createElement("iframe");
  iframe.id = "dhe-frame";
  iframe.src = chrome.runtime.getURL("content/panel.html");
  iframe.setAttribute("allowtransparency", "true");
  document.documentElement.appendChild(iframe);

  let frameReady = false;
  let frameWidth = 300;
  let frameContentHeight = 44;
  let lastAutoUrl = null;

  window.addEventListener("message", (e) => {
    if (e.source !== iframe.contentWindow || e.origin !== PANEL_ORIGIN) return;
    const msg = e.data;
    if (!msg) return;
    if (msg.type === "dhe:size") {
      frameWidth = msg.width;
      frameContentHeight = msg.height;
      iframe.style.width = `${msg.width}px`;
      positionPanel(findActiveVideoEl());
    } else if (msg.type === "dhe:ready") {
      frameReady = true;
      lastAutoUrl = null; // 强制重发一次当前识别结果
      tick();
    }
  });

  function pushUrl(url) {
    if (!frameReady || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage({ type: "dhe:url", url }, PANEL_ORIGIN);
  }

  // ---------- 悬停显示博主粉丝数 ----------

  const fansTip = document.createElement("div");
  fansTip.id = "dhe-fans";
  fansTip.classList.add("dhe-fans-hidden");
  document.documentElement.appendChild(fansTip);

  let hoverToken = 0; // 悬停目标切换后，作废之前未完成的查询

  function formatCount(n) {
    if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
    if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
    return String(n);
  }

  function showFansTip(rectEl, info) {
    const rect = rectEl.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    fansTip.textContent = info.followerCount == null
      ? "粉丝数查询中..."
      : `${info.nickname ? `@${info.nickname} · ` : ""}粉丝 ${formatCount(info.followerCount)}`;
    fansTip.classList.remove("dhe-fans-hidden");
    const top = Math.min(rect.bottom + 6, window.innerHeight - 34);
    const left = Math.min(Math.max(12, rect.left + 8), window.innerWidth - fansTip.offsetWidth - 12);
    fansTip.style.top = `${top}px`;
    fansTip.style.left = `${left}px`;
  }

  function hideFansTip() {
    hoverToken++;
    fansTip.classList.add("dhe-fans-hidden");
  }

  async function fetchAuthorInfo(videoId) {
    const cached = authorInfoMap.get(videoId);
    if (cached) return cached;
    const res = await fetch(`${API_BASE}/api/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `https://www.douyin.com/video/${videoId}` }),
    });
    const json = await res.json();
    if (!res.ok || !json.data) throw new Error(json.error || "解析失败");
    const info = {
      nickname: json.data.author?.nickname || "",
      followerCount: json.data.author?.followerCount ?? null,
    };
    if (info.followerCount != null) authorInfoMap.set(videoId, info);
    return info;
  }

  // 找到鼠标悬停对应的视频：优先卡片链接（feed 缩略图、用户主页网格），
  // 其次是正在播放的视频区域
  function resolveHoverTarget(target, x, y) {
    let node = target;
    for (let i = 0; i < 10 && node && node.getAttribute; i++, node = node.parentElement) {
      if (node.tagName === "A") {
        const id = extractIdFromHref(node.getAttribute("href"));
        if (id) return { id, rectEl: node };
      }
    }
    const videoEl = findActiveVideoEl();
    if (videoEl) {
      const rect = videoEl.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        const { url } = resolveCurrentVideo();
        const id = extractIdFromHref(url || "");
        if (id) return { id, rectEl: videoEl };
      }
    }
    return null;
  }

  let hoverDebounce = null;
  let lastHoverId = null;

  document.addEventListener("mouseover", (e) => {
    // 小红书笔记页数据里没有粉丝数，且逐条解析代价高，悬停浮层只在抖音开启
    if (IS_XHS) return;
    if (e.target === iframe || e.target === fansTip) return;
    clearTimeout(hoverDebounce);
    hoverDebounce = setTimeout(async () => {
      const hit = resolveHoverTarget(e.target, e.clientX, e.clientY);
      if (!hit) {
        lastHoverId = null;
        hideFansTip();
        return;
      }
      if (hit.id === lastHoverId && !fansTip.classList.contains("dhe-fans-hidden")) {
        return; // 同一个视频且浮层已显示，不重复查询
      }
      lastHoverId = hit.id;
      const token = ++hoverToken;
      const cached = authorInfoMap.get(hit.id);
      if (cached) {
        showFansTip(hit.rectEl, cached);
        return;
      }
      showFansTip(hit.rectEl, { followerCount: null });
      try {
        const info = await fetchAuthorInfo(hit.id);
        if (token !== hoverToken) return; // 悬停目标已变，丢弃结果
        if (info.followerCount == null) return hideFansTip();
        showFansTip(hit.rectEl, info);
      } catch {
        if (token === hoverToken) hideFansTip();
      }
    }, 200);
  });

  // 鼠标离开页面时隐藏（mouseleave 不冒泡，document 上只会收到离开文档本身）
  document.addEventListener("mouseleave", () => {
    clearTimeout(hoverDebounce);
    lastHoverId = null;
    hideFansTip();
  });

  // ---------- 定位与轮询识别 ----------

  function positionPanel(videoEl) {
    if (videoEl) {
      const rect = videoEl.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) {
        const top = Math.min(Math.max(12, rect.top + 12), Math.max(12, window.innerHeight - 56));
        const left = Math.min(window.innerWidth - frameWidth - 12, rect.right - frameWidth - 12);
        iframe.style.top = `${top}px`;
        iframe.style.left = `${Math.max(12, left)}px`;
      }
    }

    const currentTop = Number.parseFloat(iframe.style.top) || 12;
    const availableHeight = Math.max(44, window.innerHeight - currentTop - 12);
    iframe.style.height = `${Math.min(frameContentHeight, availableHeight)}px`;
  }

  function ensureFrameAttached() {
    // 抖音是 SPA，重渲染时可能把我们插入的节点移除，检查后重新挂载
    if (!document.documentElement.contains(iframe)) {
      document.documentElement.appendChild(iframe);
    }
  }

  function tick() {
    ensureFrameAttached();
    const result = resolveCurrentVideo();
    if (result.url !== lastAutoUrl) {
      lastAutoUrl = result.url;
      console.debug(`${LOG_PREFIX} 识别结果`, result);
      pushUrl(result.url);
    }
    if (result.videoEl) positionPanel(result.videoEl);
  }

  setInterval(tick, 1000);
  window.addEventListener(
    "scroll",
    () => {
      hideFansTip();
      const videoEl = findActiveVideoEl();
      if (videoEl) positionPanel(videoEl);
    },
    true
  );
  window.addEventListener("resize", () => {
    const videoEl = findActiveVideoEl();
    if (videoEl) positionPanel(videoEl);
  });

  tick();
})();
