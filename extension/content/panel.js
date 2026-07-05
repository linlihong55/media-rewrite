// 悬浮面板 UI，运行在扩展自己的 iframe 里（chrome-extension:// 页面）。
// 抖音页面脚本无法拦截 iframe 内部的键盘 / 鼠标事件，输入框、按钮不再被页面干扰。
// 与 content.js（父页面）通过 postMessage 通信：接收自动识别的视频链接，上报面板尺寸。
const API_BASE = "http://localhost:3300";
const ALLOWED_PAGE_ORIGINS = ["https://www.douyin.com", "https://www.xiaohongshu.com"];
// iframe 的 referrer 就是宿主页面，用它确定往哪个 origin 发消息
let PAGE_ORIGIN = ALLOWED_PAGE_ORIGINS[0];
try {
  const refOrigin = new URL(document.referrer).origin;
  if (ALLOWED_PAGE_ORIGINS.includes(refOrigin)) PAGE_ORIGIN = refOrigin;
} catch {
  // referrer 拿不到时保持默认（抖音）
}

const dotEl = document.getElementById("dot");
const cardEl = document.getElementById("card");
const toggleBtn = document.getElementById("btn-toggle");
const urlInput = document.getElementById("url");
const syncBtn = document.getElementById("btn-sync");
const statusEl = document.getElementById("status");
const infoEl = document.getElementById("info");
const transcriptBox = document.getElementById("transcript");
const rewriteBox = document.getElementById("rewrite");
const confirmBtn = document.getElementById("btn-confirm");
const saveResultEl = document.getElementById("save-result");

let autoUrl = null;
let userEditedUrl = false;
let busy = false;
let currentVideoData = null;
let currentFilePath = null;
let resultsUrl = null; // 当前文案/信息对应的视频链接，用于切视频时清理旧结果

// ---------- 与父页面通信 ----------

window.addEventListener("message", (e) => {
  if (!ALLOWED_PAGE_ORIGINS.includes(e.origin)) return;
  const msg = e.data;
  if (!msg || msg.type !== "dhe:url") return;
  setAutoUrl(typeof msg.url === "string" ? msg.url : null);
});

const appEl = document.getElementById("app");
new ResizeObserver(() => {
  const rect = appEl.getBoundingClientRect();
  window.parent.postMessage(
    { type: "dhe:size", width: Math.ceil(rect.width), height: Math.ceil(rect.height) },
    PAGE_ORIGIN
  );
}).observe(appEl);

window.parent.postMessage({ type: "dhe:ready" }, PAGE_ORIGIN);

function isSupportedVideoUrl(url) {
  return (
    /^https:\/\/www\.douyin\.com\/(video|note)\/\d+/.test(url || "") ||
    /^https:\/\/www\.xiaohongshu\.com\/(explore|discovery\/item|search_result)\/[0-9a-zA-Z]+/.test(
      url || ""
    )
  );
}

function setAutoUrl(url) {
  if (url && !isSupportedVideoUrl(url)) url = null;
  if (url === autoUrl) return;
  autoUrl = url;
  dotEl.classList.toggle("on", Boolean(url));
  dotEl.title = url ? `已识别：${url}` : "未识别到当前视频，可展开后手动粘贴链接";
  if (!userEditedUrl || !urlInput.value.trim()) {
    urlInput.value = url || "";
    userEditedUrl = false;
  }
  // 切到新视频且当前没有进行中的请求时，清掉上一条视频的结果，避免张冠李戴
  if (!busy && resultsUrl && url && resultsUrl !== url) {
    clearResults();
  }
}

function clearResults() {
  transcriptBox.value = "";
  rewriteBox.value = "";
  infoEl.classList.add("hidden");
  confirmBtn.classList.add("hidden");
  statusEl.textContent = "";
  saveResultEl.textContent = "";
  currentVideoData = null;
  currentFilePath = null;
  resultsUrl = null;
}

// ---------- 基础交互 ----------

function setExpanded(expanded) {
  cardEl.classList.toggle("hidden", !expanded);
  toggleBtn.textContent = expanded ? "▴" : "▾";
}

toggleBtn.addEventListener("click", () => {
  setExpanded(cardEl.classList.contains("hidden"));
});

urlInput.addEventListener("input", () => {
  userEditedUrl = true;
});

syncBtn.addEventListener("click", () => {
  urlInput.value = autoUrl || "";
  userEditedUrl = false;
  setStatus(autoUrl ? "已恢复为自动识别的链接" : "当前未自动识别到视频");
});

function setStatus(text) {
  statusEl.textContent = text;
}

function setBusy(value) {
  busy = value;
  for (const id of ["btn-download", "btn-transcribe", "btn-rewrite"]) {
    document.getElementById(id).disabled = value;
  }
}

function formatCount(n) {
  if (n == null) return "未知";
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return String(n);
}

