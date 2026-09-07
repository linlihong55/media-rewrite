// 悬浮面板 UI，运行在扩展自己的 iframe 里（chrome-extension:// 页面）。
// 抖音页面脚本无法拦截 iframe 内部的键盘 / 鼠标事件，输入框、按钮不再被页面干扰。
// 与 content.js（父页面）通过 postMessage 通信：接收自动识别的视频链接，上报面板尺寸。
const API_BASE = "http://localhost:3300";
// 抖音/小红书都设了 referrer 策略，iframe 里拿不到宿主 origin。
// 面板 → 宿主页只发「就绪 / 尺寸」两种无敏感内容的消息，目标用 "*"；
// 宿主页 → 面板的视频链接消息仍严格校验来源 origin（白名单如下）。
const ALLOWED_PAGE_ORIGINS = ["https://www.douyin.com", "https://www.xiaohongshu.com"];

const dotEl = document.getElementById("dot");
const cardEl = document.getElementById("card");
const toggleBtn = document.getElementById("btn-toggle");
const urlInput = document.getElementById("url");
const syncBtn = document.getElementById("btn-sync");
const statusEl = document.getElementById("status");
const infoEl = document.getElementById("info");
const transcriptBox = document.getElementById("transcript");
const rewriteBox = document.getElementById("rewrite");
const breakdownBox = document.getElementById("breakdown");
const confirmBtn = document.getElementById("btn-confirm");
const saveResultEl = document.getElementById("save-result");
const taskListEl = document.getElementById("task-list");
const downloadBtn = document.getElementById("btn-download");
const transcribeBtn = document.getElementById("btn-transcribe");
const rewriteBtn = document.getElementById("btn-rewrite");
const breakdownBtn = document.getElementById("btn-breakdown");
const barEl = document.getElementById("bar");

let autoUrl = null;
let userEditedUrl = false;
let activeUrl = null;
const tasks = new Map();

const OPERATION_LABELS = {
  download: "下载",
  transcribe: "提取",
  rewrite: "改写",
  breakdown: "拆解",
  save: "保存",
};

// ---------- 与父页面通信 ----------

window.addEventListener("message", (e) => {
  if (!ALLOWED_PAGE_ORIGINS.includes(e.origin)) return;
  const msg = e.data;
  if (!msg || msg.type !== "dhe:url") return;
  setAutoUrl(typeof msg.url === "string" ? msg.url : null);
});

const appEl = document.getElementById("app");
function reportPanelSize() {
  const cardVisible = !cardEl.classList.contains("hidden");
  const cardMarginTop = cardVisible ? Number.parseFloat(getComputedStyle(cardEl).marginTop) || 0 : 0;
  const width = Math.max(barEl.scrollWidth, cardVisible ? cardEl.scrollWidth : 0);
  const height = barEl.offsetHeight + (cardVisible ? cardMarginTop + cardEl.scrollHeight : 0);
  window.parent.postMessage(
    { type: "dhe:size", width: Math.ceil(width), height: Math.ceil(height) },
    "*"
  );
}

const panelResizeObserver = new ResizeObserver(reportPanelSize);
panelResizeObserver.observe(appEl);
panelResizeObserver.observe(cardEl);

window.parent.postMessage({ type: "dhe:ready" }, "*");

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
    activateUrl(url, false);
  }
}

