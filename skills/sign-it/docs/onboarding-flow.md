# sign-it first-run onboarding: the user flow

Status: spec, 2026-09-12, revised after three refute-by-default reviews (a non-technical user walkthrough, a privacy and safety review, an executability review against WSL2, macOS and Linux). Drives the next build; nothing here is implemented yet except where marked "exists".

## Who this is for

A House of Vibe member who is not technical. They run a small business, they sign PDFs by printing and scanning, they installed this plugin because someone told them to, and they have a contract to sign. They type `/sign-it` (Claude never starts the skill on its own). They will not read a README, will not type a flag, and never see a file path unless it is a link to click. Everything below is what the agent says and does on their behalf. Supported platforms this round: macOS, Linux, and Windows through WSL2. Native Windows Claude Code is not supported yet, and `doctor` says so in one sentence.

## Design rules (from the setups that already work for these users)

1. **Diagnose before touching anything.** `doctor` runs first, read-only, and decides whether onboarding is needed at all. Re-running setup when everything is stored asks nothing.
2. **One question at a time, multiple choice, recommended option first.** Asked through the host's blocking question tool. If that tool is absent, the same question is a numbered list in chat and the user answers with a number or a word. In a run with nobody to answer, the flow stops at the question; it never guesses.
3. **Say why in the same sentence as the ask.** The privacy boundary is stated where the friction is, scoped precisely (see "Privacy and safety").
4. **Hand the human-only step over cleanly and wait.** Drawing a signature is the human's. The agent opens the page, says exactly what to do, keeps checking on its own, and resumes when the drawing arrives.
5. **Prove it, then close with a receipt.** The user sees their signature rendered on a sample line and approves it; that render is also the security check. The closing message has one fixed shape and two phrases: one to sign, one to change anything.
6. **Nothing consequential is silent.** Replacing an existing signature is confirmed, the old one is kept, undo is one phrase, and a new signature re-confirms the printed name.
7. **No jargon reaches the user.** No flags, paths, file formats, exit codes, JSON, "config", "permissions". Those words live in this doc and in SKILL.md for the agent, not in chat. Every message and option the user reads is quoted below verbatim; the agent may reword only to answer a question the user asked.
8. **Phrasing tolerance is required.** "change my title", "update my job title", "I want a different title" all mean the same thing. The agent maps intent, never string-matches.

## When onboarding runs

| Situation | What happens |
|---|---|
| `/sign-it` and no signature stored | Full flow below, then the original request continues without re-asking anything answered. |
| Signature stored, a needed detail missing (a form asks for Title, none stored) | Only that detail is asked, in plain words, then stored. |
| Everything stored | No questions. Signing starts. |
| `/sign-it setup`, or "change my signature" / "update my title" in a `/sign-it` conversation | Shows what is stored, offers the one item asked about, never re-asks the rest. |
| A helper program is missing (poppler, qpdf, Node modules) | Step 0. |
| Native Windows without WSL | "sign-it runs on Mac, Linux, or Windows with WSL. On this computer it cannot run yet." Stops. |

## The flow

### Step 0: helper programs (silent when fine)

`doctor` reports tools present, signature present, and which details are stored. Only a missing tool speaks:

> One-time setup on this computer: I need a small helper program for reading PDFs. I can install it now; your computer may ask for your password, which is expected.

Options: **Install it now (Recommended)** / **Skip for now**. The agent runs the platform's installer itself (Homebrew or apt). If it cannot (no installer, no permission), the literal fallback is:

> I can't install it from here. This needs a technical helper: send them this line and they will know what to do: "install poppler-utils and qpdf for sign-it". Until then I can't sign on this computer.

That is the only place a technical phrase appears, and it is addressed to the helper, not the user.

### Step 1: the one-paragraph opener

Said once, before any question:

> Before I can sign for you, I need your signature one time. It stays on this computer, in a private folder that only your login can open, and I never draw a signature for you. One more thing: anyone who uses this same login on this computer could sign as you, so use your own login. This takes about a minute.

### Step 2: how to provide the signature (single choice)

Question: **"How would you like to give me your signature?"**

1. **Draw it now on this computer (Recommended)**: a drawing page opens; sign with your mouse, trackpad or finger and press Save.
2. **Use a photo or picture I already have**: any picture of your signature on a plain background.
3. **Draw it on my phone**: I give you a link to open on your phone; sign with your finger.
4. **Not now**: nothing is stored; type /sign-it any time to pick this up.

All voice is the user's ("my phone", "I already have"). Each path ends at Step 3.

**Draw on this computer.** The agent starts the drawing listener and opens the page in the user's browser (on WSL, the Windows browser, through the same PowerShell bridge the Word conversion uses; the page is served on localhost, which Windows reaches). It says:

> A drawing page just opened. Sign inside the box with your mouse, trackpad or finger, then press Save. I will keep checking here; you don't need to tell me.

When Save is pressed the signature is stored on the spot. There is no Download step and no file to find. The agent checks every twenty seconds for up to ten minutes. If the page did not open:

