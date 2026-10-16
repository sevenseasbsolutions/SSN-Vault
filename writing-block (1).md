# MASTER PROJECT PROMPT: Partner Payout, Expense & Profit Distribution Management System

## 1. Project Objective

Build a complete, production-ready financial management web application for managing money received through US-based business partners, tracking payouts and expenses, calculating tax reserves, distributing the remaining profit between US partners and the business owner, and maintaining accurate financial records.

The system will be used by an owner/admin, US partners, and authorized team members.

Money may arrive in a partner's account on a different date from the period the payment covers. The system must preserve the accounting month, pay period, and actual credit date separately.

This must be a fully functional application with a persistent database, backend APIs, authentication, role-based permissions, accurate financial calculations, reports, filters, and a polished frontend. Do not create only a static dashboard or UI prototype.

## 2. First Step: Inspect the Existing Project

Before making changes:

1. Inspect the existing repository, directory structure, framework, dependencies, database, routes, API conventions, and current UI.
2. Identify existing components and financial functionality that can be reused.
3. Preserve the existing application architecture wherever practical.
4. Do not rename existing files, routes, components, variables, or database entities unnecessarily.
5. Do not remove working features or replace the application with a new project without a compelling technical reason.
6. Prepare a brief implementation plan, then implement the complete solution in logical stages.
7. Create database migrations and preserve existing records.
8. Run tests and verify that existing functionality still works.

Do not stop after presenting a plan. Continue implementing the requested features.

## 3. User Roles and Partner Management

Create a secure user and partner management module.

### Owner/Admin

The owner/admin has full control over the application, including:

- Adding and managing partners and users.
- Creating partner profiles and assigning share percentages.
- Viewing all authorized financial records.
- Adding and editing income and expenses.
- Managing tax-reserve settings.
- Reviewing partner and owner share calculations.
- Recording distributions and actual payments.
- Managing permissions.
- Generating reports and exports.
- Reviewing the audit log.
- Managing accounting periods and financial settings.

### US Partner

A US partner can access only the profiles and financial information explicitly authorized by the owner.

Depending on permissions, a partner may be allowed to:

- Add payouts received into their account.
- Add expenses.
- View their payout history.
- View relevant companies and payment details.
- View authorized financial summaries.
- View their calculated share and actual payments, if granted.
- Edit their own records when explicitly permitted.

A partner must not automatically receive access to another partner's financial records.

### Editor

An editor can add and modify records within the assigned scope. Deletion, distribution finalization, tax-setting changes, and other sensitive operations require separate permissions.

### Viewer

A viewer can view only explicitly authorized records, dashboards, and reports. The viewer cannot create, edit, delete, or finalize financial records.

### Partner creation form

When adding a partner, include:

- Full name.
- Unique internal partner/profile ID.
- Email and contact details.
- Default profit-sharing percentage.
- Applicable tax-reserve policy or distribution pool.
- Active/inactive status.
- Assigned users and permissions.
- Notes and administrative details.

Support multiple partners with different arrangements. For example, one partner may receive 30% of the distributable balance while another receives 25%.

Do not assume every partner has the same share.

Support SSN-associated profiles where required for the existing business workflow, but minimize collection of sensitive information. Prefer an internal profile ID. If SSN identification is necessary, store only the minimum required information, such as the last four digits, and apply strict access controls. Never expose complete SSNs in ordinary lists, logs, or exports.

## 4. Payout Register: Required Fields

Create a dedicated Payouts / Income module with an Add Payout form.

Whenever a US partner or authorized user records money received, ask for the following fields.

### Field 1: Month

Required.

This is the accounting month and year to which the payout should belong.

Examples:

- July 2026
- August 2026
- September 2026

Use a month/year selector or an equivalent accessible control.

The selected Month determines which monthly income report and financial distribution includes the payout.

**Never automatically derive or overwrite Month from Credit Date or Pay Period dates.** The user must be able to assign the correct accounting month.

### Field 2: Pay Period From

Required.

The starting date of the period covered by the payment.

Example: July 21, 2026.

### Field 3: Pay Period To

Required.

The ending date of the period covered by the payment.

Example: August 5, 2026.

The pay period may cross calendar months and years.

Validate that Pay Period From is not later than Pay Period To.

### Field 4: Credit Date

Required.

The actual date the money was credited to or received in the partner's account.

