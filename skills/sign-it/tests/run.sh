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

for k in agreement plain ambiguous sameline nodate acroform acro-signed acro-hidden acro-nested acro-shared-date acro-readonly rotated rotated270 acro-rot270 acro-zero acro-offpage acro-comb ocrlabels; do
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

# AcroForm: a /Sig widget is a confidence-1.0 candidate paired with the Date text field
$CLI find "$T/acroform.pdf" >"$T/acro.json"; rc=$?
check "acroform find (exit 0)" "[ $rc -eq 0 ]"
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
$CLI sign "$T/agreement.pdf" --page 2 --x 20% --y 80% --width 25% --date-x 47% --date-y 80% --out "$T/manual-date.pdf" >"$T/manual-date.json"; rc=$?
check "manual placement with a manual date slot" "[ $rc -eq 0 ] && grep -q '\"date\": \"' $T/manual-date.json"
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

echo "---- $pass passed, $fail failed  (scratch: $T)"
[ "$fail" -eq 0 ]
