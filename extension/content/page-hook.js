// 运行在页面的 MAIN world（和抖音页面本身共享 window），用于兜底抓取
// 抖音内部接口返回的视频列表数据（aweme_id），作为 DOM 识别失败时的备用信号。
// 通过 document 派发自定义事件，传给 content.js（ISOLATED world）使用。
(() => {
  const EVENT_NAME = "__douyin_hit_extractor_aweme__";
  const API_HINT = /\/aweme\/v1\/web\/(tab\/feed|aweme\/(detail|post))/;

  function emit(awemeList) {
    if (!awemeList || !awemeList.length) return;
    const infos = [];
    for (const item of awemeList) {
      const aweme = item && (item.aweme_id ? item : item.aweme);
      const id = aweme && aweme.aweme_id;
      if (!id) continue;
      const author = aweme.author || {};
      infos.push({
        id,
        nickname: author.nickname || "",
        followerCount:
          typeof author.follower_count === "number" ? author.follower_count : null,
      });
    }
    if (!infos.length) return;
    document.dispatchEvent(
      new CustomEvent(EVENT_NAME, { detail: { ids: infos.map((i) => i.id), infos } })
    );
  }

  function tryParseAndEmit(text) {
    try {
      const json = JSON.parse(text);
      const list = json.aweme_list || (json.aweme_detail ? [json.aweme_detail] : null);
      if (list) emit(list);
    } catch {
      // 忽略非 JSON 或结构不符的响应
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (url && API_HINT.test(url)) {
        res
          .clone()
          .text()
          .then(tryParseAndEmit)
          .catch(() => {});
      }
    } catch {
      // 不影响原始请求
    }
    return res;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__douyinHitUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__douyinHitUrl && API_HINT.test(this.__douyinHitUrl)) {
      this.addEventListener("loadend", () => {
        if (typeof this.responseText === "string") {
          tryParseAndEmit(this.responseText);
        }
      });
    }
    return originalSend.apply(this, args);
  };
})();
