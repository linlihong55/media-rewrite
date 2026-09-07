package com.linlihong.copyassistant

import android.app.*
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.*
import android.view.inputmethod.InputMethodManager
import android.widget.*
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.math.abs

class FloatingAssistantService : Service() {
    private lateinit var windowManager: WindowManager
    private lateinit var store: SettingsStore
    private lateinit var ball: FloatingBallView
    private var panel: View? = null
    private var ballParams: WindowManager.LayoutParams? = null
    private lateinit var sourceInput: EditText
    private lateinit var transcriptInput: EditText
    private lateinit var rewrittenInput: EditText
    private lateinit var statusText: TextView
    private lateinit var videoText: TextView
    private lateinit var transcribeButton: Button
    private lateinit var rewriteButton: Button
    private lateinit var saveButton: Button
    private lateinit var queueButton: Button
    private val executor = Executors.newFixedThreadPool(5)
    private val main = Handler(Looper.getMainLooper())
    private val runningDrafts = ConcurrentHashMap.newKeySet<String>()
    private val pollingJobs = ConcurrentHashMap.newKeySet<String>()
    @Volatile private var submitting = false

    override fun onCreate() {
        super.onCreate()
        store = SettingsStore(this)
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, notification("悬浮球运行中"))
        showBall()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY
    override fun onBind(intent: Intent?): IBinder? = null

