package eu.kanade.tachiyomi.extension.en.comix

/**
 * comix.to request-token + response-decryption cipher.
 *
 * Ported natively from the site's `secure-*.js` bundle. Every `/api/v1/manga*`
 * and `/api/v1/chapters/{id}` GET is signed with a `_` query token equal to
 * [encode] of the canonical `path?sortedParams` string, and the chapter/page
 * endpoints answer with encrypted JSON (response header `x-enc: 1`, body
 * `{"e":"<token>"}`) that must be run through [decode].
 *
 * The transform is three stacked layers of: per-byte 256-entry S-box
 * substitution, XOR against a repeating key, and CBC-style chaining where each
 * output byte seeds the next. Encoding runs the layers front-to-back; decoding
 * inverts each layer and runs them back-to-front.
 *
 * The S-boxes / keys / IVs live in the versioned `secure-*.js` bundle. If comix
 * rotates them the API starts returning HTTP 403 "Missing token"; refresh the
 * constants below with:
 *
 *   main=$(curl -s https://comix.to/ | grep -oE '/assets/build/[^"]+/dist/main-[^"]+\.js' | head -1)
 *   sec=$(curl -s "https://comix.to$main" | grep -oE 'secure-[A-Za-z0-9_]+\.js' | head -1)
 *   curl -s "https://comix.to$(dirname $main)/$sec" |
 *     grep -oE 'c\("[A-Za-z0-9+/=]+"\),e=c\("[A-Za-z0-9+/=]+"\),r=e\.length,o=n\.length,i=new Array\(o\),u=[0-9]+'
 *
 * The three matches (in source order) give SBOX/KEY/IV for layers 1, 2, 3.
 */
object ComixCrypto {

    // --- Layer key material (from secure-*.js; see refresh command above) ---
    private const val SBOX1 = "gbicCvAMzfcXEtGAyjvvhmb2yCWzWhjqcxXZ7ZhpzANOzoQLo3nuPZ2vK9dkb9hJExC0Vni/hdQBceI+mw611gkhQFjBuf4bJg1TxYqM+SL4YDqtwjxiGSdeH7so7Fn1HiRo37Z+RNvl44twXWVhomtMjw+8bemfmv9XEXr7mS82MxaCOJZRR0oHd9PLI5O+gyBGT6hcLoduNa7yCObVVCk3bFWsoD+xcqTrBcP6dNJN/NB1Br2QGhSN2snHAqeRNKVFQiyeAFLPSKGwY8aq9EPgsi17qd4ywPMxiH8w6N1qX1tLKtzhOeemHWeJQfFQ5H23q7qSlJUcjgTEl3x2/Q=="
    private const val KEY1 = "rafYl4oSAKQX+GYoic9oW4iGwiYpZzs0"
    private const val SBOX2 = "2lQehmgyYFAoWUi0haazZqHy5zZ34NN+VzlfsoB2Y1yY0IuMLjgVcV2xt8t4moH+AP0NMJ5qekW7DFIHEWKkOgIBIMhDdA8lbM6iHKjDlq6IChpb3CnA9NmsvQW/afdt1SfJjTdwcvpKqunCJLxBFmXX9hecm6tGb+HRxD7BC3njoxPxgnX5pdKP1IMSkd4/O3NRfZSE6DVLG2s9uexaipA05cpJzE8Qkv/z5jzHAwlEWOLd3yxA+0cvVbpOoJPFGc8f1lb4vu2HUxjuuEwEQk0GsPCVnyKvfOoh9TG2YYmZLV4I67UU2NsrrakqZ47k/O+ne25/DjPGZCMdnZcmzQ=="
    private const val KEY2 = "2USAq+VTo5ht4bQn+K9DUcpUQRTtrB56"
    private const val SBOX3 = "+mhJSFwzaV+PQPDyKp2scO/S9SdFsy/7e56UWT8XHbK3E2+19nEPwfwOgE9uVCaDtOAWTobCZX+cBCXlIbBqyDyQB1beKLspW6kGPhBCV9x0jf0KUeFhHjmlMf7qMFIB41PfDFprZ3bJiK4YxrZDv+K6dcwJmggVO8f5ktrXTM0cZL4fer0SpnkbvNajPbHxfuTz5lVEBarOI4rdc+2V6zTsjpfQYjgN1MMr6EvA6eehN6dQ1bgUogt9rZOBbQBeNnLYY00uZqSoJBnFi5gthCJsWF33ykosn9v/9KB8udMCz0YRYImrA4VHr5mMgpH4xDXLeEHRd5vZOiAalofuMg=="
    private const val KEY3 = "yNHlokVEnuecesDrB/lDhVuUNiheWc3a47VtkwZ2ENg="

