# New Features — May 2026

This doc covers two workflow improvements added on top of the bug-fix release.

---

## 1. Draft Invoice Review Stage Tracking

### Problem

Aapke firm ka invoice workflow:

```
Associate fills entries
   -> Billing creates draft
   -> Print PDF -> hand to partner
   -> Partner marks changes on paper
   -> Billing updates draft in portal
   -> Final invoice issued
```

Pehle issue: billing ko nahi pata chal raha tha kaunsi draft kis stage par hai. Saari "draft" hi dikhti thi. 10 drafts ho gayi to confusion: kaunsi review mein hai, kaunsi ready hai?

### Solution

Har draft invoice par ab ek **review_stage** track hota hai:

| Stage | Kab use karein | UI Badge |
|---|---|---|
| `drafting` | Billing abhi prepare kar rahi hai (nothing sent yet) | 🟡 Drafting |
| `sent_for_review` | Printed/PDF partner ke pass gaya hai, feedback wait | 📤 Sent for Review |
| `revisions_pending` | Partner ne paper par changes mark kiye, billing update kar rahi hai | ✏ Revisions Pending |
| `ready_to_issue` | Partner approved, bas Issue button dabana baaki | ✅ Ready to Issue |

### Naye UI elements

**Invoice list (Admin → Billing → All Invoices):**

- **Review stage filter** dropdown — "Show only drafts awaiting feedback" / "ready to issue"
- **Review badge** under status pill — draft invoices show their current review stage
- **Assignee name** display — kis reviewer ko assigned hai (👤 RKM)
- **🏷 Stage button** in actions — quick 3-click stage change without opening editor

**Draft editor (✏ Edit button):**

- **Review stage** dropdown — full list
- **Assigned to** dropdown — pick a user (Partner, Associate, anyone)
- **Review note** field — billing can type "Printed and handed to RKM 11 May"
- **Recent activity log** — last 6 audit events for this invoice (kab issue hua, kab stage badla, kisne kya kiya)

### Naye API endpoints

```
PATCH  /api/billing/invoices/:id
       Accepts: review_stage, review_notes, review_assignee
       (along with existing status, notes, payment_ref)

POST   /api/billing/invoices/:id/review-stage   ← quick stage change
       Body: { stage, note?, assignee_id? }
       Returns: { ok: true, stage }

GET    /api/billing/invoices/:id/review-history ← audit trail
       Returns: history[] of all create/issue/stage-change events
```

### Audit trail

Har stage change `audit_log` table mein record hota hai:
- `action: 'review_stage_changed'`
- `detail: 'sent_for_review -> revisions_pending · "RKM returned with markups"'`
- `user_id`, `at` timestamp

Issue hone ke baad bhi history retain hoti hai — compliance ke liye useful.

### Typical workflow (after this feature)

1. **Billing creates draft invoice** → stage automatically NULL (or set to `drafting` manually)
2. **PDF print** → billing opens 🏷 Stage menu → `sent_for_review` + note "Printed for RKM review"
3. **Partner returns paper** with markups → billing → 🏷 Stage → `revisions_pending`
4. **Billing edits draft** → makes corrections → saves
5. **Partner approves verbally** → billing → 🏷 Stage → `ready_to_issue`
6. **Issue invoice** → `✅ Issue` button → invoice locked, review_stage auto-cleared
7. **Audit log preserves** the whole journey for that invoice

### DB migration

Auto-applied on next server start (`utils/db.js` migrations section). 4 new columns:
- `invoices.review_stage` TEXT
- `invoices.review_notes` TEXT
- `invoices.review_assignee` INTEGER (foreign key to users.id)
- `invoices.review_updated_at` TEXT

Backward compatible — existing invoices keep working as before (all fields NULL).

---

## 2. Revise Issued Invoice (one-click)

### Problem

Issued invoice mein galti pakdi → standard process bohot manual:
1. Cancel button click → confirm
2. Generate Invoice page kholo → client + period set karo → Preview → Save as Draft
3. Draft kholo → ✏ Edit → corrections karo → Issue

~7-10 clicks + repeated data entry. Aur invoice ke audit trail mein link nahi rehta ki naya invoice us old waale ka replacement hai.

### Solution

Issued invoice ki row par ek **🔁 Revise** button add kiya. Click karte hi:

1. Old invoice **cancel** ho jaata hai (records mein safe rehta hai)
2. **Naya draft** auto-create with same client, currency, tax_rate, period, items
3. Source timesheet entries **automatically re-link** to the new draft
4. **Draft editor auto-open** ho jaata hai — bas corrections karke Issue dabaye
5. Audit log mein "Invoice Revised — AP/2026/0042 → AP/2026/0043" entry
6. New invoice PDF par small italic notice: _"This invoice supersedes the earlier (cancelled) invoice AP/2026/0042"_
7. DB mein `parent_invoice_id` se chain track hoti hai

### Restrictions

- **Only `issued`** invoices can be revised (`draft` already editable, `paid` needs credit note, `cancelled` is dead-end)
- **Paid invoices** → 400 error: "Issue a Credit Note instead" (next feature)

### Naya API endpoint

```
POST /api/billing/invoices/:id/revise
Returns: {
  ok: true,
  original: { id, invoice_no },
  draft:    { id, invoice_no }
}
```

### Audit trail

- Old invoice: status → `cancelled`, notes append `[Revised to AP/2026/0043 by Mohd Amir at 2026-05-12T...]`
- New invoice: status → `draft`, notes prefix `Revision of cancelled invoice AP/2026/0042`
- audit_log: 2 rows — "Invoice Revised" and "Draft Invoice Saved" with cross-references
- Billing admins get notified via email if SMTP configured

### When to use what

| Scenario | Action |
|---|---|
| Draft invoice mein galti | Direct ✏ Edit |
| Issued but client ko nahi bheja | 🔁 Revise (this feature) |
| Issued AND client ko bhej diya, abhi paid nahi | 🔁 Revise + send corrected version + note saying "supersedes" |
| Paid invoice mein galti | ⚠ Credit Note (next iteration) |

---

## 3. Bulk operations on timesheet entries

### Problem

Pehle bulk-approve UI tha but it called individual PATCH for each entry — for 50 entries = 50 API calls, slow. Aur bulk-reject nahi tha.

### Solution

- **Bulk approve** ab dedicated `/api/admin/timesheet/bulk-approve` endpoint use karta hai — saari entries ek transaction mein. Returns `{requested, approved, skipped}` taki user ko pata chale kitne actually update hue (e.g. already-invoiced entries skip ho jaate hain).
- **Bulk reject** naya button — multiple entries select karke ek single rejection note ke saath reject. Reasonable use case: "GST holiday, sab non-billable mark karo" jaise scenarios.

### UI

Admin → Timesheets tab → entries select karein checkboxes se → top par:
- `✓ Approve selected` — single transaction, instant feedback
- `✗ Reject selected` — prompts for reason, applies to all selected
- `↻ Refresh` — reload list

---

## Files changed

| File | Change |
|---|---|
| `utils/db.js` | 4 new migration entries for review_* columns |
| `routes/billing.js` | review_stage validation, PATCH support, GET filter, /review-history, /review-stage endpoints |
| `public/admin.html` | Review filter dropdown, review section in draft editor |
| `public/js/admin.js` | Stage labels, quick-stage menu, review history loader, bulk reject |
| `public/css/styles.css` | Review badge color styles |

Total: ~150 lines added across backend + frontend.

---

## Backward compatibility

- Existing invoices: all review_* fields NULL → behave exactly as before
- Existing API consumers: PATCH /invoices/:id still works with old fields; new fields are optional
- Frontend: filter dropdown defaults to "All review stages" → no behaviour change unless user opts in
- No data migration needed — auto-applied on server restart via existing migration mechanism

---

## Testing checklist

1. Restart server: `pm2 restart ap-timesheet`
2. Confirm new columns added:
   ```powershell
   curl.exe http://localhost:3000/api/billing/invoices
   ```
   Response should include `review_stage`, `review_assignee_name` (nullable) for each invoice.
3. Open Admin → Billing → All Invoices → confirm new filter dropdown appears
4. Open any draft invoice → ✏ Edit → confirm review section is visible with stage/assignee/note fields
5. Change stage via dropdown, save — refresh list, confirm badge appears
6. Try 🏷 Stage quick button on a draft row — confirm prompt works
7. Bulk-select 3 entries → Approve selected → confirm response counts shown in alert
