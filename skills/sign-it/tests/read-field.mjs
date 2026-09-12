#!/usr/bin/env node
// Print the value of an AcroForm text field (test helper).
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
const [pdf, name] = process.argv.slice(2);
const doc = await PDFDocument.load(fs.readFileSync(pdf));
console.log(doc.getForm().getTextField(name).getText() ?? '');
