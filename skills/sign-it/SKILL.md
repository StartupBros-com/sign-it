---
name: sign-it
description: Stamps the operator's own saved signature image and today's date onto a PDF's signature line, for "sign this/that/it", "sign as Party A", "sign the NDA/contract", or "put my signature on it"; finds the line in form fields, text, or scanned pages, renders a preview, and can add a cryptographic seal. PDF documents only, not git or code signing or account sign-in/sign-up, never a counterparty's signature.
---

# sign-it

The operator drew their signature once; you apply it. The CLI is `scripts/sign-it.mjs` under this skill's base directory: use the base directory the harness reports when it loads this skill, never a path copied from prose. Commands print their JSON result on stdout; `doctor`, `setup`, `find` with no candidates, and a failed `seal` do so even on a non-zero exit. Hard failures of `sign` and usage errors print nothing on stdout and a `sign-it: <message>` block on stderr, which lists the candidate lines when the slot is ambiguous. Exit codes: 0 ok, 1 usage, 2 no signature configured, 3 no or ambiguous slot, 4 missing dependency, 5 PDF or file error.

## Hard rules

- Never draw, generate, or fabricate a signature. If none is configured, the only correct move is the one-time setup below, and the answer to "sign that" is "not yet, here is the one step".
- Never stamp at a guessed position. The tool refuses when it cannot find a signature field or a labeled blank line; do not work around it with a default coordinate. Measure from a render first.
- The stored signature belongs to the operator. Do not apply it for anyone else, and do not use this skill to sign as a counterparty.
- The input file is never overwritten; the output is `<name>-signed.pdf` beside it unless told otherwise.
- Make no determination about legal validity, in either direction. Whether a stamped signature is accepted is the counterparty's call; say so if asked. A self-signed seal proves the file was not altered after sealing, not who signed it.

## Flow

1. **Locate the file in the working directory first.** Use the path given. For "that" or "the one from X", run `ls` in the working directory (and `~/Downloads` if the file is not there); never run a filesystem-wide `find /`, which can stall for minutes on mounted drives. Name the file in your reply so a wrong pick is caught. A `.docx` must be converted first (`libreoffice --headless --convert-to pdf`) if LibreOffice exists; otherwise say so.
2. **Doctor.** `node <base>/scripts/sign-it.mjs doctor`. Exit 2 means no signature: run `setup --draw`, tell the operator to draw and download, then `setup --from <png>`; stop there this turn. Exit 4 means a dependency: `pnpm install --dir <base>` (or `npm install --prefix <base>`) for pdf-lib, `poppler-utils` for pdftotext and pdftoppm, `tesseract-ocr` only for scanned PDFs.
3. **Find the slot.** `node <base>/scripts/sign-it.mjs find <pdf>` lists candidates with page, source, label, line text, rotation, and whether a date slot sits beside it, plus a `skipped` list for signature fields that are already signed, hidden, degenerate, or off the page (never stamp over those; tell the operator). Sources in confidence order: `acroform` (a real signature field in the PDF), `text` (a blank after a label in the text layer), `ocr` (a scanned page read with tesseract; approximate). Rotated pages are handled: coordinates are as displayed and the stamp is drawn upright. Choose with the operator's words ("sign as Party B", "the client line", "the last page") via `--find TEXT` or `--pick N`. Without either, the tool signs only when there is exactly one candidate; any other case is exit 3. When the labels make the choice obvious (a Signature line beside a Print Name line), pass `--find` yourself; when they do not (Party A versus Party B), ask which line, quoting the candidate lines verbatim. Never pick silently among equals.
4. **Sign with a preview.** `node <base>/scripts/sign-it.mjs sign <pdf> --find "<label>" --preview` (or `--pick N`). Open the preview PNG with the Read tool and check two things: the signature sits on the line, not over printed text, and the date is readable. If the JSON carries `dateNote`, no date was stamped; say so. If it carries `ocrNote`, the placement is approximate: look harder at the preview. If the placement is off, render the page (`pdftoppm -f P -l P -png -r 70`), measure, and re-run with `--page P --x X --y Y --width W` (points from the bottom-left as displayed, or percentages like `20%`), adding `--date-x X --date-y Y [--date-width W]` so the date is not lost; off-page values are refused.
5. **Several lines for the same signer** (initials on every page, two copies): sign once per slot, feeding each output into the next run with `--out`.
6. **Seal only when it helps.** `--seal` adds a PAdES signature from the local PKCS#12 (`seal-setup` creates one). Use it when the recipient asked for a tamper-evident file; explain that it is self-signed. When the seal succeeds the deliverable is the `sealedOut` path in the JSON, not `out`.
7. **Report** the output path, page, and what was placed, in one or two sentences. If asked to send it back, use the operator's mail tool and attach the signed file.

## Setup (once, human-only step)

`node <base>/scripts/sign-it.mjs setup --draw` opens `setup/draw.html`, a canvas page: draw with mouse, trackpad, or finger, click Download, then `setup --from ~/Downloads/signature.png`. If the page did not open (`opened: false` in the JSON), give the operator the path. A transparent PNG scanned or exported elsewhere works the same way. Optional: `setup --name "Full Name"` (printed under the signature only with `--name`), `setup --date-format long|iso|us`. Files live under `~/.config/sign-it/` (override with `SIGN_IT_HOME`; a pre-rename `~/.config/sign-pdf/` is used until `setup` runs once, which moves it, and `doctor` says so); the directory is 0700 and its top-level files (signature, config, certificate material) are 0600; the pyhanko environment under `.venv/` keeps normal permissions.

## Reference

- `find <pdf> [--no-ocr]`: candidates from AcroForm `/Sig` widgets (a text field named like Date on the same page pairs as the date), from `pdftotext -bbox` (a run of underscores after a label such as Signature, Signed, By, Party, Name, Client, Authorized; a Date label on the same or next line becomes the date slot), and for pages with no text layer from tesseract OCR (labels anchor an approximate slot to their right).
- `sign <pdf> [--find TEXT | --pick N | --page P --x X --y Y --width W [--date-x X --date-y Y [--date-width W]]] [--date auto|none|TEXT] [--name] [--out FILE] [--preview] [--seal] [--max-width PT] [--no-ocr]`. On unrotated pages a real Date form field is filled through the form API (an ISO date if the field is short); on rotated pages and shared fields the date is drawn over the box. A literal `--` ends option parsing for file names that start with `--`.
- `seal <pdf> [--out FILE]`, `seal-setup`, `setup`, `doctor`. `SIGN_IT_OPENER` picks the browser launcher for `setup --draw`; `SIGN_IT_TESSERACT` points at a tesseract binary.
- Tests: `bash tests/run.sh` (synthetic fixtures, no real signature needed).
