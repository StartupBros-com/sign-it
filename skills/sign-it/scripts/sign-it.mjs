#!/usr/bin/env node
// sign-it: stamp the operator's stored signature (and a date) onto the
// signature line of a PDF, optionally seal it cryptographically.
//
//   sign-it find   <in.pdf> [--no-ocr]                 list candidate signature slots
//   sign-it sign   <in.pdf> [--find TEXT|--pick N|--page P --x X --y Y --width W [--date-x X --date-y Y [--date-width W]]]
//                           [--date auto|none|TEXT] [--name] [--out FILE] [--preview] [--seal] [--no-ocr]
//   sign-it seal   <in.pdf> [--out FILE]               PAdES seal with the local PKCS#12 (pyhanko)
//   sign-it setup  [--from IMAGE.png] [--name "Full Name"] [--date-format long|iso|us] [--draw]
//   sign-it seal-setup                                 create a self-signed PKCS#12 + pyhanko venv
//   sign-it doctor
//
// Slot sources, in confidence order: AcroForm signature fields (/Sig widgets,
// 1.0; already-signed and hidden ones are reported as skipped), text-layer
// blanks after a label via pdftotext -bbox (0.9), and, for pages with no text
// layer, tesseract OCR (0.6-0.7, approximate: always check the preview).
// All geometry is kept in DISPLAY space (what the viewer shows, bottom-left
// origin) and converted to content space at draw time, so rotated pages get
// an upright stamp. A literal `--` ends option parsing. Commands print their
// JSON result on stdout; `doctor`, `setup`, `find` with no candidates and a
// failed `seal` do so even on a non-zero exit; hard failures print a
// `sign-it: <message>` block on stderr. Exit codes: 0 ok, 1 usage, 2 no
// signature configured, 3 no/ambiguous slot, 4 missing dependency, 5 pdf or
// file error. Never stamps at a guessed position and never fabricates a
// signature.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_ROOT = path.join(os.homedir(), '.config');
const CANONICAL_HOME = path.join(CONFIG_ROOT, 'sign-it');
const LEGACY_HOME = path.join(CONFIG_ROOT, 'sign-pdf');
function resolveHome() {
  if (process.env.SIGN_IT_HOME) return process.env.SIGN_IT_HOME;
  if (!fs.existsSync(CANONICAL_HOME) && fs.existsSync(LEGACY_HOME)) return LEGACY_HOME; // pre-rename install; setup migrates it
  return CANONICAL_HOME;
}
let HOME = resolveHome();
const f = () => ({ SIG: path.join(HOME, 'signature.png'), CFG: path.join(HOME, 'config.json'), CERT: path.join(HOME, 'cert.p12'), CERT_PASS: path.join(HOME, 'cert.pass'), VENV_PYHANKO: path.join(HOME, '.venv', 'bin', 'pyhanko') });
const PNG_MAGIC = '89504e470d0a1a0a';
const OCR_DPI = 200;

class Exit extends Error { constructor(code, msg) { super(msg); this.code = code; } }
function die(code, msg) { throw new Exit(code, msg); }
function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }

// PATH lookup without a shell, so the primitive is injection-proof by construction.
function have(cmd) {
  if (cmd.includes('/')) { try { fs.accessSync(cmd, fs.constants.X_OK); return cmd; } catch { return null; } }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}
function tesseractBin() { return have(process.env.SIGN_IT_TESSERACT || 'tesseract'); }
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) die(4, `${cmd} not runnable: ${r.error.message}`);
  return r;
}
function ensureHome() { fs.mkdirSync(HOME, { recursive: true, mode: 0o700 }); try { fs.chmodSync(HOME, 0o700); } catch {} }
function readConfig() { try { return JSON.parse(fs.readFileSync(f().CFG, 'utf8')); } catch { return {}; } }
function writeConfig(cfg) { ensureHome(); fs.writeFileSync(f().CFG, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 }); }

