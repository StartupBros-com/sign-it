#!/usr/bin/env node
// Build synthetic PDFs for tests. Kinds:
//   agreement | plain | ambiguous | sameline | nodate   text-layer layouts
//   acroform          /Sig widget + Date text field
//   acro-signed       /Sig widget that already carries a value (must be skipped)
//   acro-hidden       /Sig widget with the Hidden flag (must be skipped)
//   acro-nested       FT and T two Parent levels above the widget
//   acro-shared-date  one Date field with widgets on pages 2 and 3
//   acro-readonly     Date field flagged read-only
//   rotated           /Rotate 90 page whose text reads upright when displayed
//   ocrlabels         labels without underscores, for the OCR rule
//   scanned <in.png> <out.pdf>   image-only page wrapped from a PNG
import fs from 'node:fs';
import { PDFDocument, PDFName, PDFString, StandardFonts, degrees } from 'pdf-lib';

const [kind, a, b] = process.argv.slice(2);
if (!kind || !a) { console.error('usage: make-fixture.mjs <kind> <out.pdf> | scanned <in.png> <out.pdf>'); process.exit(1); }

if (kind === 'scanned') {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(fs.readFileSync(a));
  const page = doc.addPage([612, 792]);
  page.drawImage(png, { x: 0, y: 0, width: 612, height: 792 });
  fs.writeFileSync(b, await doc.save()); console.log(b); process.exit(0);
}

const outPath = a;
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.TimesRoman);
const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
const line = (page, text, x, y, size = 12, f = font, extra = {}) => page.drawText(text, { x, y, size, font: f, ...extra });

const p1 = doc.addPage([612, 792]);
line(p1, 'Test Agreement (synthetic)', 72, 720, 20, bold);
['This is a synthetic agreement used only by sign-it tests. No real parties.',
 'Clause 1. The parties agree that this document is a fixture.',
 'Clause 2. Nothing here binds anyone.',
 'Clause 3. Lorem ipsum dolor sit amet, consectetur adipiscing elit.'].forEach((t, i) => line(p1, t, 72, 680 - i * 18));

// helpers for AcroForm fixtures
const sigWidget = (page, rect, opts = {}) => {
  const d = { Type: 'Annot', Subtype: 'Widget', Rect: rect, F: opts.F ?? 4, P: page.ref };
  if (!opts.parent) { d.FT = 'Sig'; d.T = PDFString.of(opts.name || 'Signature1'); }
  if (opts.V) d.V = doc.context.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached', Contents: PDFString.of('00'), ByteRange: [0, 0, 0, 0] });
  const dict = doc.context.obj(d); const ref = doc.context.register(dict);
  if (opts.parent) dict.set(PDFName.of('Parent'), opts.parent);
  page.node.addAnnot(ref);
  return ref;
};

