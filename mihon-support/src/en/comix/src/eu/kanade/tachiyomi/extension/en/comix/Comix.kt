package eu.kanade.tachiyomi.extension.en.comix

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Rect
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.online.HttpSource
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import rx.Observable
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.Calendar

/**
 * comix.to source for Mihon / Tachiyomi-compatible readers.
 *
 * comix serves its catalogue from a JSON API at `/api/v1`. Two things make that
 * API non-trivial, and both are handled transparently by [clientInterceptor]:
 *
 *  1. Every `/manga*` and `/chapters/{id}` GET must carry a `_` query token equal
 *     to [ComixCrypto.encode] of the canonical `path?sortedParams` string. Without
 *     it the API answers HTTP 403 "Missing token".
 *  2. The chapter-list and page-list endpoints answer with encrypted JSON
 *     (response header `x-enc: 1`, body `{"e":"<token>"}`) that must be run through
 *     [ComixCrypto.decode].
 *
 * Scrambled pages (rare; flagged by an `X-Scramble-Seed` image response header) are
 * un-shuffled by [ComixImageInterceptor]. Everything the reader sees — browse,
 * search, chapter list, and per-page/whole-series downloads — is driven straight
 * off this API; Mihon owns the reader and download-queue UI.
 */
class Comix : HttpSource() {
    override val name = "Comix"
    override val baseUrl = "https://comix.to"
    override val lang = "en"
    override val supportsLatest = true

