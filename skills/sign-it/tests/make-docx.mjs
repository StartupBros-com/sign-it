#!/usr/bin/env node
// Build a minimal .docx for finalize tests: body with a table row, a header
// carrying a VML "DRAFT" watermark, a footer whose banner is split across runs.
import fs from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
const out = process.argv[2]; if (!out) { console.error('usage: make-docx.mjs <out.docx>'); process.exit(1); }
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml"';
const p = (runs) => `<w:p>${runs.map(t => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`).join('')}</w:p>`;
const files = {
  '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`,
  '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`,
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${p(['Collaboration Agreement'])}${p(['This Agreement may be signed in counterparts.'])}<w:tbl><w:tr><w:tc>${p(['Signature: ______________'])}</w:tc><w:tc>${p(['Signature: ______________'])}</w:tc></w:tr></w:tbl><w:sectPr><w:headerReference w:type="default" r:id="rId1"/><w:footerReference w:type="default" r:id="rId2"/></w:sectPr></w:body></w:document>`,
  'word/header1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W}>${p(['Tasty LLC · StartupBros, LLC'])}<w:p><w:r><w:pict><v:shape id="PowerPlusWaterMarkObject" style="position:absolute"><v:textpath style="font-family:&quot;Calibri&quot;" string="DRAFT"/></v:shape></w:pict></w:r></w:p></w:hdr>`,
  'word/footer1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W}>${p(['Confidential · ', 'Proposed Revision ', 'for Discussion', '     Page 1'])}</w:ftr>`,
};
const zip = {}; for (const [k, v] of Object.entries(files)) zip[k] = strToU8(v);
fs.writeFileSync(out, zipSync(zip, { level: 6 })); console.log(out);
