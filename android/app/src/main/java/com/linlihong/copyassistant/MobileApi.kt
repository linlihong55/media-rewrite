package com.linlihong.copyassistant

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class MobileApi(private val settings: SettingsStore) {
    class ApiException(message: String) : Exception(message)

    fun health(): JSONObject = request("GET", "/api/mobile/health")

    fun createTask(
        action: String,
        idempotencyKey: String,
        draftId: String? = null,
        sourceText: String? = null,
        transcript: String? = null,
        rewritten: String? = null
    ): JSONObject {
        val body = JSONObject().put("action", action).put("idempotencyKey", idempotencyKey)
        draftId?.let { body.put("draftId", it) }
        sourceText?.let { body.put("sourceText", it) }
        transcript?.let { body.put("transcript", it) }
        rewritten?.let { body.put("rewritten", it) }
        return request("POST", "/api/mobile/tasks", body)
    }

    fun getTask(id: String): JSONObject = request("GET", "/api/mobile/tasks/$id")
    fun listDrafts(): JSONObject = request("GET", "/api/mobile/drafts")
    fun deleteDraft(id: String): JSONObject = request("DELETE", "/api/mobile/drafts/$id")

    private fun request(method: String, path: String, body: JSONObject? = null): JSONObject {
        val base = settings.serverUrl
        val token = settings.token
        if (base.isBlank() || token.isBlank()) throw ApiException("请先在主应用配置电脑地址和访问令牌")
        val connection = (URL(base + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 20_000
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Content-Type", "application/json")
            if (body != null) {
                doOutput = true
                outputStream.use { it.write(body.toString().toByteArray()) }
            }
        }
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        connection.disconnect()
        val json = runCatching { JSONObject(text) }.getOrElse { throw ApiException("电脑返回了无法识别的响应（HTTP $status）") }
        if (status !in 200..299) throw ApiException(json.optString("error", "请求失败（HTTP $status）"))
        return json.getJSONObject("data")
    }
}