Example: August 8, 2026.

Credit Date is the real receipt date, not the earning month or pay-period end date.

Allow Credit Date to occur after the pay period ends. Never automatically change Month when the Credit Date changes.

### Field 5: Amount

Required.

The actual amount received, stored using decimal-safe monetary arithmetic and displayed with two decimal places.

### Field 6: Company / Payment Source

Required.

The company, client, or payment source from which the payout originated.

Support a searchable company selector and allow authorized users to manage company records.

### Field 7: Partner / Profile

Required.

The partner or SSN-associated internal profile receiving the money.

Automatically associate the authenticated partner with their permitted profile when appropriate, but do not allow them to select an unauthorized profile by manipulating the API request.

### Field 8: Notes / Details

Optional.

Allow the user to record payment references, invoice information, explanations, and other useful details.

### Additional fields

Where appropriate, include:

- Unique payout reference.
- Optional payment receipt attachment.
- Record status.
- Created by.
- Creation timestamp.
- Last modified by.
- Last modification timestamp.
- Optional verification or reconciliation status.

### Example payout record

Month: August 2026

Pay Period From: July 21, 2026

Pay Period To: August 5, 2026

Credit Date: August 8, 2026

Amount: $2,000.00

Company: Company A

Partner: Partner A

Notes: August payout received after the pay period ended.

The dates and accounting month are separate facts. Store all of them independently.

## 5. Critical Accounting-Month Logic

This is a core business requirement and must be implemented consistently throughout the application.

A payout belongs to the Month manually assigned by the user, regardless of when the money arrives or whether the pay period crosses calendar months.

### Example scenario

Suppose a partner receives five payouts assigned to August 2026:

| Payout | Month | Pay Period | Credit Date | Amount |
|---|---|---|---|---:|
| 1 | August 2026 | Aug 01–Aug 05 | Aug 05 | $2,000 |
| 2 | August 2026 | Aug 06–Aug 12 | Aug 12 | $1,500 |
| 3 | August 2026 | Aug 13–Aug 20 | Aug 21 | $2,000 |
| 4 | August 2026 | Jul 21–Aug 05 | Sep 03 | $2,500 |
| 5 | August 2026 | Aug 21–Aug 31 | Sep 07 | $2,000 |

All five payouts belong to August 2026 because that is the Month assigned to them.

Total August income: $10,000.

Even though payouts 4 and 5 arrived in September, they must remain part of August income.

Do not move those payouts into September merely because their Credit Date falls in September.

### Reporting rules

- Monthly accounting reports use Month.
- Pay-period reports use Pay Period From and Pay Period To.
- Cash-receipt reports use Credit Date.
- Expense reports use the expense accounting period or expense date, depending on the selected reporting mode.

Label these reporting modes clearly so users do not confuse earned-period totals with actual cash-receipt totals.

## 6. Payout Register Table

Create a professional, searchable, sortable, paginated payout table.

Include the following columns:

1. Month.
2. Pay Period From → To.
3. Credit Date.
4. Company / Source.
5. Partner / Profile.
6. Amount.
7. Notes / Details.
8. Status.
9. Entered By.
10. Actions.

Display pay periods in a compact format such as:

`Jul 21 – Aug 05, 2026`

Display Month separately, for example:

`August 2026`

Display Credit Date separately, for example:

`Sep 03, 2026`

Do not combine Month, Pay Period, and Credit Date into one ambiguous date column.

Provide view, edit, and other permitted actions for each record.

Include an Add Payout button with a clearly structured form, validation, and a confirmation or success message after saving.

## 7. Payout Filters and Search

Provide independent filters for:

- Month and year.
- Month range: from one accounting month to another.
- Pay Period From.
- Pay Period To.
- Pay-period overlap with a selected date range.
- Credit Date From.
- Credit Date To.
- Company / Source.
- Partner / Profile.
- Amount range.
- Record status.

Provide convenient presets:

- This Month.
- Last Month.
- This Quarter.
- Year to Date.
- Custom Range.

Allow users to combine filters and reset them easily.

### Filter examples

**Example A: August accounting report**

Month = August 2026.

Show all payouts assigned to August, including payouts credited in September.

**Example B: Actual cash received during September**

Credit Date From = September 1, 2026.

Credit Date To = September 10, 2026.

Show all payouts credited during those dates, including payouts assigned to August.

