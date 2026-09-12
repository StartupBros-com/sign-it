#!/usr/bin/env node
// sign-it: stamp the operator's stored signature (and a date) onto the
// signature line of a PDF, optionally seal it cryptographically.
//
//   sign-it find   <in.pdf> [--no-ocr]                 list candidate signature slots
//   sign-it sign   <in.pdf> [--find TEXT|--pick N|--page P --x X --y Y --width W [--date-x X --date-y Y [--date-width W]]]
//                           [--date auto|none|TEXT] [--name] [--height PT] [--out FILE] [--preview] [--seal] [--no-ocr|--ocr] [--no-ink|--over-ink]
//   sign-it seal   <in.pdf> [--out FILE]               PAdES seal with the local PKCS#12 (pyhanko)
//   sign-it setup  [--from IMAGE.png] [--name "Full Name"] [--date-format long|iso|us] [--draw]
//   sign-it seal-setup                                 create a self-signed PKCS#12 + pyhanko venv
//   sign-it doctor
//   sign-it convert <in.docx> [--out FILE] [--force]  Word document -> PDF (LibreOffice headless, or on WSL
//                                                     the Windows-side Word through powershell.exe)
//
// Slot sources, in confidence order: AcroForm signature fields (/Sig widgets,
// 1.0; already-signed and hidden ones are reported as skipped), text-layer
// blanks after a label via pdftotext -bbox (0.9), OCR of pages with no text
// layer (0.6-0.7), and a short label with a wide gap beside it where a drawn
// rule usually sits (text-label, 0.5). Anything below 0.7 is never
// auto-picked: it needs --find or --pick after a render check.
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

