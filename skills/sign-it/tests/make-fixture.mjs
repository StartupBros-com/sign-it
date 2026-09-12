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
} else if (kind === 'glued') {
  // Word-style row: the underscores are glued to the label, so pdftotext
  // emits "signature_____" and "Date_____" as single words.
  const p2 = doc.addPage([612, 792]);
  line(p2, 'Cardholder signature_____________________________   Date______________', 72, 640);
} else if (kind === 'heading') {
  // A centered "Signatures" heading over a slash-separated table: nothing here
  // is a signature line the tool can place on its own.
  const p2 = doc.addPage([612, 792]);
  line(p2, 'Signatures', 276, 640, 12, bold);
  line(p2, 'From the side of Company', 90, 600); line(p2, '/', 300, 600); line(p2, '/', 420, 600);
  line(p2, 'From the side of Client', 90, 560); line(p2, '/', 300, 560); line(p2, '/', 420, 560);
} else if (kind === 'captions') {
  // SBA-style block: drawn rules with the captions BELOW them.
  const p2 = doc.addPage([612, 792]);
  line(p2, 'I certify that the information provided is true and correct.', 72, 300, 10);
  p2.drawLine({ start: { x: 72, y: 230 }, end: { x: 330, y: 230 }, thickness: 0.6 });
  line(p2, 'Signature of Authorized Representative of Borrower', 72, 218, 8);
  p2.drawLine({ start: { x: 360, y: 230 }, end: { x: 460, y: 230 }, thickness: 0.6 });
  line(p2, 'Date', 360, 218, 8);
  p2.drawLine({ start: { x: 72, y: 180 }, end: { x: 330, y: 180 }, thickness: 0.6 });
  line(p2, 'Print Name', 72, 168, 8);
  p2.drawLine({ start: { x: 360, y: 180 }, end: { x: 460, y: 180 }, thickness: 0.6 });
  line(p2, 'Title', 360, 168, 8);
} else if (kind === 'inked') {
  // one blank already carries a scrawl, one is clean
  const p2 = doc.addPage([612, 792]);
  line(p2, 'Client Signature: ______________________   Date: __________', 72, 640);
  for (let i = 0; i < 40; i++) p2.drawLine({ start: { x: 175 + i * 4, y: 644 + (i % 3) * 6 }, end: { x: 179 + i * 4, y: 650 - (i % 2) * 8 }, thickness: 1.2 });
  line(p2, 'Consultant Signature: ______________________   Date: __________', 72, 560);
} else if (kind === 'columns') {
  // two blocks side by side; only the left one has a Date line beneath it
  const p2 = doc.addPage([612, 792]);
  line(p2, 'Signature: ______________', 72, 640); line(p2, 'Signature: ______________', 340, 640);
  line(p2, 'Date: __________', 72, 622);
} else if (kind === 'datafields') {
  // a form whose only signature line sits among data fields
  const p2 = doc.addPage([612, 792]);
  ['Cardholder Name: ____________________', 'Credit Card Number: ____________________', 'Expiration Date: ________', 'Amount to be Paid: ____________',
   'Cardholder Signature: ____________________   Date: __________'].forEach((t, i) => line(p2, t, 72, 680 - i * 28));
} else if (kind === 'datafields2') {
  // role words inside data-field labels, a long print-name label, and one real line
  const p2 = doc.addPage([612, 792]);
  ['Lender PPP Loan Number: ______________', 'Client Name (if different from Cardholder): ______________', 'Account Number: ______________', 'Title: ______________',
   'Authorized Representative: ______________   Date: __________'].forEach((t, i) => line(p2, t, 72, 680 - i * 28));
} else if (kind === 'undercap') {
  // Word export: a bare underscore rule on one line, captions on the next
  const p2 = doc.addPage([612, 792]);
  line(p2, '______________________________          ______________', 72, 600);
  line(p2, 'Company Official Signature', 72, 586, 9); line(p2, 'Date', 300, 586, 9);
} else if (kind === 'wrapped') {
  // insurer enrollment: three captions under one drawn rule, the signature caption ends in a non-label word
  const p2 = doc.addPage([612, 792]);
  p2.drawLine({ start: { x: 40, y: 520 }, end: { x: 580, y: 520 }, thickness: 0.6 });
  line(p2, 'Date', 40, 508, 8); line(p2, 'Employee Signature for all applying', 140, 508, 8); line(p2, 'Spouse Signature (if applying for coverage)', 380, 508, 8);
} else if (kind === 'thinink') {
  const p2 = doc.addPage([612, 792]);
  line(p2, 'Client Signature: ______________________   Date: __________', 72, 640);
  for (let i = 0; i < 60; i++) p2.drawLine({ start: { x: 178 + i * 2.2, y: 645 + (i % 4) * 4 }, end: { x: 180 + i * 2.2, y: 651 - (i % 3) * 5 }, thickness: 0.5 });
} else if (kind === 'datebelow') {
  // Printed Name row between the signature and its Date, same column
  const p2 = doc.addPage([612, 792]);
  line(p2, 'Signature: ______________________', 72, 640);
  line(p2, 'Printed Name: ______________________', 72, 618);
  line(p2, 'Date: __________', 72, 596);
} else if (kind === 'acro-prefilled') {
  const p2 = doc.addPage([612, 792]);
  const form = doc.getForm();
  form.acroForm.addField(sigWidget(p2, [72, 600, 300, 650]));
  const date = form.createTextField('Date1'); date.addToPage(p2, { x: 330, y: 610, width: 130, height: 26 }); date.setText('12/4/18');
} else if (kind === 'footers') {
  // Rows that fire the label rule in the wild but are not signature lines
  // (sweep of 1,676 PDFs, 2026-09-12), plus three real labels among them.
  const p2 = doc.addPage([612, 792]);
  const rows = ['Report generated by', 'Powered by TCPDF', 'Processed by eBay', 'Sign your', 'by number', 'Sign up', 'Provided by:', 'USPS signature tracking #',
    'Approved by:', 'Sign here', 'Date signed', 'ACCEPTED:', 'You/the Owner:'];
  rows.forEach((t, i) => line(p2, t, 72, 700 - i * 30, 10));
} else if (kind === 'twocolumn') {
  // two-party block: the same labels in two columns under party headers
  const p2 = doc.addPage([612, 792]);
  line(p2, 'Tasty LLC \u00b7 StartupBros, LLC     Collaboration Agreement', 180, 760, 8); // running header names both parties
  line(p2, 'SIGNATURES', 245, 700, 12, bold); // centered between the columns
  line(p2, 'TASTY LLC', 72, 670, 10, bold); line(p2, 'STARTUPBROS, LLC', 340, 670, 10, bold);
  ['Signature: ____________________', 'Printed Name: ____________________', 'Title: ____________________', 'Date: ____________________', 'Email: ____________________']
    .forEach((t, i) => { line(p2, t, 72, 650 - i * 20, 10); line(p2, t, 340, 650 - i * 20, 10); });
} else if (kind === 'acro-text') {
  const p2 = doc.addPage([612, 792]);
  const form = doc.getForm();
  const nm = form.createTextField('Printed Name'); nm.addToPage(p2, { x: 72, y: 600, width: 200, height: 20 });
  const ti = form.createTextField('Title'); ti.addToPage(p2, { x: 72, y: 570, width: 200, height: 20 }); ti.setText('CEO');
} else if (kind === 'ruled') {
  // IRS-style row: label at left, a DRAWN rule (no underscores), Date with
  // its own rule, Title pre-filled, and a text line 26pt above the rule.
  const p2 = doc.addPage([612, 792]);
  line(p2, 'As an officer of the corporation, I will enter my PIN as my signature.', 79, 640, 10);
  line(p2, 'return.', 79, 624, 10); // wrapped tail hanging just over the rule's left end
  p2.drawLine({ start: { x: 100, y: 612 }, end: { x: 295, y: 612 }, thickness: 0.6 });
  line(p2, "Officer's signature", 36, 605, 7);
  p2.drawLine({ start: { x: 330, y: 612 }, end: { x: 395, y: 612 }, thickness: 0.6 });
  line(p2, 'Date', 309, 605, 7);
  line(p2, 'Title', 410, 605, 7); line(p2, 'PRESIDENT', 435, 607, 9);
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