    private fun showBall() {
        if (::ball.isInitialized) return
        ball = FloatingBallView(this).apply {
            text = "爆"; textSize = 18f; gravity = Gravity.CENTER; setTextColor(Color.WHITE)
            background = rounded(0xFF6C4DFF.toInt(), 99f)
            elevation = dp(8).toFloat()
        }
        val params = WindowManager.LayoutParams(
            dp(54), dp(54), WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        ).apply { gravity = Gravity.TOP or Gravity.START; x = dp(12); y = dp(220) }
        ballParams = params
        ball.setOnClickListener { openPanel() }
        var downX = 0f; var downY = 0f; var startX = 0; var startY = 0; var moved = false
        ball.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX; downY = event.rawY; startX = params.x; startY = params.y; moved = false; true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - downX).toInt(); val dy = (event.rawY - downY).toInt()
                    if (abs(dx) > dp(4) || abs(dy) > dp(4)) moved = true
                    params.x = startX + dx; params.y = startY + dy
                    windowManager.updateViewLayout(ball, params); true
                }
                MotionEvent.ACTION_UP -> {
                    if (!moved) ball.performClick() else snapBall(params)
                    true
                }
                else -> false
            }
        }
        windowManager.addView(ball, params)
    }

    private fun snapBall(params: WindowManager.LayoutParams) {
        val width = resources.displayMetrics.widthPixels
        params.x = if (params.x + dp(27) < width / 2) dp(8) else width - dp(62)
        windowManager.updateViewLayout(ball, params)
    }

    private fun openPanel() {
        if (panel != null) return
        ball.visibility = View.GONE
        val content = buildPanel()
        val params = WindowManager.LayoutParams(
            minOf(dp(370), resources.displayMetrics.widthPixels - dp(20)),
            minOf(dp(690), resources.displayMetrics.heightPixels - dp(80)),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.CENTER
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        }
        panel = content
        windowManager.addView(content, params)
        restoreDraft()
    }

    private fun closePanel() {
        persistDraft()
        panel?.let { windowManager.removeView(it) }
        panel = null
        ball.visibility = View.VISIBLE
    }

    private fun buildPanel(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(14))
            background = rounded(0xFF191A22.toInt(), 22f)
        }
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        header.addView(text("爆款文案助手", 20f, Color.WHITE), LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(button("收起") { closePanel() })
        root.addView(header)

        statusText = text("等待操作", 13f, 0xFFB9B6CC.toInt()).apply { setPadding(0, dp(6), 0, dp(6)) }
        root.addView(statusText)

        queueButton = button("后台任务队列（0/3）") { showDrafts() }
        root.addView(queueButton)

        val scroll = ScrollView(this)
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        body.addView(text("视频分享链接", 13f, Color.LTGRAY))
        sourceInput = editor("先在抖音或小红书复制链接，再点粘贴", 2)
        body.addView(sourceInput)
        body.addView(button("粘贴") { pasteClipboard() })
        videoText = text("", 13f, 0xFFB9B6CC.toInt())
        body.addView(videoText)
        transcribeButton = button("提取文案") { submit("transcribe") }
        body.addView(transcribeButton)
        body.addView(text("原文案（可编辑）", 13f, Color.LTGRAY))
        transcriptInput = editor("提取完成后显示", 8)
        body.addView(transcriptInput)
        rewriteButton = button("改写文案") { submit("rewrite") }
        body.addView(rewriteButton)
        body.addView(text("改写稿（可编辑，可留空）", 13f, Color.LTGRAY))
        rewrittenInput = editor("需要改写时点击上方按钮", 8)
        body.addView(rewrittenInput)
        saveButton = button("保存") { submit("save") }
        body.addView(saveButton)
        body.addView(button("仅重试飞书同步") { submit("retry_feishu") })
        body.addView(button("全部草稿") { showDrafts() })
        body.addView(button("删除当前草稿") { confirmDeleteDraft() })
        body.addView(button("打开设置") {
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        })
        scroll.addView(body)
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        updateButtons()
        resumeLastJob()
        return root
    }

    private fun resumeLastJob() {
        val jobId = store.activeDraft.optString("lastJobId")
        if (jobId.isBlank()) return
        if (!pollingJobs.add(jobId)) return
        executor.execute {
            runCatching {
                val data = MobileApi(store).getTask(jobId)
                val job = data.getJSONObject("job")
                val draft = data.getJSONObject("draft")
                saveServerState(draft, jobId)
                main.post { applyServerDraftIfActive(draft) }
                if (job.getString("status") in listOf("queued", "running")) {
                    runningDrafts.add(draft.getString("id"))
                    main.post { setStatus("正在恢复未完成任务…"); updateButtons() }
                    poll(jobId, job.getString("action"), draft.getString("id"))
                } else pollingJobs.remove(jobId)
            }.onFailure {
                pollingJobs.remove(jobId)
                main.post { setStatus("任务状态恢复失败：${it.message}") }
            }
        }
    }

    private fun showDrafts() {
        persistDraft()
        setStatus("正在读取历史草稿…")
        executor.execute {
            runCatching { MobileApi(store).listDrafts().getJSONArray("drafts") }
                .onSuccess { drafts ->
                    val labels = Array(drafts.length()) { index ->
                        val draft = drafts.getJSONObject(index)
                        val video = draft.optJSONObject("video")
                        val title = video?.optString("title")?.takeIf { it.isNotBlank() }
                            ?: draft.optString("source_url", "未命名草稿").take(32)
                        val latest = draft.optJSONObject("latest_job")
                        val state = when (latest?.optString("status")) {
                            "queued" -> "排队中"
                            "running" -> displayStage(latest.optString("stage"))
                            "failed" -> "失败"
                            "succeeded" -> if (draft.optString("rewritten").isNotBlank()) "已改写" else "已提取"
                            else -> "草稿"
                        }
                        "[$state] $title"
                    }
                    for (index in 0 until drafts.length()) {
                        val draft = drafts.getJSONObject(index)
                        val latest = draft.optJSONObject("latest_job") ?: continue
                        if (latest.optString("status") !in listOf("queued", "running")) continue
                        val draftId = draft.optString("id")
                        val jobId = latest.optString("id")
                        runningDrafts.add(draftId)
                        if (jobId.isNotBlank() && pollingJobs.add(jobId)) {
                            executor.execute { poll(jobId, latest.optString("action"), draftId) }
                        }
                    }
                    main.post {
                        updateButtons()
                        if (labels.isEmpty()) return@post setStatus("暂无历史草稿")
                        AlertDialog.Builder(this)
                            .setTitle("后台任务与草稿（最多3条运行）")
                            .setItems(labels) { _, which ->
                                val draft = drafts.getJSONObject(which)
                                val latest = draft.optJSONObject("latest_job")
                                store.activeDraft = JSONObject()
                                    .put("draftId", draft.optString("id"))
                                    .put("sourceText", draft.optString("source_text"))
                                    .put("transcript", draft.optString("transcript"))
                                    .put("rewritten", draft.optString("rewritten"))
                                    .put("video", draft.optJSONObject("video"))
                                    .put("lastJobId", latest?.optString("id").orEmpty())
                                restoreDraft()
                                setStatus("已切换到该视频")
                                resumeLastJob()
                            }
                            .setNegativeButton("取消", null)
                            .create().apply {
                                window?.setType(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY)
                                show()
                            }
                    }
                }
                .onFailure { main.post { setStatus("读取草稿失败：${it.message}") } }
        }
    }

    private fun confirmDeleteDraft() {
        val id = store.activeDraft.optString("draftId")
        if (id.isBlank()) return setStatus("当前没有可删除的草稿")
        AlertDialog.Builder(this)
            .setTitle("删除当前草稿？")
            .setMessage("将删除手机助手中的这条草稿和任务记录，不会删除已经保存到飞书的记录。")
            .setPositiveButton("删除") { _, _ -> deleteDraft(id) }
            .setNegativeButton("取消", null)
            .create().apply {
                window?.setType(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY)
                show()
            }
    }

    private fun deleteDraft(id: String) {
        submitting = true
        setStatus("正在删除草稿…")
        updateButtons()
        executor.execute {
            runCatching { MobileApi(store).deleteDraft(id) }
                .onSuccess {
                    store.activeDraft = JSONObject()
                    main.post {
                        sourceInput.setText(""); transcriptInput.setText(""); rewrittenInput.setText(""); videoText.text = ""
                        submitting = false; setStatus("草稿已删除"); updateButtons()
                    }
                }
                .onFailure { main.post { submitting = false; setStatus("删除失败：${it.message}"); updateButtons() } }
        }
    }

    private fun pasteClipboard() {
        val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        val value = clipboard.primaryClip?.getItemAt(0)?.coerceToText(this)?.toString().orEmpty()
        if (value.isBlank()) setStatus("剪贴板里没有文字") else {
            sourceInput.setText(value); transcriptInput.setText(""); rewrittenInput.setText("")
            store.activeDraft = JSONObject().put("sourceText", value)
            setStatus("已粘贴，请点击提取文案")
        }
        updateButtons()
    }

    private fun submit(action: String) {
        if (submitting || currentDraftBusy()) return
        val draft = store.activeDraft
        val draftId = draft.optString("draftId").takeIf { it.isNotBlank() }
        val source = sourceInput.text.toString().trim()
        val transcript = transcriptInput.text.toString()
        val rewritten = rewrittenInput.text.toString()
        when (action) {
            "transcribe" -> if (source.isBlank()) return setStatus("请先粘贴视频分享链接")
            "rewrite" -> if (draftId == null || transcript.isBlank()) return setStatus("请先提取或填写原文案")
            else -> if (draftId == null || transcript.isBlank()) return setStatus("请先提取文案")
        }
        persistDraft()
        submitting = true
        setStatus(stageLabel(action)); updateButtons()
        executor.execute {
            runCatching {
                val data = MobileApi(store).createTask(
                    action = action,
                    idempotencyKey = UUID.randomUUID().toString(),
                    draftId = draftId,
                    sourceText = if (action == "transcribe") source else null,
                    transcript = if (action != "transcribe") transcript else null,
                    rewritten = if (action == "save" || action == "retry_feishu") rewritten else null
                )
                val jobId = data.getJSONObject("job").getString("id")
                val serverDraft = data.getJSONObject("draft")
                val serverDraftId = serverDraft.getString("id")
                runningDrafts.add(serverDraftId)
                pollingJobs.add(jobId)
                saveServerState(serverDraft, jobId)
                main.post { submitting = false; applyServerDraftIfActive(serverDraft); updateButtons() }
                poll(jobId, action, serverDraftId)
            }.onFailure { error -> main.post { submitting = false; setStatus("失败：${error.message}"); updateButtons() } }
        }
    }

    private fun poll(jobId: String, action: String, draftId: String) {
        repeat(900) {
            val data = MobileApi(store).getTask(jobId)
            val job = data.getJSONObject("job")
            val draft = data.getJSONObject("draft")
            saveServerState(draft, jobId)
            val state = job.getString("status")
            main.post {
                applyServerDraftIfActive(draft)
                if (isActiveDraft(draftId)) setStatus(displayStage(job.optString("stage")))
                updateButtons()
            }
            if (state == "succeeded") {
                val message = when (action) {
                    "transcribe" -> "文案提取完成，请检查后改写或保存"
                    "rewrite" -> "改写完成，请检查后保存"
                    "save", "retry_feishu" -> if (draft.optString("feishu_sync_status") == "synced")
                        "已保存并同步到飞书" else "本地已保存，飞书同步失败：${draft.optString("feishu_sync_error")}"
                    else -> "任务完成"
                }
                runningDrafts.remove(draftId); pollingJobs.remove(jobId)
                main.post { if (isActiveDraft(draftId)) setStatus(message); updateButtons(); updateNotification(message) }
                return
            }
            if (state == "failed") {
                val message = job.optString("error_message", "任务失败")
                runningDrafts.remove(draftId); pollingJobs.remove(jobId)
                main.post { if (isActiveDraft(draftId)) setStatus("失败：$message"); updateButtons(); updateNotification("任务失败：$message") }
                return
            }
            Thread.sleep(1_000)
        }
        pollingJobs.remove(jobId)
        main.post { if (isActiveDraft(draftId)) setStatus("任务仍在电脑处理，可稍后重新打开查看"); updateButtons() }
    }

    private fun saveServerState(draft: JSONObject, jobId: String) {
        val serverId = draft.optString("id")
        val local = store.activeDraft
        val localId = local.optString("draftId")
        if (localId.isNotBlank() && localId != serverId) return
        local.put("draftId", draft.optString("id"))
            .put("sourceText", draft.optString("source_text", local.optString("sourceText")))
            .put("transcript", draft.optString("transcript"))
            .put("rewritten", draft.optString("rewritten"))
            .put("video", draft.optJSONObject("video"))
            .put("lastJobId", jobId)
        store.activeDraft = local
    }

    private fun isActiveDraft(draftId: String): Boolean =
        store.activeDraft.optString("draftId") == draftId

    private fun applyServerDraftIfActive(draft: JSONObject) {
        if (isActiveDraft(draft.optString("id"))) applyServerDraft(draft)
    }

    private fun applyServerDraft(draft: JSONObject) {
        if (panel == null) return
        val transcript = draft.optString("transcript")
        val rewritten = draft.optString("rewritten")
        if (transcript.isNotEmpty() && transcriptInput.text.toString() != transcript) transcriptInput.setText(transcript)
        if (rewritten.isNotEmpty() && rewrittenInput.text.toString() != rewritten) rewrittenInput.setText(rewritten)
        val video = draft.optJSONObject("video")
        videoText.text = if (video == null) "" else {
            val author = video.optJSONObject("author")?.optString("nickname").orEmpty()
            getString(R.string.video_summary, video.optString("title", "未命名视频"), author)
        }
        updateButtons()
    }

    private fun restoreDraft() {
        val draft = store.activeDraft
        sourceInput.setText(draft.optString("sourceText"))
        transcriptInput.setText(draft.optString("transcript"))
        rewrittenInput.setText(draft.optString("rewritten"))
        draft.optJSONObject("video")?.let { video ->
            val author = video.optJSONObject("author")?.optString("nickname").orEmpty()
            videoText.text = getString(R.string.video_summary, video.optString("title", "未命名视频"), author)
        }
        updateButtons()
    }

    private fun persistDraft() {
        if (!::sourceInput.isInitialized) return
        val draft = store.activeDraft
        draft.put("sourceText", sourceInput.text.toString())
            .put("transcript", transcriptInput.text.toString())
            .put("rewritten", rewrittenInput.text.toString())
        store.activeDraft = draft
    }

    private fun currentDraftBusy(): Boolean {
        val id = store.activeDraft.optString("draftId")
        return id.isNotBlank() && runningDrafts.contains(id)
    }

    private fun updateButtons() {
        if (!::transcribeButton.isInitialized) return
        val busy = submitting || currentDraftBusy()
        transcribeButton.isEnabled = !busy && sourceInput.text.toString().isNotBlank()
        val hasDraft = store.activeDraft.optString("draftId").isNotBlank()
        rewriteButton.isEnabled = !busy && hasDraft && transcriptInput.text.toString().isNotBlank()
        saveButton.isEnabled = !busy && hasDraft && transcriptInput.text.toString().isNotBlank()
        if (::queueButton.isInitialized) queueButton.text = "后台任务队列（${runningDrafts.size}/3）"
    }

    private fun setStatus(value: String) { if (::statusText.isInitialized) statusText.text = value }
    private fun stageLabel(action: String) = when (action) {
        "transcribe" -> "正在提交提取任务…"; "rewrite" -> "正在提交改写任务…"
        "retry_feishu" -> "正在重试飞书同步…"; else -> "正在保存…"
    }
    private fun displayStage(stage: String) = when (stage) {
        "queued" -> "等待电脑处理"; "resolving" -> "正在解析视频"; "downloading" -> "正在下载临时视频"
        "transcribing" -> "正在提取口播文案"; "rewriting" -> "正在按电脑版规则改写"
        "saving" -> "正在保存并同步飞书"; "retrying_feishu" -> "正在重试飞书同步"; else -> "电脑处理中"
    }

    private fun editor(hintValue: String, lines: Int) = EditText(this).apply {
        hint = hintValue; minLines = lines; maxLines = maxOf(lines, 12); gravity = Gravity.TOP
        setTextColor(Color.WHITE); setHintTextColor(0xFF777586.toInt()); setBackgroundColor(0xFF242630.toInt())
        setPadding(dp(10), dp(8), dp(10), dp(8))
        setOnFocusChangeListener { view, focused ->
            if (focused) (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(view, InputMethodManager.SHOW_IMPLICIT)
            if (!focused) persistDraft()
        }
    }
    private fun button(value: String, click: () -> Unit) = Button(this).apply {
        text = value; isAllCaps = false; setOnClickListener { click() }
    }
    private fun text(value: String, size: Float, color: Int) = TextView(this).apply {
        text = value; textSize = size; setTextColor(color)
    }
    private fun rounded(color: Int, radius: Float) = GradientDrawable().apply {
        setColor(color); cornerRadius = dp(radius.toInt()).toFloat()
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun createNotificationChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "悬浮文案助手", NotificationManager.IMPORTANCE_LOW)
        )
    }
    private fun notification(message: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_edit).setContentTitle("爆款文案助手")
            .setContentText(message).setOngoing(true).setContentIntent(open).build()
    }
    private fun updateNotification(message: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(message))
    }

    override fun onDestroy() {
        persistDraft()
        panel?.let { windowManager.removeView(it) }
        if (::ball.isInitialized) windowManager.removeView(ball)
        executor.shutdownNow()
        super.onDestroy()
    }

    companion object { const val CHANNEL_ID = "floating_assistant"; const val NOTIFICATION_ID = 4101 }
}

private class FloatingBallView(context: Context) : TextView(context) {
    override fun performClick(): Boolean {
        super.performClick()
        return true
    }
}