function clearResults() {
  transcriptBox.value = "";
  rewriteBox.value = "";
  breakdownBox.value = "";
  infoEl.classList.add("hidden");
  confirmBtn.classList.add("hidden");
  statusEl.textContent = "";
  saveResultEl.textContent = "";
  updateActionButtons(null);
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

urlInput.addEventListener("change", () => {
  activateUrl(urlInput.value.trim() || null, true);
});

syncBtn.addEventListener("click", () => {
  activateUrl(autoUrl, false);
  setStatus(autoUrl ? "已恢复为自动识别的链接" : "当前未自动识别到视频");
});

function setStatus(text) {
  statusEl.textContent = text;
}

function formatCount(n) {
  if (n == null) return "未知";
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return String(n);
}

function showVideoInfo(video, filePath) {
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
  if (filePath) lines.push(`视频文件：${filePath}`);
  for (const line of lines) {
    const div = document.createElement("div");
    div.textContent = line;
    infoEl.appendChild(div);
  }
}

function createTask(url) {
  return {
    url,
    title: "",
    videoData: null,
    filePath: null,
    transcript: "",
    rewritten: "",
    breakdown: "",
    message: "等待执行",
    saveResult: "",
    operations: {
      download: "idle",
      transcribe: "idle",
      rewrite: "idle",
      breakdown: "idle",
      save: "idle",
    },
  };
}

function ensureTask(url) {
  let task = tasks.get(url);
  if (!task) {
    task = createTask(url);
    tasks.set(url, task);
    renderTaskList();
  }
  return task;
}

function getActiveTask() {
  return activeUrl ? tasks.get(activeUrl) ?? null : null;
}

function saveActiveInputs() {
  const task = getActiveTask();
  if (!task) return;
  task.transcript = transcriptBox.value;
  task.rewritten = rewriteBox.value;
}

function activateUrl(url, manual) {
  saveActiveInputs();
  activeUrl = url;
  userEditedUrl = manual;
  urlInput.value = url || "";
  renderActiveTask();
  renderTaskList();
}

function renderActiveTask() {
  const task = getActiveTask();
  if (!task) {
    clearResults();
    return;
  }

  transcriptBox.value = task.transcript;
  rewriteBox.value = task.rewritten;
  breakdownBox.value = task.breakdown;
  const stage = getTaskStage(task);
  statusEl.textContent = stage.state === "running" ? `${stage.text}...` : task.message;
  saveResultEl.textContent = task.saveResult;
  if (task.videoData) showVideoInfo(task.videoData, task.filePath);
  else infoEl.classList.add("hidden");
  confirmBtn.classList.toggle(
    "hidden",
    task.operations.transcribe !== "done" && task.operations.rewrite !== "done"
  );
  updateActionButtons(task);
}

function updateActionButtons(task) {
  const operations = task?.operations;
  const mediaRunning =
    operations?.download === "running" || operations?.transcribe === "running";
  downloadBtn.disabled = Boolean(mediaRunning);
  transcribeBtn.disabled = Boolean(mediaRunning);
  rewriteBtn.disabled = operations?.rewrite === "running";
  breakdownBtn.disabled = operations?.breakdown === "running";
  confirmBtn.disabled = operations?.save === "running";
}

function getTaskStage(task) {
  const running = Object.entries(task.operations)
    .filter(([, state]) => state === "running")
    .map(([name]) => OPERATION_LABELS[name]);
  if (running.length) return { text: `${running.join("、")}中`, state: "running" };

  const failed = Object.entries(task.operations)
    .filter(([, state]) => state === "failed")
    .map(([name]) => OPERATION_LABELS[name]);
  if (failed.length) return { text: `${failed.at(-1)}失败`, state: "failed" };
  if (task.operations.save === "done") return { text: "已保存", state: "done" };
  if (task.operations.breakdown === "done") return { text: "拆解完成", state: "done" };
  if (task.operations.rewrite === "done") return { text: "改写完成", state: "done" };
  if (task.operations.transcribe === "done") return { text: "提取完成", state: "done" };
  if (task.operations.download === "done") return { text: "下载完成", state: "done" };
  return { text: "等待执行", state: "idle" };
}

function getTaskName(task) {
  if (task.title) return task.title;
  const id = task.url.match(/\/(?:video|note|explore|item|search_result)\/([0-9a-zA-Z]+)/)?.[1];
  return id ? `视频 ${id}` : task.url;
}

function renderTaskList() {
  taskListEl.textContent = "";
  if (!tasks.size) {
    const empty = document.createElement("div");
    empty.className = "task-empty";
    empty.textContent = "暂无任务";
    taskListEl.appendChild(empty);
    return;
  }

  for (const task of Array.from(tasks.values()).reverse()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `task-item${task.url === activeUrl ? " active" : ""}`;
    button.title = task.url;

    const name = document.createElement("span");
    name.className = "task-name";
    name.textContent = getTaskName(task);

    const stage = getTaskStage(task);
    const status = document.createElement("span");
    status.className = `task-stage ${stage.state}`;
    status.textContent = stage.text;

    button.append(name, status);
    button.addEventListener("click", () => {
      activateUrl(task.url, true);
      setExpanded(true);
    });
    taskListEl.appendChild(button);
  }
}

function refreshTask(task) {
  if (task.url === activeUrl) renderActiveTask();
  renderTaskList();
}

function startOperation(task, operation, message) {
  if (task.operations[operation] === "running") return false;
  task.operations[operation] = "running";
  task.message = message;
  refreshTask(task);
  return true;
}

function finishOperation(task, operation, message, failed = false) {
  task.operations[operation] = failed ? "failed" : "done";
  task.message = message;
  refreshTask(task);
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
  const raw = await res.text();
  let json;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`本地服务返回了非 JSON 响应（HTTP ${res.status}），请查看 server 终端日志`);
  }
  if (!res.ok) throw new Error(json?.error || `请求失败（HTTP ${res.status}）`);
  if (!json) throw new Error(`本地服务返回了空响应（HTTP ${res.status}），请查看 server 终端日志`);
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

function requireTask() {
  const url = requireUrl();
  if (!url) return null;
  if (url !== activeUrl) activateUrl(url, true);
  return ensureTask(url);
}

function formatSaveResult(data) {
  return data.feishu?.synced
    ? "✅ 已保存到本地工作台，并同步到飞书"
    : `⚠️ 已保存到本地工作台；${data.feishu?.message || "飞书未同步"}`;
}

// ---------- 三个功能按钮 ----------

downloadBtn.addEventListener("click", async () => {
  const task = requireTask();
  if (!task || !startOperation(task, "download", "下载中...（视频较大可能需要一会儿）")) return;
  setExpanded(true);
  try {
    const data = await callApi("/api/download", { url: task.url });
    task.filePath = data.filePath;
    task.videoData = data;
    task.title = data.title || task.title;
    finishOperation(task, "download", "下载完成");
  } catch (err) {
    finishOperation(task, "download", `下载失败：${err.message}`, true);
  }
});

