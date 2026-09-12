#!/usr/bin/env node
// Print the joined text of a .docx part (w:t nodes) plus any VML textpath strings: docx-text.mjs <file.docx> <part>
import fs from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
const [file, part] = process.argv.slice(2);
const xml = strFromU8(unzipSync(new Uint8Array(fs.readFileSync(file)))[part]);
const t = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => m[1]).join('');
const wm = [...xml.matchAll(/<v:textpath\b[^>]*\bstring="([^"]*)"/g)].map(m => m[1]).join('|');
process.stdout.write(t + (wm ? ` [textpath:${wm}]` : '') + '\n');