function parseArgs(argv) {
  const pos = []; const flags = {}; let onlyPos = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!onlyPos && a === '--') { onlyPos = true; continue; }
    if (!onlyPos && a.startsWith('--')) {
      const k = a.slice(2); const n = argv[i + 1];
      if (n === undefined || (n.startsWith('--') && n !== '--')) flags[k] = true; else { flags[k] = n; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}
function num(v, what) { const n = Number(v); if (!Number.isFinite(n)) die(1, `${what} must be a number (got "${v}")`); return n; }

async function loadPdfLib() {
  try { return await import('pdf-lib'); }
  catch { die(4, `pdf-lib is not installed. Run: pnpm install --dir "${SKILL_DIR}"  (or npm install --prefix "${SKILL_DIR}")`); }
}

// ---------- geometry: display space <-> content space ----------
function pageRotation(page) { let a = page.getRotation().angle % 360; if (a < 0) a += 360; return a; }
function displaySize(page) { const { width, height } = page.getSize(); const r = pageRotation(page); return (r === 90 || r === 270) ? { width: height, height: width } : { width, height }; }
// content box -> display box (both bottom-left origin)
function contentToDisplay(rot, pw, ph, b) {
  const x0 = b.x, y0 = b.y, x1 = b.x + b.width, y1 = b.y + b.height;
  if (rot === 90) return { x: y0, y: pw - x1, width: y1 - y0, height: x1 - x0 };
  if (rot === 180) return { x: pw - x1, y: ph - y1, width: b.width, height: b.height };
  if (rot === 270) return { x: ph - y1, y: x0, width: y1 - y0, height: x1 - x0 };
  return { ...b };
}
// display box -> content box
function displayToContent(rot, pw, ph, b) {
  const x0 = b.x, y0 = b.y, x1 = b.x + b.width, y1 = b.y + b.height;
  if (rot === 90) return { x: pw - y1, y: x0, width: y1 - y0, height: x1 - x0 };
  if (rot === 180) return { x: pw - x1, y: ph - y1, width: b.width, height: b.height };
  if (rot === 270) return { x: y0, y: ph - x1, width: y1 - y0, height: x1 - x0 };
  return { ...b };
}
// Anchor for a w x h object drawn with `rotate: degrees(rot)` so that it
// appears upright at the visual bottom-left of the display box (with a small
// inset). pdf-lib rotates around the object's own (x, y).
function anchorFor(rot, cbox, w, h, inset = { x: 4, y: 2 }) {
  if (rot === 90) return { x: cbox.x + cbox.width - inset.y, y: cbox.y + inset.x };
  if (rot === 180) return { x: cbox.x + cbox.width - inset.x, y: cbox.y + cbox.height - inset.y };
  if (rot === 270) return { x: cbox.x + inset.y, y: cbox.y + cbox.height - inset.x };
  return { x: cbox.x + inset.x, y: cbox.y + inset.y };
}

// ---------- word sources ----------
const LABEL_RE = /(signature|signed|\bsign\b|\bby\b|party|\bname\b|authori[sz]ed|client|customer|contractor|lessee|lessor|tenant|landlord|buyer|seller|employee|employer|licensee|licensor|witness|agreed|accepted|approved|owner|member|manager|director|president|officer|signer)/i;
const DATE_RE = /\bdate\b/i;
const BLANK_RE = /^_{3,}$/;
const BLANK_OCR_RE = /^[_\-\u2013\u2014]{3,}$/;

function decode(s) { return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }

function textWords(pdf) {
  if (!have('pdftotext')) die(4, 'pdftotext (poppler-utils) is required for slot finding; install it or pass --page/--x/--y');
  const r = run('pdftotext', ['-bbox', pdf, '-']);
  if (r.status !== 0) die(5, `pdftotext failed: ${r.stderr.trim()}`);
  const pages = []; let cur = null;
  for (const line of r.stdout.split('\n')) {
    let m = line.match(/<page width="([\d.]+)" height="([\d.]+)">/);
    if (m) { cur = { num: pages.length + 1, width: +m[1], height: +m[2], words: [], source: 'text' }; pages.push(cur); continue; }
    m = line.match(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/word>/);
    if (m && cur) cur.words.push({ xMin: +m[1], yMin: +m[2], xMax: +m[3], yMax: +m[4], text: decode(m[5]) });
  }
  return pages;
}

// Pages with no text layer: render (display orientation), OCR, map pixel
// boxes into display points (top-left origin, like pdftotext).
function ocrPage(pdf, page, scratchDir) {
  const tess = tesseractBin();
  if (!tess) die(4, `page ${page.num} has no text layer (scanned?) and tesseract is not installed; install tesseract-ocr for OCR, or pass --page/--x/--y after measuring a render`);
  if (!have('pdftoppm')) die(4, 'pdftoppm (poppler-utils) is required to OCR a scanned page');
  const base = path.join(scratchDir, `p${page.num}`);
  let r = run('pdftoppm', ['-f', String(page.num), '-l', String(page.num), '-r', String(OCR_DPI), '-png', '-singlefile', pdf, base]);
  if (r.status !== 0) die(5, `pdftoppm failed on page ${page.num}: ${r.stderr.trim()}`);
  r = run(tess, [base + '.png', '-', '--psm', '6', 'tsv'], { env: { ...process.env, OMP_THREAD_LIMIT: '1' } });
  if (r.status !== 0) die(5, `tesseract failed on page ${page.num}: ${(r.stderr || '').trim().slice(-300)}`);
  const k = 72 / OCR_DPI; const words = [];
  for (const line of r.stdout.split('\n').slice(1)) {
    const c = line.split('\t'); if (c.length < 12 || c[0] !== '5') continue;
    const text = c.slice(11).join('\t').trim(); if (!text) continue;
    const left = +c[6], top = +c[7], w = +c[8], h = +c[9];
    if (![left, top, w, h].every(Number.isFinite)) continue;
    words.push({ xMin: left * k, yMin: top * k, xMax: (left + w) * k, yMax: (top + h) * k, text });
  }
  page.words = words; page.source = 'ocr';
}

function pdfWords(pdf, flags, sizes) {
  const pages = textWords(pdf);
  // poppler prints the content-space MediaBox in the <page> header but word
  // boxes in display space, so a /Rotate 90 page comes back with the wrong
  // height; the display size from pdf-lib always wins.
  if (sizes) sizes.forEach((s, i) => {
    if (!pages[i]) pages[i] = { num: i + 1, width: s.width, height: s.height, words: [], source: 'text' };
    else { pages[i].width = s.width; pages[i].height = s.height; }
  });
  const empty = pages.filter(p => p.words.length === 0);
  if (empty.length && !flags['no-ocr']) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-it-ocr-'));
    try { for (const p of empty) ocrPage(pdf, p, scratch); }
    finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }
  return pages;
}

