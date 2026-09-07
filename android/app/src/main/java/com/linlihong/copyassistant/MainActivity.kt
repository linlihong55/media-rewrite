package com.linlihong.copyassistant

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.ViewGroup
import android.widget.*
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var store: SettingsStore
    private lateinit var urlInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var status: TextView
    private val executor = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = SettingsStore(this)
        setContentView(buildContent())
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 31)
    }

    private fun buildContent(): ScrollView {
        val scroll = ScrollView(this).apply { setBackgroundColor(Color.rgb(16, 17, 22)) }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(32), dp(24), dp(32))
        }
        box.addView(TextView(this).apply {
            text = "爆款文案助手"
            textSize = 28f
            setTextColor(Color.WHITE)
        })
        box.addView(label("手机负责操作，Mac负责提取、改写和保存。"))
        box.addView(label("电脑地址"))
        urlInput = EditText(this).apply {
            hint = "例如 http://你的Mac名称:3300"
            setText(store.serverUrl)
            setTextColor(Color.WHITE); setHintTextColor(Color.GRAY)
            inputType = android.text.InputType.TYPE_TEXT_VARIATION_URI
        }
        box.addView(urlInput, matchWrap())
        box.addView(label("访问令牌"))
        tokenInput = EditText(this).apply {
            hint = "粘贴Mac生成的令牌"
            setText(store.token)
            setTextColor(Color.WHITE); setHintTextColor(Color.GRAY)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        box.addView(tokenInput, matchWrap())
        box.addView(button("保存并测试连接") {
            store.serverUrl = urlInput.text.toString()
            store.token = tokenInput.text.toString()
            status.text = "正在连接电脑…"
            executor.execute {
                val result = runCatching { MobileApi(store).health() }
                runOnUiThread { status.text = result.fold({ "连接成功，电脑处理服务可用" }, { "连接失败：${it.message}" }) }
            }
        })
        box.addView(button("开启悬浮球") { startFloatingAssistant() })
        box.addView(button("停止悬浮球") {
            stopService(Intent(this, FloatingAssistantService::class.java))
            status.text = "悬浮球已停止"
        })
        status = label("请先保存配置并测试连接").apply { setPadding(0, dp(18), 0, 0) }
        box.addView(status)
        box.addView(label("使用条件：Mac需开机、开盖、联网且未睡眠；手机与Mac需连接同一Tailscale私有网络。"))
        scroll.addView(box)
        return scroll
    }

    private fun startFloatingAssistant() {
        store.serverUrl = urlInput.text.toString()
        store.token = tokenInput.text.toString()
        if (!Settings.canDrawOverlays(this)) {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            status.text = "请允许显示在其他应用上层，然后返回再次点击开启"
            return
        }
        startForegroundService(Intent(this, FloatingAssistantService::class.java))
        status.text = "悬浮球已开启"
    }

    private fun label(textValue: String) = TextView(this).apply {
        text = textValue; textSize = 15f; setTextColor(Color.LTGRAY); setPadding(0, dp(14), 0, dp(6))
    }
    private fun button(textValue: String, click: () -> Unit) = Button(this).apply {
        text = textValue; isAllCaps = false; setOnClickListener { click() }
    }
    private fun matchWrap() = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }
}