**Example C: Cross-month pay period**

Filter for pay periods that overlap July 25 through August 10.

Include any payout whose pay-period interval overlaps the selected interval. Implement the overlap condition correctly rather than filtering only by the start date.

The filters must work independently and in combination. All summary cards, totals, reports, and tables must use the appropriate filter basis.

## 8. Expense Management

Create a separate Expenses module.

Each expense must include:

- Expense date.
- Expense accounting month.
- Amount.
- Category.
- Description / Notes.
- Related partner or profile, if applicable.
- Company or vendor, if applicable.
- Payment method or reference, if applicable.
- Optional receipt attachment.
- Record status.
- Created by.
- Last modified by.

Allow authorized users to add, view, edit, and appropriately void or delete expenses.

Support categories such as:

- Software and subscriptions.
- Operating expenses.
- Contractor or service costs.
- Payment processing fees.
- Partner-related expenses.
- Other business expenses.

Allow the owner to customize categories.

Provide filters by expense month, expense date range, partner, category, vendor, and amount.

### Expense allocation

Support expenses allocated to:

- The overall business.
- A specific partner.
- A specific distribution pool.
- Multiple partners using explicit allocation percentages or amounts.

A shared expense must not be counted in full against every partner.

Validate allocation totals and prevent duplicate deductions.

The owner must be able to determine which expenses reduce a given distribution pool and which are tracked separately.

## 9. Financial Calculation Engine

Implement a central backend calculation service. Do not duplicate financial formulas independently across frontend components.

Use exact decimal arithmetic for monetary calculations. Store money in a suitable decimal database type or integer minor units. Do not rely on JavaScript binary floating-point arithmetic for financial calculations.

For a selected accounting month or period, calculate the following.

### A. Total Gross Income

Sum all valid payout amounts assigned to the selected accounting Month or range, subject to the applicable partner, profile, and distribution-pool filters.

### B. Total Deductible Expenses

Sum approved expenses allocated to the same accounting period and distribution pool, applying the configured expense-allocation rules.

### C. Net Before Tax Reserve

Net Before Tax Reserve = Total Gross Income − Total Deductible Expenses.

### D. Tax Reserve

Calculate the configured tax reserve based on the applicable policy.

### E. Distributable Balance

Distributable Balance = Net Before Tax Reserve − Tax Reserve.

### F. Partner Allocations

Calculate each partner's share using the applicable distribution percentage or agreed allocation rule.

For a single-partner arrangement:

Partner Share = Distributable Balance × Partner Percentage.

### G. Owner Share

For a single-partner arrangement:

Owner Percentage = 100% − Partner Percentage.

Owner Share = Distributable Balance − Partner Share.

For multiple partners:

Owner Share = Distributable Balance − Sum of Partner Allocations.

Validate that the sum of all partner allocations and the owner allocation equals the distributable balance, subject only to explicitly documented rounding adjustments.

### Distribution percentage example

Suppose the distributable balance is $7,200.

Partner percentage: 30%.

Owner percentage: 70%.

Partner allocation: $2,160.

Owner allocation: $5,040.

Partner allocation plus owner allocation equals $7,200, or 100% of the distributable balance.

Do not calculate partner shares from the gross income if the business arrangement specifies that shares are based on the balance after expenses and tax reserves.

### Multiple-partner rules

Do not automatically assign 30% to every partner.

Support:
- Individual partner percentages.
- Distribution pools with their own agreements.
- Effective dates for changes to share percentages.
- Historical calculation snapshots.
- Allocation validation.

For a shared pool, validate that partner percentages do not unintentionally exceed 100%.

If partners have separate pools or agreements, calculate each pool independently rather than combining unrelated balances.

### Negative balances

If expenses exceed income, show the negative balance clearly.

Do not create negative partner payments automatically.

Provide an explicitly configured deficit carry-forward or adjustment policy. Do not silently change a prior month's finalized distribution.

### Rounding

Round monetary outputs consistently to two decimal places.

Allocate any unavoidable rounding remainder deterministically so that the ledger reconciles to the cent.

## 10. Tax Reserve Management

Create a Tax Reserve module.

Allow the owner to configure:

- Reserve percentage.
- Fixed reserve amount.
- Manual reserve amount for a specific period.
- Calculation basis.
- Applicable partner or distribution pool.
- Tax year.
- Effective date.
- Reserve adjustments.
- Reserve withdrawals.

