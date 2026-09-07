"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./page.module.css";

type Candidate = {
  id: string;
  platform: string;
  title: string;
  author_name: string;
  digg_count: string;
  collect_count: string | null;
  score: string | null;
  recommendation: { level?: string };
  l2: string;
  l3: string;
  source_url: string;
  feishu_sync_status: string;
  promoted: boolean;
};
type Item = {
  id: string;
  title: string;
  final_script: string;
  status: string;
  priority: string;
  platform?: string;
  score?: string;
  post_url?: string;
};
type Data = { summary: Record<string, number>; candidates: Candidate[]; items: Item[] };

const columns = [
  ["selected", "已选题"],
  ["writing", "创作中"],
  ["filming", "待拍摄"],
  ["editing", "待剪辑"],
  ["review", "待审核"],
  ["ready", "待发布"],
  ["published", "已发布"],
  ["retrospective", "待复盘"],
  ["completed", "已完成"],
  ["shelved", "已搁置"],
] as const;

const fmt = (n: string | null) =>
  n == null ? "—" : Intl.NumberFormat("zh-CN", { notation: "compact" }).format(Number(n));

async function responseJson<T>(response: Response): Promise<T> {
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || `请求失败（HTTP ${response.status}）`);
  return json.data as T;
}

export default function Home() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [tab, setTab] = useState<"candidates" | "board">("candidates");
  const [busy, setBusy] = useState("");
  const [metricsFor, setMetricsFor] = useState<Item | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/workspace");
      setData(await responseJson<Data>(response));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const counts = useMemo(
    () => ({
      candidates: data?.candidates.length ?? 0,
      active: data?.items.filter((x) => !["completed", "shelved"].includes(x.status)).length ?? 0,
      ready: data?.summary.ready ?? 0,
      review: data?.summary.retrospective ?? 0,
    }),
    [data]
  );

  async function promote(id: string) {
    setBusy(id);
    setOperationError("");
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: Number(id) }),
      });
      await responseJson(response);
      await load();
      setTab("board");
    } catch (err) {
      setOperationError(err instanceof Error ? err.message : "转为选题失败");
    } finally {
      setBusy("");
    }
  }

  async function move(id: string, status: string) {
    setBusy(id);
    setOperationError("");
    try {
      const response = await fetch(`/api/content/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      await responseJson(response);
      await load();
    } catch (err) {
      setOperationError(err instanceof Error ? err.message : "状态更新失败");
    } finally {
      setBusy("");
    }
  }

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span>爆</span>
          <div>
            AI 内容工作台<small>CREATOR OS</small>
          </div>
        </div>
        <nav>
          <button className={tab === "candidates" ? styles.active : ""} onClick={() => setTab("candidates")}>
            趋势候选
          </button>
          <button className={tab === "board" ? styles.active : ""} onClick={() => setTab("board")}>
            创作看板
          </button>
        </nav>
        <div className={styles.audience}>
          内容定位<strong>AI 转行 · 实用教程</strong><small>让普通人真正用上 AI</small>
        </div>
      </aside>

      <section className={styles.main}>
        <header>
          <div>
            <p>阶段 A · 增长闭环</p>
            <h1>{tab === "candidates" ? "今天，跟进哪条内容？" : "从选题到复盘，一处完成"}</h1>
          </div>
          <button className={styles.refresh} onClick={load}>刷新数据</button>
        </header>

        <div className={styles.stats}>
          <Stat label="高潜候选" value={counts.candidates} />
          <Stat label="进行中" value={counts.active} />
          <Stat label="待发布" value={counts.ready} />
          <Stat label="待复盘" value={counts.review} />
        </div>

        {error && (
          <div className={styles.error}>
            <strong>工作台暂不可用</strong><span>{error}</span>
            <code>npm run db:up &amp;&amp; npm run db:migrate</code>
          </div>
        )}
        {operationError && <div className={styles.error}>{operationError}</div>}

        {!error && tab === "candidates" && (
          <div className={styles.panel}>
            <div className={styles.panelHead}><div><h2>爆款候选雷达</h2><p>评分偏重账号匹配度与收藏价值</p></div></div>
            <div className={styles.table}>
              <div className={`${styles.row} ${styles.tableHead}`}><span>内容</span><span>信号</span><span>评分</span><span>操作</span></div>
              {data?.candidates.map((candidate) => (
                <div className={styles.row} key={candidate.id}>
                  <span><b>{candidate.title || "未命名内容"}</b><small>{candidate.platform === "douyin" ? "抖音" : "小红书"} · {candidate.author_name} · {candidate.l3}</small></span>
                  <span><b>{fmt(candidate.digg_count)} 赞</b><small>{fmt(candidate.collect_count)} 收藏 · 飞书 {candidate.feishu_sync_status}</small></span>
                  <span><i className={styles.score}>{candidate.score ?? "—"}</i><small>{candidate.recommendation?.level ?? "待评估"}</small></span>
                  <span className={styles.actions}>
                    <a href={candidate.source_url} target="_blank" rel="noreferrer">查看</a>
                    <button disabled={candidate.promoted || busy === candidate.id} onClick={() => promote(candidate.id)}>
                      {candidate.promoted ? "已进入看板" : busy === candidate.id ? "处理中" : "转为选题"}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {!error && tab === "board" && (
          <div className={styles.board}>
            {columns.map(([status, label]) => (
              <section className={styles.column} key={status}>
                <div className={styles.columnHead}><b>{label}</b><span>{data?.items.filter((item) => item.status === status).length ?? 0}</span></div>
                {data?.items.filter((item) => item.status === status).map((item) => (
                  <article className={styles.card} key={item.id}>
                    <small>{item.platform ?? "创作任务"} {item.score ? `· ${item.score} 分` : ""}</small>
                    <h3>{item.title || "未命名选题"}</h3>
                    <p>{item.final_script?.slice(0, 80) || "等待完善脚本..."}</p>
                    <div className={styles.actions}>
                      {["published", "retrospective"].includes(status) && <button onClick={() => setMetricsFor(item)}>录入数据</button>}
                      <select disabled={busy === item.id} value={item.status} onChange={(event) => move(item.id, event.target.value)}>
                        {columns.map(([value, text]) => <option value={value} key={value}>{text}</option>)}
                      </select>
                    </div>
                  </article>
                ))}
              </section>
            ))}
          </div>
        )}
      </section>

      {metricsFor && <MetricsModal item={metricsFor} close={() => setMetricsFor(null)} done={async () => { setMetricsFor(null); await load(); }} />}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div><span>{label}</span><strong>{String(value).padStart(2, "0")}</strong></div>;
}

function MetricsModal({ item, close, done }: { item: Item; close: () => void; done: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const publishedAt = new Date(String(values.publishedAt));
      if (Number.isNaN(publishedAt.getTime())) throw new Error("发布时间无效");
      const response = await fetch("/api/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, contentItemId: Number(item.id), publishedAt: publishedAt.toISOString() }),
      });
      await responseJson(response);
      await done();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.overlay}>
      <form className={styles.modal} onSubmit={submit}>
        <div><h2>录入发布数据</h2><button type="button" onClick={close}>×</button></div>
        <p>{item.title}</p>
        {error && <div className={styles.error}>{error}</div>}
        <label>平台<select name="platform" defaultValue={item.platform ?? "douyin"}><option value="douyin">抖音</option><option value="xhs">小红书</option></select></label>
        <label>作品链接<input name="postUrl" defaultValue={item.post_url ?? ""} /></label>
        <label>发布时间<input name="publishedAt" type="datetime-local" required /></label>
        <label>数据窗口<select name="windowHours"><option value="24">24 小时</option><option value="72">3 天</option><option value="168">7 天</option></select></label>
        <div className={styles.formGrid}>
          {[["views", "播放量"], ["completionRate", "完播率（0-1）"], ["collects", "收藏"], ["followerGain", "涨粉"], ["likes", "点赞"], ["comments", "评论"], ["shares", "分享"]].map(([name, label]) => (
            <label key={name}>{label}<input name={name} type="number" step={name === "completionRate" ? "0.001" : "1"} min="0" max={name === "completionRate" ? "1" : undefined} defaultValue="0" /></label>
          ))}
        </div>
        <button className={styles.submit} disabled={saving}>{saving ? "保存中" : "保存并生成复盘"}</button>
      </form>
    </div>
  );
}