    // Base64 tables are declared before [layers] because Layer init decodes its
    // S-box/key material through them (Kotlin object properties init top-to-bottom).
    private const val B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    private val B64_INV: IntArray = IntArray(128) { -1 }.also { for (i in B64.indices) it[B64[i].code] = i }

    private class Layer(sboxB64: String, keyB64: String, val iv: Int) {
        val sbox: IntArray = unsigned(b64Decode(sboxB64))
        val inverse: IntArray = IntArray(256).also { inv -> for (i in sbox.indices) inv[sbox[i]] = i }
        val key: IntArray = unsigned(b64Decode(keyB64))
    }

    private val layers: List<Layer> = listOf(
        Layer(SBOX1, KEY1, 189),
        Layer(SBOX2, KEY2, 133),
        Layer(SBOX3, KEY3, 32),
    )

    /** Encode a plaintext string into a `_` request token (base64url). */
    fun encode(input: String): String {
        var bytes = unsigned(input.toByteArray(Charsets.UTF_8))
        for (layer in layers) {
            val out = IntArray(bytes.size)
            var prev = layer.iv
            val key = layer.key
            for (a in bytes.indices) {
                val f = layer.sbox[(bytes[a] xor key[a % key.size] xor prev) and 0xFF]
                out[a] = f
                prev = f
            }
            bytes = out
        }
        return b64UrlEncode(bytes)
    }

    /** Decode a base64url token / encrypted response body back into UTF-8 text. */
    fun decode(token: String): String {
        var bytes = unsigned(b64UrlDecode(token))
        for (i in layers.indices.reversed()) {
            val layer = layers[i]
            val out = IntArray(bytes.size)
            var prev = layer.iv
            val key = layer.key
            for (s in bytes.indices) {
                val cipher = bytes[s]
                out[s] = (layer.inverse[cipher] xor key[s % key.size] xor prev) and 0xFF
                prev = cipher
            }
            bytes = out
        }
        return String(ByteArray(bytes.size) { bytes[it].toByte() }, Charsets.UTF_8)
    }

    // --- helpers ---

    private fun unsigned(bytes: ByteArray): IntArray = IntArray(bytes.size) { bytes[it].toInt() and 0xFF }

    private fun b64Decode(input: String): ByteArray {
        val s = input.trimEnd('=')
        val out = ByteArray(s.length * 3 / 4)
        var buffer = 0
        var bits = 0
        var o = 0
        for (c in s) {
            val v = if (c.code < 128) B64_INV[c.code] else -1
            if (v < 0) continue
            buffer = (buffer shl 6) or v
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out[o++] = ((buffer shr bits) and 0xFF).toByte()
            }
        }
        return if (o == out.size) out else out.copyOf(o)
    }

    private fun b64UrlEncode(bytes: IntArray): String {
        val sb = StringBuilder((bytes.size + 2) / 3 * 4)
        var i = 0
        while (i < bytes.size) {
            val b0 = bytes[i]
            val b1 = if (i + 1 < bytes.size) bytes[i + 1] else -1
            val b2 = if (i + 2 < bytes.size) bytes[i + 2] else -1
            sb.append(B64[b0 shr 2])
            sb.append(B64[((b0 and 0x03) shl 4) or (if (b1 >= 0) b1 shr 4 else 0)])
            if (b1 >= 0) sb.append(B64[((b1 and 0x0F) shl 2) or (if (b2 >= 0) b2 shr 6 else 0)])
            if (b2 >= 0) sb.append(B64[b2 and 0x3F])
            i += 3
        }
        return sb.toString().replace('+', '-').replace('/', '_')
    }

    private fun b64UrlDecode(input: String): ByteArray =
        b64Decode(input.replace('-', '+').replace('_', '/'))
}