Support a configurable policy for calculating reserves, including a percentage of net income after eligible expenses.

Do not hardcode a universal tax percentage.

### Tax reserve ledger

Track:

- Opening reserve balance.
- Reserve additions.
- Adjustments.
- Withdrawals.
- Closing reserve balance.
- Related accounting month.
- Tax year.
- Related transaction or reference.
- Created by and timestamp.

Keep reserve balances distinct from partner and owner shares.

The reserve should be deducted before calculating the distributable balance according to the configured policy.

Do not describe the reserve as the final tax liability. Actual tax obligations depend on the relevant tax circumstances and professional advice.

Prevent the same reserve transaction from being deducted more than once.

## 11. Partner Distribution and Payment Ledger

Create a separate module for calculated distributions and actual payments.

A calculated partner share is not automatically a completed bank transfer.

Track the following for each distribution:

- Accounting month.
- Partner.
- Distribution pool.
- Applicable share percentage.
- Eligible net balance.
- Tax reserve allocation.
- Calculated partner share.
- Approved adjustments.
- Actual amount paid.
- Payment date.
- Payment reference.
- Payment method.
- Outstanding amount.
- Distribution status.
- Approved by.
- Last updated.

Support statuses such as:

- Draft.
- Calculated.
- Pending Approval.
- Approved.
- Partially Paid.
- Paid.
- Adjusted.
- Reversed.

Allow the owner to record a real payment separately from the calculated share.

If the calculated share is $2,160 and the partner has received $1,000, the outstanding amount should be $1,160.

Never mark a distribution as paid merely because the calculation was generated.

Use appropriate approval controls before finalizing distributions or modifying finalized financial periods.

## 12. Dashboard

Create a premium financial dashboard with clear summary cards for:

- Total gross income.
- Total expenses.
- Net before tax reserve.
- Tax reserve added.
- Current tax reserve balance.
- Distributable balance.
- Total partner allocations.
- Owner share.
- Total actual partner payments.
- Outstanding partner distributions.
- Number of payouts.
- Number of expenses.

Allow dashboard filters by:

- Accounting month.
- Accounting month range.
- Credit-date range.
- Partner/profile.
- Company.
- Distribution pool.

Use the selected reporting basis consistently throughout the dashboard.

### Charts and visualizations

Include:

- Monthly income versus expenses.
- Monthly distributable balance.
- Tax reserve trends.
- Income by company.
- Income by partner.
- Partner versus owner distribution.
- Actual partner payments versus outstanding distributions.
- Income by accounting month compared with income by credit date.

Make charts interactive where useful.

Clicking a chart segment should open the relevant filtered records, provided the user has permission.

Clearly label whether a chart uses accounting month, receipt date, expense date, or distribution date.

Use realistic demo data only in demo mode, and label it clearly.

## 13. User Permissions and Access Control

The owner must be able to create users, assign roles, and grant permissions.

Support at least:

- View Only.
- Add and Edit.
- Full Access within a defined scope.
- Custom permissions.

Support access scopes such as:

- Specific partner/profile.
- Specific companies.
- Income records.
- Expense records.
- Tax-reserve records.
- Distribution ledger.
- Dashboard.
- Reports and exports.
- User management.
- Financial settings.

Examples:

1. A partner can add payouts only to their own authorized profile.
2. An editor can add and edit payouts but cannot change tax-reserve policies.
3. A viewer can view assigned records but cannot edit them.
4. An owner can see all authorized business records.
5. A partner cannot see another partner's private records unless access is explicitly granted.

Enforce every permission on the backend and database query paths, not merely by hiding frontend buttons.

Check permissions for listing, reading, creating, editing, deleting, exporting, and finalizing financial records.

Prevent ID-guessing attacks and unauthorized access through direct API requests.

Do not allow a user to grant themselves additional permissions.

Allow the owner to revoke access and deactivate users.

Record permission changes in the audit log.

## 14. Audit History and Financial Corrections

Maintain an audit trail for important financial operations.

Record:

- Record creation.
- Record modification.
- Previous and updated values for important fields.
- User who performed the action.
- Timestamp.
- Reason for material financial changes.
- Record voiding or reversal.
- Tax-reserve adjustments.
- Distribution approval and payment changes.
- Permission changes.
- Export activity where appropriate.