function showVideoInfo(video) {
  currentVideoData = video;
  infoEl.classList.remove("hidden");
  infoEl.textContent = "";
  const lines = [
    `标题：${video.title || "（无）"}`,
    `正文：${video.desc || "（无）"}`,
    `标签：${video.hashtags?.length ? video.hashtags.map((t) => `#${t}`).join(" ") : "（无）"}`,
    `发布时间：${video.publishTime || "未知"}`,
    `账号：${video.author.nickname}　粉丝数：${formatCount(video.author.followerCount)}`,
    `点赞数：${video.stats.diggCount}　收藏数：${video.stats.collectCount}`,
  ];
  if (currentFilePath) lines.push(`视频文件：${currentFilePath}`);
  for (const line of lines) {
    const div = document.createElement("div");
    div.textContent = line;
    infoEl.appendChild(div);
  }
}

async function callApi(path, body) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("无法连接本地服务，请确认已在 server 目录运行 npm run dev（端口 3300）");
  }
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `请求失败（${res.status}）`);
  return json.data;
}

function requireUrl() {
  const url = urlInput.value.trim();
  if (!url) {
    setExpanded(true);
    setStatus("没有识别到视频链接，请在上方输入框手动粘贴");
    return null;
  }
  return url;
}

// ---------- 三个功能按钮 ----------

document.getElementById("btn-download").addEventListener("click", async () => {
  const url = requireUrl();
  if (!url) return;
  setExpanded(true);
  setBusy(true);
  setStatus("下载中...（视频较大可能需要一会儿）");
  try {
    const data = await callApi("/api/download", { url });
    currentFilePath = data.filePath;
    showVideoInfo(data);
    resultsUrl = url;
    setStatus("下载完成");
  } catch (err) {
    setStatus(`下载失败：${err.message}`);
  } finally {
    setBusy(false);
  }
});

document.getElementById("btn-transcribe").addEventListener("click", async () => {
  const url = requireUrl();
  if (!url) return;
  setExpanded(true);
  setBusy(true);
  setStatus("提取中...（下载视频 + 语音转写，可能需要 1-2 分钟）");
  try {
    const data = await callApi("/api/transcribe", { url });
    currentFilePath = data.filePath;
    showVideoInfo(data);
    transcriptBox.value = data.transcript;
    resultsUrl = url;
    setStatus("文案提取完成");
  } catch (err) {
    setStatus(`提取失败：${err.message}`);
  } finally {
    setBusy(false);
  }
});

document.getElementById("btn-rewrite").addEventListener("click", async () => {
  const text = transcriptBox.value.trim();
  setExpanded(true);
  if (!text) return setStatus("请先提取文案，或在「原文案」中手动填写");
  setBusy(true);
  setStatus("改写中...");
  try {
    const data = await callApi("/api/rewrite", { text });
    rewriteBox.value = data.rewritten;
    confirmBtn.classList.remove("hidden");
    setStatus(
      data.skipped
        ? "改写完成（未配置改写服务，暂时原样返回，可手动编辑后确认）"
        : "改写完成，请确认后保存"
    );
  } catch (err) {
    setStatus(`改写失败：${err.message}`);
  } finally {
    setBusy(false);
  }
});

confirmBtn.addEventListener("click", async () => {
  if (!currentVideoData) return setStatus("请先提取文案或下载视频");
  confirmBtn.disabled = true;
  saveResultEl.textContent = "保存中...";
  try {
    const data = await callApi("/api/save", {
      video: currentVideoData,
      transcript: transcriptBox.value,
      rewritten: rewriteBox.value,
    });
    saveResultEl.textContent = `✅ ${data.feishu.message}`;
  } catch (err) {
    saveResultEl.textContent = `保存失败：${err.message}`;
  } finally {
    confirmBtn.disabled = false;
  }
});

// ---------- 批量提取 ----------

const batchBox = document.getElementById("batch-urls");
const batchBtn = document.getElementById("btn-batch");
const batchProgress = document.getElementById("batch-progress");

function shortenUrl(url) {
  return url.length > 46 ? `${url.slice(0, 43)}...` : url;
}

batchBtn.addEventListener("click", async () => {
  const urls = batchBox.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!urls.length) return setStatus("请先在批量输入框中粘贴链接，一行一个");

  batchBtn.disabled = true;
  setBusy(true);
  batchProgress.textContent = "";
  const rows = urls.map((url) => {
    const div = document.createElement("div");
    div.textContent = `⏳ 等待中 ${shortenUrl(url)}`;
    batchProgress.appendChild(div);
    return div;
  });

  let okCount = 0;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    rows[i].textContent = `▶ 提取中（${i + 1}/${urls.length}）${shortenUrl(url)}`;
    setStatus(`批量提取中：第 ${i + 1}/${urls.length} 条（每条需下载 + 转写，请耐心等待）`);
    try {
      const data = await callApi("/api/transcribe", { url });
      await callApi("/api/save", {
        video: data,
        transcript: data.transcript,
        rewritten: "",
      });
      okCount++;
      rows[i].textContent = `✅ ${data.title || shortenUrl(url)}｜已同步飞书`;
    } catch (err) {
      rows[i].textContent = `❌ ${shortenUrl(url)}：${err.message}`;
    }
  }

  setStatus(`批量提取完成：成功 ${okCount}/${urls.length} 条，已同步到飞书多维表格`);
  setBusy(false);
  batchBtn.disabled = false;
});

// ---------- 启动时探测本地服务 ----------

(async () => {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    if (!res.ok) throw new Error();
  } catch {
    setStatus("提示：本地服务（localhost:3300）未启动，功能按钮暂不可用");
  }
})();
