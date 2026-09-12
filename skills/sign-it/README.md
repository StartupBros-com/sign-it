# sign-it

Agent-native PDF signing for Claude Code. You draw your signature once; from then on "sign that" works: the agent finds the signature line, stamps your signature and today's date, renders a preview of the result for you to check, and hands back `<file>-signed.pdf`. Optionally it adds a cryptographic seal so the recipient can verify the file was not altered afterwards.

It replaces print, sign, scan. It does not send documents to other people for their signature.

## How it finds the line

Three sources, in confidence order, all local: a real AcroForm signature field in the PDF (already-signed and hidden fields are reported as skipped, never stamped over; a Date text field on the same page is filled through the form API); a run of underscores after a label such as Signature, Signed, By, Party, Name, Client in the text layer (a Date label on the same or next line becomes the date slot); and, for scanned pages with no text layer, tesseract OCR with the label anchoring an approximate slot. Rotated pages get an upright stamp. When there is no candidate, or more than one and no hint, the tool stops and lists what it found instead of guessing. It never draws a signature for you.

## Install

- As a Claude Code skill: put this directory at `~/.claude/skills/sign-it/` (or install the plugin), then `pnpm install --dir ~/.claude/skills/sign-it` (or `npm install --prefix ~/.claude/skills/sign-it`). Needs Node 18+ and `pdftotext` plus `pdftoppm` from poppler-utils (`apt install poppler-utils`, `brew install poppler`).
- Optional: `tesseract-ocr` (scanned PDFs; set `SIGN_IT_TESSERACT` to point at a specific binary), `uv` + `openssl` (for the seal). `qpdf` is used only by the test suite.

## One-time setup

```
node scripts/sign-it.mjs setup --draw          # opens setup/draw.html: draw, click Download
node scripts/sign-it.mjs setup --from ~/Downloads/signature.png --name "Your Name"
node scripts/sign-it.mjs doctor
```

Any transparent PNG of your signature works with `--from`. Files live in `~/.config/sign-it/` (directory 0700; the signature, config and certificate material are 0600; the pyhanko environment under `.venv/` keeps normal permissions); set `SIGN_IT_HOME` to move them. `setup --draw` opens the page with `xdg-open` or `open`; set `SIGN_IT_OPENER` to use another launcher.

## Use

```
node scripts/sign-it.mjs find contract.pdf                       # list candidate lines with their source
node scripts/sign-it.mjs sign contract.pdf --find "Client" --preview
node scripts/sign-it.mjs sign contract.pdf --page 3 --x 20% --y 12% --width 25% --date-x 50% --date-y 12%   # manual
node scripts/sign-it.mjs sign contract.pdf --find "By" --seal    # plus PAdES seal
```

Commands print their JSON result on stdout; `doctor`, `setup`, `find` with no candidates, and a failed `seal` do so even on a non-zero exit. Hard failures of `sign` and usage errors print nothing on stdout and a `sign-it: <message>` block on stderr, which lists the candidate lines when the slot is ambiguous. Exit codes: 0 ok, 1 usage, 2 no signature configured, 3 no or ambiguous slot, 4 missing dependency, 5 PDF or file error. Without `--find` or `--pick` it signs only when there is exactly one candidate. OCR placements carry an `ocrNote` in the result: check the preview.

## What the seal is and is not

`seal-setup` creates a self-signed PKCS#12 and a pyhanko environment; `--seal` writes a PAdES (CAdES-detached) signature covering the whole file. Verifiers such as `pdfsig` or Acrobat report the signature as valid and the issuer as untrusted, which is the honest description: it proves integrity, not identity. A certificate from a trusted authority can be dropped into `~/.config/sign-it/cert.p12` to change that.

## Legal note

Whether a stamped image is accepted as a signature depends on the counterparty and your jurisdiction. This tool makes no determination either way, and neither should an agent on its behalf. This is not legal advice.

## Related tools

Open-Document-Alliance/PDF-Tools (MCP server with a Sign Mode), DrBaher/sign-cli (agent-first contract-ops CLI with MCP and PAdES), and dwmkerr/claude-toolkit's pdf-sign recipe cover neighbouring ground. sign-it is deliberately narrower: one command, the operator's own signature only, fail-closed on ambiguity, MIT-only dependencies.

## Tests

`bash tests/run.sh` builds synthetic agreements with pdf-lib and checks: the legal-claims lint, refusal without a configured signature, rejection of an undecodable PNG at `setup --from`, file modes, migration of a pre-rename config directory, slot detection with same-line and next-line date slots, an AcroForm signature field paired with a Date text field and stamped inside its rectangle (plus already-signed and hidden fields skipped, attributes inherited up nested parents, a date field shared across pages drawn locally, a read-only date field left alone), pages rotated 90 and 270 degrees whose stamped date OCRs upright on the right line (text and form-field variants), degenerate and off-page signature rectangles skipped, a short date field taking the ISO form, manual placement with a manual date slot, signing with preview, `dateNote` when no date field exists versus `--date none`, refusal on a prose-only document, refusal on several candidates and resolution with `--pick`, manual placement with off-page, out-of-range and non-numeric refusals, refuse-to-overwrite including through a symlink and `../`, a missing output directory, the `--` separator, a corrupt stored signature PNG, chained signatures, scanned pages (OCR candidates, refusal on a scanned prose page, exit 4 without tesseract, `--no-ocr`), and (with `SIGN_IT_TEST_SEAL=1`) the seal with no plaintext key left behind and a PAdES signature type.