Prefer voiding or reversing finalized financial transactions over permanent deletion.

For finalized accounting periods, require an authorized correction or reopening workflow.

Recalculate affected summaries when records are corrected, while preserving the historical audit trail.

Prevent a correction from creating duplicate partner allocations or reserve entries.

## 15. Reports and Exports

Provide reports for:

- Monthly income by accounting Month.
- Payouts by Credit Date.
- Payouts by Pay Period.
- Income by company.
- Income by partner/profile.
- Monthly expenses.
- Expense categories.
- Tax-reserve ledger.
- Partner share statements.
- Owner share statements.
- Actual partner payments.
- Outstanding partner distributions.
- Annual financial summaries.
- Audit history.

Allow authorized users to export reports to CSV and Excel.

Generate printable or downloadable PDF statements where practical.

Every report must clearly identify its reporting basis.

For example:

- Accounting Month: August 2026.
- Credit Date Range: September 1–10, 2026.
- Pay Period Range: July 21–August 5, 2026.

Exports must respect all active filters and permissions.

Do not include unauthorized partners' data or sensitive SSN information in exported files.

## 16. Company and Payment Source Management

Create a company/source management module.

Store:

- Company name.
- Optional company identifier.
- Contact details where needed.
- Notes.
- Active/inactive status.
- Created by.
- Created and updated timestamps.

Allow users with appropriate permissions to select a company while recording a payout.

Prevent accidental duplicate company creation and provide a searchable selector.

Changing a company name should not corrupt or duplicate historical financial transactions.

## 17. Search, Forms, and Usability

Implement:

- Global search for authorized records.
- Pagination for large datasets.
- Sorting by supported columns.
- Useful date pickers.
- Searchable dropdowns.
- Form validation.
- Clear required-field indicators.
- Confirmation dialogs for high-impact actions.
- Empty states with useful instructions.
- Loading states.
- Success and error notifications.
- Filter reset controls.
- Responsive tables or card-based mobile views.
- Clear currency and date formatting.

The Add Payout form must be quick to complete and make Month, Pay Period From, Pay Period To, Credit Date, and Amount especially clear.

Avoid ambiguous labels such as "Date" when multiple dates exist.

## 18. Visual Design Direction

Create a modern, premium fintech-style interface suitable for a business managing US partner finances.

Design principles:

- Professional and trustworthy appearance.
- Clear visual hierarchy.
- Elegant typography.
- Consistent spacing.
- Clean tables and forms.
- Restrained use of color.
- Accessible contrast.
- Smooth, subtle animations.
- Fast navigation.
- Responsive desktop, tablet, and mobile layouts.
- Optional light and dark themes.
- Useful financial charts.
- Consistent icons and interaction patterns.

Differentiate visually between:

- Income received.
- Expenses.
- Tax reserves.
- Calculated distributions.
- Actual payments.
- Outstanding balances.

Do not sacrifice usability, accessibility, or performance for decorative animations.

Preserve the existing brand and application naming unless a change is explicitly requested.

## 19. Security and Data Integrity

Implement:

- Secure authentication.
- Appropriate password hashing.
- Server-side authorization.
- Validated API inputs.
- Database constraints.
- Decimal-safe calculations.
- Database transactions for financial updates.
- Audit logging.
- Secure session management.
- Protection against injection and privilege escalation.
- CSRF protection where applicable.
- Safe file-upload validation.
- Environment-based secret management.
- Appropriate rate limiting.
- Backup and restore procedures.
- Error handling and operational logging.
- Minimal collection of sensitive personal information.

Do not expose secrets, passwords, complete SSNs, or private credentials in logs, frontend responses, or exports.

Do not rely on frontend validation as the only validation layer.

Do not claim HIPAA compliance or tax compliance without a proper assessment of applicable requirements and actual implementation.

## 20. Database Design

Inspect the existing schema first, then adapt or create the necessary tables.

Potential entities include:

- Users.
- Roles and permissions.
- Partners.
- Partner profiles.
- Companies.
- Payouts.
- Expenses.
- Expense allocations.
- Distribution pools.
- Partner share agreements.
- Tax-reserve policies.
- Tax-reserve ledger entries.
- Distribution calculations or snapshots.
- Partner distributions.
- Actual partner payments.
- Accounting periods.
- Attachments.
- Audit log.

