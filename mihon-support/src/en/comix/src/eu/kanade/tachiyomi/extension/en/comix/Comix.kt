package eu.kanade.tachiyomi.extension.en.comix

import android.annotation.SuppressLint
import android.app.Application
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.online.HttpSource
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import okhttp3.Response
import org.jsoup.Jsoup
import org.jsoup.parser.Parser
import rx.Observable
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import java.io.ByteArrayInputStream
import java.io.IOException
import java.util.Calendar
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

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

    private val jsonHeaders: Headers by lazy {
        headers.newBuilder()
            .set("Accept", "application/json, text/plain, */*")
            .set("Referer", "$baseUrl/")
            .build()
    }

    private val imageHeaders: Headers by lazy {
        headers.newBuilder()
            .set("Accept", "image/webp,image/avif,image/*,*/*;q=0.8")
            .set("Referer", "$baseUrl/")
            .build()
    }

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .set("Referer", "$baseUrl/")
        .set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")

    override fun popularMangaRequest(page: Int): Request {
        val url = apiBaseBuilder("manga")
            .addQueryParameter("order[score]", "desc")
            .addQueryParameter("limit", "28")
            .addQueryParameter("page", page.toString())
            .build()

        return GET(url, jsonHeaders)
    }

    override fun popularMangaParse(response: Response): MangasPage = searchMangaParse(response)

    override fun latestUpdatesRequest(page: Int): Request {
        val url = apiBaseBuilder("manga")
            .addQueryParameter("order[chapter_updated_at]", "desc")
            .addQueryParameter("limit", "28")
            .addQueryParameter("page", page.toString())
            .build()

        return GET(url, jsonHeaders)
    }

    override fun latestUpdatesParse(response: Response): MangasPage = searchMangaParse(response)

    override fun searchMangaRequest(page: Int, query: String, filters: FilterList): Request {
        val queryUrl = query.trim().toHttpUrlOrNull()
        if (queryUrl != null && queryUrl.host.removePrefix("www.") == "comix.to") {
            val titleSlug = queryUrl.pathSegments.getOrNull(1)
            if (queryUrl.pathSegments.firstOrNull() == "title" && !titleSlug.isNullOrBlank()) {
                return mangaDetailsRequest(SManga.create().apply { url = "/$titleSlug" })
            }
        }

        val builder = apiBaseBuilder("manga")
            .addQueryParameter("limit", "28")
            .addQueryParameter("page", page.toString())

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
        val body = response.body.string()
        val path = response.request.url.encodedPath

        return if (Regex("""/api/v1/manga/[^/]+$""").containsMatchIn(path)) {
            val result = json.decodeFromString<SingleMangaResponse>(body).result
            MangasPage(listOf(result.toSManga(basicOnly = true)), false)
        } else {
            val result = json.decodeFromString<SearchResponse>(body).result
            MangasPage(
                result.items.map { it.toSManga(basicOnly = true) },
                result.hasNextPage(),
            )
        }
    }

    override fun mangaDetailsRequest(manga: SManga): Request {
        val hid = manga.url.removePrefix("/").substringBefore("-")
        return GET(apiBaseBuilder("manga", hid).build(), jsonHeaders)
    }

    override fun mangaDetailsParse(response: Response): SManga {
        return json.decodeFromString<SingleMangaResponse>(response.body.string())
            .result
            .toSManga(basicOnly = false)
    }

    override fun getMangaUrl(manga: SManga): String {
        return "$baseUrl/title${manga.url}"
    }

    override fun fetchChapterList(manga: SManga): Observable<List<SChapter>> = Observable.fromCallable {
        runCatching { fetchChapterListFromApi(manga) }
            .getOrElse {
                client.newCall(chapterListRequest(manga)).execute().use { response ->
                    chapterListParse(response).ifEmpty { throw it }
                }
            }
    }

    override fun chapterListRequest(manga: SManga): Request = GET(getMangaUrl(manga), headers)

    override fun chapterListParse(response: Response): List<SChapter> {
        val raw = response.body.string()
        val titleSlug = response.request.url.encodedPath
            .substringAfter("/title/", "")
            .substringBefore("/")

        return extractChapterPathsFromRaw(raw, titleSlug)
            .map { pathToChapter(it) }
            .deduplicateByChapterNumber()
            .sortedByDescending { it.chapter_number }
    }

    override fun getChapterUrl(chapter: SChapter): String = "$baseUrl/${chapter.url.removePrefix("/")}"

    override fun fetchPageList(chapter: SChapter): Observable<List<Page>> = Observable.fromCallable {
        runCatching { fetchPageListFromApi(chapter) }
            .getOrElse {
                client.newCall(pageListRequest(chapter)).execute().use { response ->
                    pageListParse(response).ifEmpty { throw it }
                }
            }
    }

    override fun pageListRequest(chapter: SChapter): Request = GET(getChapterUrl(chapter), headers)

    override fun pageListParse(response: Response): List<Page> {
        return extractPagesFromRaw(response.body.string())
    }

    override fun imageRequest(page: Page): Request {
        return GET(page.imageUrl!!, imageHeaders)
    }

    override fun imageUrlParse(response: Response): String = throw UnsupportedOperationException()

    private fun fetchChapterListFromApi(manga: SManga): List<SChapter> {
        val mangaPath = manga.url.removePrefix("/")
        val hid = mangaPath.substringBefore("-")
        val token = captureToken(getMangaUrl(manga)) { url ->
            url.encodedPath.endsWith("/api/v1/manga/$hid/chapters")
        }

        val chapters = mutableListOf<ChapterDto>()
        var page = 1
        var hasNextPage = true

        while (page <= MAX_CHAPTER_API_PAGES && hasNextPage) {
            val url = apiBaseBuilder("manga", hid, "chapters")
                .addQueryParameter("page", page.toString())
                .addQueryParameter("limit", "100")
                .addQueryParameter("order[number]", "desc")
                .addQueryParameter("_", token)
                .build()

            val response = client.newCall(GET(url, jsonHeaders)).execute()
            response.use {
                if (!it.isSuccessful) throw IOException("Chapter list HTTP ${it.code}")
                val result = json.decodeFromString<ChapterDetailsResponse>(it.body.string()).result
                chapters += result.items
                hasNextPage = result.hasNextPage()
            }

            page++
        }

        return chapters
            .map { it.toSChapter(mangaPath) }
            .deduplicateByChapterNumber()
            .sortedByDescending { it.chapter_number }
    }

    private fun fetchPageListFromApi(chapter: SChapter): List<Page> {
        val chapterId = chapter.url.substringAfterLast("/").substringBefore("-")
        if (chapterId.isBlank()) throw IOException("Missing chapter id")

        val token = captureToken(getChapterUrl(chapter)) { url ->
            url.encodedPath.endsWith("/api/v1/chapters/$chapterId")
        }

        val url = apiBaseBuilder("chapters", chapterId)
            .addQueryParameter("_", token)
            .build()

        client.newCall(GET(url, jsonHeaders)).execute().use { response ->
            if (!response.isSuccessful) throw IOException("Page list HTTP ${response.code}")

            val pages = json.decodeFromString<ChapterResponse>(response.body.string()).result.pages
            val base = pages.baseUrl.trimEnd('/')
            return pages.items.mapIndexed { index, item ->
                val fullUrl = if (item.url.startsWith("http")) {
                    item.url
                } else {
                    "$base/${item.url.trimStart('/')}"
                }
                Page(index, imageUrl = fullUrl)
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun captureToken(pageUrl: String, urlMatches: (HttpUrl) -> Boolean): String {
        val handler = Handler(Looper.getMainLooper())
        val latch = CountDownLatch(1)
        val tokenRef = AtomicReference<String>()
        val emptyResponse = WebResourceResponse(
            "text/plain",
            "utf-8",
            ByteArrayInputStream(ByteArray(0)),
        )
        var webView: WebView? = null

        val createAndLoad = {
            val view = WebView(Injekt.get<Application>())
            webView = view

            with(view.settings) {
                javaScriptEnabled = true
                domStorageEnabled = true
                blockNetworkImage = true
                userAgentString = headers["User-Agent"]
            }

            view.webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? {
                    val httpUrl = request.url?.toString()?.toHttpUrlOrNull()
                        ?: return emptyResponse

                    if (urlMatches(httpUrl)) {
                        httpUrl.queryParameter("_")?.let { token ->
                            if (tokenRef.compareAndSet(null, token)) {
                                latch.countDown()
                            }
                        }
                    }

                    val allowed = httpUrl.host.endsWith("comix.to") &&
                        (
                            httpUrl.encodedPath.startsWith("/title/") ||
                                httpUrl.encodedPath.startsWith("/api/") ||
                                httpUrl.encodedPath.endsWith(".js") ||
                                httpUrl.encodedPath.endsWith(".css")
                            )

                    return if (allowed) {
                        super.shouldInterceptRequest(view, request)
                    } else {
                        emptyResponse
                    }
                }
            }

            view.loadUrl(pageUrl)
        }

        if (Looper.myLooper() == Looper.getMainLooper()) {
            createAndLoad()
        } else {
            handler.post(createAndLoad)
        }

        val completed = latch.await(30, TimeUnit.SECONDS)
        handler.post { webView?.destroy() }

        if (!completed) throw IOException("Timed out waiting for Comix token")
        return tokenRef.get() ?: throw IOException("Failed to capture Comix token")
    }

    private fun apiBaseBuilder(vararg pathSegments: String): HttpUrl.Builder {
        return apiUrl.toHttpUrl().newBuilder().apply {
            pathSegments.forEach { addPathSegment(it) }
        }
    }

    private fun extractChapterPathsFromRaw(raw: String, titleSlug: String): List<String> {
        val unescaped = Parser.unescapeEntities(raw, false)
            .replace("\\u002F", "/")
            .replace("\\/", "/")

        val regexPaths = CHAPTER_PATH_REGEX.findAll(unescaped)
            .map { it.value }
            .filter { titleSlug.isBlank() || it.startsWith("/title/$titleSlug/") }
            .toList()

        val domPaths = Jsoup.parse(raw, baseUrl)
            .select("a[href*=/title/]")
            .map { it.attr("abs:href").substringAfter(baseUrl) }
            .filter { CHAPTER_PATH_REGEX.matches(it) }
            .filter { titleSlug.isBlank() || it.startsWith("/title/$titleSlug/") }

        return (regexPaths + domPaths).distinct()
    }

    private fun pathToChapter(path: String): SChapter {
        val label = chapterLabel(path)
        val chapterNumber = label.removePrefix("Ch").toFloatOrNull() ?: -1f
        return SChapter.create().apply {
            url = path.removePrefix("/")
            name = "Chapter ${label.removePrefix("Ch")}"
            chapter_number = chapterNumber
        }
    }

    private fun List<SChapter>.deduplicateByChapterNumber(): List<SChapter> {
        val byNumber = LinkedHashMap<Float, SChapter>()
        for (chapter in this) {
            val key = chapter.chapter_number
            if (!byNumber.containsKey(key)) byNumber[key] = chapter
        }
        return byNumber.values.toList()
    }

    private fun chapterLabel(path: String): String {
        val match = Regex("""/(\d+)-chapter-([0-9a-z.-]+)(?:/|$)""", RegexOption.IGNORE_CASE)
            .find(path)
        return "Ch${match?.groupValues?.getOrNull(2).orEmpty()}"
    }

    private fun extractPagesFromRaw(raw: String): List<Page> {
        val unescaped = Parser.unescapeEntities(raw, false)
            .replace("\\u002F", "/")
            .replace("\\/", "/")

        val imageUrls = IMAGE_URL_REGEX.findAll(unescaped)
            .map { it.value }
            .distinct()
            .toList()

        val grouped = imageUrls.mapNotNull { url ->
            val match = IMAGE_PATTERN_REGEX.find(url) ?: return@mapNotNull null
            ImageCandidate(
                url = url,
                base = match.groupValues[1],
                number = match.groupValues[2].toInt(),
                digits = match.groupValues[2].length,
                extension = match.groupValues[3],
            )
        }.groupBy { it.base }

        val best = grouped.values.maxByOrNull { it.size }.orEmpty().sortedBy { it.number }
        if (best.isNotEmpty()) {
            val total = maxOf(best.size, detectPageTotal(unescaped, best.size))
            val first = best.first()
            val urls = if (total > best.size) {
                (1..total).map {
                    "${first.base}${it.toString().padStart(first.digits, '0')}${first.extension}"
                }
            } else {
                best.map { it.url }
            }

            return urls.mapIndexed { index, url -> Page(index, imageUrl = url) }
        }

        return Jsoup.parse(raw, baseUrl)
            .select("img[alt^=Page], img[src*=.webp], img[src*=.jpg], img[src*=.png]")
            .mapNotNull { img ->
                listOf("abs:src", "abs:data-src", "abs:data-lazy-src", "abs:data-original")
                    .firstNotNullOfOrNull { attr -> img.attr(attr).takeIf(String::isNotBlank) }
            }
            .filter { IMAGE_URL_REGEX.containsMatchIn(it) }
            .distinct()
            .mapIndexed { index, url -> Page(index, imageUrl = url) }
    }

    private fun detectPageTotal(raw: String, current: Int): Int {
        var total = current
        val metaRegex = Regex(
            """"(?:pageCount|page_count|totalPages|total_pages|pagesCount|pages_count|imagesCount|images_count|nbPages|nb_pages|pages_total|img_count)"\s*:\s*(\d{1,4})""",
            RegexOption.IGNORE_CASE,
        )
        for (match in metaRegex.findAll(raw)) {
            val candidate = match.groupValues[1].toIntOrNull() ?: continue
            if (candidate in (total + 1)..499) total = candidate
        }

        val denominatorCounts = mutableMapOf<Int, Int>()
        Regex("""\b\d+\s*/\s*(\d{1,4})\b""").findAll(raw).forEach { match ->
            val candidate = match.groupValues[1].toIntOrNull() ?: return@forEach
            if (candidate in 2..999) {
                denominatorCounts[candidate] = (denominatorCounts[candidate] ?: 0) + 1
            }
        }
        denominatorCounts.maxByOrNull { it.value }?.key?.let { candidate ->
            if (candidate > total) total = candidate
        }

        return total
    }

    @Serializable
    private data class TermDto(
        val title: String = "",
    )

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
        val synopsis: String? = null,
        val type: String = "",
        val status: String = "",
        val poster: PosterDto? = null,
        val url: String? = null,
        val year: Int? = null,
        val originalLanguage: String? = null,
        val genres: List<TermDto>? = null,
        @SerialName("genre") val genreOld: List<TermDto>? = null,
        val demographics: List<TermDto>? = null,
        @SerialName("demographic") val demographicOld: List<TermDto>? = null,
        val formats: List<TermDto>? = null,
        val tags: List<TermDto>? = null,
        val authors: List<TermDto>? = null,
        @SerialName("author") val authorOld: List<TermDto>? = null,
        val artists: List<TermDto>? = null,
        @SerialName("artist") val artistOld: List<TermDto>? = null,
    ) {
        fun toSManga(basicOnly: Boolean): SManga = SManga.create().apply {
            url = this@MangaDto.url?.substringAfter("/title") ?: "/$hid"
            title = this@MangaDto.title
            thumbnail_url = poster?.best()

            if (!basicOnly) {
                author = (authors ?: authorOld).orEmpty().joinToString { it.title }
                artist = (artists ?: artistOld).orEmpty().joinToString { it.title }
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
                    addAll((genres ?: genreOld).orEmpty().map { it.title })
                    addAll((demographics ?: demographicOld).orEmpty().map { it.title })
                    addAll(formats.orEmpty().map { it.title })
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
    private data class SingleMangaResponse(
        val result: MangaDto,
    )

    @Serializable
    private data class MetaDto(
        val page: Int = 1,
        val lastPage: Int = 1,
        @SerialName("last_page") val lastPageOld: Int = 1,
    ) {
        val actualLastPage: Int get() = maxOf(lastPage, lastPageOld)
    }

    @Serializable
    private data class SearchResponse(
        val result: Items,
    ) {
        @Serializable
        data class Items(
            val items: List<MangaDto> = emptyList(),
            val meta: MetaDto? = null,
            val pagination: MetaDto? = null,
        ) {
            fun hasNextPage(): Boolean = when {
                meta != null -> meta.page < meta.actualLastPage
                pagination != null -> pagination.page < pagination.actualLastPage
                else -> false
            }
        }
    }

    @Serializable
    private data class ChapterDetailsResponse(
        val result: Items,
    ) {
        @Serializable
        data class Items(
            val items: List<ChapterDto> = emptyList(),
            val meta: MetaDto? = null,
            val pagination: MetaDto? = null,
        ) {
            fun hasNextPage(): Boolean = when {
                meta != null -> meta.page < meta.actualLastPage
                pagination != null -> pagination.page < pagination.actualLastPage
                else -> false
            }
        }
    }

    @Serializable
    private data class ChapterDto(
        val id: Int,
        val url: String = "",
        val number: Double = 0.0,
        val name: String = "",
        val votes: Int = 0,
        val createdAtFormatted: String = "",
        val group: ScanlationGroupDto? = null,
        val isOfficial: Boolean = false,
    ) {
        fun toSChapter(mangaPath: String): SChapter {
            val numberText = number.toString().removeSuffix(".0")
            val chapterPath = url.indexOf("/title/").let { index ->
                if (index >= 0) {
                    url.substring(index + 1)
                } else {
                    "title/$mangaPath/$id-chapter-$numberText"
                }
            }

            return SChapter.create().apply {
                url = chapterPath
                chapter_number = number.toFloat()
                name = buildString {
                    append("Chapter ")
                    append(numberText)
                    name.takeIf { it.isNotBlank() }?.let { append(": $it") }
                }
                date_upload = parseRelativeDate(createdAtFormatted)
                scanlator = group?.name ?: if (isOfficial) "Official" else null
            }
        }

        @Serializable
        data class ScanlationGroupDto(
            val id: Int? = null,
            val name: String = "",
        )
    }

    @Serializable
    private data class ChapterResponse(
        val result: ChapterResult,
    ) {
        @Serializable
        data class ChapterResult(
            val pages: Pages,
        )

        @Serializable
        data class Pages(
            val baseUrl: String,
            val items: List<PageDto> = emptyList(),
        )

        @Serializable
        data class PageDto(
            val url: String,
        )
    }

    private data class ImageCandidate(
        val url: String,
        val base: String,
        val number: Int,
        val digits: Int,
        val extension: String,
    )

    companion object {
        private const val MAX_CHAPTER_API_PAGES = 100

        private val CHAPTER_PATH_REGEX = Regex(
            """/title/[a-z0-9-]+/\d+-chapter-[\w.-]+""",
            RegexOption.IGNORE_CASE,
        )
        private val IMAGE_URL_REGEX = Regex(
            """https?://[^\s"'<>\\]+/\d+\.(?:webp|jpg|jpeg|png|avif)""",
            RegexOption.IGNORE_CASE,
        )
        private val IMAGE_PATTERN_REGEX = Regex(
            """^(https?://.+/)(\d+)(\.\w+)$""",
            RegexOption.IGNORE_CASE,
        )

        private val RELATIVE_DATE_REGEX = Regex(
            """^(\d+)\s*(s|m|h|d|w|mo|mos|y|yr|yrs|min|mins|sec|secs|hr|hrs|day|days|week|weeks|month|months|year|years)$""",
        )

        private fun parseRelativeDate(dateStr: String): Long {
            if (dateStr.isBlank()) return 0L
            val trimmed = dateStr.trim().lowercase().removeSuffix(" ago")
            val match = RELATIVE_DATE_REGEX.find(trimmed) ?: return 0L

            val amount = match.groupValues[1].toIntOrNull() ?: return 0L
            val unit = match.groupValues[2]
            val calendar = Calendar.getInstance()

            when (unit) {
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