if (kind === 'agreement') {
  const p2 = doc.addPage([612, 792]);
  line(p2, 'Signatures', 72, 720, 18, bold);
  line(p2, 'Party A: ______________________   Date: __________', 72, 640);
  line(p2, 'Party B: ______________________   Date: __________', 72, 560);
  line(p2, 'Witness signature: ______________________', 72, 480);
  line(p2, 'Date: __________', 72, 462);
} else if (kind === 'ambiguous') {
  const p2 = doc.addPage([612, 792]);
  line(p2, 'Signature: ______________________', 72, 640);
  line(p2, 'Signature: ______________________', 72, 560);
} else if (kind === 'sameline') {
  const p2 = doc.addPage([612, 792]);
  line(p2, 'Signature: ______________________   Date: __________', 72, 640);
} else if (kind === 'nodate') {
  const p2 = doc.addPage([612, 792]);
  line(p2, 'Authorized signature: ______________________', 72, 640);
} else if (kind === 'ocrlabels') {
  const p2 = doc.addPage([612, 792]);
  line(p2, 'Sign here', 72, 640);
  line(p2, 'Authorized Signer', 72, 580);
  line(p2, 'Signature of Tenant', 72, 520);
  line(p2, 'Please sign below', 72, 460);
} else if (kind === 'rotated') {
  // A landscape scan stored as a portrait page with /Rotate 90: the text is
  // drawn rotated in content space so it reads upright when displayed.
  const p2 = doc.addPage([612, 792]);
  p2.setRotation(degrees(90));
  // display space is 792 x 612; display point (X, Y) -> content (612 - Y, X)
  const at = (X, Y) => ({ x: 612 - Y, y: X });
  const t1 = at(72, 400); line(p2, 'Party A: ______________________   Date: __________', t1.x, t1.y, 12, font, { rotate: degrees(90) });
  const t2 = at(72, 300); line(p2, 'Party B: ______________________   Date: __________', t2.x, t2.y, 12, font, { rotate: degrees(90) });
} else if (kind === 'rotated270') {
  const p2 = doc.addPage([612, 792]);
  p2.setRotation(degrees(270));
  // display space is 792 x 612; display point (X, Y) -> content (Y, 792 - X)
  const at = (X, Y) => ({ x: Y, y: 792 - X });
  const t1 = at(72, 400); line(p2, 'Party A: ______________________   Date: __________', t1.x, t1.y, 12, font, { rotate: degrees(270) });
  const t2 = at(72, 300); line(p2, 'Party B: ______________________   Date: __________', t2.x, t2.y, 12, font, { rotate: degrees(270) });
} else if (kind === 'acro-rot270') {
  const p2 = doc.addPage([612, 792]);
  p2.setRotation(degrees(270));
  const form = doc.getForm();
  // display box x 72..300, y 380..430 -> content rect via (X, Y) -> (Y, 792 - X)
  form.acroForm.addField(sigWidget(p2, [380, 792 - 300, 430, 792 - 72]));
  const date = form.createTextField('Date1'); date.addToPage(p2, { x: 380, y: 792 - 460, width: 50, height: 130 });
} else if (kind === 'acro-zero') {
  const p2 = doc.addPage([612, 792]);
  doc.getForm().acroForm.addField(sigWidget(p2, [150, 600, 150, 650]));
} else if (kind === 'acro-offpage') {
  const p2 = doc.addPage([612, 792]);
  doc.getForm().acroForm.addField(sigWidget(p2, [72, 900, 300, 950]));
} else if (kind === 'acro-comb') {
  const p2 = doc.addPage([612, 792]);
  const form = doc.getForm();
  form.acroForm.addField(sigWidget(p2, [72, 600, 300, 650]));
  const date = form.createTextField('Date1'); date.setMaxLength(10); date.addToPage(p2, { x: 330, y: 610, width: 130, height: 26 });
} else if (kind === 'acroform') {
  const p2 = doc.addPage([612, 792]);
  line(p2, 'Signature', 72, 655, 10); line(p2, 'Date', 330, 655, 10);
  const form = doc.getForm();
  form.acroForm.addField(sigWidget(p2, [72, 600, 300, 650]));
  const date = form.createTextField('Date1'); date.addToPage(p2, { x: 330, y: 610, width: 130, height: 26 });
} else if (kind === 'acro-signed') {
  const p2 = doc.addPage([612, 792]);
  doc.getForm().acroForm.addField(sigWidget(p2, [72, 600, 300, 650], { V: true }));
} else if (kind === 'acro-hidden') {
  const p2 = doc.addPage([612, 792]);
  doc.getForm().acroForm.addField(sigWidget(p2, [72, 600, 300, 650], { F: 2 }));
} else if (kind === 'acro-nested') {
  const p2 = doc.addPage([612, 792]);
  const grand = doc.context.obj({ FT: 'Sig', T: PDFString.of('Signature1') }); const grandRef = doc.context.register(grand);
  const mid = doc.context.obj({ Parent: grandRef }); const midRef = doc.context.register(mid);
  const w = sigWidget(p2, [72, 600, 300, 650], { parent: midRef });
  mid.set(PDFName.of('Kids'), doc.context.obj([w])); grand.set(PDFName.of('Kids'), doc.context.obj([midRef]));
  doc.getForm().acroForm.addField(grandRef);
} else if (kind === 'acro-shared-date') {
  const p2 = doc.addPage([612, 792]); const p3 = doc.addPage([612, 792]);
  const form = doc.getForm();
  form.acroForm.addField(sigWidget(p2, [72, 600, 300, 650]));
  const date = form.createTextField('Date1');
  date.addToPage(p2, { x: 330, y: 610, width: 130, height: 26 });
  date.addToPage(p3, { x: 330, y: 610, width: 130, height: 26 });
} else if (kind === 'acro-readonly') {
  const p2 = doc.addPage([612, 792]);
  const form = doc.getForm();
  form.acroForm.addField(sigWidget(p2, [72, 600, 300, 650]));
  const date = form.createTextField('Date1'); date.addToPage(p2, { x: 330, y: 610, width: 130, height: 26 }); date.enableReadOnly();
}
fs.writeFileSync(outPath, await doc.save());
console.log(outPath);