Use appropriate relationships, foreign keys, indexes, uniqueness constraints, and timestamps.

### Payout data model

At minimum, each payout should persist:

- id.
- accounting_month, represented by a year and month or a normalized month-start date.
- pay_period_from.
- pay_period_to.
- credit_date.
- amount.
- company_id or payment_source.
- partner_profile_id.
- notes.
- status.
- created_by.
- created_at.
- updated_by.
- updated_at.

Store all dates consistently and avoid timezone conversions that shift date-only values.

Keep Month, Pay Period From, Pay Period To, and Credit Date independent.

Use migrations to update existing data safely. If old records have only a single date, do not silently invent their pay periods or accounting months. Use an explicitly documented migration policy and allow the owner to correct uncertain legacy values.

## 21. Performance and Maintainability

- Use server-side pagination for large financial registers.
- Add indexes for accounting month, credit date, pay-period dates, partner/profile, company, and status.
- Avoid loading all financial records into the browser for totals.
- Perform authoritative financial aggregation on the backend.
- Keep calculation logic in a reusable service.
- Keep permission checks consistent across endpoints.
- Use transactions when finalizing distributions or recording payments.
- Make retry behavior safe so repeated requests do not duplicate financial entries.
- Separate business logic from presentation code.
- Document important accounting assumptions.

## 22. Required Automated Tests

Create automated tests covering at least the following scenarios.

### Payout dates

1. A payout assigned to August remains in August when its Credit Date is in September.
2. A payout with a pay period spanning July and August saves correctly.
3. Month remains unchanged when Credit Date is edited.
4. Month remains unchanged when pay-period dates are edited.
5. Pay Period From later than Pay Period To is rejected.
6. Missing Month is rejected.
7. Missing Credit Date is rejected.
8. A Credit Date after the pay-period end is accepted.
9. A Credit Date before the pay-period start is handled according to the configured validation policy rather than silently changed.
10. Month filters and Credit Date filters return different, correct results.

### Reporting

11. Five payouts assigned to August total correctly when two are credited in September.
12. Credit Date filtering finds those September receipts regardless of assigned accounting month.
13. Pay-period overlap filtering includes records whose periods overlap the selected range.
14. Combined filters produce correct totals.
15. Dashboard cards and exports use the same selected reporting basis.

### Financial calculations

16. Expenses are deducted exactly once.
17. The configured tax reserve is applied before profit distribution.
18. Partner and owner allocations reconcile to 100% of the distributable balance.
19. Multiple partners receive the correct configured allocations.
20. Invalid allocation percentages are rejected.
21. Negative balances do not automatically create negative partner payments.
22. Rounding differences are handled consistently.
23. Actual payments remain separate from calculated distributions.
24. Partial payments produce the correct outstanding balance.
25. Editing a payout does not create duplicate distributions or tax-reserve entries.

### Permissions and security

26. Viewers cannot modify records through the API.
27. Partners cannot access unauthorized partner records by guessing IDs.
28. Unauthorized users cannot export restricted information.
29. Users cannot grant themselves permissions.
30. Audit history records important financial edits and reversals.

## 23. Completion Criteria

The project is complete only when:

- All required forms work.
- Payout dates are stored independently and accurately.
- Accounting-month totals are correct.
- Expense allocation works.
- Tax reserves are configurable.
- Partner and owner shares reconcile.
- Actual distributions and payments are tracked separately.
- Filters work independently and in combination.
- Permissions are enforced by the backend.
- Reports and exports work.
- Database migrations preserve existing records.
- Automated tests pass.
- No critical financial operation is left as a placeholder.
- Setup and deployment instructions are documented.

## 24. Final Implementation Instructions

Inspect the existing project and give a short summary of its current architecture and the proposed implementation plan.

Then implement the application, including database changes, backend services, frontend pages, financial calculations, filters, permissions, reports, and automated tests.

After implementation:

1. Run the available test suite.
2. Fix failures caused by your changes.
3. Verify the month, pay-period, and credit-date scenarios using automated tests.
4. Verify partner and viewer access restrictions.
5. Verify financial reconciliation with representative test cases.
6. Report the files changed, database migrations created, commands executed, test results, and any remaining limitations.

Do not claim that a feature works unless it has been implemented and verified. Do not stop at a design mockup, sample dashboard, or implementation plan.