    private val apiUrl = "$baseUrl/api/v1"

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        coerceInputValues = true
    }

    override val client: OkHttpClient = network.cloudflareClient.newBuilder()
        .addInterceptor(clientInterceptor())
        .addInterceptor(ComixImageInterceptor())
        .build()

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .set("Referer", "$baseUrl/")
        .set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")

    private val jsonHeaders: Headers by lazy {
        headersBuilder()
            .set("Accept", "application/json, text/plain, */*")
            .build()
    }

    private val imageHeaders: Headers by lazy {
        headersBuilder()
            .set("Accept", "image/webp,image/avif,image/*,*/*;q=0.8")
            .build()
    }

    // ── Browse / latest / search ─────────────────────────────────────────────────

    override fun popularMangaRequest(page: Int): Request =
        GET(mangaListUrl(page).addQueryParameter("order[score]", "desc").build(), jsonHeaders)

    override fun popularMangaParse(response: Response): MangasPage = mangaListParse(response)

    override fun latestUpdatesRequest(page: Int): Request =
        GET(mangaListUrl(page).addQueryParameter("order[chapter_updated_at]", "desc").build(), jsonHeaders)

    override fun latestUpdatesParse(response: Response): MangasPage = mangaListParse(response)

    override fun searchMangaRequest(page: Int, query: String, filters: FilterList): Request {
        // Let users paste a comix.to title URL straight into search.
        val queryUrl = query.trim().toHttpUrlOrNull()
        if (queryUrl != null && queryUrl.host.removePrefix("www.") == "comix.to") {
            if (queryUrl.pathSegments.firstOrNull() == "title") {
                val titleSlug = queryUrl.pathSegments.getOrNull(1)
                if (!titleSlug.isNullOrBlank()) {
                    return mangaDetailsRequest(SManga.create().apply { url = "/$titleSlug" })
                }
            }
        }

        val builder = mangaListUrl(page)
        if (query.isBlank()) {
            builder.addQueryParameter("order[score]", "desc")
        } else {
            builder
                .addQueryParameter("keyword", query.trim())
                .addQueryParameter("order[relevance]", "desc")
        }
        return GET(builder.build(), jsonHeaders)
    }

    override fun searchMangaParse(response: Response): MangasPage {
        // The URL-paste shortcut resolves to a single-manga details request.
        if (Regex("""/api/v1/manga/[^/]+$""").containsMatchIn(response.request.url.encodedPath)) {
            val result = json.decodeFromString<SingleMangaResponse>(response.body.string()).result
            return MangasPage(listOf(result.toSManga(basicOnly = true)), false)
        }
        return mangaListParse(response)
    }

    private fun mangaListUrl(page: Int): HttpUrl.Builder =
        "$apiUrl/manga".toHttpUrl().newBuilder()
            .addQueryParameter("limit", "28")
            .addQueryParameter("page", page.toString())

    private fun mangaListParse(response: Response): MangasPage {
        val result = json.decodeFromString<MangaListResponse>(response.body.string()).result
        return MangasPage(result.items.map { it.toSManga(basicOnly = true) }, result.hasNextPage())
    }

    // ── Details ──────────────────────────────────────────────────────────────────

    override fun mangaDetailsRequest(manga: SManga): Request =
        GET("$apiUrl/manga/${manga.hid()}", jsonHeaders)

    override fun mangaDetailsParse(response: Response): SManga =
        json.decodeFromString<SingleMangaResponse>(response.body.string())
            .result
            .toSManga(basicOnly = false)

    override fun getMangaUrl(manga: SManga): String = "$baseUrl/title${manga.url}"

    // ── Chapters (encrypted, paginated) ──────────────────────────────────────────

    override fun fetchChapterList(manga: SManga): Observable<List<SChapter>> = Observable.fromCallable {
        val hid = manga.hid()
        val chapters = ArrayList<ChapterDto>()
        var page = 1
        while (page <= MAX_CHAPTER_API_PAGES) {
            val url = "$apiUrl/manga/$hid/chapters".toHttpUrl().newBuilder()
                .addQueryParameter("limit", "100")
                .addQueryParameter("page", page.toString())
                .addQueryParameter("order[number]", "desc")
                .build()

            val meta = client.newCall(GET(url, jsonHeaders)).execute().use { response ->
                if (!response.isSuccessful) throw IOException("Chapter list HTTP ${response.code}")
                val result = json.decodeFromString<ChapterListResponse>(response.body.string()).result
                chapters += result.items
                result.meta
            }

            page++
            if (meta == null || !meta.hasNext || page > meta.lastPage) break
        }

        chapters
            .map { it.toSChapter() }
            .deduplicateByChapterNumber()
            .sortedByDescending { it.chapter_number }
    }

    override fun chapterListRequest(manga: SManga): Request =
        GET(
            "$apiUrl/manga/${manga.hid()}/chapters".toHttpUrl().newBuilder()
                .addQueryParameter("limit", "100")
                .addQueryParameter("page", "1")
                .addQueryParameter("order[number]", "desc")
                .build(),
            jsonHeaders,
        )

    override fun chapterListParse(response: Response): List<SChapter> =
        json.decodeFromString<ChapterListResponse>(response.body.string())
            .result.items
            .map { it.toSChapter() }
            .deduplicateByChapterNumber()
            .sortedByDescending { it.chapter_number }

    override fun getChapterUrl(chapter: SChapter): String = "$baseUrl/${chapter.url.removePrefix("/")}"

    // ── Pages (encrypted) ────────────────────────────────────────────────────────

    override fun pageListRequest(chapter: SChapter): Request {
        val chapterId = chapter.url.substringAfterLast("/").substringBefore("-")
        if (chapterId.isBlank()) throw IOException("Missing chapter id")
        return GET("$apiUrl/chapters/$chapterId", jsonHeaders)
    }

    override fun pageListParse(response: Response): List<Page> {
        val pages = json.decodeFromString<ChapterResponse>(response.body.string()).result.pages
        val base = pages.baseUrl.trimEnd('/')
        return pages.items.mapIndexed { index, item ->
            val fullUrl = if (item.url.startsWith("http")) item.url else "$base/${item.url.trimStart('/')}"
            Page(index, imageUrl = fullUrl)
        }
    }

    override fun imageRequest(page: Page): Request = GET(page.imageUrl!!, imageHeaders)

    override fun imageUrlParse(response: Response): String = throw UnsupportedOperationException()

    // ── Request signing + response decryption ────────────────────────────────────

    private fun clientInterceptor() = Interceptor { chain ->
        val response = chain.proceed(signRequest(chain.request()))
        if (response.header("x-enc") != "1") return@Interceptor response

        // Read the body once; on any failure hand back an equivalent, still-readable
        // response instead of a consumed one.
        val raw = response.body.string()
        val decrypted = try {
            ComixCrypto.decode(json.decodeFromString<EncEnvelope>(raw).e)
        } catch (_: Exception) {
            return@Interceptor response.newBuilder()
                .body(raw.toResponseBody(response.body.contentType()))
                .build()
        }
        response.newBuilder()
            .removeHeader("x-enc")
            .body(decrypted.toResponseBody(JSON_MEDIA))
            .build()
    }

    private fun signRequest(request: Request): Request {
        if (request.method != "GET") return request
        val url = request.url
        if (!url.host.endsWith("comix.to") || !url.encodedPath.startsWith("/api/v1/")) return request
        val token = tokenFor(url) ?: return request
        return request.newBuilder()
            .url(url.newBuilder().setQueryParameter("_", token).build())
            .build()
    }

    private fun tokenFor(url: HttpUrl): String? {
        val path = url.encodedPath.removePrefix("/api/v1")
        if (TOKEN_PATHS.none { it.containsMatchIn(path) }) return null
        // Canonical string the site signs: path?<params sorted by name, "_" excluded,
        // decoded key=value joined by &>. We only ever send single-valued params.
        val canonical = url.queryParameterNames
            .filter { it != "_" }
            .sorted()
            .joinToString("&") { "$it=${url.queryParameter(it)}" }
        val plain = if (canonical.isEmpty()) path else "$path?$canonical"
        return ComixCrypto.encode(plain)
    }

    // ── DTO → model helpers ──────────────────────────────────────────────────────

    private fun SManga.hid(): String = url.removePrefix("/").substringBefore("-")

    private fun List<SChapter>.deduplicateByChapterNumber(): List<SChapter> {
        val byNumber = LinkedHashMap<Float, SChapter>()
        for (chapter in this) {
            if (!byNumber.containsKey(chapter.chapter_number)) byNumber[chapter.chapter_number] = chapter
        }
        return byNumber.values.toList()
    }

    // ── DTOs (verified against the live /api/v1 responses) ────────────────────────

    @Serializable
    private data class TermDto(val title: String = "")

    @Serializable
    private data class PosterDto(
        val small: String? = null,
        val medium: String? = null,
        val large: String? = null,
    ) {
        fun best(): String? = large ?: medium ?: small
    }

    @Serializable
    private data class MangaDto(
        val hid: String,
        val title: String,
        val url: String? = null,
        val synopsis: String? = null,
        val type: String = "",
        val status: String = "",
        val poster: PosterDto? = null,
        val year: Int? = null,
        val originalLanguage: String? = null,
        val genres: List<TermDto>? = null,
        val demographics: List<TermDto>? = null,
        val formats: List<TermDto>? = null,
        val tags: List<TermDto>? = null,
        val authors: List<TermDto>? = null,
        val artists: List<TermDto>? = null,
    ) {
        fun toSManga(basicOnly: Boolean): SManga = SManga.create().apply {
            url = this@MangaDto.url?.substringAfter("/title") ?: "/$hid"
            title = this@MangaDto.title
            thumbnail_url = poster?.best()

            if (!basicOnly) {
                author = authors.orEmpty().joinToString { it.title }
                artist = artists.orEmpty().joinToString { it.title }
                description = buildString {
                    synopsis?.takeIf { it.isNotBlank() }?.let { append(it) }
                    val extras = buildList {
                        year?.takeIf { it > 0 }?.let { add("Year: $it") }
                        originalLanguage?.takeIf { it.isNotBlank() }?.let { add("Language: ${it.uppercase()}") }
                    }
                    if (extras.isNotEmpty()) {
                        if (isNotEmpty()) append("\n\n")
                        append(extras.joinToString("\n"))
                    }
                }
                genre = buildList {
                    type.takeIf { it.isNotBlank() }?.replaceFirstChar(Char::uppercase)?.let { add(it) }
                    addAll(genres.orEmpty().map { it.title })
                    addAll(demographics.orEmpty().map { it.title })
                    addAll(formats.orEmpty().map { it.title })
                    addAll(tags.orEmpty().map { it.title })
                }.distinct().joinToString()
                status = when (this@MangaDto.status) {
                    "releasing" -> SManga.ONGOING
                    "on_hiatus" -> SManga.ON_HIATUS
                    "finished" -> SManga.COMPLETED
                    "discontinued" -> SManga.CANCELLED
                    else -> SManga.UNKNOWN
                }
                initialized = true
            }
        }
    }

    @Serializable
    private data class SingleMangaResponse(val result: MangaDto)

    @Serializable
    private data class MetaDto(
        val page: Int = 1,
        val lastPage: Int = 1,
        val hasNext: Boolean = false,
    )

    @Serializable
    private data class MangaListResponse(val result: Items) {
        @Serializable
        data class Items(
            val items: List<MangaDto> = emptyList(),
            val meta: MetaDto? = null,
        ) {
            fun hasNextPage(): Boolean = meta?.hasNext ?: false
        }
    }

    @Serializable
    private data class ChapterListResponse(val result: Items) {
        @Serializable
        data class Items(
            val items: List<ChapterDto> = emptyList(),
            val meta: MetaDto? = null,
        )
    }

    @Serializable
    private data class ChapterDto(
        val id: Long,
        val url: String = "",
        val number: Double = 0.0,
        val name: String = "",
        val createdAtFormatted: String = "",
        val group: ScanlationGroupDto? = null,
        val isOfficial: Boolean = false,
    ) {
        fun toSChapter(): SChapter {
            val numberText = number.toString().removeSuffix(".0")
            return SChapter.create().apply {
                url = this@ChapterDto.url.removePrefix("/")
                chapter_number = number.toFloat()
                name = buildString {
                    append("Chapter ")
                    append(numberText)
                    this@ChapterDto.name.takeIf { it.isNotBlank() }?.let { append(": $it") }
                }
                date_upload = parseRelativeDate(createdAtFormatted)
                scanlator = group?.name ?: if (isOfficial) "Official" else null
            }
        }

        @Serializable
        data class ScanlationGroupDto(val name: String = "")
    }

    @Serializable
    private data class ChapterResponse(val result: ChapterResult) {
        @Serializable
        data class ChapterResult(val pages: Pages)

        @Serializable
        data class Pages(
            val baseUrl: String = "",
            val items: List<PageDto> = emptyList(),
        )

        @Serializable
        data class PageDto(val url: String)
    }

    @Serializable
    private data class EncEnvelope(val e: String)

    companion object {
        private const val MAX_CHAPTER_API_PAGES = 100
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
        private val TOKEN_PATHS = listOf(
            Regex("""^/manga(?:/|$)"""),
            Regex("""^/chapters/[^/]+(?:\?|$)"""),
        )

        private val RELATIVE_DATE_REGEX = Regex(
            """^(\d+)\s*(s|m|h|d|w|mo|mos|y|yr|yrs|min|mins|sec|secs|hr|hrs|day|days|week|weeks|month|months|year|years)$""",
        )

        private fun parseRelativeDate(dateStr: String): Long {
            if (dateStr.isBlank()) return 0L
            val trimmed = dateStr.trim().lowercase().removeSuffix(" ago")
            val match = RELATIVE_DATE_REGEX.find(trimmed) ?: return 0L
            val amount = match.groupValues[1].toIntOrNull() ?: return 0L
            val calendar = Calendar.getInstance()
            when (match.groupValues[2]) {
                "s", "sec", "secs" -> calendar.add(Calendar.SECOND, -amount)
                "m", "min", "mins" -> calendar.add(Calendar.MINUTE, -amount)
                "h", "hr", "hrs" -> calendar.add(Calendar.HOUR_OF_DAY, -amount)
                "d", "day", "days" -> calendar.add(Calendar.DAY_OF_YEAR, -amount)
                "w", "week", "weeks" -> calendar.add(Calendar.WEEK_OF_YEAR, -amount)
                "mo", "mos", "month", "months" -> calendar.add(Calendar.MONTH, -amount)
                "y", "yr", "yrs", "year", "years" -> calendar.add(Calendar.YEAR, -amount)
            }
            return calendar.timeInMillis
        }
    }
}

