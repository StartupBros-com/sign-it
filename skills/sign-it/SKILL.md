---
name: sign-it
description: Sign a PDF or Word document with your saved signature. Stamps it and today's date on the signature line, fills Printed Name, Title and Email, handles scanned pages, holds drafts until you say the text is final, and can add a cryptographic seal.
disable-model-invocation: true
---

# sign-it

This skill loads only when the operator types `/sign-it`; Claude never starts it on its own. Once it is loaded, "sign that", "the other one too", and "change my title" in the same conversation belong to this flow.

The operator drew their signature once; you apply it. The CLI is `scripts/sign-it.mjs` under this skill's base directory: use the base directory the harness reports when it loads this skill, never a path copied from prose. Commands print their JSON result on stdout; `doctor`, `setup`, `find` with no candidates, and a failed `seal` do so even on a non-zero exit. Hard failures of `sign` and usage errors print nothing on stdout and a `sign-it: <message>` block on stderr, which lists the candidate lines when the slot is ambiguous. Exit codes: 0 ok, 1 usage, 2 no signature configured, 3 no or ambiguous slot, 4 missing dependency, 5 PDF or file error.

## Hard rules

- Never draw, generate, or fabricate a signature. If none is configured, the only correct move is the one-time setup below, and the answer to a signing request is "not yet, here is the one step".
- Never stamp at a guessed position. The tool refuses when it cannot find a signature field or a labeled blank line; do not work around it with a default coordinate. Measure from a render first.
- The stored signature belongs to the operator. Do not apply it for anyone else, and do not use this skill to sign as a counterparty.
- The input file is never overwritten; the output is `<name>-signed.pdf` beside it unless told otherwise.
- Make no determination about legal validity, in either direction. Whether a stamped signature is accepted is the counterparty's call; say so if asked. A self-signed seal proves the file was not altered after sealing, not who signed it.

## Flow

1. **Locate the file in the working directory first.** Use the path given. For "that" or "the one from X", run `ls` in the working directory (and `~/Downloads` if the file is not there); never run a filesystem-wide `find /`, which can stall for minutes on mounted drives. Name the file in your reply so a wrong pick is caught. A Word document (.docx, .doc, .odt, .rtf) is converted first with `node <base>/scripts/sign-it.mjs convert <file>` (LibreOffice headless, or on WSL the Windows-side Word through PowerShell; exit 4 names what to install when neither exists), and the PDF it writes beside the source is what gets signed.
2. **Doctor.** `node <base>/scripts/sign-it.mjs doctor`, read-only. Check `platform` first: `windows` (native, no WSL) means say "sign-it runs on Mac, Linux, or Windows with WSL. On this computer it cannot run yet." and stop. Check `missing` (`signature`, `name`, `title`, `company`, `email`): if it contains `signature`, or this is the first time anything has been asked on this login, run **First run** below in full, then continue this same request without re-asking anything it just answered. If a signature is stored but `missing` names something this request needs (a form asks for Title and none is stored), ask only that one detail in the plain words from First run Step 4, store it, and continue — never re-ask what is already stored. Exit 4 means a missing dependency: that is First run Step 0 — offer to install it, run the platform's installer yourself, and fall back to the technical-helper sentence if you cannot.
3. **Find the slot, and read the draft markers first.** `node <base>/scripts/sign-it.mjs find <pdf>` returns `draftMarkers` before its candidates: any DRAFT, Proposed Revision, For Discussion, For Review, Redline, Not for signature, Sample, Specimen, Template, Void, Preliminary or Working copy found in a header, footer, watermark or short banner, each with `where` and a `phrase` (the exact words to remove, such as "Proposed Revision for Discussion"). The operator never sees a flag or a command; you run this conversation:
   - Markers present, and the operator has not said the text is final: do not sign this turn. Ask one question in plain words, quoting the phrase and where it sits: "This document says 'Proposed Revision for Discussion' in the footer of every page. Is the text final? If yes, I will remove that line and sign the clean copy. If it is still a proposal, I will hold."
   - They say it is final and a Word file is at hand (the .docx you converted, or one they name): run `finalize <docx> --remove "<phrase>"` with one `--remove` per distinct phrase, `convert` the `-final.docx`, run `find` on it (the markers must be gone), then sign and fill as below, and name the finalized file in your reply. Never feed `finalize` text the tool did not report or the operator did not name.
   - They say it is final but only a PDF exists: say the footer cannot be edited from the PDF, offer to sign it as is or to work from the Word file if they have it, and wait.
   - They say sign it as is: pass `--draft-ok`; the result records the markers, and your report says the draft marker stayed.
   - They already said "final", "this is the final version", or asked you to remove the draft footer: skip the question and proceed.
   Never pass `--draft-ok` on your own. `find` lists candidates with page, source, label, line text, rotation, and whether a date slot sits beside it, plus a `skipped` list for signature fields that are already signed, hidden, degenerate, or off the page (never stamp over those; tell the operator). Sources in confidence order: `acroform` (a real signature field in the PDF), `text` (a blank after a label in the text layer), `ocr` (a scanned page read with tesseract; approximate), `text-label` (a short label such as "Officer's signature" with a wide gap beside it where a drawn rule sits) and `text-caption` (a caption printed UNDER a drawn rule, the SBA and IRS layout: the slot is the empty band above the caption); both are confidence 0.5, never auto-picked: check a render, then pass `--find` or `--pick`. Every candidate carries `ink`, the dark share of its stamp area; above 0.025 it is flagged `note: already carries ink` (an existing signature, a typed name, a filled field) and `sign` refuses it with exit 3. Never pass `--over-ink` on your own: an inked line is somebody's signature until the operator says otherwise. Rotated pages are handled: coordinates are as displayed and the stamp is drawn upright. A flattened form (a scanned image with a few typed values in its text layer) can list nothing: retry with `--ocr`, which reads every page with tesseract. Choose with the operator's words ("sign as Party B", "the client line", "the last page") via `--find TEXT` or `--pick N`. Without either, the tool signs only when there is exactly one candidate; any other case is exit 3. When the labels make the choice obvious (a Signature line beside a Print Name line), pass `--find` yourself; when they do not (Party A versus Party B), ask which line, quoting the candidate lines verbatim. Never pick silently among equals.