> I couldn't open the drawing page myself. Click this link to open it: [link]

If nothing has arrived after ten minutes:

> Still waiting for your signature. Say "ready" when you have pressed Save, or say "skip" and I will stop here.

**A photo or picture.** The agent says:

> Tell me where the picture is; Downloads is fine, or the name of the file. If your window lets you, you can also drag the file in here.

On WSL, "Downloads" means both the Linux and the Windows Downloads folders. The agent reads PNG and JPG and phone photos on a plain background, cutting the background away itself, then goes to Step 3 with: "I cleaned up the background; here is the result." If the picture cannot be used:

> That picture won't open for me. The quickest fix is to draw your signature instead. Or email the photo to yourself and try the copy you receive; that usually works.

(HEIC, the iPhone default, is the usual cause; the word is never spoken. If the picture is too small or blank: "That picture is too small for me to use as a signature. Try a closer photo, or draw it instead.")

**Phone.** Available when the computer has a network address a phone can reach: the LAN address on macOS or Linux (virtual interfaces excluded), or a Tailscale address when Tailscale runs where sign-it runs (on WSL2 that means inside WSL; the WSL2 internal address is never offered because a phone cannot reach it). When available, the agent says:

> Open this on your phone and sign with your finger, then press Save: [link]
> Your phone needs to be on the same Wi-Fi as this computer. The link is long and random, works for ten minutes, and stops working the moment a signature arrives. Anyone on your Wi-Fi who had this link could open it during those ten minutes, so don't share it.

When the drawing arrives: "A signature just arrived from your phone; here is how it looks." then Step 3, where the user confirms it is theirs. If the link expires unused, the agent reissues one: "That link timed out. Here is a new one, good for another ten minutes: [link]". When the phone path is not available:

> Your phone and this computer aren't on a network I can use. Draw it on this computer instead, or use a photo.

**Not now.** The agent stops and stores nothing: "Okay. Nothing was saved. Type /sign-it with a document whenever you're ready."

### Step 3: proof before first use

The agent stamps the stored signature onto a sample signature line, renders it, and shows the image:

> Here is how it will look on a document. If this doesn't look like your signature, say Redraw. Keep it, redraw it, or use a different picture?

Options: **Keep it (Recommended)** / **Redraw** / **Use a different picture**. Redraw returns to Step 2; the previous signature is kept until the new one is approved.

### Step 4: details, one question each, all skippable except the name

