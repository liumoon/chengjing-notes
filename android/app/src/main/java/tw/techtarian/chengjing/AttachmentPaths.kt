package tw.techtarian.chengjing

import java.io.File
import java.security.MessageDigest
import java.util.UUID

/**
 * 附件儲存路徑規則，與桌面 `electron/attachment-store.cjs` 保持一致。
 *
 * attachments/
 *   ├── <legacy>            舊單層附件：永遠可讀，不搬移、不批次遷移
 *   ├── objects/ab/<id>     新附件：依附件 ID 前兩碼分 shard
 *   └── staging/<uuid>.part 寫入中的暫存，對外一律不可見
 *
 * `relativePath` 對 WebView 與同步協定是不透明字串：新舊格式都要能讀、
 * 能刪、能備份。資料夾只依附件 ID 分 shard，不使用標題、日期或原始檔名。
 */
object AttachmentPaths {
    const val OBJECTS = "objects"
    const val STAGING = "staging"
    private val SHARD = Regex("[a-z0-9]{2}")

    /** 正規化並驗證相對路徑；拒絕絕對路徑、`..`、隱藏檔、控制字元與 staging。 */
    fun normalize(relativePath: String): String {
        val raw = relativePath.trim()
        require(raw.isNotEmpty() && raw.length <= 512) { "Invalid attachment path" }
        require(!raw.startsWith("/") && !raw.startsWith("\\")) { "Invalid attachment path" }
        require(!(raw.length >= 2 && raw[1] == ':')) { "Invalid attachment path" }
        require(!raw.any { it.code < 0x20 }) { "Invalid attachment path" }
        val segments = raw.replace('\\', '/').trim('/').split('/')
        require(segments.all { it.isNotEmpty() && it != "." && it != ".." && it != STAGING && !it.startsWith(".") }) { "Invalid attachment path" }
        return segments.joinToString("/")
    }

    fun isSafe(relativePath: String): Boolean = try { normalize(relativePath).isNotEmpty() } catch (_: Exception) { false }

    /** 本管線寫出的正式格式：舊單層檔名或 `objects/<shard>/<file>`。 */
    fun isManaged(relativePath: String): Boolean {
        val segments = try { normalize(relativePath).split('/') } catch (_: Exception) { return false }
        return if (segments.size == 1) true
        else segments.size == 3 && segments[0] == OBJECTS && segments[1].matches(SHARD)
    }

    fun extension(name: String): String {
        val base = name.substringAfterLast('/', name)
        val dot = base.lastIndexOf('.')
        if (dot <= 0 || dot == base.length - 1) return ""
        val ext = base.substring(dot + 1).lowercase().filter { it.code < 128 && (it.isLetterOrDigit()) }
        return if (ext.isEmpty() || ext.length > 11) "" else ".$ext"
    }

    fun fileId(id: String): String = id.replace(Regex("[^A-Za-z0-9_-]"), "-").take(120).ifEmpty { UUID.randomUUID().toString() }

    fun shard(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }.take(2)

    /** 新附件的正式相對路徑。 */
    fun newPath(id: String, name: String = ""): String {
        val fileId = fileId(id)
        return "$OBJECTS/${shard(fileId)}/$fileId${extension(name)}"
    }

    /** 根目錄內的檔案；符號連結不得把存取導向根目錄之外。 */
    fun resolve(root: File, relativePath: String): File {
        val canonicalRoot = root.canonicalFile
        val file = File(root, normalize(relativePath)).canonicalFile
        val rootPath = canonicalRoot.path
        require(file.path == rootPath || file.path.startsWith("$rootPath${File.separator}")) { "Invalid attachment path" }
        return file
    }

    fun relative(root: File, file: File): String {
        val rootPath = root.canonicalFile.path + File.separator
        val path = file.canonicalFile.path
        require(path.startsWith(rootPath)) { "Invalid attachment path" }
        return path.removePrefix(rootPath).replace(File.separatorChar, '/')
    }

    fun stagingFile(root: File): File {
        val staging = File(root, STAGING)
        staging.mkdirs()
        return File(staging, "${UUID.randomUUID()}.part")
    }

    /** staging 完整寫入 ＋ fsync ＋ 原子 rename；失敗不留下半檔。 */
    fun promote(root: File, temporary: File, relativePath: String): File {
        val destination = resolve(root, relativePath)
        destination.parentFile?.mkdirs()
        check(temporary.renameTo(destination)) { "Failed to store attachment" }
        return destination
    }

    fun writeAtomic(root: File, relativePath: String, data: ByteArray): File {
        val temporary = stagingFile(root)
        try {
            temporary.outputStream().use { output -> output.write(data); output.flush(); output.fd.sync() }
            return promote(root, temporary, relativePath)
        } catch (error: Exception) {
            temporary.delete()
            throw error
        }
    }

    fun copyAtomic(root: File, relativePath: String, source: File): File {
        val temporary = stagingFile(root)
        try {
            source.inputStream().use { input -> temporary.outputStream().use { output -> input.copyTo(output); output.flush(); output.fd.sync() } }
            return promote(root, temporary, relativePath)
        } catch (error: Exception) {
            temporary.delete()
            throw error
        }
    }

    /** 受管理的正式附件：舊單層與 objects/<shard>/…，排除 staging 與隱藏檔。 */
    fun managedFiles(root: File): List<File> {
        val found = ArrayList<File>()
        root.listFiles()?.forEach { entry ->
            if (entry.isFile) {
                if (isSafe(entry.name)) found.add(entry)
            } else if (entry.isDirectory && entry.name == OBJECTS) {
                entry.listFiles()?.forEach { shardDirectory ->
                    if (!shardDirectory.isDirectory || !shardDirectory.name.matches(SHARD)) return@forEach
                    shardDirectory.listFiles()?.forEach { file -> if (file.isFile && isSafe(file.name)) found.add(file) }
                }
            }
        }
        return found
    }

    fun keepMatches(keep: Set<String>, relativePath: String): Boolean {
        if (keep.contains(relativePath)) return true
        val name = relativePath.substringAfterLast('/')
        return keep.any { candidate ->
            val normalized = runCatching { normalize(candidate) }.getOrNull()
            if (normalized != null) normalized == relativePath || normalized.substringAfterLast('/') == name
            else File(candidate).name == name
        }
    }

    /** 刪除附件並清掉空 shard；只碰受管理的路徑。 */
    fun delete(root: File, relativePath: String): Boolean {
        val file = resolve(root, relativePath)
        if (!file.isFile) return false
        if (!file.delete()) return false
        file.parentFile?.takeIf { it != root.canonicalFile }?.delete()
        return true
    }

    fun stats(root: File): Pair<Int, Long> {
        val files = managedFiles(root)
        return files.size to files.sumOf { it.length() }
    }
}