4. **Sign with a preview.** `node <base>/scripts/sign-it.mjs sign <pdf> --find "<label>" --preview` (or `--pick N`). Open the preview PNG with the Read tool and check two things: the signature sits on the line, not over printed text, and the date is readable. If the JSON carries `dateNote`, no date was stamped; say so. If it carries `ocrNote`, the placement is approximate: look harder at the preview. If the placement is off, render the page (`pdftoppm -f P -l P -png -r 70`), measure, and re-run with `--page P --x X --y Y --width W` (points from the bottom-left as displayed, or percentages like `20%`), adding `--date-x X --date-y Y [--date-width W]` so the date is not lost; off-page values are refused.
5. **Fill the rest of the block.** A signature block usually carries Printed Name, Title, Date, Email lines. `node <base>/scripts/sign-it.mjs fields <pdf>` lists every labeled blank ("Printed Name: ____") and text field with its page and column; `fill <pdf> --set "Printed Name=<name>" --set "Title=<title>" --set "Email=<email>" --near "<party header>" --out <file>` writes them. `--near` names text printed above the operator's column (the party name) so a label that appears in both columns lands on the right side; without it a doubled label is exit 3 listing both — but it may be omitted when the stored company matches exactly one column's header text, in which case the CLI picks it and reports `near: <company> (from setup)`. A blank that already carries ink, a pre-filled field, or an unmatched label is exit 3 and nothing is written. Use the operator's stored name, title, company, and email for the matching `--set` values; never invent any of them. When a detail this fill needs is not stored, ask once in plain words for that detail alone (the wording in First run, Step 4), then store the answer and reuse it for the rest of the session and for next time. The operator never has to know these are `--set` values. Chain with `sign` in either order through `--out`.
6. **Several lines for the same signer** (initials on every page, two copies): sign once per slot, feeding each output into the next run with `--out`.
7. **Seal only when it helps.** `--seal` adds a PAdES signature from the local PKCS#12 (`seal-setup` creates one). Use it when the recipient asked for a tamper-evident file; explain that it is self-signed. When the seal succeeds the deliverable is the `sealedOut` path in the JSON, not `out`.
8. **Report** the output path, page, and what was placed, in one or two sentences. If asked to send it back, use the operator's mail tool and attach the signed file.