// AcroForm widgets read from each page's annotations. Field attributes are
// inherited up the Parent chain. /Sig fields with a value (already signed)
// and hidden widgets are reported as skipped, never stamped over silently.
function acroformSlots(doc, pdfLib) {
  const { PDFName, PDFDict, PDFArray, PDFString, PDFHexString } = pdfLib;
  const sigs = [], dates = [], skipped = [];
  const inherit = (dict, key) => {
    let d = dict, guard = 0;
    while (d instanceof PDFDict && guard++ < 32) {
      const v = d.get(PDFName.of(key)); if (v !== undefined) return v;
      const p = d.get(PDFName.of('Parent')); d = p ? doc.context.lookup(p) : null;
    }
    return undefined;
  };
  const widgetCount = (dict) => {
    let d = dict, guard = 0, best = 1;
    while (d instanceof PDFDict && guard++ < 32) {
      const kids = d.get(PDFName.of('Kids'));
      if (kids instanceof PDFArray) best = Math.max(best, kids.size());
      if (d.get(PDFName.of('T')) !== undefined) break; // reached the field
      const p = d.get(PDFName.of('Parent')); d = p ? doc.context.lookup(p) : null;
    }
    return best;
  };
  const asNum = v => (v && typeof v.asNumber === 'function') ? v.asNumber() : Number(v);
  doc.getPages().forEach((page, i) => {
    const annots = page.node.Annots(); if (!annots) return;
    const { width: pw, height: ph } = page.getSize();
    const rot = pageRotation(page); const disp = displaySize(page);
    for (const ref of annots.asArray()) {
      const dict = doc.context.lookup(ref); if (!(dict instanceof PDFDict)) continue;
      if (String(dict.get(PDFName.of('Subtype'))) !== '/Widget') continue;
      const ft = String(inherit(dict, 'FT') ?? '');
      const t = inherit(dict, 'T');
      const name = (t instanceof PDFString || t instanceof PDFHexString) ? t.decodeText() : (t ? String(t) : '');
      const rect = dict.get(PDFName.of('Rect')); if (!(rect instanceof PDFArray)) continue;
      const [x0, y0, x1, y1] = rect.asArray().map(asNum);
      if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
      const cbox = { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
      const dbox = contentToDisplay(rot, pw, ph, cbox);
      const flagsF = asNum(dict.get(PDFName.of('F'))) || 0;
      const label = `AcroForm: ${name || '(unnamed)'}`;
      if (ft === '/Sig' || (ft === '/Tx' && /date/i.test(name))) {
        if (dbox.width < 4 || dbox.height < 4) { skipped.push({ page: i + 1, label, reason: `degenerate rectangle (${dbox.width.toFixed(0)}x${dbox.height.toFixed(0)}pt)` }); continue; }
        if (dbox.x + dbox.width <= 0 || dbox.y + dbox.height <= 0 || dbox.x >= disp.width || dbox.y >= disp.height) { skipped.push({ page: i + 1, label, reason: 'rectangle lies off the page' }); continue; }
      }
      const slot = { page: i + 1, pageWidth: disp.width, pageHeight: disp.height, rot, fieldName: name, label, line: `AcroForm field ${name || '(unnamed)'}`,
        x: dbox.x, y: dbox.y, width: dbox.width, boxHeight: dbox.height,
        yMinTop: disp.height - (dbox.y + dbox.height), yMaxTop: disp.height - dbox.y, lineHeight: dbox.height, source: 'acroform', confidence: 1.0 };
      if (ft === '/Sig') {
        if (inherit(dict, 'V') !== undefined) { skipped.push({ page: i + 1, label, reason: 'already signed (the field has a signature value)' }); continue; }
        if (flagsF & 2) { skipped.push({ page: i + 1, label, reason: 'hidden widget' }); continue; }
        sigs.push({ ...slot, kind: 'signature' });
      } else if (ft === '/Tx' && /date/i.test(name)) {
        if (flagsF & 2) continue;
        const ff = asNum(inherit(dict, 'Ff')) || 0;
        dates.push({ ...slot, kind: 'date', readOnly: !!(ff & 1), widgetCount: widgetCount(dict), widgetRef: ref });
      }
    }
  });
  return { sigs, dates, skipped };
}

function groupLines(page) {
  const lines = [];
  for (const w of [...page.words].sort((a, b) => a.yMin - b.yMin || a.xMin - b.xMin)) {
    const tol = page.source === 'ocr' ? 6 : 3.5;
    const l = lines.find(L => Math.abs(L.yMin - w.yMin) < tol);
    if (l) { l.words.push(w); l.yMax = Math.max(l.yMax, w.yMax); } else lines.push({ yMin: w.yMin, yMax: w.yMax, words: [w] });
  }
  for (const l of lines) l.words.sort((a, b) => a.xMin - b.xMin);
  return lines;
}

function textSlots(pages, rots) {
  const slots = [];
  for (const page of pages) {
    const ocr = page.source === 'ocr'; const blankRe = ocr ? BLANK_OCR_RE : BLANK_RE;
    const rot = rots ? (rots[page.num - 1] || 0) : 0;
    const mk = (kind, label, line, x, w, lineTop, lineBottom, confidence, source) => ({
      page: page.num, pageWidth: page.width, pageHeight: page.height, rot, kind, label, line,
      x, y: page.height - lineBottom, width: w, yMinTop: lineTop, yMaxTop: lineBottom, lineHeight: lineBottom - lineTop, source, confidence });
    for (const line of groupLines(page)) {
      const text = line.words.map(w => w.text).join(' ');
      let prevBlank = -1, found = false;
      line.words.forEach((w, wi) => {
        if (!blankRe.test(w.text)) return;
        const between = line.words.slice(prevBlank + 1, wi).map(x => x.text);
        prevBlank = wi;
        const labelWords = between.slice(-4).join(' ');
        const isDate = DATE_RE.test(labelWords) && !/sign/i.test(labelWords);
        const isSig = !isDate && (LABEL_RE.test(labelWords) || /:\s*$/.test(between.join(' ')));
        if (!isSig && !isDate) return;
        found = true;
        slots.push(mk(isDate ? 'date' : 'signature', labelWords || '(unlabeled)', text, w.xMin, w.xMax - w.xMin, line.yMin, line.yMax, ocr ? 0.7 : 0.9, page.source));
      });
      // OCR pages: a drawn rule is invisible to OCR, so a short label segment
      // ("Party A:", "Signature of Tenant", "Sign here") anchors an
      // approximate slot to its right. Prose sentences never qualify.
      if (ocr && !found) {
        const segs = []; let cur = [line.words[0]];
        for (let i = 1; i < line.words.length; i++) { const w = line.words[i]; if (w.xMin - cur[cur.length - 1].xMax > 40) { segs.push(cur); cur = [w]; } else cur.push(w); }
        segs.push(cur);
        segs.forEach((seg, si) => {
          if (seg.length > 4) return;
          const stext = seg.map(w => w.text).join(' ');
          const lastWord = seg[seg.length - 1].text;
          if (/[.,;!?]$/.test(lastWord)) return;
          const isDate = DATE_RE.test(stext) && !/sign/i.test(stext);
          const isSig = !isDate && LABEL_RE.test(stext);
          if (!isSig && !isDate) return;
          const last = seg[seg.length - 1]; const nextSeg = segs[si + 1];
          const right = nextSeg ? nextSeg[0].xMin - 6 : page.width - 36;
          const width = Math.max(0, Math.min(right - last.xMax - 4, isDate ? 120 : 220));
          if (width < 30) return;
          slots.push(mk(isDate ? 'date' : 'signature', stext, text, last.xMax + 4, width, line.yMin, line.yMax, 0.6, 'ocr'));
        });
      }
    }
  }
  return slots;
}

function findSlots(pages, acro, rots) {
  const slots = textSlots(pages, rots);
  const sigs = [...acro.sigs, ...slots.filter(s => s.kind === 'signature')];
  const dates = [...acro.dates, ...slots.filter(s => s.kind === 'date')];
  for (const s of sigs) {
    s.date = dates.find(d => d.page === s.page && Math.abs(d.yMinTop - s.yMinTop) < (s.source === 'ocr' ? 8 : 3.5) && d.x > s.x)
      || dates.find(d => d.page === s.page && d.yMinTop > s.yMinTop && d.yMinTop - s.yMinTop < 28)
      || (s.source === 'acroform' ? dates.find(d => d.page === s.page && d.source === 'acroform') : null) || null;
    s.score = (/sign/i.test(s.label) ? 3 : 0) + (/\bby\b/i.test(s.label) ? 2 : 0) + (LABEL_RE.test(s.label) ? 1 : 0) + (s.source === 'acroform' ? 3 : 0);
  }
  return sigs.map((s, i) => ({ index: i + 1, ...s }));
}

function describe(slots) {
  return slots.map(s => `  [${s.index}] p${s.page} y=${s.yMinTop.toFixed(0)}pt ${s.source}  "${s.line.slice(0, 70)}"${s.date ? '  (+date slot)' : ''}`).join('\n');
}

// Selection policy (documented in SKILL.md): --pick or --find decide; with
// neither, a single candidate is used and anything else is exit 3.
function pickSlot(slots, flags, skipped) {
  const skippedNote = skipped && skipped.length ? `\n  skipped: ` + skipped.map(s => `p${s.page} ${s.label} (${s.reason})`).join('; ') : '';
  if (!slots.length) die(3, 'no signature slot found: no open AcroForm signature field and no labeled blank line (e.g. "Signature: ____" or "By: ____"). Render the page (pdftoppm -png) and pass --page --x --y --width explicitly.' + skippedNote);
  if (flags.pick) { const s = slots[num(flags.pick, '--pick') - 1]; if (!s) die(3, `--pick ${flags.pick} out of range 1..${slots.length}`); return s; }
  if (flags.find) {
    const q = String(flags.find).toLowerCase();
    const hits = slots.filter(s => s.line.toLowerCase().includes(q) || s.label.toLowerCase().includes(q));
    if (hits.length === 1) return hits[0];
    if (!hits.length) die(3, `--find "${flags.find}" matched no slot; candidates:\n` + describe(slots) + skippedNote);
    die(3, `--find "${flags.find}" is ambiguous (${hits.length} slots); use --pick N:\n` + describe(hits));
  }
  if (slots.length === 1) return slots[0];
  die(3, `${slots.length} candidate slots; choose with --find TEXT or --pick N:\n` + describe(slots) + skippedNote);
}

// ---------- commands ----------
function requireSignature() {
  const { SIG } = f();
  if (!fs.existsSync(SIG)) die(2, `no signature configured at ${SIG}. One-time setup: draw it with \`sign-it setup --draw\` or import a transparent PNG with \`sign-it setup --from IMAGE.png\`. Nothing was written.`);
  if (fs.readFileSync(SIG).subarray(0, 8).toString('hex') !== PNG_MAGIC) die(2, `${SIG} is not a PNG file`);
}
async function decodablePng(bytes, pdfLib) {
  try { const probe = await pdfLib.PDFDocument.create(); await probe.embedPng(bytes); return true; } catch { return false; }
}
function fmtDate(spec, cfg, style) {
  if (spec === 'none') return null;
  if (spec && spec !== 'auto' && spec !== true) return String(spec);
  const d = new Date(); const s = style || cfg.dateFormat || 'long';
  const pad = n => String(n).padStart(2, '0');
  if (s === 'iso') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // local calendar day, never UTC
  if (s === 'us') return d.toLocaleDateString('en-US');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
function sameFile(a, b) {
  try {
    const ra = fs.realpathSync(a);
    const rb = fs.existsSync(b) ? fs.realpathSync(b) : path.join(fs.realpathSync(path.dirname(b)), path.basename(b));
    return ra === rb;
  } catch { return false; }
}
function candidateView(s) {
  return { index: s.index, page: s.page, source: s.source, confidence: s.confidence, label: s.label, line: s.line, x: +s.x.toFixed(1), y: +s.y.toFixed(1), width: +s.width.toFixed(1), rotation: s.rot || 0, score: s.score,
    date: s.date ? { source: s.date.source, x: +s.date.x.toFixed(1), y: +s.date.y.toFixed(1), width: +s.date.width.toFixed(1) } : null };
}
function pageMeta(doc) { return doc.getPages().map(p => ({ size: displaySize(p), rot: pageRotation(p) })); }

async function cmdFind(pos, flags) {
  const pdf = pos[0]; if (!pdf) die(1, 'usage: sign-it find <in.pdf> [--no-ocr]');
  if (!fs.existsSync(pdf)) die(5, `no such file: ${pdf}`);
  const pdfLib = await loadPdfLib();
  const doc = await pdfLib.PDFDocument.load(fs.readFileSync(pdf)).catch(e => die(5, `cannot open PDF: ${e.message}`));
  const meta = pageMeta(doc);
  const acro = acroformSlots(doc, pdfLib);
  const slots = findSlots(pdfWords(pdf, flags, meta.map(m => m.size)), acro, meta.map(m => m.rot));
  out({ file: pdf, candidates: slots.map(candidateView), skipped: acro.skipped });
  if (!slots.length) process.exit(3);
}

async function cmdSign(pos, flags) {
  const pdf = pos[0]; if (!pdf) die(1, 'usage: sign-it sign <in.pdf> [--find TEXT|--pick N|--page P --x X --y Y --width W] [--date auto|none|TEXT] [--name] [--out FILE] [--preview] [--seal] [--no-ocr]');
  if (!fs.existsSync(pdf)) die(5, `no such file: ${pdf}`);
  requireSignature();
  const cfg = readConfig();
  const pdfLib = await loadPdfLib();
  const { PDFDocument, StandardFonts, rgb, degrees } = pdfLib;
  const outPath = flags.out ? String(flags.out) : path.join(path.dirname(pdf), path.basename(pdf).replace(/\.pdf$/i, '') + '-signed.pdf');
  if (!fs.existsSync(path.dirname(outPath))) die(5, `output directory does not exist: ${path.dirname(outPath)}`);
  if (sameFile(pdf, outPath)) die(1, 'refusing to overwrite the input; pass a different --out');
  const doc = await PDFDocument.load(fs.readFileSync(pdf)).catch(e => die(5, `cannot open PDF: ${e.message}`));
  const png = await doc.embedPng(fs.readFileSync(f().SIG)).catch(e => die(5, `stored signature is not a decodable PNG (${e.message}); re-run sign-it setup --from with a valid PNG`));
  const meta = pageMeta(doc);
  let slot, skipped = [];
  if (flags.page !== undefined || flags.x !== undefined || flags.y !== undefined) {
    if (!(flags.page !== undefined && flags.x !== undefined && flags.y !== undefined)) die(1, 'manual placement needs --page, --x and --y (points from the bottom-left as displayed, or percentages like 20%)');
    const pageNo = num(flags.page, '--page');
    if (pageNo < 1 || pageNo > doc.getPageCount() || !Number.isInteger(pageNo)) die(1, `--page must be 1..${doc.getPageCount()}`);
    const { width: pw, height: ph } = meta[pageNo - 1].size;
    const pct = (v, total, what) => String(v).endsWith('%') ? total * num(String(v).slice(0, -1), what) / 100 : num(v, what);
    const x = pct(flags.x, pw, '--x'), y = pct(flags.y, ph, '--y'), width = flags.width !== undefined ? pct(flags.width, pw, '--width') : 150;
    if (x < 0 || x > pw || y < 0 || y > ph) die(1, `placement is off the page (page ${pageNo} is ${pw.toFixed(0)}x${ph.toFixed(0)}pt as displayed; got x=${x.toFixed(0)}, y=${y.toFixed(0)})`);
    if (width <= 0 || x + width > pw + 1) die(1, `--width ${width.toFixed(0)}pt runs off the page at x=${x.toFixed(0)}`);
    slot = { page: pageNo, x, y, width, lineHeight: 13, rot: meta[pageNo - 1].rot, date: null, label: '(manual)', line: '(manual placement)', source: 'manual', confidence: 1 };
    if (flags['date-x'] !== undefined || flags['date-y'] !== undefined) {
      if (!(flags['date-x'] !== undefined && flags['date-y'] !== undefined)) die(1, 'manual date placement needs both --date-x and --date-y (plus optional --date-width)');
      const dx = pct(flags['date-x'], pw, '--date-x'), dy = pct(flags['date-y'], ph, '--date-y'), dw = flags['date-width'] !== undefined ? pct(flags['date-width'], pw, '--date-width') : 90;
      if (dx < 0 || dx > pw || dy < 0 || dy > ph) die(1, `date placement is off the page (got x=${dx.toFixed(0)}, y=${dy.toFixed(0)})`);
      slot.date = { x: dx, y: dy, width: dw, lineHeight: 12, source: 'manual' };
    }
  } else {
    const acro = acroformSlots(doc, pdfLib); skipped = acro.skipped;
    slot = pickSlot(findSlots(pdfWords(pdf, flags, meta.map(m => m.size)), acro, meta.map(m => m.rot)), flags, skipped);
  }
  const page = doc.getPage(slot.page - 1);
  const { width: pw, height: ph } = page.getSize();
  const rot = slot.rot || 0;
  const inBox = slot.source === 'acroform';
  const maxW = Math.max(40, Math.min(slot.width - 8, num(flags['max-width'] ?? cfg.maxWidth ?? 170, '--max-width')));
  const maxH = inBox ? Math.max(slot.boxHeight - 4, 10) : Math.max(slot.lineHeight * 2.6, 26);
  let w = maxW, h = w * (png.height / png.width);
  if (h > maxH) { h = maxH; w = h * (png.width / png.height); }
  const dbox = { x: slot.x, y: slot.y, width: slot.width, height: inBox ? slot.boxHeight : maxH };
  const cbox = displayToContent(rot, pw, ph, dbox);
  const a = anchorFor(rot, cbox, w, h);
  page.drawImage(png, { x: a.x, y: a.y, width: w, height: h, rotate: degrees(rot) });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const drawTextIn = (text, size, box, color) => {
    const cb = displayToContent(rot, pw, ph, box); const t = anchorFor(rot, cb, font.widthOfTextAtSize(text, size), size, { x: 2, y: 2 });
    page.drawText(text, { x: t.x, y: t.y, size, font, color, rotate: degrees(rot) });
  };
  const wantDate = (flags.date ?? 'auto') !== 'none';
  let datePlaced = null, dateNote = null;
  const fitText = (text, base, avail) => {
    let size = base, tw = font.widthOfTextAtSize(text, size);
    if (tw > avail) { size = Math.max(6, base * avail / tw); tw = font.widthOfTextAtSize(text, size); }
    if (tw > avail && (flags.date ?? 'auto') === 'auto') { text = fmtDate('auto', cfg, 'iso'); size = base; tw = font.widthOfTextAtSize(text, size); if (tw > avail) { size = Math.max(6, base * avail / tw); tw = font.widthOfTextAtSize(text, size); } }
    return { text, size, fits: tw <= avail };
  };
  if (wantDate && slot.date && slot.date.source === 'acroform' && slot.date.readOnly) {
    dateNote = `date field "${slot.date.fieldName}" is read-only; no date was stamped`;
  } else if (wantDate && slot.date && slot.date.source === 'acroform' && (slot.date.widgetCount || 1) === 1 && rot === 0) {
    // A real text field with one widget on an unrotated page: set its value
    // so the field's own appearance shows it, instead of drawing under the
    // widget. (pdf-lib's generated appearance ignores page rotation, so
    // rotated pages take the drawing path below.)
    let text = fmtDate(flags.date ?? 'auto', cfg);
    try {
      const tf = doc.getForm().getTextField(slot.date.fieldName);
      const maxLen = tf.getMaxLength();
      if (maxLen !== undefined && text.length > maxLen && (flags.date ?? 'auto') === 'auto') text = fmtDate('auto', cfg, 'iso');
      if (maxLen !== undefined && text.length > maxLen) die(5, `date field "${slot.date.fieldName}" allows ${maxLen} characters; "${text}" does not fit`);
      const avail = slot.date.width - 6;
      let size = Math.min(11, Math.max(7, slot.date.boxHeight * 0.55));
      if (font.widthOfTextAtSize(text, size) > avail && (flags.date ?? 'auto') === 'auto') text = fmtDate('auto', cfg, 'iso');
      while (size > 6 && font.widthOfTextAtSize(text, size) > avail) size -= 0.5;
      tf.setFontSize(size); tf.setText(text); tf.enableReadOnly(); tf.updateAppearances(font);
      datePlaced = text;
    } catch (e) {
      if (e instanceof Exit) dateNote = `${e.message}; no date was stamped`;
      else dateNote = `date field "${slot.date.fieldName}" could not be filled (${e.message}); no date was stamped`;
    }
  } else if (wantDate && slot.date) {
    // Text/OCR date slot, or a form field shared across pages: draw over this box only.
    const base = Math.min(10, Math.max(7, slot.date.lineHeight * 0.75));
    const r = fitText(fmtDate(flags.date ?? 'auto', cfg), base, slot.date.width - 2);
    if (!r.fits) dateNote = `date slot is ${slot.date.width.toFixed(0)}pt wide; "${r.text}" does not fit even at 6pt, so no date was stamped`;
    else {
      if (slot.date.source === 'acroform' && slot.date.widgetRef) {
        // The widget's own appearance would paint over anything drawn on the
        // page beneath it, so hide this page's widget and draw the date in its box.
        const { PDFName, PDFNumber, PDFDict } = pdfLib;
        const wd = doc.context.lookup(slot.date.widgetRef);
        if (wd instanceof PDFDict) { const cur = wd.get(PDFName.of('F')); const n = cur && typeof cur.asNumber === 'function' ? cur.asNumber() : 0; wd.set(PDFName.of('F'), PDFNumber.of(n | 2)); }
      }
      drawTextIn(r.text, r.size, { x: slot.date.x, y: slot.date.y, width: slot.date.width, height: slot.date.lineHeight || r.size + 4 }, rgb(0.1, 0.1, 0.1));
      datePlaced = r.text;
      if (slot.date.source === 'acroform') dateNote = rot !== 0
        ? `date field "${slot.date.fieldName}" is on a rotated page; its widget was hidden and the date drawn upright in its box`
        : `date field "${slot.date.fieldName}" has widgets on several pages; this page's widget was hidden and the date drawn in its box`;
    }
  } else if (wantDate) {
    dateNote = 'no date field found near the signature line; no date was stamped';
  }
  if (flags.name || cfg.printName) {
    const name = typeof flags.name === 'string' ? flags.name : (cfg.name || null);
    if (name) drawTextIn(name, 7, { x: slot.x, y: Math.max(0, slot.y - 11), width: slot.width, height: 9 }, rgb(0.35, 0.35, 0.35));
  }
  fs.writeFileSync(outPath, await doc.save());
  const result = { out: outPath, page: slot.page, source: slot.source, confidence: slot.confidence, label: slot.label, line: slot.line, x: +a.x.toFixed(1), y: +a.y.toFixed(1), width: +w.toFixed(1), height: +h.toFixed(1), rotation: rot, date: datePlaced, dateNote, skipped, sealed: false, preview: null };
  if (slot.source === 'ocr') result.ocrNote = 'placement comes from OCR of a scanned page and is approximate; check the preview before delivering';
  if (flags.preview) result.preview = preview(outPath, slot.page);
  if (flags.seal) result.sealed = seal(outPath, outPath.replace(/\.pdf$/i, '') + '-sealed.pdf', result);
  out(result);
}

function preview(pdf, pageNum) {
  if (!have('pdftoppm')) return null;
  const base = pdf.replace(/\.pdf$/i, '') + '-preview';
  const r = run('pdftoppm', ['-f', String(pageNum), '-l', String(pageNum), '-png', '-r', '70', '-singlefile', pdf, base]);
  return r.status === 0 ? base + '.png' : null;
}

function pyhanko() { const { VENV_PYHANKO } = f(); return fs.existsSync(VENV_PYHANKO) ? VENV_PYHANKO : have('pyhanko'); }
function seal(inPdf, outPdf, result) {
  const { CERT, CERT_PASS } = f();
  const bin = pyhanko();
  if (!bin) { if (result) result.sealNote = 'pyhanko not installed; run `sign-it seal-setup`'; return false; }
  if (!fs.existsSync(CERT) || !fs.existsSync(CERT_PASS)) { if (result) result.sealNote = `no ${CERT}; run \`sign-it seal-setup\``; return false; }
  const r = run(bin, ['sign', 'addsig', '--field', 'Sig1', '--use-pades', 'pkcs12', '--passfile', CERT_PASS, inPdf, outPdf, CERT]);
  if (r.status !== 0) { if (result) result.sealNote = `pyhanko failed: ${(r.stderr || '').trim().slice(-300)}`; return false; }
  if (result) {
    result.sealedOut = outPdf;
    if (have('pdfsig')) result.pdfsig = run('pdfsig', [outPdf]).stdout.split('\n').filter(l => /Validation|Signature Type|Common Name/.test(l)).map(l => l.trim());
  }
  return true;
}
async function cmdSeal(pos, flags) {
  const pdf = pos[0]; if (!pdf) die(1, 'usage: sign-it seal <in.pdf> [--out FILE]');
  if (!fs.existsSync(pdf)) die(5, `no such file: ${pdf}`);
  const outPdf = flags.out ? String(flags.out) : pdf.replace(/\.pdf$/i, '') + '-sealed.pdf';
  if (sameFile(pdf, outPdf)) die(1, 'refusing to overwrite the input; pass a different --out');
  const result = { in: pdf, out: outPdf };
  const ok = seal(pdf, outPdf, result);
  out({ ...result, sealed: ok });
  if (!ok) process.exit(4);
}

async function cmdSetup(flags) {
  let migrated = null;
  if (!process.env.SIGN_IT_HOME && HOME === LEGACY_HOME && !fs.existsSync(CANONICAL_HOME)) {
    fs.renameSync(LEGACY_HOME, CANONICAL_HOME); HOME = CANONICAL_HOME; migrated = `${LEGACY_HOME} -> ${CANONICAL_HOME}`;
  }
  ensureHome();
  const cfg = readConfig();
  if (typeof flags.name === 'string') { cfg.name = flags.name; writeConfig(cfg); }
  if (typeof flags['date-format'] === 'string') { cfg.dateFormat = flags['date-format']; writeConfig(cfg); }
  if (flags.from) {
    const src = String(flags.from);
    if (!fs.existsSync(src)) die(1, `no such file: ${src}`);
    const bytes = fs.readFileSync(src);
    if (bytes.subarray(0, 8).toString('hex') !== PNG_MAGIC) die(1, 'signature must be a PNG, ideally with a transparent background. For a JPG or photo, use setup --draw instead, or remove the white background with any image tool first.');
    if (!(await decodablePng(bytes, await loadPdfLib()))) die(1, `${src} has a PNG header but does not decode as a PNG; export it again`);
    fs.writeFileSync(f().SIG, bytes, { mode: 0o600 }); fs.chmodSync(f().SIG, 0o600);
  }
  if (flags.draw) {
    const page = path.join(SKILL_DIR, 'setup', 'draw.html');
    const opener = (process.env.SIGN_IT_OPENER && have(process.env.SIGN_IT_OPENER)) || have('xdg-open') || have('open');
    if (opener) spawnSync(opener, [page], { stdio: 'ignore' });
    out({ draw: page, opened: !!opener, migrated, next: 'draw your signature in the page, click Download, then run: sign-it setup --from <downloaded signature.png>' });
    return;
  }
  const ready = fs.existsSync(f().SIG);
  out({ home: HOME, migrated, signature: ready ? f().SIG : null, config: cfg, ready });
  if (!ready) process.exit(2);
}

function cmdSealSetup() {
  ensureHome();
  const { CERT, CERT_PASS } = f();
  if (!have('openssl')) die(4, 'openssl is required');
  if (!fs.existsSync(CERT)) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const pass = [...Array(24)].map(() => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
    fs.writeFileSync(CERT_PASS, pass, { mode: 0o600 });
    const cn = readConfig().name || os.userInfo().username;
    const key = path.join(HOME, 'cert.key'), crt = path.join(HOME, 'cert.crt');
    try {
      let r = run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '1095', '-subj', `/CN=${cn}`]);
      if (fs.existsSync(key)) fs.chmodSync(key, 0o600);
      if (fs.existsSync(crt)) fs.chmodSync(crt, 0o600);
      if (r.status !== 0) die(4, `openssl req failed: ${r.stderr}`);
      r = run('openssl', ['pkcs12', '-export', '-out', CERT, '-inkey', key, '-in', crt, '-passout', `pass:${pass}`, '-keypbe', 'AES-256-CBC', '-certpbe', 'AES-256-CBC', '-macalg', 'sha256']);
      if (r.status !== 0) die(4, `openssl pkcs12 failed: ${r.stderr}`);
      fs.chmodSync(CERT, 0o600);
    } finally {
      fs.rmSync(key, { force: true }); // the unencrypted key never outlives this command
    }
  }
  if (!pyhanko()) {
    const uv = have('uv'); if (!uv) die(4, 'uv is required to create the pyhanko venv (https://docs.astral.sh/uv/)');
    const venv = path.join(HOME, '.venv');
    let r = run(uv, ['venv', venv]); if (r.status !== 0) die(4, `uv venv failed: ${r.stderr}`);
    r = run(uv, ['pip', 'install', '--python', path.join(venv, 'bin', 'python'), 'pyhanko', 'pyhanko-cli']); if (r.status !== 0) die(4, `uv pip install failed: ${r.stderr.slice(-400)}`);
  }
  out({ cert: CERT, pyhanko: pyhanko(), note: 'self-signed: verifiers show the seal as valid but the issuer as untrusted; it proves integrity, not third-party identity' });
}