/**
 * Un-shuffles the rare scrambled comix page. A scrambled image carries an
 * `X-Scramble-Seed` response header (plus optional `X-Scramble-Grid` / `-Algo` /
 * `-Hash`); un-flagged images pass straight through untouched.
 *
 * The reader reshuffles a `cols × rows` tile grid using a permutation seeded by
 * the header value. We reproduce that permutation ([makeScramblePermutation]) and
 * redraw the tiles back into place. comix ships a few PRNG init constants across
 * pages, so we try each and keep the redraw whose internal tile seams line up.
 */
class ComixImageInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        val seed = response.header("X-Scramble-Seed")?.toLongOrNull()
        if (seed == null || seed <= 0L) return response

        val grid = (response.header("X-Scramble-Grid") ?: "5x5").lowercase()
        val gridMatch = Regex("""(\d+)\s*x\s*(\d+)""").find(grid)
        val cols = gridMatch?.groupValues?.get(1)?.toIntOrNull()?.coerceAtLeast(1) ?: 5
        val rows = gridMatch?.groupValues?.get(2)?.toIntOrNull()?.coerceAtLeast(1) ?: 5
        val hash = response.header("X-Scramble-Hash")?.trim()?.lowercase().orEmpty()

        val bytes = response.body.bytes()
        val descrambled = try {
            descramble(bytes, seed, cols, rows, hash)
        } catch (_: Exception) {
            null
        } ?: return response.newBuilder()
            .body(bytes.toResponseBody(response.body.contentType()))
            .build()

        return response.newBuilder()
            .removeHeader("X-Scramble-Seed")
            .body(descrambled.toResponseBody("image/png".toMediaType()))
            .build()
    }

    private fun descramble(bytes: ByteArray, seed: Long, cols: Int, rows: Int, hash: String): ByteArray? {
        val source = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
        val tileW = source.width / cols
        val tileH = source.height / rows
        if (tileW < 1 || tileH < 1) return null
        val count = cols * rows

        val candidates = initCandidates(hash)
        val multi = count > 1 && candidates.size > 1
        var best: Bitmap? = null
        var bestScore = Long.MAX_VALUE

        for (initConst in candidates) {
            val out = Bitmap.createBitmap(source.width, source.height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(out)
            // Draw the whole mosaic first so bottom/right remainders survive when the
            // image size is not an exact multiple of the grid, then overwrite tiles.
            canvas.drawBitmap(source, 0f, 0f, null)
            val permutation = makeScramblePermutation(seed, count, initConst)
            for (i in 0 until count) {
                val srcX = (i % cols) * tileW
                val srcY = (i / cols) * tileH
                val dst = permutation[i]
                val dstX = (dst % cols) * tileW
                val dstY = (dst / cols) * tileH
                canvas.drawBitmap(
                    source,
                    Rect(srcX, srcY, srcX + tileW, srcY + tileH),
                    Rect(dstX, dstY, dstX + tileW, dstY + tileH),
                    null,
                )
            }

            if (!multi) {
                best = out
                break
            }
            val score = seamScore(out, tileW, tileH, cols, rows)
            if (score < bestScore) {
                best?.recycle()
                best = out
                bestScore = score
            } else {
                out.recycle()
            }
        }

        val chosen = best ?: return null
        return ByteArrayOutputStream().use { stream ->
            chosen.compress(Bitmap.CompressFormat.PNG, 100, stream)
            chosen.recycle()
            source.recycle()
            stream.toByteArray()
        }
    }

    // Total colour discontinuity along the internal tile seams. Low = tiles line up.
    private fun seamScore(bitmap: Bitmap, tileW: Int, tileH: Int, cols: Int, rows: Int): Long {
        val w = tileW * cols
        val h = tileH * rows
        if (w < 2 || h < 2) return Long.MAX_VALUE
        val pixels = IntArray(w * h)
        bitmap.getPixels(pixels, 0, w, 0, 0, w, h)
        var score = 0L
        val step = 3
        fun diff(a: Int, b: Int): Long {
            val ar = (a shr 16) and 0xFF; val ag = (a shr 8) and 0xFF; val ab = a and 0xFF
            val br = (b shr 16) and 0xFF; val bg = (b shr 8) and 0xFF; val bb = b and 0xFF
            return (Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb)).toLong()
        }
        for (c in 1 until cols) {
            val x = c * tileW
            var y = 0
            while (y < h) { score += diff(pixels[y * w + x - 1], pixels[y * w + x]); y += step }
        }
        for (r in 1 until rows) {
            val y = r * tileH
            var x = 0
            while (x < w) { score += diff(pixels[(y - 1) * w + x], pixels[y * w + x]); x += step }
        }
        return score
    }

    private fun initCandidates(hash: String): List<Long> {
        val preferred = HASH_INIT_CONSTS[hash].orEmpty()
        val out = LinkedHashSet<Long>()
        out.addAll(preferred)
        out.addAll(INIT_CONSTS)
        return out.toList()
    }

    companion object {
        private val INIT_CONSTS = listOf(0xe42fL, 0x1L, 0x1cb1dL)
        private val HASH_INIT_CONSTS = mapOf(
            "03632" to listOf(0xe42fL),
            "02900" to listOf(0x1cb1dL),
            "09197" to listOf(0x1L),
            "bca9b" to listOf(0x1L),
            "e8a87" to listOf(0x1L),
        )

        /**
         * Reproduces comix's exact tile permutation. Ground-truth vectors are locked
         * into tests/integration.test.js in the browser-extension repo:
         *   - PRNG state init: initConst XOR (seed with its low bit cleared)
         *   - step: xorshift32 (shifts 13, 17, 5)
         *   - shuffle: Durstenfeld, remaining = count..2, j = state % remaining
         */
        fun makeScramblePermutation(seed: Long, count: Int, initConst: Long): IntArray {
            val order = IntArray(count) { it }
            var state = (initConst xor ((seed ushr 1) shl 1)) and 0xFFFFFFFFL
            var remaining = count
            while (remaining >= 2) {
                state = (state xor ((state shl 13) and 0xFFFFFFFFL)) and 0xFFFFFFFFL
                state = (state xor (state ushr 17)) and 0xFFFFFFFFL
                state = (state xor ((state shl 5) and 0xFFFFFFFFL)) and 0xFFFFFFFFL
                val swapWith = (state % remaining).toInt()
                val last = remaining - 1
                val tmp = order[last]; order[last] = order[swapWith]; order[swapWith] = tmp
                remaining--
            }
            return order
        }
    }
}