transcribeBtn.addEventListener("click", async () => {
  const task = requireTask();
  if (
    !task ||
    !startOperation(task, "transcribe", "提取中...（下载视频 + 语音转写，可能需要 1-2 分钟）")
  ) return;
  setExpanded(true);
  try {
    const data = await callApi("/api/transcribe", { url: task.url });
    task.filePath = data.filePath;
    task.videoData = data;
    task.title = data.title || task.title;
    task.transcript = data.transcript;
    finishOperation(task, "transcribe", "文案提取完成，可直接确认并保存");
  } catch (err) {
    finishOperation(task, "transcribe", `提取失败：${err.message}`, true);
  }
});

rewriteBtn.addEventListener("click", async () => {
  const task = requireTask();
  if (!task) return;
  saveActiveInputs();
  const text = task.transcript.trim();
  setExpanded(true);
  if (!text) {
    task.message = "请先提取文案，或在「原文案」中手动填写";
    return refreshTask(task);
  }
  if (!startOperation(task, "rewrite", "改写中...")) return;
  try {
    const data = await callApi("/api/rewrite", { text });
    task.rewritten = data.rewritten;
    finishOperation(
      task,
      "rewrite",
      data.skipped
        ? "改写完成（未配置改写服务，暂时原样返回，可手动编辑后确认）"
        : "改写完成，请确认后保存"
    );
  } catch (err) {
    finishOperation(task, "rewrite", `改写失败：${err.message}`, true);
  }
});

breakdownBtn.addEventListener("click", async () => {
  const task = requireTask();
  if (!task) return;
  saveActiveInputs();
  const text = task.transcript.trim();
  setExpanded(true);
  if (!text) {
    task.message = "请先提取文案，或在「原文案」中手动填写";
    return refreshTask(task);
  }
  if (!task.videoData) {
    task.message = "请先提取文案（需要视频信息才能拆解存档）";
    return refreshTask(task);
  }
  if (!startOperation(task, "breakdown", "拆解中...")) return;
  try {
    const data = await callApi("/api/breakdown", { video: task.videoData, transcript: text });
    task.breakdown = data.breakdown;
    finishOperation(task, "breakdown", `拆解完成，已存档至 ${data.filePath}`);
  } catch (err) {
    finishOperation(task, "breakdown", `拆解失败：${err.message}`, true);
  }
});

confirmBtn.addEventListener("click", async () => {
  const task = requireTask();
  if (!task) return;
  saveActiveInputs();
  if (!task.videoData) {
    task.message = "请先提取文案或下载视频";
    return refreshTask(task);
  }
  if (!startOperation(task, "save", "保存中...")) return;
  task.saveResult = "保存中...";
  refreshTask(task);
  try {
    const data = await callApi("/api/save", {
      video: task.videoData,
      transcript: task.transcript,
      rewritten: task.rewritten,
    });
    task.saveResult = formatSaveResult(data);
    finishOperation(task, "save", task.saveResult);
  } catch (err) {
    task.saveResult = `保存失败：${err.message}`;
    finishOperation(task, "save", task.saveResult, true);
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
  batchProgress.textContent = "";
  const rows = urls.map((url) => {
    const div = document.createElement("div");
    div.textContent = `⏳ 等待中 ${shortenUrl(url)}`;
    batchProgress.appendChild(div);
    return div;
  });

  let okCount = 0;
  let feishuCount = 0;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    rows[i].textContent = `▶ 提取中（${i + 1}/${urls.length}）${shortenUrl(url)}`;
    setStatus(`批量提取中：第 ${i + 1}/${urls.length} 条（每条需下载 + 转写，请耐心等待）`);
    try {
      const data = await callApi("/api/transcribe", { url });
      const saved = await callApi("/api/save", {
        video: data,
        transcript: data.transcript,
        rewritten: "",
      });
      okCount++;
      if (saved.feishu?.synced) feishuCount++;
      rows[i].textContent = `✅ ${data.title || shortenUrl(url)}｜已保存本地${
        saved.feishu?.synced ? "并同步飞书" : "（飞书未同步）"
      }`;
    } catch (err) {
      rows[i].textContent = `❌ ${shortenUrl(url)}：${err.message}`;
    }
  }

  setStatus(`批量提取完成：本地保存 ${okCount}/${urls.length} 条，飞书同步 ${feishuCount}/${urls.length} 条`);
  batchBtn.disabled = false;
});

// ---------- 启动时探测本地服务 ----------

renderTaskList();

(async () => {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    const health = await res.json().catch(() => null);
    if (!res.ok && health?.database === false) {
      setStatus("提示：本地服务已启动，但数据库未就绪；保存和工作台暂不可用");
      return;
    }
    if (!res.ok) throw new Error();
  } catch {
    setStatus("提示：本地服务（localhost:3300）未启动，功能按钮暂不可用");
  }
})();
