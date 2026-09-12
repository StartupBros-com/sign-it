#!/usr/bin/env bash
# sign-it test suite: synthetic fixtures only; never touches the real
# ~/.config/sign-it. Requires node, pdf-lib installed in the skill dir, and
# pdftotext. qpdf/pdftoppm/tesseract/pyhanko are used when present.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="$(cd "$HERE/.." && pwd)"
CLI="node $SKILL/scripts/sign-it.mjs"
T="$(mktemp -d /tmp/sign-it-test.XXXXXX)"
export SIGN_IT_HOME="$T/home"
pass=0; fail=0
ok()   { pass=$((pass+1)); echo "PASS $1"; }
bad()  { fail=$((fail+1)); echo "FAIL $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

for k in agreement plain ambiguous sameline nodate acroform acro-signed acro-hidden acro-nested acro-shared-date acro-readonly rotated rotated270 ruled twocolumn acro-text glued heading footers captions inked columns datafields datafields2 undercap wrapped thinink datebelow acro-prefilled acro-rot270 acro-zero acro-offpage acro-comb ocrlabels; do
  node "$HERE/make-fixture.mjs" "$k" "$T/$k.pdf" >/dev/null || { echo "fixture build failed (is pdf-lib installed? pnpm install --dir $SKILL)"; exit 1; }
done
cp "$T/agreement.pdf" "$T/agreement.orig.pdf"

# legal-claims lint: the docs make no validity determination
check "docs contain no legal-validity claim" "! grep -qiE 'legally (binding|valid)' $SKILL/SKILL.md $SKILL/README.md"

# planted negative 1: no signature configured -> exit 2, nothing written
$CLI sign "$T/agreement.pdf" --find "Party A" --out "$T/neg1.pdf" >/dev/null 2>"$T/neg1.err"; rc=$?
check "no-signature refuses (exit 2)" "[ $rc -eq 2 ]"
check "no-signature writes nothing" "[ ! -e $T/neg1.pdf ]"
check "no-signature names the setup step" "grep -q 'setup --draw' $T/neg1.err"

# planted negative 2: a PNG header on garbage is rejected at setup (exit 1)
printf '\x89PNG\x0d\x0a\x1a\x0aGARBAGEGARBAGEGARBAGE' > "$T/fake.png"
$CLI setup --from "$T/fake.png" >/dev/null 2>"$T/fake.err"; rc=$?
check "setup rejects an undecodable PNG (exit 1)" "[ $rc -eq 1 ] && [ ! -e $SIGN_IT_HOME/signature.png ]"

# setup from the committed test signature
$CLI setup --from "$HERE/fixture-signature.png" --name "Test Signer" >/dev/null; rc=$?
check "setup --from imports a PNG (exit 0)" "[ $rc -eq 0 ]"
check "signature stored 0600" "[ \"\$(stat -c %a $SIGN_IT_HOME/signature.png)\" = 600 ]"
check "home dir 0700" "[ \"\$(stat -c %a $SIGN_IT_HOME)\" = 700 ]"
$CLI doctor >"$T/doctor.json"; rc=$?
check "doctor ready" "[ $rc -eq 0 ] && grep -q '\"ready\": true' $T/doctor.json"

# pre-rename config dir is used until setup migrates it
mkdir -p "$T/fakehome/.config/sign-pdf"; cp "$HERE/fixture-signature.png" "$T/fakehome/.config/sign-pdf/signature.png"
( unset SIGN_IT_HOME; HOME="$T/fakehome" $CLI doctor >"$T/legacy-doctor.json" ); rc=$?
check "legacy ~/.config/sign-pdf is used and reported" "[ $rc -eq 0 ] && grep -q '\"legacyHome\": \"using' $T/legacy-doctor.json"
( unset SIGN_IT_HOME; HOME="$T/fakehome" $CLI setup >"$T/legacy-setup.json" ); rc=$?
check "setup migrates the legacy dir to ~/.config/sign-it" "[ $rc -eq 0 ] && [ -f $T/fakehome/.config/sign-it/signature.png ] && [ ! -e $T/fakehome/.config/sign-pdf ] && grep -q '\"migrated\": \"' $T/legacy-setup.json"

# find (text layer)
$CLI find "$T/agreement.pdf" >"$T/find.json"; rc=$?
check "find lists candidates (exit 0)" "[ $rc -eq 0 ]"
check "find sees Party A, Party B, Witness" "grep -q 'Party A' $T/find.json && grep -q 'Party B' $T/find.json && grep -qi 'witness' $T/find.json"
check "text candidates carry source text" "grep -q '\"source\": \"text\"' $T/find.json"
check "find pairs a same-line date slot" "python3 -c \"import json;d=json.load(open('$T/find.json'));c=[x for x in d['candidates'] if 'Party A' in x['line']][0];assert c['date'] is not None\""
check "find pairs a next-line date slot" "python3 -c \"import json;d=json.load(open('$T/find.json'));c=[x for x in d['candidates'] if 'Witness' in x['line']][0];assert c['date'] is not None\""
$CLI find "$T/sameline.pdf" >"$T/sameline.json"
check "same-line Signature+Date yields one signature slot with a date" "python3 -c \"import json;d=json.load(open('$T/sameline.json'));assert len(d['candidates'])==1 and d['candidates'][0]['date'] is not None\""

# drawn rule (no underscores): a short label with a wide gap is a low-confidence candidate
$CLI find "$T/ruled.pdf" >"$T/ruled-find.json"; rc=$?
check "ruled row yields a text-label candidate with a date" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/ruled-find.json'));c=[x for x in d['candidates'] if 'Officer' in x['label']][0];assert c['source']=='text-label' and c['confidence']==0.5 and c['date'] is not None, c\""
$CLI sign "$T/ruled.pdf" --out "$T/ruled-auto.pdf" >/dev/null 2>"$T/ruled-auto.err"; rc=$?
check "low-confidence lone candidate is not auto-picked (exit 3)" "[ $rc -eq 3 ] && [ ! -e $T/ruled-auto.pdf ] && grep -q 'low-confidence' $T/ruled-auto.err"
$CLI sign "$T/ruled.pdf" --find "Officer" --out "$T/ruled-signed.pdf" >"$T/ruled-sign.json"; rc=$?
check "ruled row signs with --find and a date" "[ $rc -eq 0 ] && grep -q '\"date\": \"' $T/ruled-sign.json"
check "stamp height stays below the text line above (room-capped)" "python3 -c \"import json;d=json.load(open('$T/ruled-sign.json'));assert d['height']<=26, d\""
check "slot steps past the short tail hanging over its left end instead of shrinking under it" "python3 -c \"import json;d=json.load(open('$T/ruled-sign.json'));assert d['x']>106 and d['height']>14, d\""
check "a pre-filled Title field with a drawn rule is not a candidate" "python3 -c \"import json;d=json.load(open('$T/ruled-find.json'));assert not any('PRESIDENT' in x['label'] for x in d['candidates']), d\""
check "apostrophe in the label is decoded (pdftotext emits &apos;)" "python3 -c \"import json;d=json.load(open('$T/ruled-find.json'));assert any(x['label']==\\\"Officer's signature\\\" for x in d['candidates']), d\""
check "prose line above the rule is not a candidate" "python3 -c \"import json;d=json.load(open('$T/ruled-find.json'));assert not any('enter my PIN' in x['label'] for x in d['candidates'])\""
$CLI sign "$T/agreement.pdf" --find "Party B" --height 12 --out "$T/short.pdf" >"$T/short.json"; rc=$?
check "--height caps the stamp" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/short.json'));assert d['height']<=12, d\""

# AcroForm: a /Sig widget is a confidence-1.0 candidate paired with the Date text field
$CLI find "$T/acroform.pdf" >"$T/acro.json"; rc=$?
check "acroform find (exit 0)" "[ $rc -eq 0 ]"
check "printed caption beside a real signature field is not a second candidate" "python3 -c \"import json;d=json.load(open('$T/acro.json'));assert [x['source'] for x in d['candidates']]==['acroform'], d\""
check "acroform /Sig widget listed" "python3 -c \"import json;d=json.load(open('$T/acro.json'));c=d['candidates'];assert len(c)==1 and c[0]['source']=='acroform' and c[0]['label']=='AcroForm: Signature1' and c[0]['confidence']==1.0\""
check "acroform date text field paired" "python3 -c \"import json;d=json.load(open('$T/acro.json'));assert d['candidates'][0]['date']['source']=='acroform'\""
$CLI sign "$T/acroform.pdf" --out "$T/acroform-out.pdf" >"$T/acro-sign.json"; rc=$?
check "acroform sign without a hint (single candidate, exit 0)" "[ $rc -eq 0 ] && [ -s $T/acroform-out.pdf ]"
check "acroform stamp lands inside the field rect" "python3 -c \"import json;d=json.load(open('$T/acro-sign.json'));assert 72<=d['x']<=300 and 600<=d['y']<=650 and d['x']+d['width']<=301 and d['y']+d['height']<=651\""
check "acroform date placed" "grep -q '\"date\": \"' $T/acro-sign.json"
check "acroform date written into the Date1 field value" "[ -n \"\$(node $HERE/read-field.mjs $T/acroform-out.pdf Date1)\" ]"

# AcroForm edge cases
$CLI find "$T/acro-signed.pdf" >"$T/acro-signed-find.json" 2>/dev/null; rc=$?
check "already-signed /Sig field is skipped, not a candidate (exit 3)" "[ $rc -eq 3 ] && grep -q 'already signed' $T/acro-signed-find.json"
$CLI sign "$T/acro-signed.pdf" --out "$T/neg-signed.pdf" >/dev/null 2>"$T/neg-signed.err"; rc=$?
check "already-signed field is never stamped over" "[ $rc -eq 3 ] && [ ! -e $T/neg-signed.pdf ] && grep -q 'already signed' $T/neg-signed.err"
$CLI find "$T/acro-hidden.pdf" >"$T/acro-hidden-find.json" 2>/dev/null; rc=$?
check "hidden /Sig widget is skipped (exit 3)" "[ $rc -eq 3 ] && grep -q 'hidden widget' $T/acro-hidden-find.json"
$CLI find "$T/acro-nested.pdf" >"$T/acro-nested.json"; rc=$?
check "field attributes inherited two Parent levels up" "[ $rc -eq 0 ] && grep -q 'AcroForm: Signature1' $T/acro-nested.json"
$CLI sign "$T/acro-shared-date.pdf" --out "$T/shared-signed.pdf" >"$T/shared.json"; rc=$?
check "shared date field: drawn on this page only, noted" "[ $rc -eq 0 ] && grep -q 'several pages' $T/shared.json && [ -z \"\$(node $HERE/read-field.mjs $T/shared-signed.pdf Date1)\" ]"
$CLI sign "$T/acro-readonly.pdf" --out "$T/ro-signed.pdf" >"$T/ro.json"; rc=$?
check "read-only date field left alone, noted" "[ $rc -eq 0 ] && grep -q 'read-only' $T/ro.json && grep -q '\"date\": null' $T/ro.json"

# rotated page: text reads upright when displayed; the stamp and date must too
$CLI find "$T/rotated.pdf" >"$T/rot-find.json"; rc=$?
check "rotated page lists candidates with rotation 90" "[ $rc -eq 0 ] && grep -q '\"rotation\": 90' $T/rot-find.json && grep -q 'Party A' $T/rot-find.json"
check "rotated page slot sits on the Party A line (display y near 397)" "python3 -c \"import json;d=json.load(open('$T/rot-find.json'));c=[x for x in d['candidates'] if 'Party A' in x['line']][0];assert 385<c['y']<410, c\""
$CLI sign "$T/rotated.pdf" --find "Party A" --date "2026-01-31" --out "$T/rot-signed.pdf" >"$T/rot.json"; rc=$?
check "rotated page signs (exit 0)" "[ $rc -eq 0 ] && grep -q '\"rotation\": 90' $T/rot.json"

# 270-degree page and an AcroForm signature field on a rotated page
$CLI find "$T/rotated270.pdf" >"$T/rot270-find.json"; rc=$?
check "270-degree page slot sits on the Party A line" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/rot270-find.json'));c=[x for x in d['candidates'] if 'Party A' in x['line']][0];assert c['rotation']==270 and 385<c['y']<410, c\""
$CLI sign "$T/acro-rot270.pdf" --date "2026-01-31" --out "$T/acro-rot270-signed.pdf" >"$T/acro-rot270.json"; rc=$?
check "acroform on a 270-degree page signs with the date drawn, not filled" "[ $rc -eq 0 ] && grep -q '\"date\": \"2026-01-31\"' $T/acro-rot270.json"
if command -v pdftoppm >/dev/null && command -v tesseract >/dev/null; then
  pdftoppm -f 2 -l 2 -r 150 -png -singlefile "$T/acro-rot270-signed.pdf" "$T/acro-rot270-render"
  tesseract "$T/acro-rot270-render.png" - --psm 6 2>/dev/null > "$T/acro-rot270-ocr.txt"
  check "date on the rotated form reads upright to OCR" "grep -q '2026-01-31' $T/acro-rot270-ocr.txt"
fi

# degenerate and off-page signature rectangles are skipped, short date fields get the ISO form
$CLI find "$T/acro-zero.pdf" >"$T/acro-zero.json" 2>/dev/null; rc=$?
check "zero-width /Sig rect is skipped (exit 3)" "[ $rc -eq 3 ] && grep -q 'degenerate rectangle' $T/acro-zero.json"
$CLI find "$T/acro-offpage.pdf" >"$T/acro-offpage.json" 2>/dev/null; rc=$?
check "off-page /Sig rect is skipped (exit 3)" "[ $rc -eq 3 ] && grep -q 'off the page' $T/acro-offpage.json"
$CLI sign "$T/acro-comb.pdf" --out "$T/acro-comb-signed.pdf" >"$T/acro-comb.json"; rc=$?
check "date field with maxLength 10 gets the ISO date" "[ $rc -eq 0 ] && python3 -c \"import json,re;d=json.load(open('$T/acro-comb.json'));assert re.fullmatch(r'\d{4}-\d{2}-\d{2}', d['date'] or ''), d\""
if command -v pdftoppm >/dev/null && command -v tesseract >/dev/null; then
  pdftoppm -f 2 -l 2 -r 150 -png -singlefile "$T/rot-signed.pdf" "$T/rot-render"
  tesseract "$T/rot-render.png" - --psm 6 2>/dev/null > "$T/rot-ocr.txt"
  check "date on the rotated page reads upright to OCR" "grep -q '2026-01-31' $T/rot-ocr.txt"
  tesseract "$T/rot-render.png" - --psm 6 tsv 2>/dev/null > "$T/rot-ocr.tsv"
  check "stamped date sits on the Party A row in the render" "python3 -c \"
import csv
rows=[r for r in csv.DictReader(open('$T/rot-ocr.tsv'), delimiter='\t') if r['level']=='5' and r['text'].strip()]
party=[r for r in rows if r['text']=='Party'][0]; date=[r for r in rows if '2026-01-31' in r['text']][0]
assert abs(int(party['top'])-int(date['top']))<40, (party['top'], date['top'])\""
fi

# sign Party B with preview
$CLI sign "$T/agreement.pdf" --find "Party B" --preview --out "$T/signed.pdf" >"$T/sign.json"; rc=$?
check "sign --find Party B (exit 0)" "[ $rc -eq 0 ]"
check "output exists" "[ -s $T/signed.pdf ]"
check "date placed" "grep -q '\"date\": \"' $T/sign.json"
check "original untouched" "cmp -s $T/agreement.orig.pdf $T/agreement.pdf"
check "text preserved in output" "pdftotext $T/signed.pdf - | grep -q 'Party B'"
if command -v qpdf >/dev/null; then check "qpdf --check clean" "qpdf --check $T/signed.pdf >/dev/null 2>&1"; fi
if command -v pdftoppm >/dev/null; then check "preview png written" "grep -q 'preview.png' $T/sign.json && [ -s $T/signed-preview.png ]"; fi
check "stamp lands on page 2" "grep -q '\"page\": 2' $T/sign.json"

# same-line layout signs and dates
$CLI sign "$T/sameline.pdf" --out "$T/sameline-signed.pdf" >"$T/sameline-sign.json"; rc=$?
check "same-line layout signs with a date" "[ $rc -eq 0 ] && grep -q '\"date\": \"' $T/sameline-sign.json"

# no date field anywhere: signs, reports dateNote
$CLI sign "$T/nodate.pdf" --out "$T/nodate-signed.pdf" >"$T/nodate-sign.json"; rc=$?
check "no date field: signs and reports dateNote" "[ $rc -eq 0 ] && grep -q '\"dateNote\": \"no date field' $T/nodate-sign.json"
$CLI sign "$T/nodate.pdf" --date none --out "$T/nodate-none.pdf" >"$T/nodate-none.json"
check "--date none carries no dateNote" "grep -q '\"dateNote\": null' $T/nodate-none.json"

# planted negative 3: prose-only document -> exit 3, nothing written
$CLI sign "$T/plain.pdf" --out "$T/neg2.pdf" >/dev/null 2>"$T/neg2.err"; rc=$?
check "no-slot refuses (exit 3)" "[ $rc -eq 3 ]"
check "no-slot writes nothing" "[ ! -e $T/neg2.pdf ]"

# planted negative 4: several candidates, no hint -> exit 3 with all listed
$CLI sign "$T/ambiguous.pdf" --out "$T/neg3.pdf" >/dev/null 2>"$T/neg3.err"; rc=$?
check "ambiguous refuses (exit 3)" "[ $rc -eq 3 ]"
check "ambiguous lists candidates" "grep -q '\[2\]' $T/neg3.err"
check "ambiguous writes nothing" "[ ! -e $T/neg3.pdf ]"
$CLI sign "$T/agreement.pdf" --out "$T/neg4.pdf" >/dev/null 2>&1; rc=$?
check "three labeled candidates without a hint refuse (exit 3)" "[ $rc -eq 3 ] && [ ! -e $T/neg4.pdf ]"
$CLI sign "$T/ambiguous.pdf" --pick 2 --out "$T/pick2.pdf" >/dev/null; rc=$?
check "--pick resolves ambiguity" "[ $rc -eq 0 ] && [ -s $T/pick2.pdf ]"

# manual placement, bounds, and bad numbers
$CLI sign "$T/agreement.pdf" --page 1 --x 20% --y 12% --width 25% --out "$T/manual.pdf" >/dev/null; rc=$?
check "manual placement (exit 0)" "[ $rc -eq 0 ] && [ -s $T/manual.pdf ]"
$CLI sign "$T/agreement.pdf" --page 2 --x 20% --y 75% --width 25% --date-x 47% --date-y 75% --out "$T/manual-date.pdf" >"$T/manual-date.json"; rc=$?
check "manual placement with a manual date slot" "[ $rc -eq 0 ] && grep -q '\"date\": \"' $T/manual-date.json"
$CLI sign "$T/agreement.pdf" --page 2 --x 20% --y 80% --width 25% --out "$T/manual-over-text.pdf" >/dev/null 2>"$T/manual-over-text.err"; rc=$?
check "manual placement over printed text is refused as inked (exit 3)" "[ $rc -eq 3 ] && grep -q 'already carries ink' $T/manual-over-text.err && [ ! -e $T/manual-over-text.pdf ]"
$CLI sign "$T/agreement.pdf" --page 1 --x 150% --y 12% --out "$T/offpage.pdf" >/dev/null 2>"$T/offpage.err"; rc=$?
check "off-page placement refused (exit 1)" "[ $rc -eq 1 ] && [ ! -e $T/offpage.pdf ] && grep -q 'off the page' $T/offpage.err"
$CLI sign "$T/agreement.pdf" --page 99 --x 10 --y 10 --out "$T/badpage.pdf" >/dev/null 2>&1; rc=$?
check "page out of range refused (exit 1)" "[ $rc -eq 1 ] && [ ! -e $T/badpage.pdf ]"
$CLI sign "$T/agreement.pdf" --page 1 --x abc --y 10 --out "$T/badx.pdf" >/dev/null 2>&1; rc=$?
check "non-numeric --x refused (exit 1)" "[ $rc -eq 1 ] && [ ! -e $T/badx.pdf ]"

# refuse-to-overwrite, including through a symlink and a relative path
$CLI sign "$T/agreement.pdf" --find "Party A" --out "$T/agreement.pdf" >/dev/null 2>&1; rc=$?
check "refuses to overwrite input (exit 1)" "[ $rc -eq 1 ]"
ln -sf "$T/agreement.pdf" "$T/alias.pdf"
$CLI sign "$T/agreement.pdf" --find "Party A" --out "$T/alias.pdf" >/dev/null 2>&1; rc=$?
check "refuses to overwrite input through a symlink (exit 1)" "[ $rc -eq 1 ] && cmp -s $T/agreement.orig.pdf $T/agreement.pdf"
( cd "$T" && $CLI sign "./agreement.pdf" --find "Party A" --out "./sub/../agreement.pdf" >/dev/null 2>&1 ); rc=$?
check "refuses to overwrite input via ../ (exit 1 or 5)" "[ $rc -eq 1 ] || [ $rc -eq 5 ]"
check "input still byte-identical after overwrite attempts" "cmp -s $T/agreement.orig.pdf $T/agreement.pdf"
$CLI sign "$T/agreement.pdf" --find "Party A" --out "$T/missing-dir/x.pdf" >/dev/null 2>&1; rc=$?
check "missing output directory is a clean exit 5" "[ $rc -eq 5 ]"

# file names that start with -- via the -- separator
cp "$T/agreement.pdf" "$T/--weird.pdf"
( cd "$T" && $CLI find -- "--weird.pdf" >/dev/null ); rc=$?
check "-- ends option parsing" "[ $rc -eq 0 ]"

# corrupt stored signature: clean exit 5, nothing written
cp "$SIGN_IT_HOME/signature.png" "$T/good.png"
cp "$T/fake.png" "$SIGN_IT_HOME/signature.png"
$CLI sign "$T/agreement.pdf" --find "Party A" --out "$T/corrupt.pdf" >/dev/null 2>"$T/corrupt.err"; rc=$?
check "corrupt stored PNG is a clean exit 5" "[ $rc -eq 5 ] && [ ! -e $T/corrupt.pdf ] && grep -q 'not a decodable PNG' $T/corrupt.err"
cp "$T/good.png" "$SIGN_IT_HOME/signature.png"

# chained signing: sign Party A on top of the Party B output
$CLI sign "$T/signed.pdf" --find "Party A" --out "$T/both.pdf" >/dev/null; rc=$?
check "chained second signature" "[ $rc -eq 0 ] && [ -s $T/both.pdf ]"

# scanned PDFs: no text layer -> OCR (tesseract) with approximate, flagged candidates
if command -v pdftoppm >/dev/null && command -v tesseract >/dev/null; then
  pdftoppm -f 2 -l 2 -r 150 -png -singlefile "$T/agreement.pdf" "$T/scan2" && node "$HERE/make-fixture.mjs" scanned "$T/scan2.png" "$T/scanned.pdf" >/dev/null
  pdftoppm -f 1 -l 1 -r 150 -png -singlefile "$T/plain.pdf" "$T/scan1" && node "$HERE/make-fixture.mjs" scanned "$T/scan1.png" "$T/scanned-prose.pdf" >/dev/null
  check "scanned fixture has no text layer" "[ -z \"\$(pdftotext $T/scanned.pdf - | tr -d '[:space:]')\" ]"
  $CLI find "$T/scanned.pdf" >"$T/scan-find.json"; rc=$?
  check "scanned find (exit 0)" "[ $rc -eq 0 ]"
  check "scanned candidates come from OCR and include Party A" "python3 -c \"import json;d=json.load(open('$T/scan-find.json'));c=[x for x in d['candidates'] if 'Party A' in x['line']];assert c and c[0]['source']=='ocr' and c[0]['confidence']<1\""
  $CLI sign "$T/scanned.pdf" --find "Party A" --preview --out "$T/scanned-signed.pdf" >"$T/scan-sign.json"; rc=$?
  check "scanned sign --find Party A (exit 0)" "[ $rc -eq 0 ] && [ -s $T/scanned-signed.pdf ]"
  check "scanned result carries the OCR note" "grep -q '\"ocrNote\"' $T/scan-sign.json"
  check "scanned stamp sits on the page's lower half where Party A is" "python3 -c \"import json;d=json.load(open('$T/scan-sign.json'));assert d['page']==1 and 550<d['y']<720, d\""
  $CLI sign "$T/scanned-prose.pdf" --out "$T/neg5.pdf" >/dev/null 2>"$T/neg5.err"; rc=$?
  check "scanned prose page refuses (exit 3), no corner fallback" "[ $rc -eq 3 ] && [ ! -e $T/neg5.pdf ]"
  SIGN_IT_TESSERACT=/nonexistent/tesseract $CLI sign "$T/scanned.pdf" --find "Party A" --out "$T/neg6.pdf" >/dev/null 2>"$T/neg6.err"; rc=$?
  check "scanned page without tesseract is exit 4 naming tesseract" "[ $rc -eq 4 ] && [ ! -e $T/neg6.pdf ] && grep -q 'tesseract' $T/neg6.err"
  $CLI find "$T/scanned.pdf" --no-ocr >/dev/null 2>&1; rc=$?
  check "--no-ocr on a scanned page finds nothing (exit 3)" "[ $rc -eq 3 ]"
  pdftoppm -f 2 -l 2 -r 150 -png -singlefile "$T/ocrlabels.pdf" "$T/scan3" && node "$HERE/make-fixture.mjs" scanned "$T/scan3.png" "$T/scanned-labels.pdf" >/dev/null
  $CLI find "$T/scanned-labels.pdf" >"$T/scan-labels.json"; rc=$?
  check "OCR label phrasings (Sign here, Authorized Signer, Signature of Tenant) are candidates" "python3 -c \"import json;d=json.load(open('$T/scan-labels.json'));ls=' | '.join(c['line'] for c in d['candidates']);assert 'Sign here' in ls and 'Authorized Signer' in ls and 'Signature of Tenant' in ls, ls\""
else
  echo "SKIP scanned-PDF cases (need pdftoppm and tesseract)"
fi

# seal when requested
if command -v uv >/dev/null && command -v openssl >/dev/null && [ "${SIGN_IT_TEST_SEAL:-0}" = 1 ]; then
  $CLI seal-setup >/dev/null 2>&1
  check "seal-setup leaves no plaintext key" "[ ! -e $SIGN_IT_HOME/cert.key ] && [ \"\$(stat -c %a $SIGN_IT_HOME/cert.p12)\" = 600 ]"
  check "every top-level file in the home is 0600" "[ -z \"\$(find $SIGN_IT_HOME -maxdepth 1 -type f ! -perm 600)\" ]"
  $CLI seal "$T/both.pdf" --out "$T/sealed.pdf" >/dev/null; rc=$?
  check "seal (exit 0)" "[ $rc -eq 0 ]"
  if command -v pdfsig >/dev/null; then
    check "pdfsig validates the seal" "pdfsig $T/sealed.pdf 2>&1 | grep -q 'Signature is Valid'"
    check "seal is PAdES (ETSI.CAdES.detached)" "pdfsig $T/sealed.pdf 2>&1 | grep -q 'ETSI.CAdES.detached'"
  fi
else
  echo "SKIP seal (set SIGN_IT_TEST_SEAL=1 with uv+openssl to exercise it)"
fi


# glued underscores: "signature_____" is one word; the blank is split off and the row is a 0.9 text slot
$CLI find "$T/glued.pdf" >"$T/glued-find.json"; rc=$?
check "glued underscores yield a 0.9 text slot with a date" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/glued-find.json'));c=d['candidates'];assert len(c)==1 and c[0]['source']=='text' and c[0]['confidence']==0.9 and c[0]['date'] is not None and 'signature' in c[0]['label'], c\""
$CLI sign "$T/glued.pdf" --out "$T/glued-signed.pdf" >"$T/glued-sign.json"; rc=$?
check "glued row signs without a hint (single 0.9 candidate)" "[ $rc -eq 0 ] && grep -q '\"date\": \"' $T/glued-sign.json"

# a centered "Signatures" heading over a slash table is not a candidate
$CLI find "$T/heading.pdf" >"$T/heading-find.json" 2>/dev/null; rc=$?
check "centered Signatures heading is not a candidate (exit 3, empty list)" "[ $rc -eq 3 ] && python3 -c \"import json;d=json.load(open('$T/heading-find.json'));assert d['candidates']==[], d\""

# convert: Word documents
printf 'not really a docx' >"$T/letter.docx"
SIGN_IT_SOFFICE=/nonexistent/soffice SIGN_IT_POWERSHELL=/nonexistent/powershell.exe $CLI convert "$T/letter.docx" >/dev/null 2>"$T/conv0.err"; rc=$?
check "convert with no converter is exit 4 naming LibreOffice" "[ $rc -eq 4 ] && grep -q 'LibreOffice' $T/conv0.err && [ ! -e $T/letter.pdf ]"
$CLI find "$T/letter.docx" >/dev/null 2>"$T/conv1.err"; rc=$?
check "find on a .docx is exit 1 pointing at convert" "[ $rc -eq 1 ] && grep -q 'sign-it convert' $T/conv1.err"
$CLI sign "$T/letter.docx" --find x --out "$T/nope.pdf" >/dev/null 2>"$T/conv2.err"; rc=$?
check "sign on a .docx is exit 1 pointing at convert" "[ $rc -eq 1 ] && grep -q 'sign-it convert' $T/conv2.err && [ ! -e $T/nope.pdf ]"
cat >"$T/soffice-stub" <<'STUB'
#!/usr/bin/env bash
# fake LibreOffice: --headless --convert-to pdf --outdir DIR SRC
outdir=""; src=""
while [ $# -gt 0 ]; do case "$1" in --outdir) outdir="$2"; shift 2;; --headless|--convert-to) shift; [ "$1" = pdf ] && shift;; *) src="$1"; shift;; esac; done
stem="$(basename "$src")"; stem="${stem%.*}"
cp "$SIGN_IT_STUB_PDF" "$outdir/$stem.pdf"
STUB
chmod +x "$T/soffice-stub"
SIGN_IT_STUB_PDF="$T/agreement.pdf" SIGN_IT_SOFFICE="$T/soffice-stub" $CLI convert "$T/letter.docx" >"$T/conv3.json"; rc=$?
check "convert via LibreOffice writes <stem>.pdf beside the source" "[ $rc -eq 0 ] && grep -q '\"via\": \"libreoffice\"' $T/conv3.json && [ -s $T/letter.pdf ]"
SIGN_IT_STUB_PDF="$T/agreement.pdf" SIGN_IT_SOFFICE="$T/soffice-stub" $CLI convert "$T/letter.docx" >/dev/null 2>"$T/conv4.err"; rc=$?
check "convert refuses to overwrite an existing PDF (exit 5)" "[ $rc -eq 5 ] && grep -q 'refusing to overwrite' $T/conv4.err"
cat >"$T/powershell-stub" <<'STUB'
#!/usr/bin/env bash
# fake powershell.exe: answers $env:TEMP, or copies a PDF to the -Out path
case "$*" in *'$env:TEMP'*) echo "$SIGN_IT_STUB_TEMP"; exit 0;; esac
out=""; while [ $# -gt 0 ]; do [ "$1" = -Out ] && out="$2"; shift; done
cp "$SIGN_IT_STUB_PDF" "$out"; echo "ok $out"
STUB
chmod +x "$T/powershell-stub"; mkdir -p "$T/wintemp"
SIGN_IT_STUB_PDF="$T/agreement.pdf" SIGN_IT_STUB_TEMP="$T/wintemp" SIGN_IT_SOFFICE=/nonexistent/soffice SIGN_IT_POWERSHELL="$T/powershell-stub" $CLI convert "$T/letter.docx" --out "$T/letter-word.pdf" >"$T/conv5.json"; rc=$?
check "convert via Word COM (WSL) writes --out and cleans the exchange dir" "[ $rc -eq 0 ] && grep -q '\"via\": \"word-com\"' $T/conv5.json && [ -s $T/letter-word.pdf ] && [ -z \"\$(ls -A $T/wintemp/sign-it-convert)\" ]"
$CLI find "$T/letter-word.pdf" >/dev/null; rc=$?
check "the converted PDF is findable" "[ $rc -eq 0 ]"


# owner-password PDFs (empty user password): opened through a qpdf-decrypted scratch copy
if command -v qpdf >/dev/null 2>&1; then
  qpdf --encrypt --user-password= --owner-password=owner-only --bits=256 -- "$T/agreement.pdf" "$T/owner-locked.pdf"
  $CLI find "$T/owner-locked.pdf" >"$T/locked-find.json"; rc=$?
  check "owner-password PDF is found through qpdf (repaired: decrypted)" "[ $rc -eq 0 ] && grep -q '\"repaired\": \"decrypted\"' $T/locked-find.json && grep -q 'Party A' $T/locked-find.json"
  $CLI sign "$T/owner-locked.pdf" --find "Party A" --out "$T/locked-signed.pdf" >"$T/locked-sign.json"; rc=$?
  check "owner-password PDF signs" "[ $rc -eq 0 ] && grep -q '\"repaired\": \"decrypted\"' $T/locked-sign.json"
  check "signed output of an owner-password PDF carries no encryption" "qpdf --show-encryption $T/locked-signed.pdf 2>&1 | grep -q 'not encrypted'"
  check "decrypted scratch copies are removed at exit" "[ -z \"\$(ls -d /tmp/sign-it-open-* 2>/dev/null)\" ]"
  qpdf --encrypt --user-password=secret --owner-password=owner-only --bits=256 -- "$T/agreement.pdf" "$T/user-locked.pdf"
  $CLI find "$T/user-locked.pdf" >/dev/null 2>"$T/user-locked.err"; rc=$?
  check "PDF that needs a password to open is exit 5 and says so" "[ $rc -eq 5 ] && grep -q 'needs a password' $T/user-locked.err"
else
  echo "SKIP qpdf not installed: owner-password checks"
fi


# label precision: "<verb> by" footers and truncated prose are not candidates; real labels still are
$CLI find "$T/footers.pdf" >"$T/footers-find.json"; rc=$?
check "footers: only Approved by, Sign here (signature) and Date signed (date) survive" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/footers-find.json'));ls=sorted(c['label'] for c in d['candidates']);assert ls==['Approved by:','Sign here'], ls\""
check "footers: no footer, prose fragment or block header is a candidate" "python3 -c \"import json;d=json.load(open('$T/footers-find.json'));bad=[c['label'] for c in d['candidates'] if c['label'] in ('Report generated by','Powered by TCPDF','Processed by eBay','Sign your','by number','Sign up','Provided by:','USPS signature tracking #','ACCEPTED:','You/the Owner:')];assert not bad, bad\""


# captions below drawn rules (SBA/IRS layout): the band above the caption is the slot
$CLI find "$T/captions.pdf" >"$T/captions-find.json"; rc=$?
check "caption-below: the Authorized Representative caption yields a text-caption slot with a date" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/captions-find.json'));c=[x for x in d['candidates'] if 'Authorized' in x['label']];assert len(c)==1 and c[0]['source']=='text-caption' and c[0]['date'] is not None, d\""
check "caption-below: Print Name and Title captions are not candidates" "python3 -c \"import json;d=json.load(open('$T/captions-find.json'));assert not any(('Name' in x['label'] or 'Title' in x['label']) for x in d['candidates']), d\""
$CLI sign "$T/captions.pdf" --find "Authorized" --out "$T/captions-signed.pdf" >"$T/captions-sign.json"; rc=$?
check "caption-below: the stamp lands above the caption and below the paragraph (y in 232..300)" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/captions-sign.json'));assert 226<=d['y']<=240 and d['y']+d['height']<=300, d\""
check "caption-below: the date is stamped" "grep -q '\"date\": \"' $T/captions-sign.json"

# ink: a line that already carries a scrawl is reported and refused
$CLI find "$T/inked.pdf" >"$T/inked-find.json"; rc=$?
check "ink: the scrawled line reports ink above the limit, the clean line below it" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/inked-find.json'));c={x['label']:x for x in d['candidates']};assert c['Client Signature:']['ink']>0.025 and c['Consultant Signature:']['ink']<=0.025, c\""
$CLI sign "$T/inked.pdf" --find "Client" --out "$T/inked-no.pdf" >/dev/null 2>"$T/inked-no.err"; rc=$?
check "ink: signing the scrawled line is refused (exit 3) naming --over-ink" "[ $rc -eq 3 ] && grep -q 'already carries ink' $T/inked-no.err && grep -q 'over-ink' $T/inked-no.err && [ ! -e $T/inked-no.pdf ]"
$CLI sign "$T/inked.pdf" --find "Client" --over-ink --out "$T/inked-forced.pdf" >/dev/null; rc=$?
check "ink: --over-ink forces it" "[ $rc -eq 0 ] && [ -s $T/inked-forced.pdf ]"
$CLI sign "$T/inked.pdf" --find "Consultant" --out "$T/inked-ok.pdf" >/dev/null; rc=$?
check "ink: the clean line signs normally" "[ $rc -eq 0 ]"
$CLI sign "$T/inked.pdf" --find "Client" --no-ink --out "$T/inked-noink.pdf" >/dev/null; rc=$?
check "ink: --no-ink skips the check" "[ $rc -eq 0 ]"

# two side-by-side blocks: the Date under the left block pairs with the left signature only
$CLI find "$T/columns.pdf" >"$T/columns-find.json"; rc=$?
check "columns: left signature gets the date, right signature does not" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/columns-find.json'));c=sorted(d['candidates'],key=lambda x:x['x']);assert len(c)==2 and c[0]['date'] is not None and c[1]['date'] is None, c\""

# data fields: only the signature line of a form is a candidate
$CLI find "$T/datafields.pdf" >"$T/datafields-find.json"; rc=$?
check "datafields: only Cardholder Signature is a candidate, with its date" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/datafields-find.json'));c=d['candidates'];assert [x['label'] for x in c]==['Cardholder Signature:'] and c[0]['date'] is not None, c\""
$CLI sign "$T/datafields.pdf" --out "$T/datafields-signed.pdf" >/dev/null; rc=$?
check "datafields: signs without a hint" "[ $rc -eq 0 ]"


# data-field labels that contain role words are not signature lines
$CLI find "$T/datafields2.pdf" >"$T/datafields2-find.json"; rc=$?
check "datafields2: only Authorized Representative is a candidate, with its date" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/datafields2-find.json'));c=d['candidates'];assert [x['label'] for x in c]==['Authorized Representative:'] and c[0]['date'] is not None, c\""

# a bare underscore rule with captions beneath: the rule's own geometry is the slot
$CLI find "$T/undercap.pdf" >"$T/undercap-find.json"; rc=$?
check "undercap: the caption claims the underscore rule above it (source text, 0.8, y on the rule, date paired)" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/undercap-find.json'));c=d['candidates'];assert len(c)==1 and c[0]['source']=='text' and c[0]['confidence']==0.8 and c[0]['y']>=596 and c[0]['date'] is not None and c[0]['date']['y']>=596, c\""

# a signature caption that ends in a non-label word, three captions under one drawn rule
$CLI find "$T/wrapped.pdf" >"$T/wrapped-find.json"; rc=$?
check "wrapped: 'Employee Signature for all applying' is a text-caption candidate with the Date beside it" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/wrapped-find.json'));c=[x for x in d['candidates'] if 'Employee' in x['label']];assert len(c)==1 and c[0]['source']=='text-caption', d\""
check "wrapped: the Spouse Signature caption is a separate candidate" "python3 -c \"import json;d=json.load(open('$T/wrapped-find.json'));assert any('Spouse' in x['label'] for x in d['candidates']), d\""

# thin cursive strokes still count as ink
$CLI find "$T/thinink.pdf" >"$T/thinink-find.json"; rc=$?
check "thin ink: hairline strokes over the line are flagged" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/thinink-find.json'));c=d['candidates'][0];assert c['ink']>0.025, c\""

# a Date two rows below the signature, past a Printed Name row, still pairs
$CLI find "$T/datebelow.pdf" >"$T/datebelow-find.json"; rc=$?
check "datebelow: the Date under the Printed Name row pairs with the signature" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/datebelow-find.json'));c=d['candidates'];assert len(c)==1 and c[0]['date'] is not None, c\""

# a pre-filled AcroForm Date field is left alone
$CLI sign "$T/acro-prefilled.pdf" --out "$T/acro-prefilled-signed.pdf" >"$T/acro-prefilled.json"; rc=$?
check "acro-prefilled: signs, leaves the existing date, says so in dateNote" "[ $rc -eq 0 ] && grep -q 'already holds' $T/acro-prefilled.json && [ \"\$(node $HERE/read-field.mjs $T/acro-prefilled-signed.pdf Date1)\" = '12/4/18' ]"

# --ocr forces OCR on a page that has a text layer
if command -v tesseract >/dev/null 2>&1; then
  $CLI find "$T/agreement.pdf" --ocr >"$T/forced-ocr.json"; rc=$?
  check "--ocr: candidates come from the OCR source even though the page has text" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/forced-ocr.json'));assert d['candidates'] and all(x['source']=='ocr' for x in d['candidates']), d\""
else
  echo "SKIP tesseract not installed: --ocr check"
fi


# fields / fill: labeled blanks in a two-party block
$CLI fields "$T/twocolumn.pdf" >"$T/fields.json"; rc=$?
check "fields: lists the ten labeled blanks of the two-party block" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/fields.json'));f=d['fields'];assert len(f)==10 and sorted(set(x['label'] for x in f))==['Date:','Email:','Printed Name:','Signature:','Title:'], f\""
$CLI fill "$T/twocolumn.pdf" --set "Printed Name=Will Mitchell" --out "$T/fill-ambig.pdf" >/dev/null 2>"$T/fill-ambig.err"; rc=$?
check "fill: a label present in both columns is ambiguous without --near (exit 3, nothing written)" "[ $rc -eq 3 ] && grep -q 'appears 2 times' $T/fill-ambig.err && grep -q -- '--near' $T/fill-ambig.err && [ ! -e $T/fill-ambig.pdf ]"
$CLI fill "$T/twocolumn.pdf" --set "Printed Name=Will Mitchell" --set "Title=Managing Member" --set "email=will@example.com" --near "STARTUPBROS" --out "$T/filled.pdf" >"$T/fill.json"; rc=$?
check "fill: --near picks the right column for all three labels" "[ $rc -eq 0 ] && python3 -c \"import json;d=json.load(open('$T/fill.json'));f=d['filled'];assert len(f)==3 and all(x['x']>330 for x in f), f\""
check "fill: the values are in the output's text layer, once each" "[ \"\$(pdftotext $T/filled.pdf - | grep -c 'Will Mitchell')\" = 1 ] && [ \"\$(pdftotext $T/filled.pdf - | grep -c 'Managing Member')\" = 1 ] && pdftotext $T/filled.pdf - | grep -q 'will@example.com'"
check "fill: the running header naming both parties does not steer --near (all three land under the table header)" "python3 -c \"import json;d=json.load(open('$T/fill.json'));assert [x['x']>330 for x in d['filled']]==[True,True,True], d\""
$CLI fill "$T/twocolumn.pdf" --set "Title=x" --near "SIGNATURES" --out "$T/fill-vague.pdf" >/dev/null 2>"$T/fill-vague.err"; rc=$?
check "fill: an anchor that sits between the columns is refused as not separating them" "[ $rc -eq 3 ] && grep -q 'does not separate' $T/fill-vague.err && [ ! -e $T/fill-vague.pdf ]"
check "fill: the left column is untouched" "python3 -c \"import json;d=json.load(open('$T/fill.json'));assert all(x['x']>330 for x in d['filled'])\" && [ \"\$(pdftotext -layout $T/filled.pdf - | grep -c 'Printed Name: ____')\" -ge 1 ]"
$CLI fill "$T/filled.pdf" --set "Printed Name=Someone Else" --near "STARTUPBROS" --out "$T/fill-twice.pdf" >/dev/null 2>"$T/fill-twice.err"; rc=$?
check "fill: a blank that already carries text is refused (exit 3)" "[ $rc -eq 3 ] && grep -q 'already carries ink' $T/fill-twice.err && [ ! -e $T/fill-twice.pdf ]"
$CLI fill "$T/twocolumn.pdf" --set "Fax=555" --near "STARTUPBROS" --out "$T/fill-none.pdf" >/dev/null 2>"$T/fill-none.err"; rc=$?
check "fill: an unmatched label is exit 3 listing the labels on offer, nothing written" "[ $rc -eq 3 ] && grep -q 'matches no blank' $T/fill-none.err && grep -q 'Printed Name:' $T/fill-none.err && [ ! -e $T/fill-none.pdf ]"
$CLI fill "$T/twocolumn.pdf" --set "Title=Managing Member" --set "Fax=555" --near "STARTUPBROS" --out "$T/fill-partial.pdf" >/dev/null 2>&1; rc=$?
check "fill: one bad label among good ones writes nothing (all or nothing)" "[ $rc -eq 3 ] && [ ! -e $T/fill-partial.pdf ]"
$CLI sign "$T/filled.pdf" --find "Signature" --pick 2 --out "$T/filled-signed.pdf" >/dev/null 2>&1; rc=$?
check "fill then sign chains (exit 0)" "[ $rc -eq 0 ] && [ -s $T/filled-signed.pdf ]"
$CLI fill "$T/acro-text.pdf" --set "Printed Name=Will Mitchell" --out "$T/acro-filled.pdf" >"$T/acro-fill.json"; rc=$?
check "fill: an AcroForm text field is filled by name" "[ $rc -eq 0 ] && grep -q '\"source\": \"acroform\"' $T/acro-fill.json && [ \"\$(node $HERE/read-field.mjs $T/acro-filled.pdf 'Printed Name')\" = 'Will Mitchell' ]"
$CLI fill "$T/acro-text.pdf" --set "Title=Founder" --out "$T/acro-filled2.pdf" >/dev/null 2>"$T/acro-fill2.err"; rc=$?
check "fill: a pre-filled AcroForm field is refused, not overwritten" "[ $rc -eq 3 ] && grep -q 'already holds \"CEO\"' $T/acro-fill2.err && [ ! -e $T/acro-filled2.pdf ]"
$CLI fill "$T/letter.docx" --set "Title=x" >/dev/null 2>"$T/fill-docx.err"; rc=$?
check "fill on a .docx is exit 1 pointing at convert" "[ $rc -eq 1 ] && grep -q 'sign-it convert' $T/fill-docx.err"

echo "---- $pass passed, $fail failed  (scratch: $T)"
[ "$fail" -eq 0 ]