- **Name.** "How should your name print under your signature?" When the computer knows a full name (git's global user name, two words or more), it is offered as the Recommended option; the user still chooses it. A login name such as "will" is never offered. Otherwise free text.
- **Title.** "Some forms ask for a title, such as Managing Member or CEO. What is yours? You can skip this."
- **Company.** "Your company name as it appears on your contracts? It helps me find your side of a two-party signature block. You can skip this."
- **Email.** "An email for forms that ask for one? You can skip this."
- **Date style.** "How should dates look?" **September 12, 2026 (Recommended)** / **2026-09-12** / **09/12/2026**.

Each answer is stored the moment it is given, so an interruption loses nothing.

### Step 5: receipt

One fixed shape, each item on its own line:

> ✅ sign-it is ready.
> Signature: saved (drawn on this computer)
> Name: Jane Example
> Title: Managing Member
> Company: Example LLC
> Email: skipped
> Dates: September 12, 2026
> Stored in a private folder that only your login on this computer can open.
> Type /sign-it with a document to sign it, or /sign-it setup to change any of this.

Then, if the user started with a document, the agent proceeds to sign it without re-asking anything answered here.

## Re-entry and change

- "change my signature" (any phrasing) → Step 2 with the same paths; the old signature is kept until the new one is approved in Step 3; then one confirmation: "This will print your name as Jane Example. Still right?" **Yes (Recommended)** / **Change it**. "undo my signature" restores the previous one.
- "change my title" (or name, company, email, date style; any phrasing) → that one question, nothing else.
- `/sign-it setup` → the receipt with current values, then "What would you like to change?" with one option per item and **Nothing (Recommended)**.

## What the user is never asked

- To type a path, a flag, or a command.
- To find a downloaded file, or to know what a file format is.
- Whether the signature is legally valid; the agent makes no determination either way.
- To sign as someone else, or to let the agent invent a signature, a title, or an email.
- To answer the same question twice on the same login.

## Failure handling

| Failure | The agent says | Then |
|---|---|---|
| Browser page did not open | "I couldn't open the drawing page myself. Click this link to open it: [link]" | keeps checking |
| No drawing after ten minutes | "Still waiting for your signature. Say 'ready' when you have pressed Save, or say 'skip' and I will stop here." | waits again, or stops without storing |
| Phone link expired unused | "That link timed out. Here is a new one, good for another ten minutes: [link]" | reissues once, then offers the other paths |
| Phone can't load the link | "Your phone needs to be on the same Wi-Fi as this computer. If it still won't open, draw it on this computer instead." | Step 2 |
| Unreadable picture | "That picture won't open for me. The quickest fix is to draw your signature instead. Or email the photo to yourself and try the copy you receive." | Step 2 |
| Picture too small or blank | "That picture is too small for me to use as a signature. Try a closer photo, or draw it instead." | Step 2 |
| Someone else's signature is stored here | "The signature stored here belongs to whoever set this login up. Ask whoever manages this computer for a login of your own, then type /sign-it there." | stops |
| Helper program cannot be installed | the technical-helper sentence from Step 0 | stops |

## Privacy and safety, stated to the user once and enforced in the tool

Spoken (in the opener and the receipt): the signature and details stay on this computer in a private folder that only this login can open; sign-it never sends them to us or to any server; the phone path moves the drawing only from the user's phone to this computer over the user's own network. What the user later sends (a signed document, a sealed document) goes wherever they send it; that is theirs, not sign-it's.

Enforced: the folder and files are owner-only on macOS, Linux and WSL (the platforms supported this round); the agent never draws, generates, or types a signature in a script font; the agent never signs as a counterparty; the tool refuses a line that already carries a signature; the phone link is a random token of at least 128 bits, loadable until used or expired, consumed by the first accepted drawing, and the listener is torn down the moment a drawing is accepted, the user says skip, or the agent exits. The Step 3 render is the check that the drawing is the user's own: a drawing that does not look right is redrawn, never kept.

## What the CLI must gain (for the build, not for the user)

Exists today: `setup --draw` opens a canvas page that requires a Download step; `setup --from PNG`; `setup --name`; `setup --date-format`; `doctor`.

1. `setup --draw`: start a detached one-shot listener on localhost (ten-minute lifetime) serving the canvas page, which posts the drawing back; print the link; open it through the platform opener (on WSL, via the PowerShell bridge already used by `convert`), checking the opener's exit status before reporting it opened. `setup --draw --phone` binds the listener to a reachable address (LAN on macOS/Linux with loopback and virtual interfaces excluded; Tailscale where it runs locally; never the WSL2 internal address) with a 128-bit token in the path. `setup --wait [seconds]` blocks until a drawing arrives or the timeout, returning saved/waiting/expired; `setup --cancel` tears the listener down. The agent polls `--wait 20` in a loop while talking to the user.
2. `setup --from`: accept JPG and photos; cut a plain background to transparency with a pure-JS decoder (pngjs and jpeg-js, MIT); refuse HEIC and too-small images with the reasons above as plain codes the skill maps to the spoken sentences; on WSL resolve "Downloads" to the Windows profile's Downloads as well.
3. `setup --title`, `--company`, `--email`: stored beside name and date style.
4. `setup --preview`: render the stored signature onto a sample line and write a PNG for Step 3.
5. Replacing a signature keeps the previous one as `signature.prev.png`; `setup --undo` restores it.
6. `doctor` gains `missing` (plain names: signature, name, title, company, email) and `platform` (macos, linux, wsl, windows), and reports the private-folder protection actually verified.
7. Name suggestion: `doctor` reports `suggestedName` only from git's global user name when it has two words or more.

## SKILL.md changes (the agent's script)

- A "First run" section that maps `doctor`'s `missing` list and `platform` to the steps above, with the exact wording of every question and message from this document, the question-tool rule with the numbered-list fallback, the poll loop for drawing, and the rule that a signing request resumes automatically after the receipt.
- The existing "Setup (once, human-only step)" section is replaced by that section.

## Acceptance

**CLI tests (in the suite, run in CI):**
1. `setup --draw` listener: a test client loads the page and posts a PNG; the signature is stored without a Download step; a second post is rejected; `--cancel` stops the listener; a token that is expired is refused.
2. `setup --from` with a JPG on a white background yields a transparent signature; an HEIC and a 20-pixel image are refused with their codes.
3. `doctor` reports `missing` exactly for what is absent, `platform` correctly, and `suggestedName` only for a two-word git name.
4. Replacing a signature keeps the previous one and `--undo` restores it byte for byte.
5. The two safety invariants already covered stay covered: a line that carries ink is refused, and two equal signature lines are never picked silently.

**Skill wording checks (in the suite):** SKILL.md contains each quoted question and message above verbatim.

**Headless proofs (run by hand at release time, transcripts posted on the PR, as done for the draft flow):**
6. Fresh config, `/sign-it` with a document: the reply is the opener plus the Step 2 question; nothing is signed; no path or flag appears.
7. Everything stored, `/sign-it` with a document: no questions.
8. Signature stored, no title, a form with a Title line: exactly the title question.
9. `/sign-it change my signature`: Step 2 only; the previous signature is retained.

## Non-goals for this round

- Typed-name signatures in a cursive font (a fabricated signature, ruled out).
- Multiple signatures or initials per user.
- Cloud storage or syncing of the signature between machines.
- Certificates and sealing inside onboarding.
- Native Windows without WSL.
