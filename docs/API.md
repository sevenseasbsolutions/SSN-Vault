# API reference

All endpoints are under `/api`, return JSON, and require an authenticated
session cookie except `POST /api/auth/login` and `GET /api/health`.

**State-changing requests** (`POST`, `PUT`, `DELETE`) must send the CSRF token
from the `vault_csrf` cookie in an `X-CSRF-Token` header.

**Money on input** is accepted in exactly one of two unambiguous forms, and
sending both is rejected rather than guessed at:

| Form | Example | Meaning |
|---|---|---|
| `amount` | `"2,000.00"` | a decimal amount in currency units |
| `amount_cents` | `200000` | an explicit whole number of cents |

**Percentages on input** follow the same two-form rule:

| Form | Example | Meaning |
|---|---|---|
| `percent` / `share` / `default_share` | `30`, `"33.33"` | a percentage |
| `percent_bps` / `share_bps` / `default_share_bps` | `3000` | explicit basis points |

**Money and percentages on output** are always the integer `*_cents` and
`*_bps` forms. A field whose name says `_bps` always carries basis points, so a
30% share can never be stored as 0.3% or 3000%.

**Errors** are `{ "error": { "code", "message", "details?" } }`. A `422` carries
`details` as a field-to-message map. An out-of-scope record returns `404`, never
`403`, so responses cannot be used to discover that a record exists.

---

## Authentication

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/auth/login` | `{ email, password }`. Rate limited; locks after repeated failures |
| `POST` | `/api/auth/logout` | Revokes the current session |
| `GET` | `/api/auth/session` | Current user, effective permissions, scopes, display settings |
| `GET` | `/api/auth/permissions` | The permission catalog |
| `GET` | `/api/auth/sessions` | This user's sessions |
| `POST` | `/api/auth/change-password` | `{ current_password, new_password }`. Revokes other sessions |

## Salaries

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/payouts` | `payouts.view` |
| `GET` | `/api/payouts/summary` | `payouts.view` |
| `GET` | `/api/payouts/:id` | `payouts.view` |
| `GET` | `/api/payouts/meta/months` | `payouts.view` |
| `POST` | `/api/payouts` | `payouts.create` |
| `PUT` | `/api/payouts/:id` | `payouts.edit` |
| `DELETE` | `/api/payouts/:id` | `payouts.delete` — requires `reason` |

### Deleting

Voiding was removed: nothing in the application marks a record void any more.
Deleting is the only destructive action, and it is **off by default**. A `DELETE`
is refused with `403` unless an owner has set `allow_delete` to `true` in
settings, whatever permission the caller holds. A `reason` is always required,
and the deletion is written to the audit history even though the record itself
is gone for good. `server/lib/deletion.js` is the single implementation of that
rule.

### Create / update body

| Field | Required | Notes |
|---|---|---|
| `accounting_month` | yes | `"2026-08"` or `"2026-08-01"`. **Never derived from another date** |
| `pay_period_from` / `pay_period_to` | yes | `"YYYY-MM-DD"`; from ≤ to; may cross months/years |
| `credit_date` | yes | `"YYYY-MM-DD"`; may fall after the period ends |
| `amount` or `amount_cents` | yes | > 0 |
| `company_id` | yes | Must be active and in scope |
| `partner_profile_id` | yes | Must be active and in scope; partner and pool are derived server-side |
| `notes` | no | |
| `status` | no | `active` (default) or `draft`. `void` exists only on records voided before voiding was removed |
| `verification_status` | no | `unverified` (default), `verified`, `disputed` |
| `attachment_id` | no | From `POST /api/attachments` |
| `reason` | on edit | Required for a material change above the configured threshold |

On `PUT`, omitted fields keep their stored value — which is why editing the
credit date or pay period cannot move the accounting month.

Responses include `warnings[]`: human-readable notices (for example, that the
salary is assigned to August but was credited in September) that never alter
what was stored.

### Filters

Every filter is independent and they combine with `AND`.

| Basis | Parameters |
|---|---|
| Accounting month | `month_from`, `month_to` |
| Credit date | `credit_from`, `credit_to` |
| Pay-period boundaries | `period_from`, `period_to` |
| Pay-period **overlap** | `overlap_from` + `overlap_to` — includes any period intersecting the range |
| Entities | `company_id`, `partner_id`, `partner_profile_id`, `pool_id` |
| Amount | `amount_min`, `amount_max` (cents) |
| Other | `status`, `verification_status`, `search` |
| Paging | `page`, `limit`, `sort`, `dir` |

Sortable: `accounting_month`, `credit_date`, `pay_period_from`,
`pay_period_to`, `amount`, `company`, `partner`, `status`, `created_at`.

