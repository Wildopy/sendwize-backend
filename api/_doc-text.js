// ─────────────────────────────────────────────────────────────
// SENDWIZE: _doc-text.js  v1.0
// Reads an uploaded document for the copy checker.
//
//   readDocument({ name, mediaType, data })  data = base64
//     → { kind: 'pdf', pdfBase64 }        a PDF goes to Claude as a
//                                         document, so it sees the
//                                         layout, images and small print
//     → { kind: 'text', text, pages }     Word (.docx) and PowerPoint
//                                         (.pptx) are read here, so the
//                                         code checks (house rules, facts)
//                                         run on their words too
//     → throws Error(message for the member) when it can't be read
//
// .docx and .pptx are zip files of XML. A small zip reader (node:zlib, no
// new dependency) pulls out the text. Old .doc/.ppt files are not
// supported: the member is asked to save as .docx/.pptx or PDF.
//
// v1.0 (24 Nov 2026): first version.
// ─────────────────────────────────────────────────────────────
import { inflateRawSync } from 'node:zlib';

export const MAX_FILE_BYTES = 3 * 1024 * 1024;   // keeps the request under Vercel's 4.5MB body limit
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;       // per XML part once unzipped (zip bomb guard)
const MAX_TEXT = 60000;

export const DOC_TYPES = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};
const EXT = { pdf: 'pdf', docx: 'docx', pptx: 'pptx' };

function kindOf(name, mediaType) {
  if (DOC_TYPES[mediaType]) return DOC_TYPES[mediaType];
  const ext = String(name || '').toLowerCase().split('.').pop();
  return EXT[ext] || null;
}

// ── Minimal zip reader ──
function unzip(buf, wanted) {
  // End of central directory: last 22+ bytes, signature 0x06054b50
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (!wanted(name)) continue;
    if (usize > MAX_ENTRY_BYTES) throw new Error('too big');
    if (buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }) : null;
    if (data) out[name] = data.toString('utf8');
  }
  return out;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()]);

// Paragraph by paragraph: text runs (<w:t>/<a:t>), tabs and line breaks
function xmlText(xml, ns) {
  return xml.split(new RegExp(`</${ns}:p>`)).map(para => {
    let s = '';
    const re = new RegExp(`<${ns}:t(?:\\s[^>]*)?>([\\s\\S]*?)</${ns}:t>|<${ns}:tab\\s*/>|<${ns}:br\\s*/>`, 'g');
    let m;
    while ((m = re.exec(para))) s += m[1] !== undefined ? decode(m[1]) : m[0].includes('tab') ? '\t' : '\n';
    return s.trim();
  }).filter(Boolean).join('\n');
}

const num = name => parseInt((name.match(/(\d+)\.xml$/) || [])[1] || '0', 10);

function readDocx(buf) {
  const parts = unzip(buf, n => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n));
  if (!parts['word/document.xml']) throw new Error('no document');
  const order = n => (n === 'word/document.xml' ? 1 : /header/.test(n) ? 0 : 2);
  const names = Object.keys(parts).sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  return { text: names.map(n => xmlText(parts[n], 'w')).filter(Boolean).join('\n\n'), pages: null };
}

function readPptx(buf) {
  const parts = unzip(buf, n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const names = Object.keys(parts).sort((a, b) => num(a) - num(b));
  if (!names.length) throw new Error('no slides');
  const text = names.map((n, i) => { const t = xmlText(parts[n], 'a'); return t ? `[Slide ${i + 1}]\n${t}` : ''; }).filter(Boolean).join('\n\n');
  return { text, pages: names.length };
}

export function readDocument(file) {
  const name = String(file?.name || '').slice(0, 200);
  const kind = kindOf(name, file?.mediaType);
  if (!kind) throw new Error('Upload a PDF, Word (.docx) or PowerPoint (.pptx) file. For an older .doc or .ppt, save it as .docx, .pptx or PDF first.');
  const b64 = String(file?.data || '').replace(/^data:[^,]*,/, '');
  if (!b64) throw new Error('The file is empty.');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_FILE_BYTES) throw new Error('The file is over 3MB. Save a smaller copy (for example, compress the images) or upload the pages that matter.');
  if (kind === 'pdf') {
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('That file doesn\'t look like a PDF.');
    return { kind: 'pdf', pdfBase64: buf.toString('base64'), name };
  }
  let got;
  try { got = kind === 'docx' ? readDocx(buf) : readPptx(buf); }
  catch { throw new Error(`We couldn't read that ${kind === 'docx' ? 'Word' : 'PowerPoint'} file. Save it again as .${kind} or PDF and retry.`); }
  const text = got.text.slice(0, MAX_TEXT).trim();
  if (!text) throw new Error('We couldn\'t find any text in that file. If the words are in images, upload it as a PDF instead.');
  return { kind: 'text', text, pages: got.pages, name, truncated: got.text.length > MAX_TEXT };
}
