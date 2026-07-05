const API_BASE = "http://localhost:3300";

const urlInput = document.getElementById("url-input");
const statusEl = document.getElementById("status");
const videoInfoEl = document.getElementById("video-info");
const infoTitle = document.getElementById("info-title");
const infoDesc = document.getElementById("info-desc");
const infoTags = document.getElementById("info-tags");
const infoPublish = document.getElementById("info-publish");
const infoAuthor = document.getElementById("info-author");
const infoFollower = document.getElementById("info-follower");
const infoDigg = document.getElementById("info-digg");
const infoCollect = document.getElementById("info-collect");
const infoFile = document.getElementById("info-file");
const transcriptBox = document.getElementById("transcript-box");
const rewriteBox = document.getElementById("rewrite-box");
const confirmBtn = document.getElementById("btn-confirm-save");
const saveResultEl = document.getElementById("save-result");

let currentVideo = null;
let currentFilePath = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function setButtonsDisabled(disabled) {
  for (const id of ["btn-download", "btn-transcribe", "btn-rewrite"]) {
    document.getElementById(id).disabled = disabled;
  }
}

function formatCount(n) {
  if (n == null) return "未知";
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return String(n);
}

function showVideoInfo(video) {
  currentVideo = video;
  videoInfoEl.classList.remove("hidden");
  infoTitle.textContent = video.title || "（无）";
  infoDesc.textContent = video.desc || "（无）";
  infoTags.textContent = video.hashtags?.length
    ? video.hashtags.map((t) => `#${t}`).join(" ")
    : "（无）";
  infoPublish.textContent = video.publishTime || "未知";
  infoAuthor.textContent = `${video.author.nickname}（${video.author.profileUrl}）`;
  infoFollower.textContent = formatCount(video.author.followerCount);
  infoDigg.textContent = video.stats.diggCount;
  infoCollect.textContent = video.stats.collectCount;
  if (currentFilePath) {
    infoFile.textContent = currentFilePath;
  }
}

async function callApi(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error || `请求失败（${res.status}）`);
  }
  return json.data;
}

document.getElementById("btn-download").addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) return setStatus("请先粘贴抖音/小红书链接");
  setButtonsDisabled(true);
  setStatus("下载中...（视频较大可能需要一会儿）");
  try {
    const data = await callApi("/api/download", { url });
    currentFilePath = data.filePath;
    showVideoInfo(data);
    setStatus("下载完成");
  } catch (err) {
    setStatus(`下载失败：${err.message}`);
  } finally {
    setButtonsDisabled(false);
  }
});

document.getElementById("btn-transcribe").addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) return setStatus("请先粘贴抖音/小红书链接");
  setButtonsDisabled(true);
  setStatus("提取中...（下载视频 + 语音转写，可能需要 1-2 分钟）");
  try {
    const data = await callApi("/api/transcribe", { url });
    currentFilePath = data.filePath;
    showVideoInfo(data);
    transcriptBox.value = data.transcript;
    setStatus("文案提取完成");
  } catch (err) {
    setStatus(`提取失败：${err.message}`);
  } finally {
    setButtonsDisabled(false);
  }
});

document.getElementById("btn-rewrite").addEventListener("click", async () => {
  const text = transcriptBox.value.trim();
  if (!text) return setStatus("请先提取文案，或手动填写原文案");
  setButtonsDisabled(true);
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
    setButtonsDisabled(false);
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
  setButtonsDisabled(true);
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
  setButtonsDisabled(false);
  batchBtn.disabled = false;
});

confirmBtn.addEventListener("click", async () => {
  if (!currentVideo) return setStatus("请先提取文案或下载视频");
  confirmBtn.disabled = true;
  saveResultEl.textContent = "保存中...";
  try {
    const data = await callApi("/api/save", {
      video: currentVideo,
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