## First run

Before the opener, read `doctor.protection`: when it is `unverified`, replace "in a private folder that only your login can open" with "in a private folder on this computer" and say nothing more about it; `owner-only` keeps the sentence as written.

This is the script for a non-technical operator who has never used sign-it: they typed `/sign-it`, will not read a README, will not type a flag, and never see a file path unless it is a link to click. Every message and option below is quoted verbatim; reword only to answer a question the operator asked. Supported this round: macOS, Linux, and Windows through WSL2 (native Windows is Step 0/2's platform check above, not this section).

Ask through the host's blocking question tool: one question at a time, multiple choice, the recommended option first. If that tool is not available, ask the same question as a numbered list in chat and accept a number or a word back. If nobody answers, stop at the question — never guess, never invent a signature, a title, or an email, never sign as someone else. Map intent loosely ("change my title", "update my job title", "I want a different title" all mean the same thing); never string-match. Nothing here is asked twice on the same login.

**When onboarding runs:**

| Situation | What happens |
|---|---|
| `/sign-it` and no signature stored | Full flow below, then the original request continues without re-asking anything answered. |
| Signature stored, a needed detail missing (a form asks for Title, none stored) | Only that detail is asked, in plain words, then stored. |
| Everything stored | No questions. Signing starts. |
| `/sign-it setup`, or "change my signature" / "update my title" in a `/sign-it` conversation | Shows what is stored, offers the one item asked about, never re-asks the rest. |
| A helper program is missing (poppler, qpdf, Node modules) | Step 0. |
| Native Windows without WSL | "sign-it runs on Mac, Linux, or Windows with WSL. On this computer it cannot run yet." Stops. |

**Step 0: helper programs (silent when fine).** `doctor` reports tools present, signature present, and which details are stored; only a missing tool speaks:

> One-time setup on this computer: I need a small helper program for reading PDFs. I can install it now; your computer may ask for your password, which is expected.

Options: **Install it now (Recommended)** / **Skip for now**. Run the platform's installer yourself (Homebrew or apt). If you cannot (no installer, no permission):

> I can't install it from here. This needs a technical helper: send them this line and they will know what to do: "install poppler-utils and qpdf for sign-it". Until then I can't sign on this computer.

That is the only place a technical phrase appears, and it is addressed to the helper, not the operator.

**Step 1: the one-paragraph opener.** Said once, before any question:

> Before I can sign for you, I need your signature one time. It stays on this computer, in a private folder that only your login can open, and I never draw a signature for you. One more thing: anyone who uses this same login on this computer could sign as you, so use your own login. This takes about a minute.

**Step 2: how to provide the signature (single choice).** Question: **"How would you like to give me your signature?"**

1. **Draw it now on this computer (Recommended)**: a drawing page opens; sign with your mouse, trackpad or finger and press Save.
2. **Use a photo or picture I already have**: any picture of your signature on a plain background.
3. **Draw it on my phone**: I give you a link to open on your phone; sign with your finger.
4. **Not now**: nothing is stored; type /sign-it any time to pick this up.

*Draw on this computer.* Run `setup --draw`, which starts a detached listener and opens the page through the platform opener (on WSL, the Windows browser via the same PowerShell bridge `convert` uses). Say:

> A drawing page just opened. Sign inside the box with your mouse, trackpad or finger, then press Save. I will keep checking here; you don't need to tell me.

Then poll: run `setup --wait 20` in a loop (each call blocks up to 20 seconds and returns `saved`, `expired`, or `waiting`) — say nothing between polls, and speak only once ten minutes of waiting have passed with nothing saved. If the page did not open (`opened: false`):

> I couldn't open the drawing page myself. Click this link to open it: [link]

After ten minutes with nothing saved:

> Still waiting for your signature. Say "ready" when you have pressed Save, or say "skip" and I will stop here.

"ready" resumes the same `setup --wait` loop; "skip" runs `setup --cancel` and returns to Step 2.

*A photo or picture.* Say:

> Tell me where the picture is; Downloads is fine, or the name of the file. If your window lets you, you can also drag the file in here.

On WSL, "Downloads" means both the Linux and the Windows Downloads folders: run `ls ~/Downloads` and `ls /mnt/c/Users/*/Downloads` (never a filesystem-wide find) and match the name the operator gave. Run `setup --from <path>` on the file named; the CLI cuts the background away itself. On success go to Step 3 with: "I cleaned up the background; here is the result." If it cannot be used (exit 3, `unsupported-photo`):

> That picture won't open for me. The quickest fix is to draw your signature instead. Or email the photo to yourself and try the copy you receive; that usually works.

The word HEIC is never spoken to the operator. If too small or blank (exit 3, `too-small`):

> That picture is too small for me to use as a signature. Try a closer photo, or draw it instead.

*Phone.* Available when `setup --draw --phone` finds a reachable address. When available, say:

> Open this on your phone and sign with your finger, then press Save: [link]
> Your phone needs to be on the same Wi-Fi as this computer. The link is long and random, works for ten minutes, and stops working the moment a signature arrives. Anyone on your Wi-Fi who had this link could open it during those ten minutes, so don't share it.

Poll the same way as the on-computer path. When the drawing arrives: "A signature just arrived from your phone; here is how it looks." then Step 3. If the link expires unused, reissue with `setup --draw --phone` again: "That link timed out. Here is a new one, good for another ten minutes: [link]" (reissue once, then offer the other paths). When not available (`--draw --phone` exits 3 with `phone: false`):

> Your phone and this computer aren't on a network I can use. Draw it on this computer instead, or use a photo.

*Not now.* Stop and store nothing: "Okay. Nothing was saved. Type /sign-it with a document whenever you're ready."

**Step 3: proof before first use.** Run `setup --preview` and show the resulting image:

> Here is how it will look on a document. If this doesn't look like your signature, say Redraw. Keep it, redraw it, or use a different picture?

Options: **Keep it (Recommended)** / **Redraw** / **Use a different picture**. Redraw or a different picture return to Step 2; the previous signature is kept (via `signature.prev.png`) until the new one is approved here.

**Step 4: details, one question each, all skippable except the name.**

- **Name.** "How should your name print under your signature?" `doctor.suggestedName` (git's global user name, two words or more only) is offered as the Recommended option when present; a login name such as "will" is never offered. Otherwise free text.
- **Title.** "Some forms ask for a title, such as Managing Member or CEO. What is yours? You can skip this."
- **Company.** "Your company name as it appears on your contracts? It helps me find your side of a two-party signature block. You can skip this."
- **Email.** "An email for forms that ask for one? You can skip this."
- **Date style.** "How should dates look?" **September 12, 2026 (Recommended)** / **2026-09-12** / **09/12/2026**.

Store each answer the moment it is given (`setup --name/--title/--company/--email/--date-format`) so an interruption loses nothing.

**Step 5: receipt.** One fixed shape, each item on its own line:

> ✅ sign-it is ready.
> Signature: saved (drawn on this computer)
> Name: Jane Example
> Title: Managing Member
> Company: Example LLC
> Email: skipped
> Dates: September 12, 2026
> Stored in a private folder that only your login on this computer can open.
> Type /sign-it with a document to sign it, or /sign-it setup to change any of this.

"Signature: saved" names the path actually used (drawn on this computer, drawn on your phone, or a photo); a skipped detail reads "skipped", not blank. If the operator started with a document to sign, proceed to sign it now without re-asking anything answered here.

**Re-entry and change.**

- "change my signature" (any phrasing) → Step 2 with the same paths; the old signature is kept until the new one is approved in Step 3; then one confirmation: "This will print your name as Jane Example. Still right?" **Yes (Recommended)** / **Change it**. "undo my signature" runs `setup --undo`, which restores the previous one.
- "change my title" (or name, company, email, date style; any phrasing) → that one question, nothing else.
- `/sign-it setup` → the receipt with current values, then "What would you like to change?" with one option per item and **Nothing (Recommended)**.

**What the operator is never asked:** to type a path, a flag, or a command; to find a downloaded file or know a file format; whether the signature carries legal validity; to sign as someone else or let the agent invent a signature, a title, or an email; to answer the same question twice on the same login.

**Failure handling** (beyond the ones already quoted above):

| Failure | The agent says | Then |
|---|---|---|
| Phone can't load the link | "Your phone needs to be on the same Wi-Fi as this computer. If it still won't open, draw it on this computer instead." | Step 2 |
| Someone else's signature is stored here | "The signature stored here belongs to whoever set this login up. Ask whoever manages this computer for a login of your own, then type /sign-it there." | stops |
| Helper program cannot be installed | the technical-helper sentence from Step 0 | stops |

**Privacy, stated once, in the opener and the receipt:** the signature and details stay on this computer in a private folder that only this login can open; sign-it never sends them to us or to any server; the phone path moves the drawing only from the operator's phone to this computer over their own network. What the operator later sends (a signed or sealed document) goes wherever they send it; that is theirs, not sign-it's.

Files live under `~/.config/sign-it/` (override with `SIGN_IT_HOME`; a pre-rename `~/.config/sign-pdf/` is used until `setup` runs once, which moves it, and `doctor` says so); the directory is 0700 and its top-level files (signature, config, certificate material) are 0600; the pyhanko environment under `.venv/` keeps normal permissions.

## Reference

- `find <pdf> [--no-ocr]`: candidates from AcroForm `/Sig` widgets (a text field named like Date on the same page pairs as the date), from `pdftotext -bbox` (a run of underscores after a label such as Signature, Signed, By, Party, Name, Client, Authorized; a Date label on the same or next line becomes the date slot), and for pages with no text layer from tesseract OCR (labels anchor an approximate slot to their right).
- `sign <pdf> [--find TEXT | --pick N | --page P --x X --y Y --width W [--date-x X --date-y Y [--date-width W]]] [--date auto|none|TEXT] [--name] [--height PT] [--out FILE] [--preview] [--seal] [--max-width PT] [--no-ocr]`. The stamp never climbs into the text line above the slot (room-capped); `--height` caps it further on tight forms. On unrotated pages a real Date form field is filled through the form API (an ISO date if the field is short) unless it already holds a value, which is left alone and reported in `dateNote`; on rotated pages and shared fields the date is drawn over the box. A literal `--` ends option parsing for file names that start with `--`.
- `finalize <docx> --remove "TEXT" [--remove ...] [--out FILE]`: removes exactly the named text from a Word file's body, headers, footers, notes and VML watermark text paths (text split across runs is found; a dangling separator is tidied); writes `<name>-final.docx`; exit 3 and nothing written if any named text is absent; never chooses markers itself. A `.doc` must be saved as `.docx` first.
- `fields <pdf> [--no-ocr|--ocr]`: every labeled blank in the text layer and every AcroForm text field, with `ink` and `existing`, plus `draftMarkers`. `fill <pdf> --set "Label=Value" [--set ...] [--near TEXT] [--out FILE] [--preview] [--over-ink|--no-ink]`: labels match case-insensitively without the colon (exact first, then substring); text is Helvetica sized to fit, upright on rotated pages; a form field is set through the form API on unrotated pages; output is `<name>-filled.pdf` beside the input; all or nothing.
- `convert <doc> [--out FILE] [--force]`: Word document to PDF, LibreOffice first, then Word via `powershell.exe` on WSL (`SIGN_IT_SOFFICE`, `SIGN_IT_POWERSHELL` override the binaries); refuses to overwrite an existing PDF. `find` and `sign` refuse a Word document with exit 1 and point here.
- `seal <pdf> [--out FILE]`, `seal-setup`, `setup`, `doctor` (reports `wordConverter`: `libreoffice`, `word-com`, or null).
- Owner-password PDFs (government fill-ins, bank "print to PDF" forms: encrypted, but the user password is empty) are opened through a qpdf-decrypted scratch copy; `find`/`sign` report `repaired: "decrypted"` and the signed output carries no encryption. A file that needs a password to open is exit 5; a damaged file gets one qpdf rewrite (`repaired: "rewritten"`). Without qpdf an encrypted file is exit 4. `SIGN_IT_OPENER` picks the browser launcher for `setup --draw`; `SIGN_IT_TESSERACT` points at a tesseract binary.
- Tests: `bash tests/run.sh` (synthetic fixtures, no real signature needed).