## Expenses

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/expenses` · `/summary` · `/:id` | `expenses.view` |
| `POST` | `/api/expenses` | `expenses.create` |
| `PUT` | `/api/expenses/:id` | `expenses.edit` |
| `DELETE` | `/api/expenses/:id` | `expenses.delete` — requires `reason` |
| `GET` | `/api/expenses/meta/categories` | `expenses.view` |
| `POST`/`PUT` | `/api/expenses/meta/categories[/:id]` | `settings.manage` |

Body: `expense_date`, `accounting_month`, `amount`, `category_id`,
`description`, `vendor_company_id`, `payment_method`, `payment_reference`,
`status` (`approved` default), `attachment_id`, and `allocations[]`.

Each allocation is
`{ target_type, pool_id?, partner_id?, percent | percent_bps | amount | amount_cents }`
where `target_type` is:

| `target_type` | What it reduces |
|---|---|
| `pool` | that pool's net income — borne by its partners and the owner in proportion. Needs `pool_id` |
| `partner` | that one partner's payable only; the pool is untouched. Needs `partner_id` |
| `business` | nothing in any distribution; recorded as an owner cost. Needs neither |

Allocations must total **exactly 100%** (or exactly the expense amount when
using explicit amounts), and the same target may not appear twice.

Omitting `allocations` creates a single 100% allocation to `pool_id`. If
`pool_id` is also omitted it is resolved **only when the organisation has
exactly one active pool**; with several pools the request is rejected, because
charging a cost to a pool nobody chose would silently skew that pool's
net income.

Filters: `month_from/to`, `expense_from/to`, `category_id`, `partner_id`,
`pool_id`, `company_id`, `target_type`, `amount_min/max`, `status`, `search`.

### `pool_id` is optional

Every endpoint that accepts a `pool_id` — expense allocations, partner creation,
`POST /api/distributions/calculate`, `GET /api/distributions/preview`,
`/api/distributions/periods/finalize` and `/reopen`, `PUT`/`DELETE
/api/tax/override`, `GET /api/tax/preview` — resolves it to the only active pool
when it is omitted. With more than one active pool, omitting it is rejected: a
422 naming the field for body requests, a 400 for query strings. Picking a pool
on the caller's behalf would attribute money to a pool nobody chose.

`server/lib/pools.js` is the single implementation of that rule.

## Partners, profiles, pools and companies

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/partners` · `/:id` · `/meta/profiles` · `/:id/share-check` | `partners.view` |
| `POST`/`PUT` | `/api/partners[/:id]` | `partners.manage` |
| `POST` | `/api/partners/:id/profiles` | `partners.manage` |
| `PUT` | `/api/partners/profiles/:profileId` | `partners.manage` |
| `POST` | `/api/partners/:id/agreements` | `partners.manage` |
| `GET` | `/api/pools` | `pools.view` |
| `POST`/`PUT` | `/api/pools[/:id]` | `pools.manage` |
| `GET` | `/api/companies` · `/check` | `companies.view` |
| `POST`/`PUT` | `/api/companies[/:id]` | `companies.manage` |

A US partner share above the pool's remaining capacity is rejected at entry.
US partner shares use `default_share` (percentage) or `default_share_bps`;
agreements use `share` or `share_bps`. Agreements are effective-dated by
accounting month, so changing a percentage never rewrites an earlier month. `ssn_last4` accepts only four digits; a full
SSN is refused with an explanation.

## Tax Hold

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/tax/policies` · `/ledger` · `/preview` | `tax.view` |
| `POST`/`PUT` | `/api/tax/policies[/:id]` | `tax.manage` |
| `PUT`/`DELETE` | `/api/tax/override` | `tax.manage` |
| `POST` | `/api/tax/ledger` | `tax.manage` |

Policy `scope_type` is `global`, `pool`, `company` or `partner`, naming its
target with `pool_id` / `company_id` / `partner_id`. `basis` is
`percent_of_gross`, `percent_of_net`, `fixed`, `manual` or `none`. The rate is
given as `percent` or `percent_bps`, a fixed amount as `fixed_amount` or
`fixed_amount_cents`. Policies are effective-dated by accounting month.

A `company` or `partner` policy **must** use `percent_of_gross`, `fixed` or
`none`; `percent_of_net` and `manual` are rejected, because net is only known
for a whole pool and a manual amount belongs to a pool and month.

The reserve is a sum of slices, resolved most-specific-first: manual override,
then `company`, then `partner`, then `pool`, then `global`. The pool/global base
excludes income already claimed by a company or partner policy, so nothing is
reserved against twice. `GET /api/tax/preview` and a saved distribution run both
return `breakdown[]` of `{ scope, label, policy_id, policy_name, basis,
percent_bps, income_cents, reserve_cents }`. Resolution order: a manual override for
that exact month wins, then the most specific active policy. There is no
built-in percentage. Ledger entries are `adjustment` or `withdrawal`; additions
come from distribution runs and are deduplicated by `(source_type, source_id)`.

### W2 Paid

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/w2` | `payouts.view` |

Returns `totals`, `by_company`, `by_profile`, `monthly` and `rows` for the
filter window. Everything is derived from the salaries that carry
`w2_paid_cents`, so it can never disagree with the register — there is no
second ledger to keep in step. Takes the same filters as the salary endpoints.

A company carries `partner_profile_id` (the profile the job sits under) and
`tax_category` (`w2` or `1099`). A salary carries `invoice_amount_cents` and
`w2_paid_cents` alongside `amount_cents`, and they always reconcile:
`invoice = credited + w2_paid`.

