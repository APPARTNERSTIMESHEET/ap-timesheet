# LEDES XML Validation Script
# Usage: powershell -File validate-ledes-xml.ps1 path\to\file.xml
#
# Performs basic XML well-formedness and structure check on a LEDES XML file.
# Does NOT do full XSD validation (requires downloading official schema from
# ledes.org). For full XSD validation, open the file in VS Code with the
# XML extension or Notepad++ with XML Tools plugin.

param(
    [Parameter(Mandatory=$true)]
    [string]$Path
)

if (-not (Test-Path $Path)) {
    Write-Host "ERROR: File not found: $Path" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  LEDES XML Validator" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "File: $Path"
Write-Host ""

$errorCount = 0
$warnCount = 0

# ── Check 1: XML Well-Formedness ──
try {
    $xml = [xml](Get-Content $Path -Raw)
    Write-Host "[OK]   XML is well-formed" -ForegroundColor Green
} catch {
    Write-Host "[FAIL] XML is NOT well-formed: $($_.Exception.Message)" -ForegroundColor Red
    exit 2
}

# ── Check 2: LEDES Root Element ──
if ($xml.LEDESBillingData) {
    $version = $xml.LEDESBillingData.version
    Write-Host "[OK]   LEDES version detected: $version" -ForegroundColor Green
    if ($version -notin @('2.0', '2.1', '2.2')) {
        Write-Host "[WARN] Uncommon LEDES version. Most platforms expect 2.1." -ForegroundColor Yellow
        $warnCount++
    }
} else {
    Write-Host "[FAIL] Root element is not <LEDESBillingData>" -ForegroundColor Red
    $errorCount++
}

# ── Check 3: Firm element ──
if ($xml.LEDESBillingData.Firm) {
    Write-Host "[OK]   Firm: $($xml.LEDESBillingData.Firm.Name) (ID: $($xml.LEDESBillingData.Firm.ID))" -ForegroundColor Green
} else {
    Write-Host "[FAIL] Missing <Firm> element" -ForegroundColor Red
    $errorCount++
}

# ── Check 4: Invoice element ──
$invoice = $xml.LEDESBillingData.Invoice
if (-not $invoice) {
    Write-Host "[FAIL] Missing <Invoice> element" -ForegroundColor Red
    $errorCount++
} else {
    Write-Host "[OK]   Invoice: $($invoice.InvoiceNumber)" -ForegroundColor Green
    Write-Host "       Date: $($invoice.InvoiceDate)"
    Write-Host "       Total: $($invoice.Currency) $($invoice.InvoiceTotal)"

    # Mandatory fields
    foreach ($field in @('InvoiceNumber','InvoiceDate','InvoiceTotal','Currency','Client')) {
        if (-not $invoice.$field) {
            Write-Host "[FAIL] Missing required field: <$field>" -ForegroundColor Red
            $errorCount++
        }
    }
}

# ── Check 5: Date format YYYYMMDD ──
$dateRegex = '^\d{8}$'
if ($invoice.InvoiceDate -and $invoice.InvoiceDate -notmatch $dateRegex) {
    Write-Host "[FAIL] InvoiceDate '$($invoice.InvoiceDate)' is not in YYYYMMDD format" -ForegroundColor Red
    $errorCount++
}

# ── Check 6: Currency code ──
$currencyRegex = '^[A-Z]{3}$'
if ($invoice.Currency -and $invoice.Currency -notmatch $currencyRegex) {
    Write-Host "[FAIL] Currency '$($invoice.Currency)' is not a 3-letter ISO 4217 code" -ForegroundColor Red
    $errorCount++
}

# ── Check 7: Line items ──
$matters = @($invoice.Matter)
$lineCount = 0
$totalLineAmount = 0.0
foreach ($matter in $matters) {
    if (-not $matter) { continue }
    $items = @($matter.LineItem)
    foreach ($li in $items) {
        if (-not $li) { continue }
        $lineCount++
        $totalLineAmount += [decimal]$li.LineItemTotal
        if (-not $li.LineItemType -or $li.LineItemType -notin @('F', 'E', 'IF', 'IE')) {
            Write-Host "[FAIL] Line $($li.LineItemNumber): invalid LineItemType '$($li.LineItemType)'" -ForegroundColor Red
            $errorCount++
        }
        if (-not $li.Description) {
            Write-Host "[WARN] Line $($li.LineItemNumber): no description" -ForegroundColor Yellow
            $warnCount++
        }
    }
}
Write-Host "[OK]   Line items: $lineCount (sum: $totalLineAmount)" -ForegroundColor Green

# ── Final Report ──
Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
if ($errorCount -eq 0 -and $warnCount -eq 0) {
    Write-Host "  RESULT: ALL CHECKS PASSED" -ForegroundColor Green
} elseif ($errorCount -eq 0) {
    Write-Host "  RESULT: PASSED with $warnCount warning(s)" -ForegroundColor Yellow
} else {
    Write-Host "  RESULT: FAILED -- $errorCount error(s), $warnCount warning(s)" -ForegroundColor Red
}
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

if ($errorCount -gt 0) { exit 1 } else { exit 0 }