async function cmdDoctor() {
  let pdfLib = false; try { await import('pdf-lib'); pdfLib = true; } catch {}
  const { SIG, CERT } = f();
  const r = { skillDir: SKILL_DIR, home: HOME, legacyHome: HOME === LEGACY_HOME ? `using the pre-rename ${LEGACY_HOME}; run \`sign-it setup\` once to move it to ${CANONICAL_HOME}` : null,
    signature: fs.existsSync(SIG), config: readConfig(), pdfLib, node: process.version,
    pdftotext: !!have('pdftotext'), pdftoppm: !!have('pdftoppm'), tesseract: !!tesseractBin(), pdfsig: !!have('pdfsig'), pyhanko: !!pyhanko(), cert: fs.existsSync(CERT) };
  r.ready = r.signature && r.pdfLib && r.pdftotext;
  out(r);
  if (!r.ready) process.exit(r.signature ? 4 : 2);
}

try {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos.shift();
  switch (cmd) {
    case 'find': await cmdFind(pos, flags); break;
    case 'sign': await cmdSign(pos, flags); break;
    case 'seal': await cmdSeal(pos, flags); break;
    case 'setup': await cmdSetup(flags); break;
    case 'seal-setup': cmdSealSetup(); break;
    case 'doctor': await cmdDoctor(); break;
    default: die(1, 'usage: sign-it <find|sign|seal|setup|seal-setup|doctor> ... (see the header of scripts/sign-it.mjs)');
  }
} catch (e) {
  if (e instanceof Exit) { process.stderr.write(`sign-it: ${e.message}\n`); process.exit(e.code); }
  process.stderr.write(`sign-it: ${e && e.message ? e.message : String(e)}\n`); process.exit(5);
}