On create, `invoice_amount` is optional; omitted, it equals the credited amount
and nothing was withheld, which is the 1099 case. An invoice below the credited
amount is a `422`, as is any withholding on a company recorded as `1099`.

On update, only an invoice stated **in that request** is treated as stated. Where
tax was withheld the stored invoice stands as the company's own figure and the
W2 amount adjusts beneath it; where nothing was withheld the invoice follows the
credited amount, so an ordinary correction is not blocked by a stale figure.

A partner accepts `tax_percent` on create and update. It is not a column: it
upserts a partner-scoped `percent_of_gross` tax hold policy effective from the
current month, and closes the previous one at the end of last month, so earlier
months keep the rate that produced their figures. `GET /api/partners` returns
the rate in force as `tax_percent_bps`.

## Distributions

A partner's share is a percentage of **their own** net, not of the pool's. Each
row returned by a preview or a saved run therefore carries the basis as well as
the result:

| Field | Meaning |
|---|---|
| `own_income_cents` | credited through that partner's profiles in the window |
| `own_expense_share_cents` | shared pool costs, apportioned by income |
| `own_tax_cents` / `tax_allocation_cents` | their own rate, or their share of a pool-wide rate |
| `own_net_cents` | income − costs − tax: what the share percentage applies to |
| `calculated_share_cents` | `share_bps` of `own_net_cents` |
| `direct_charges_cents` | costs charged to them alone, deducted from payable in full |
| `payable_cents` | `calculated_share_cents − direct_charges_cents` |

The per-partner nets sum to `distributable_cents` exactly, so
`partner_total_cents + owner_share_cents = distributable_cents` still holds to
the cent. `share_basis` is `own_earnings`. A partner with no earnings has a zero
net and a zero share; a partner whose own costs exceed their own earnings is
paid nothing rather than a negative amount.

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/distributions/preview` | `distributions.view` |
| `GET` | `/api/distributions/runs` · `/runs/:id` | `distributions.view` |
| `GET` | `/api/distributions/ledger` · `/ledger/:id` | `distributions.view` |
| `GET` | `/api/distributions/periods` · `/carryforwards` | `distributions.view` |
| `POST` | `/api/distributions/calculate` | `distributions.calculate` |
| `POST` | `/api/distributions/runs/:id/approve` | `distributions.approve` |
| `POST` | `/api/distributions/runs/:id/reverse` | `distributions.approve` — requires `reason` |
| `POST` | `/api/distributions/ledger/:id/adjust` | `distributions.approve` — requires `reason` |
| `POST` | `/api/distributions/ledger/:id/payments` | `distributions.pay` |
| `POST` | `/api/distributions/payments/:id/void` | `distributions.pay` — requires `reason`. Reverses a wrongly recorded payment; shown as "Reverse" in the interface |
| `POST` | `/api/distributions/periods/finalize` · `/reopen` | `periods.manage` |

`preview` calculates without saving. `calculate` upserts one run per
(pool, accounting month) — recalculating updates it, never duplicates it, and
preserves recorded payments and adjustments.

Recording a payment accepts `amount`, `payment_date`, `method`, `reference`,
`note`, `idempotency_key` and `allow_overpayment`. A payment larger than the
outstanding balance returns `409` until `allow_overpayment` is set. Reusing an
`idempotency_key` returns the original payment with `duplicate: true`.

## Dashboard, reports, settings, audit, attachments

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/dashboard` · `/dashboard/charts` | `dashboard.view` |
| `GET` | `/api/reports` | `reports.view` |
| `GET` | `/api/reports/:key` | per report; non-JSON formats also need `reports.export` |
| `GET` | `/api/reports/statement/:partnerId` | `reports.view` |
| `GET`/`PUT` | `/api/settings` | read: any; write: `settings.manage` |
| `GET` | `/api/audit` | `audit.view` |
| `GET` | `/api/users` · `/:id` | `users.manage` |
| `POST`/`PUT` | `/api/users[/:id]` · `/:id/access` · `/:id/reset-password` · `/:id/revoke-sessions` | `users.manage` |
| `POST` | `/api/attachments` | `attachments.upload` |
| `GET` | `/api/attachments/:id` | Visible only to someone who can see a record it belongs to |

Report keys: `monthly-income`, `payouts-by-credit-date`,
`payouts-by-pay-period`, `income-by-company`, `income-by-partner`,
`monthly-expenses`, `expense-categories`, `tax-reserve-ledger`, `w2-paid`,
`partner-statement`, `owner-statement`, `partner-payments`,
`outstanding-distributions`, `annual-summary`, `audit-history`.

Add `format=csv|xlsx|html` for a download. Every export states its reporting
basis in the file and respects the caller's filters, permissions and scope.

Attachments are uploaded as a raw body with the file's `Content-Type` and an
`X-Filename` header. Only PDF, PNG, JPEG and WebP are accepted, verified by
magic bytes as well as the declared type, up to 8 MB.
