/**
 * Ordered image-to-PDF output for Comix Downloader.
 *
 * Depends on pdf-lib's UMD build (`globalThis.PDFLib`). The caller supplies a
 * converter for browser-native formats PDF does not embed directly (WebP,
 * AVIF, GIF). JPEG and PNG bytes are embedded unchanged.
 */
(function (global) {
  'use strict';

  const MAX_PDF_PAGE_POINTS = 14400;

  function normalizedExtension(file) {
    const explicit = String(file && file.ext || '').toLowerCase().replace(/^\./, '');
    if (explicit) return explicit === 'jpeg' ? 'jpg' : explicit;
    const match = String(file && file.name || '').match(/\.([a-z0-9]+)$/i);
    const ext = match ? match[1].toLowerCase() : '';
    return ext === 'jpeg' ? 'jpg' : ext;
  }

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new Error('PDF page image bytes are missing.');
  }

  function setMetadata(doc, metadata) {
    metadata = metadata || {};
    const title = String(metadata.title || '').trim();
    const subject = String(metadata.subject || '').trim();
    const author = String(metadata.author || '').trim();
    const keywords = Array.isArray(metadata.keywords)
      ? metadata.keywords.map(String).filter(Boolean)
      : [];
    if (title) doc.setTitle(title);
    if (subject) doc.setSubject(subject);
    if (author) doc.setAuthor(author);
    if (keywords.length) doc.setKeywords(keywords);
    doc.setCreator('Comix Downloader');
    doc.setProducer('Comix Downloader with pdf-lib');
  }

  async function buildChapterPdf(files, options) {
    options = options || {};
    const PDFDocument = global.PDFLib && global.PDFLib.PDFDocument;
    if (!PDFDocument) throw new Error('The PDF generator is unavailable. Reload the extension and try again.');
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error('No chapter images are available for the PDF.');
    }

    const prepareImage = typeof options.prepareImage === 'function'
      ? options.prepareImage
      : async (file) => ({ bytes: file.buffer, ext: normalizedExtension(file) });
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const yieldEvery = Math.max(1, Math.floor(Number(options.yieldEvery) || 8));
    const doc = await PDFDocument.create();
    setMetadata(doc, options.metadata);

    for (let index = 0; index < files.length; index++) {
      const prepared = await prepareImage(files[index], index);
      const ext = normalizedExtension(prepared) || normalizedExtension(files[index]);
      const bytes = asBytes(prepared && (prepared.bytes || prepared.buffer));
      let image;
      if (ext === 'jpg') image = await doc.embedJpg(bytes);
      else if (ext === 'png') image = await doc.embedPng(bytes);
      else throw new Error(`Page ${index + 1} uses unsupported ${ext || 'unknown'} image data.`);

      const sourceWidth = Math.max(1, Number(image.width) || 1);
      const sourceHeight = Math.max(1, Number(image.height) || 1);
      const scale = Math.min(1, MAX_PDF_PAGE_POINTS / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, sourceWidth * scale);
      const height = Math.max(1, sourceHeight * scale);
      const page = doc.addPage([width, height]);
      page.drawImage(image, { x: 0, y: 0, width, height });

      if (onProgress) onProgress({
        current: index + 1,
        total: files.length,
        phase: 'pages',
        finalizing: false,
      });
      if ((index + 1) % yieldEvery === 0 && index + 1 < files.length) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    // Image streams already contain the overwhelming majority of the output.
    // Skipping PDF object streams avoids a second compression-heavy pass over
    // the document and makes finalization substantially faster for long chapters.
    if (onProgress) onProgress({
      current: files.length,
      total: files.length,
      phase: 'finalizing',
      finalizing: true,
    });
    return doc.save({ useObjectStreams: false, addDefaultPage: false, objectsPerTick: 100 });
  }

  const api = { MAX_PDF_PAGE_POINTS, normalizedExtension, buildChapterPdf };
  global.CDLPdf = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