// Scratch dirs (decrypted copies, OCR renders) removed when the process ends.
const SCRATCH_DIRS = [];
process.on('exit', () => { for (const d of SCRATCH_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

// Owner-password PDFs (IRS and passport fill-ins, many "print to PDF" bank
// forms) open with an EMPTY user password, but pdf-lib refuses anything
// encrypted. They are decrypted through qpdf into a scratch copy that every
// later step (pdftotext, pdftoppm, stamping) reads, so the signed output
// carries no encryption. A damaged file gets one qpdf rewrite the same way.
// A file that needs a real password to open stays exit 5.
async function openPdf(pdfLib, pdf) {
  try { return { doc: await pdfLib.PDFDocument.load(fs.readFileSync(pdf)), src: pdf, repaired: null }; }
  catch (e) {
    const msg = e && e.message ? e.message : String(e);
    const encrypted = /encrypted/i.test(msg);
    const qpdf = have('qpdf');
    if (!qpdf) die(encrypted ? 4 : 5, encrypted ? 'the PDF is encrypted; install qpdf (apt install qpdf, brew install qpdf) so sign-it can open owner-password files' : `cannot open PDF: ${msg}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-it-open-')); SCRATCH_DIRS.push(dir);
    const copy = path.join(dir, path.basename(pdf));
    const r = run(qpdf, encrypted ? ['--decrypt', pdf, copy] : [pdf, copy]);
    if (r.status !== 0 && r.status !== 3) { // 3 = succeeded with warnings
      if (/password/i.test(r.stderr || '')) die(5, 'the PDF needs a password to open; sign-it does not take passwords');
      die(5, `cannot open PDF: ${msg} (qpdf: ${(r.stderr || '').trim().slice(-200)})`);
    }
    const doc = await pdfLib.PDFDocument.load(fs.readFileSync(copy)).catch(e2 => die(5, `cannot open PDF even after qpdf ${encrypted ? 'decrypt' : 'rewrite'}: ${e2.message}`));
    return { doc, src: copy, repaired: encrypted ? 'decrypted' : 'rewritten' };
  }
}

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
// Signature words, party/role words, and their union. "name" is deliberately
// absent: a Name line is a print-name line, never a place to sign.
const ROLE_RE = /\b(party|authori[sz]ed|client|customer|contractor|lessee|lessor|tenant|landlord|buyer|seller|employee|employer|licensee|licensor|witness|agreed|accepted|approved|owner|member|manager|director|president|officer|signer|borrower|lender|applicant|taxpayer|spouse|representative|guarantor|grantor|grantee|trustee|beneficiary|patient|parent|guardian|student|participant|preparer|agent|principal|debtor|creditor|payee|payer|cardholder|holder|claimant|insured|recipient|vendor|supplier|consultant|artist|talent|company)\b/i;
const LABEL_RE = /(signature|\bsigned\b|\bsign\b|\bby\b|\b(?:party|authori[sz]ed|client|customer|contractor|lessee|lessor|tenant|landlord|buyer|seller|employee|employer|licensee|licensor|witness|agreed|accepted|approved|owner|member|manager|director|president|officer|signer|borrower|lender|applicant|taxpayer|spouse|representative|guarantor|grantor|grantee|trustee|beneficiary|patient|parent|guardian|student|participant|preparer|agent|principal|debtor|creditor|payee|payer|cardholder|holder|claimant|insured|recipient|vendor|supplier|consultant|artist|talent|company)\b)/i;
const DATE_RE = /\bdate\b/i;
// A text-layer label with no blank beside it must say "sign" (or end in a
// colon) to count: a title or name field with a drawn rule is not a signature line.
const STRONG_SIG_RE = /(signature|signed|\bsign\b|\bsigner\b|\bby\b)/i;
// A "by" label is "By:" (optionally "Signed by", "Authorized by", ...); a
// "<verb> by" footer (provided by, powered by, processed by eBay) is not.
const BY_LABEL_RE = /^(?:(?:signed|authori[sz]ed|accepted|agreed|approved)\s+)?by:?$/i;
// A label ends in a label word, a colon, or "here"/"below"; a truncated prose
// fragment ("Sign your", "by number", "sign up") does not.
const LABEL_END_RE = /^(?:here|below)$/i;
// A label naming a data field is a fill-in line, not a signature line, unless
// it also says "signature" ("Lender PPP Loan Number", "Account No.", "Title").
const DATA_RE = /\b(?:number|no\.?|amount|address|phone|tel|fax|email|e-mail|title|account|acct|id|ssn|ein|tin|zip|city|state|company|firm|dob|birth|website|url|position|department|dept|routing|name)\b|#/i;
const BLANK_ANY_RE = /^[_\-\u2013\u2014]{3,}$/;
const BLANK_RE = /^_{3,}$/;
const BLANK_OCR_RE = /^[_\-\u2013\u2014]{3,}$/;

function decode(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }

// "signature_______" arrives as one word from pdftotext and tesseract; split
// the trailing blank run off its label (x split by character share) so the
// row scores as a labeled blank rather than a low-confidence label guess.
function pushWord(words, w) {
  const m = w.text.match(/^(.*[^_\s])(_{3,})$/);
  if (!m) { words.push(w); return; }
  const cut = w.xMin + (w.xMax - w.xMin) * (m[1].length / w.text.length);
  words.push({ ...w, xMax: cut, text: m[1] });
  words.push({ ...w, xMin: cut, text: m[2] });
}

function textWords(pdf) {
  if (!have('pdftotext')) die(4, 'pdftotext (poppler-utils) is required for slot finding; install it or pass --page/--x/--y');
  const r = run('pdftotext', ['-bbox', pdf, '-']);
  if (r.status !== 0) die(5, `pdftotext failed: ${r.stderr.trim()}`);
  const pages = []; let cur = null;
  for (const line of r.stdout.split('\n')) {
    let m = line.match(/<page width="([\d.]+)" height="([\d.]+)">/);
    if (m) { cur = { num: pages.length + 1, width: +m[1], height: +m[2], words: [], source: 'text' }; pages.push(cur); continue; }
    m = line.match(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/word>/);
    if (m && cur) pushWord(cur.words, { xMin: +m[1], yMin: +m[2], xMax: +m[3], yMax: +m[4], text: decode(m[5]) });
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
    pushWord(words, { xMin: left * k, yMin: top * k, xMax: (left + w) * k, yMax: (top + h) * k, text });
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
  const empty = flags.ocr ? pages : pages.filter(p => p.words.length === 0);
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

// Nearest text line above yTop (top-origin) that has a word over the x-range
// [x0, x1], with those words; null when nothing hangs over the slot.
function hangingAbove(lines, yTop, x0, x1, ignoreBlanks = false) {
  let best = null;
  for (const l of lines) {
    if (l.yMax > yTop + 1) continue;
    const words = l.words.filter(w => w.xMax > x0 && w.xMin < x1 && !(ignoreBlanks && BLANK_ANY_RE.test(w.text)));
    if (words.length && (!best || l.yMax > best.line.yMax)) best = { line: l, words };
  }
  return best;
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
    const lines = groupLines(page);
    const usedBlanks = new Set(); // blank runs already claimed by a labeled row or a caption
    // Free vertical room above a slot: the row's own height plus the gap to
    // the nearest text that actually hangs over the slot, so a stamp never
    // climbs into the line above. When only a short tail of that line covers
    // the slot's left end ("return." wrapped above an IRS rule), the slot
    // starts past the tail instead of shrinking to fit under it.
    const fitAbove = (li, x, w) => {
      const l = lines[li]; const lh = l.yMax - l.yMin;
      let o = hangingAbove(lines, l.yMin, x, x + w);
      if (o && l.yMin - o.line.yMax < 20) {
        const tailEnd = Math.max(...o.words.map(wd => wd.xMax));
        if (tailEnd < x + 0.4 * w) { w -= tailEnd + 4 - x; x = tailEnd + 4; o = hangingAbove(lines, l.yMin, x, x + w); }
      }
      const gap = o ? Math.max(0, l.yMin - o.line.yMax) : 200;
      return { x, w, room: lh + Math.min(gap, 200) };
    };
    const mk = (kind, label, line, x, w, lineTop, lineBottom, confidence, source, li, room) => {
      const fit = room === undefined ? fitAbove(li, x, w) : { x, w, room };
      return { page: page.num, pageWidth: page.width, pageHeight: page.height, rot, kind, label, line, rowTop: lines[li].yMin,
        x: fit.x, y: page.height - lineBottom, width: fit.w, yMinTop: lineTop, yMaxTop: lineBottom, lineHeight: lineBottom - lineTop, source, confidence, roomAbove: fit.room };
    };
    lines.forEach((line, li) => {
      const text = line.words.map(w => w.text).join(' ');
      let prevBlank = -1, found = false;
      line.words.forEach((w, wi) => {
        if (!blankRe.test(w.text)) return;
        const between = line.words.slice(prevBlank + 1, wi).map(x => x.text);
        prevBlank = wi;
        const labelWords = between.slice(-4).join(' ');
        if (/[.;!?]$/.test(labelWords)) return; // prose ending before a rule: a divider, not a label
        const fullLabel = between.join(' ');
        if (DATA_RE.test(fullLabel) && !/signature/i.test(fullLabel)) return; // a Name / Number / Title line is a fill-in line
        const isDate = DATE_RE.test(labelWords) && !/sign/i.test(labelWords);
        // "By: ___", "Party A: ___", "Cardholder Signature: ___" qualify; "Credit Card Number: ___" and "Print Name: ___" do not
        const byOnly = !/(signature|\bsigned\b|\bsign\b|\bsigner\b)/i.test(labelWords) && /\bby\b/i.test(labelWords);
        const isSig = !isDate && LABEL_RE.test(labelWords) && !(byOnly && !BY_LABEL_RE.test(between.slice(-3).join(' ')));
        if (!isSig && !isDate) return;
        found = true; usedBlanks.add(w);
        slots.push(mk(isDate ? 'date' : 'signature', labelWords || '(unlabeled)', text, w.xMin, w.xMax - w.xMin, line.yMin, line.yMax, ocr ? 0.7 : 0.9, page.source, li));
      });
      // No blank run on the row: a drawn rule is invisible to both pdftotext
      // and OCR, so a short label segment ("Officer's signature", "Party A:",
      // "Sign here") followed by a wide gap anchors an approximate slot to its
      // right. Low confidence: never auto-picked, and prose never qualifies.
      if (!found) {
        const segs = []; let cur = [line.words[0]];
        for (let i = 1; i < line.words.length; i++) { const w = line.words[i]; if (w.xMin - cur[cur.length - 1].xMax > 40) { segs.push(cur); cur = [w]; } else cur.push(w); }
        segs.push(cur);
        const infos = segs.map((seg, si) => {
          if (seg.length > 8) return null;
          // a lone centered segment is a heading ("Signatures"), not a line label
          if (segs.length === 1 && Math.abs((seg[0].xMin + seg[seg.length - 1].xMax) / 2 - page.width / 2) < 30) return null;
          const stext = seg.map(w => w.text).join(' ');
          const lastWord = seg[seg.length - 1].text;
          if (/[.,;!?]$/.test(lastWord) || /[^\w):]$/.test(lastWord)) return null; // prose, or a "#"-style column header
          if (DATA_RE.test(stext) && !/signature/i.test(stext)) return null; // print-name / data caption
          const endWord = lastWord.replace(/:$/, '');
          // a caption that says "signature" qualifies whatever its last word ("Employee Signature for all applying")
          if (!(/signature/i.test(stext) || /:$/.test(lastWord) || LABEL_RE.test(endWord) || DATE_RE.test(endWord) || LABEL_END_RE.test(endWord))) return null;
          const isDate = (DATE_RE.test(stext) && !/sign/i.test(stext)) || /^date\s+signed:?$/i.test(stext);
          const isSig = !isDate && LABEL_RE.test(stext);
          if (!isSig && !isDate) return null;
          if (isSig && !ocr && !STRONG_SIG_RE.test(stext) && !/:$/.test(lastWord)) return null;
          if (isSig && !/(signature|signed|\bsign\b|\bsigner\b)/i.test(stext) && /\bby\b/i.test(stext) && !BY_LABEL_RE.test(stext)) return null;
          const last = seg[seg.length - 1]; const nextSeg = segs[si + 1];
          const right = nextSeg ? nextSeg[0].xMin - 6 : page.width - 36;
          const rightGap = right - last.xMax - 4;
          // Caption UNDER the rule (SBA/IRS/bank forms: the rule is drawn, the
          // caption "Signature of Authorized Representative" sits below it): an
          // empty band over the caption's own width is where the ink goes.
          const over = hangingAbove(lines, line.yMin, seg[0].xMin, last.xMax, true);
          const band = over ? line.yMin - over.line.yMax : 200;
          return { seg, si, stext, isDate, last, nextSeg, rightGap, band, captionBelow: !ocr && band >= 14 && rightGap < 150 };
        });
        // once one caption on the row sits under its rule, a Date caption beside it does too
        const rowCaption = infos.some(i => i && i.captionBelow && !i.isDate);
        const rowHasDate = infos.some(i => i && i.isDate);
        infos.forEach((info) => {
          if (!info) return;
          const { seg, stext, isDate, last, nextSeg, rightGap, band } = info;
          // "ACCEPTED:" or "SELLER:" alone is a block header; a role-only colon label needs a Date beside it to be a line
          if (!isDate && !STRONG_SIG_RE.test(stext) && !rowHasDate) return;
          const captionBelow = info.captionBelow || (isDate && rowCaption && band >= 14);
          if (captionBelow) {
            // an unlabeled underscore rule right above the caption is the line itself: use its exact geometry
            const ruleLine = lines.slice(0, li).reverse().find(l => l.yMax <= line.yMin + 1 && line.yMin - l.yMax < 18 && l.words.some(w => BLANK_ANY_RE.test(w.text) && !usedBlanks.has(w) && w.xMax > seg[0].xMin - 4 && w.xMin < last.xMax + 4));
            const rule = ruleLine && ruleLine.words.find(w => BLANK_ANY_RE.test(w.text) && !usedBlanks.has(w) && w.xMax > seg[0].xMin - 4 && w.xMin < last.xMax + 4);
            if (rule) {
              usedBlanks.add(rule);
              slots.push(mk(isDate ? 'date' : 'signature', stext, text, rule.xMin, rule.xMax - rule.xMin, ruleLine.yMin, ruleLine.yMax, 0.8, 'text', lines.indexOf(ruleLine)));
              return;
            }
            const cw = Math.max(0, Math.min((nextSeg ? nextSeg[0].xMin - 6 : page.width - 36) - seg[0].xMin, Math.max(last.xMax - seg[0].xMin + 4, isDate ? 70 : 150)));
            if (cw < (isDate ? 40 : 60)) return;
            const bottom = line.yMin - 4; // the rule usually sits a few points above its caption
            slots.push(mk(isDate ? 'date' : 'signature', stext, text, seg[0].xMin, cw, bottom - 12, bottom, 0.5, 'text-caption', li, Math.min(band, 200) - 2));
            return;
          }
          if (seg.length > 4) return;
          const width = Math.max(0, Math.min(rightGap, isDate ? 120 : 220));
          if (width < (ocr ? 30 : 60)) return; // a text page needs real room for a rule to plausibly sit there
          slots.push(mk(isDate ? 'date' : 'signature', stext, text, last.xMax + 4, width, line.yMin, line.yMax, ocr ? 0.6 : 0.5, ocr ? 'ocr' : 'text-label', li));
        });
      }
    });
  }
  return slots;
}

function findSlots(pages, acro, rots) {
  // A text-label guess is a fallback for flat pages. Where the page carries a
  // real signature field (open or skipped), its printed caption is that
  // field's label, not a second place to sign.
  const fieldPages = new Set([...acro.sigs.map(s => s.page), ...acro.skipped.map(s => s.page)]);
  const slots = textSlots(pages, rots).filter(s => !((s.source === 'text-label' || s.source === 'text-caption') && fieldPages.has(s.page)));
  const sigs = [...acro.sigs, ...slots.filter(s => s.kind === 'signature')];
  const dates = [...acro.dates, ...slots.filter(s => s.kind === 'date')];
  for (const s of sigs) {
    const tol = s.source === 'ocr' ? 8 : 3.5;
    const rt = (o) => o.rowTop ?? o.yMinTop; // caption line's top: shared by label, caption and blank slots on one row
    const onRow = (o) => o.page === s.page && Math.abs(rt(o) - rt(s)) < tol && o.x > s.x;
    // a date on the row belongs to this signature only if no other signature
    // slot sits between them (two side-by-side blocks share a row)
    const nextSig = sigs.filter(o => o !== s && onRow(o)).sort((a, b) => a.x - b.x)[0];
    const rowDate = dates.filter(d => onRow(d) && (!nextSig || d.x < nextSig.x)).sort((a, b) => a.x - b.x)[0];
    // a date on the next line must be in this signature's column
    const between = (d) => sigs.some(o => o !== s && o.page === s.page && rt(o) > rt(s) && rt(o) < rt(d) && Math.abs(o.x - s.x) < 200);
    const below = dates.filter(d => d.page === s.page && rt(d) > rt(s) && rt(d) - rt(s) < 60 && Math.abs(d.x - s.x) < 200 && !between(d))
      .sort((a, b) => (rt(a) - rt(s)) - (rt(b) - rt(s)) || Math.abs(a.x - s.x) - Math.abs(b.x - s.x))[0];
    s.date = rowDate || below
      || (s.source === 'acroform' ? dates.find(d => d.page === s.page && d.source === 'acroform') : null) || null;
    s.score = (/sign/i.test(s.label) ? 3 : 0) + (/\bby\b/i.test(s.label) ? 2 : 0) + (LABEL_RE.test(s.label) ? 1 : 0) + (s.source === 'acroform' ? 3 : 0);
  }
  return sigs.map((s, i) => ({ index: i + 1, ...s }));
}

function describe(slots) {
  return slots.map(s => `  [${s.index}] p${s.page} y=${s.yMinTop.toFixed(0)}pt ${s.source}  "${s.line.slice(0, 70)}"${s.date ? '  (+date slot)' : ''}${inked(s) ? '  (INKED: already signed or filled)' : ''}`).join('\n');
}

// Selection policy (documented in SKILL.md): --pick or --find decide; with
// neither, a single candidate is used and anything else is exit 3.
function pickSlot(slots, flags, skipped) {
  const skippedNote = skipped && skipped.length ? `\n  skipped: ` + skipped.map(s => `p${s.page} ${s.label} (${s.reason})`).join('; ') : '';
  if (!slots.length) die(3, 'no signature slot found: no open AcroForm signature field and no labeled blank line (e.g. "Signature: ____" or "By: ____"). Render the page (pdftoppm -png) and pass --page --x --y --width explicitly.' + skippedNote);
  if (flags.pick) { const s = slots[num(flags.pick, '--pick') - 1]; if (!s) die(3, `--pick ${flags.pick} out of range 1..${slots.length}`); return s; }
  if (flags.find) {
    const q = String(flags.find).toLowerCase();
    // label matches win over row-text matches, so two slots on one row stay distinct
    const byLabel = slots.filter(s => s.label.toLowerCase().includes(q));
    const hits = byLabel.length ? byLabel : slots.filter(s => s.line.toLowerCase().includes(q));
    if (hits.length === 1) return hits[0];
    if (!hits.length) die(3, `--find "${flags.find}" matched no slot; candidates:\n` + describe(slots) + skippedNote);
    die(3, `--find "${flags.find}" is ambiguous (${hits.length} slots); use --pick N:\n` + describe(hits));
  }
  if (slots.length === 1 && slots[0].confidence >= 0.7) { if (inked(slots[0])) die(3, 'the only candidate already carries ink (an existing signature or typed text):\n' + describe(slots) + skippedNote); return slots[0]; }
  if (slots.length === 1) die(3, `one low-confidence candidate (a label with no blank line beside it); confirm it with --find TEXT or --pick 1 after checking a render:\n` + describe(slots) + skippedNote);
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
// Ink already on a slot (a wet or typed signature, a printed name) is a hard
// stop: the rule is never to stamp over an existing signature. The slot's
// stamp area is rendered small and gray through pdftoppm (PGM) and the dark
// share is measured, trimming the rule strip at the bottom and the box edges.
const INK_LIMIT = 0.025;
function inkFraction(pdf, s, ph) {
  if (!have('pdftoppm')) return null;
  const inBox = s.source === 'acroform';
  const bx = s.x + 3, bw = s.width - 6;
  const by = s.y + (inBox ? 3 : 4);
  const bh = (inBox ? s.boxHeight - 6 : Math.min(Math.max(12, (s.roomAbove || 26) - 3), 30)) - 3;
  if (bw < 8 || bh < 4) return null;
  const k = 1; // 72 dpi: one point per pixel, so a hairline stroke still registers
  const X = Math.max(0, Math.round(bx * k)), Y = Math.max(0, Math.round((ph - (by + bh)) * k)), Wd = Math.max(1, Math.round(bw * k)), H = Math.max(1, Math.round(bh * k));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-it-ink-')); SCRATCH_DIRS.push(dir);
  const base = path.join(dir, 'crop');
  const r = run('pdftoppm', ['-f', String(s.page), '-l', String(s.page), '-r', '72', '-gray', '-x', String(X), '-y', String(Y), '-W', String(Wd), '-H', String(H), '-singlefile', pdf, base]);
  if (r.status !== 0) return null;
  let buf; try { buf = fs.readFileSync(base + '.pgm'); } catch { return null; }
  // P5 header: magic, width height, maxval, then one byte per pixel
  const head = buf.toString('latin1', 0, 64).match(/^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/);
  if (!head) return null;
  const px = buf.subarray(head[0].length); const w = +head[1]; const col = new Array(w).fill(0); let rows = 0;
  for (let r = 0; r + w <= px.length; r += w) {
    let d = 0; for (let i = r; i < r + w; i++) if (px[i] < 176) d++;
    if (d / w > 0.5) continue; // a drawn rule or box border crossing the crop, not ink
    for (let i = 0; i < w; i++) if (px[r + i] < 176) col[i]++;
    rows++;
  }
  if (!rows) return null;
  // a signature rarely spans the whole slot: judge the densest third of it
  const win = Math.max(8, Math.floor(w / 3)); let best = 0;
  for (let x0 = 0; x0 + win <= w; x0 += Math.max(1, Math.floor(w / 12))) { let d = 0; for (let i = x0; i < x0 + win; i++) d += col[i]; best = Math.max(best, d / (win * rows)); }
  return +best.toFixed(3);
}
function inked(s) { return Number.isFinite(s.ink) && s.ink > INK_LIMIT; }

function candidateView(s) {
  return { index: s.index, page: s.page, source: s.source, confidence: s.confidence, label: s.label, line: s.line, x: +s.x.toFixed(1), y: +s.y.toFixed(1), width: +s.width.toFixed(1), rotation: s.rot || 0, score: s.score,
    date: s.date ? { source: s.date.source, x: +s.date.x.toFixed(1), y: +s.date.y.toFixed(1), width: +s.date.width.toFixed(1) } : null,
    ink: s.ink === undefined ? null : s.ink, note: inked(s) ? 'already carries ink (an existing signature or typed text); not a place to sign' : undefined };
}
function pageMeta(doc) { return doc.getPages().map(p => ({ size: displaySize(p), rot: pageRotation(p) })); }

// Word documents are converted first; pdf-lib would otherwise fail with an
// unhelpful parse error.
function wordDocGuard(p) {
  if (p && /\.(docx?|odt|rtf)$/i.test(p)) die(1, `${p} is a Word document; run: sign-it convert "${p}"   then sign the PDF it writes`);
}

// ---------- convert: Word document -> PDF ----------
function winwordPath() {
  for (const p of ['/mnt/c/Program Files/Microsoft Office/root/Office16/WINWORD.EXE', '/mnt/c/Program Files (x86)/Microsoft Office/root/Office16/WINWORD.EXE']) if (fs.existsSync(p)) return p;
  return null;
}
function powershellBin() { return have(process.env.SIGN_IT_POWERSHELL || 'powershell.exe'); }
function sofficeBin() { return process.env.SIGN_IT_SOFFICE ? have(process.env.SIGN_IT_SOFFICE) : (have('soffice') || have('libreoffice')); }
function converterKind() { if (sofficeBin()) return 'libreoffice'; if (powershellBin() && (winwordPath() || process.env.SIGN_IT_POWERSHELL)) return 'word-com'; return null; }

async function cmdConvert(pos, flags) {
  const src = pos[0];
  if (!src) die(1, 'usage: sign-it convert <file.docx|.doc|.odt|.rtf> [--out FILE] [--force]');
  if (!fs.existsSync(src)) die(5, `no such file: ${src}`);
  if (!/\.(docx?|odt|rtf)$/i.test(src)) die(1, 'convert takes a Word document (.docx, .doc, .odt, .rtf)');
  if (flags.out === true) die(1, '--out needs a file name');
  const outPath = flags.out ? String(flags.out) : src.replace(/\.[^.]+$/, '') + '.pdf';
  if (fs.existsSync(outPath) && !flags.force) die(5, `refusing to overwrite ${outPath}; pass --out FILE or --force`);
  const kind = converterKind();
  if (!kind) die(4, 'no Word converter: install LibreOffice (apt install libreoffice-writer-nogui, brew install --cask libreoffice), or on WSL have Word installed on the Windows side (powershell.exe drives it)');
  if (kind === 'libreoffice') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-it-convert-'));
    try {
      const r = run(sofficeBin(), ['--headless', '--convert-to', 'pdf', '--outdir', dir, src], { stdio: ['ignore', 'pipe', 'pipe'] });
      const produced = path.join(dir, path.basename(src).replace(/\.[^.]+$/, '') + '.pdf');
      if (r.status !== 0 || !fs.existsSync(produced)) die(5, `LibreOffice conversion failed: ${(r.stderr || r.stdout || '').trim().slice(-300)}`);
      fs.copyFileSync(produced, outPath);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  } else {
    // WSL with Word on the Windows side. Files pass through the Windows TEMP
    // directory because Word opens UNC \\wsl paths unreliably; stdin is
    // closed because powershell.exe otherwise swallows the caller's stdin.
    const ps = powershellBin(); const wp = have('wslpath');
    // only files on a mounted Windows drive need a Windows spelling; anything
    // else (a test stub's scratch dir) passes through untouched
    const toWin = (p) => { if (!wp || !p.startsWith('/mnt/')) return p; const r = run(wp, ['-w', p]); return r.stdout.trim(); };
    const toLinux = (p) => { if (!wp || p.startsWith('/')) return p; const r = run(wp, ['-u', p]); return r.stdout.trim(); };
    const q = run(ps, ['-NoProfile', '-Command', '$env:TEMP'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const winTemp = (q.stdout || '').trim();
    if (q.status !== 0 || !winTemp) die(5, 'could not read the Windows TEMP directory through powershell.exe');
    const exch = path.join(toLinux(winTemp), 'sign-it-convert');
    fs.mkdirSync(exch, { recursive: true });
    const base = path.basename(src).replace(/[^A-Za-z0-9._-]/g, '_'); const stem = base.replace(/\.[^.]+$/, '');
    const inCopy = path.join(exch, base); const pdfCopy = path.join(exch, stem + '.pdf'); const script = path.join(exch, 'word-to-pdf.ps1');
    fs.copyFileSync(src, inCopy); fs.rmSync(pdfCopy, { force: true });
    fs.copyFileSync(path.join(SKILL_DIR, 'scripts', 'word-to-pdf.ps1'), script); // run from the Windows side, not a \\wsl UNC path
    try {
      const r = run(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', toWin(script), '-In', toWin(inCopy), '-Out', toWin(pdfCopy)], { stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.status !== 0 || !fs.existsSync(pdfCopy)) die(5, `Word conversion failed: ${(r.stderr || r.stdout || '').trim().slice(-300)}`);
      fs.copyFileSync(pdfCopy, outPath);
    } finally { for (const f of [inCopy, pdfCopy, script]) fs.rmSync(f, { force: true }); }
  }
  out({ file: src, out: outPath, via: kind });
}

async function cmdFind(pos, flags) {
  wordDocGuard(pos[0]);
  const pdf = pos[0]; if (!pdf) die(1, 'usage: sign-it find <in.pdf> [--no-ocr]');
  if (!fs.existsSync(pdf)) die(5, `no such file: ${pdf}`);
  const pdfLib = await loadPdfLib();
  const { doc, src, repaired } = await openPdf(pdfLib, pdf);
  const meta = pageMeta(doc);
  const acro = acroformSlots(doc, pdfLib);
  const slots = findSlots(pdfWords(src, flags, meta.map(m => m.size)), acro, meta.map(m => m.rot));
  if (!flags['no-ink']) for (const s of slots) s.ink = inkFraction(src, s, meta[s.page - 1].size.height);
  out({ file: pdf, repaired, candidates: slots.map(candidateView), skipped: acro.skipped });
  if (!slots.length) process.exit(3);
}

async function cmdSign(pos, flags) {
  wordDocGuard(pos[0]);
  const pdf = pos[0]; if (!pdf) die(1, 'usage: sign-it sign <in.pdf> [--find TEXT|--pick N|--page P --x X --y Y --width W] [--date auto|none|TEXT] [--name] [--out FILE] [--preview] [--seal] [--no-ocr]');
  if (!fs.existsSync(pdf)) die(5, `no such file: ${pdf}`);
  requireSignature();
  const cfg = readConfig();
  const pdfLib = await loadPdfLib();
  const { PDFDocument, StandardFonts, rgb, degrees } = pdfLib;
  const outPath = flags.out ? String(flags.out) : path.join(path.dirname(pdf), path.basename(pdf).replace(/\.pdf$/i, '') + '-signed.pdf');
  if (!fs.existsSync(path.dirname(outPath))) die(5, `output directory does not exist: ${path.dirname(outPath)}`);
  if (sameFile(pdf, outPath)) die(1, 'refusing to overwrite the input; pass a different --out');
  const { doc, src, repaired } = await openPdf(pdfLib, pdf);
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
    // free room above the manual anchor: distance to the nearest text line above it
    try {
      const pg = pdfWords(src, { 'no-ocr': true }, meta.map(m => m.size))[pageNo - 1];
      const yTop = ph - y; // manual y is display-space bottom-left; lines are top-origin
      const above = hangingAbove(groupLines(pg), yTop, x, x + width);
      if (above) slot.roomAbove = Math.max(0, yTop - above.line.yMax);
    } catch {}
    if (flags['date-x'] !== undefined || flags['date-y'] !== undefined) {
      if (!(flags['date-x'] !== undefined && flags['date-y'] !== undefined)) die(1, 'manual date placement needs both --date-x and --date-y (plus optional --date-width)');
      const dx = pct(flags['date-x'], pw, '--date-x'), dy = pct(flags['date-y'], ph, '--date-y'), dw = flags['date-width'] !== undefined ? pct(flags['date-width'], pw, '--date-width') : 90;
      if (dx < 0 || dx > pw || dy < 0 || dy > ph) die(1, `date placement is off the page (got x=${dx.toFixed(0)}, y=${dy.toFixed(0)})`);
      slot.date = { x: dx, y: dy, width: dw, lineHeight: 12, source: 'manual' };
    }
  } else {
    const acro = acroformSlots(doc, pdfLib); skipped = acro.skipped;
    const found = findSlots(pdfWords(src, flags, meta.map(m => m.size)), acro, meta.map(m => m.rot));
    if (!flags['no-ink']) for (const c of found) c.ink = inkFraction(src, c, meta[c.page - 1].size.height);
    slot = pickSlot(found, flags, skipped);
  }
  const page = doc.getPage(slot.page - 1);
  const { width: pw, height: ph } = page.getSize();
  const rot = slot.rot || 0;
  const inBox = slot.source === 'acroform';
  if (!flags['no-ink'] && !flags['over-ink']) {
    if (slot.ink === undefined) slot.ink = inkFraction(src, slot, meta[slot.page - 1].size.height);
    if (inked(slot)) die(3, `the chosen line already carries ink (${Math.round(slot.ink * 100)}% of the stamp area is dark: an existing signature, a typed name, or a filled field). Pick another line; --over-ink forces it after you have checked a render.`);
  }
  const maxW = Math.max(40, Math.min(slot.width - 8, num(flags['max-width'] ?? cfg.maxWidth ?? 170, '--max-width')));
  let maxH = inBox ? Math.max(slot.boxHeight - 4, 10) : Math.max(slot.lineHeight * 2.6, 26);
  if (Number.isFinite(slot.roomAbove)) maxH = Math.min(maxH, Math.max(12, slot.roomAbove - 3)); // never climb into the line above
  if (flags.height !== undefined) maxH = Math.min(maxH, Math.max(8, num(flags.height, '--height')));
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
      const existing = (tf.getText() || '').trim();
      if (existing) dateNote = `date field "${slot.date.fieldName}" already holds "${existing}"; left as is`;
      else {
      const maxLen = tf.getMaxLength();
      if (maxLen !== undefined && text.length > maxLen && (flags.date ?? 'auto') === 'auto') text = fmtDate('auto', cfg, 'iso');
      if (maxLen !== undefined && text.length > maxLen) die(5, `date field "${slot.date.fieldName}" allows ${maxLen} characters; "${text}" does not fit`);
      const avail = slot.date.width - 6;
      let size = Math.min(11, Math.max(7, slot.date.boxHeight * 0.55));
      if (font.widthOfTextAtSize(text, size) > avail && (flags.date ?? 'auto') === 'auto') text = fmtDate('auto', cfg, 'iso');
      while (size > 6 && font.widthOfTextAtSize(text, size) > avail) size -= 0.5;
      tf.setFontSize(size); tf.setText(text); tf.enableReadOnly(); tf.updateAppearances(font);
      datePlaced = text;
      }
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
  const result = { out: outPath, repaired, page: slot.page, source: slot.source, confidence: slot.confidence, label: slot.label, line: slot.line, x: +a.x.toFixed(1), y: +a.y.toFixed(1), width: +w.toFixed(1), height: +h.toFixed(1), rotation: rot, date: datePlaced, dateNote, skipped, sealed: false, preview: null };
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
    pdftotext: !!have('pdftotext'), pdftoppm: !!have('pdftoppm'), tesseract: !!tesseractBin(), pdfsig: !!have('pdfsig'), wordConverter: converterKind(), pyhanko: !!pyhanko(), cert: fs.existsSync(CERT) };
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
    case 'convert': await cmdConvert(pos, flags); break;
    default: die(1, 'usage: sign-it <find|sign|seal|setup|seal-setup|doctor|convert> ... (see the header of scripts/sign-it.mjs)');
  }
} catch (e) {
  if (e instanceof Exit) { process.stderr.write(`sign-it: ${e.message}\n`); process.exit(e.code); }
  process.stderr.write(`sign-it: ${e && e.message ? e.message : String(e)}\n`); process.exit(5);
}
