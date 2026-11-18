# Vite Ecosystem Fund distribution

Distributes money from the [Vite Ecosystem Fund](https://opencollective.com/cloudflare/projects/vite-ecosystem-fund) to the recipients listed in a CSV. Recipients that can receive a contribution from the Fund get one (one-time or monthly, as the CSV says). Everyone else gets an expense invite through Open Collective.

The script is meant to be **run repeatedly**, once a month, with the CSV updated between runs (see [Monthly re-runs](#monthly-re-runs)).

The CSV, `results.json` (the local ledger of completed rows) and any `.with-links.csv` copy contain recipient details. They are gitignored by `cloudflare_distribution/.gitignore`. Never commit them.

## Setup

Needs `PERSONAL_TOKEN` and `API_URL` in a `.env` file for an admin of the Fund. The token needs the scopes for creating contributions and expenses.

`.env` is read from the directory you run the command in, so run from the `opencollective-tools` root:

```
cd opencollective-tools
```

`API_URL` defaults to staging, but the Fund only exists on production, so set `API_URL=https://api.opencollective.com`. The first line of output shows the API in use. Variables already exported in your shell take precedence over `.env`.

## CSV format

Columns: `name, URLs, Amounts, monthly vs one-time, Personal or Project?, Donation URL, contact address, Status, Notes`.

- `Donation URL`: the recipient's opencollective.com page, if they have one (falls back to an opencollective.com link in `URLs`). Leave empty if they have no account.
- `Amounts`: e.g. `$1,500`, in USD.
- `monthly vs one-time`: `Monthly` or `One-off`.
- `Personal or Project?`: `Personal` for an individual, `Project` for a project. It selects the invite note (see "Invite flow"). Rows that need an invite and have any other value (including `Fund` or blank) are reported as `ambiguous` until it is fixed. Rows that become contributions are not affected.
- `contact address`: who the invite is sent to when the recipient has no account.
- `Status`: `Sent` or a link, both mean the row has been handled (see below).

## Usage

```
node cloudflare_distribution/import.js "<csv>"                 # dry run, changes nothing
node cloudflare_distribution/import.js "<csv>" --run           # for real, asks for confirmation
node cloudflare_distribution/import.js "<csv>" --update-csv    # also write a copy of the CSV with links
node cloudflare_distribution/import.js "<csv>" --run --update-csv --delay 30
```

Always do a dry run first and read the summary. Console output uses row ids (`R01`...) instead of names or emails.

| Option                    | Meaning                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `--run`                   | Create contributions and invites. Without it nothing is changed.                                                |
| `--yes`                   | Skip the confirmation prompt (with `--run`).                                                                    |
| `--update-csv`            | Write `<name>.with-links.csv` with a link in `Status` for each handled row.                                     |
| `--delay <seconds>`       | Wait after each invite expense (default 20). Invites are rate limited by the API.                               |
| `--retry-delay <seconds>` | First wait after a rate limit or network error (default 5), doubled on each retry. A `Retry-After` header wins. |
| `--max-retries <n>`       | Retries of one call after a rate limit or network error before stopping (default 6).                            |
| `--fund <slug>`           | Fund making the payments (default `vite-ecosystem-fund`).                                                       |
| `--ledger <path>`         | Where completed rows are recorded (default `cloudflare_distribution/results.json`).                             |
| `--description <text>`    | Description used for invite expenses.                                                                           |

### Rate limits and network errors

When the API rate limits a call (HTTP 429 or a "Rate limit exceeded" error) or the network fails, the script waits and sends the same call again. The wait is the `Retry-After` of the response when there is one, otherwise it starts at `--retry-delay` (5 seconds) and **doubles each time the same call fails again**: 5, 10, 20, 40, 80, 160 seconds (never more than 10 minutes). Each wait prints a line such as `Rate limited, waiting 10s before retry 2/6...`. Only rate limit and network errors are retried, other errors (validation, permissions, server errors) are reported right away.

- **No duplicates.** A rate limited call is rejected before it does anything, so it is safe to send again. After a network error the call may still have gone through, so the script first looks on the Fund for the invite expense or contribution it was creating and uses it if it is there, instead of sending it again.
- **When retries run out** (`--max-retries`), the script stops instead of guessing: no row is reported as `ambiguous` because of a rate limit or network problem. Rows completed so far are saved in `results.json`, so just rerun later.
- The API allows about one invite per 10 seconds, which the default `--delay 20` stays under, so retries should be rare.
- Error messages are redacted so the personal token never reaches the console.

## How rows are handled

Every row is put in one bucket and the summary prints the bucket, amount, frequency, account and the reason.

| Bucket                     | Meaning                                                                                                                 | What `--run` does                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ready`                    | Account exists, is active and is on the same host as the Fund                                                           | Creates a contribution from the Fund balance (one-time or monthly) |
| `existing-account-expense` | Account exists but is on another host, has no host, or is not active yet                                                | Sends an expense invite to the existing account                    |
| `needs-invite`             | No Open Collective account                                                                                              | Sends an expense invite to the contact address                     |
| `already-contributed`      | The Fund already paid the recipient this month, has an active monthly contribution to it, or has an open expense for it | Nothing                                                            |
| `skipped-sent`             | `Status` is `Sent`, or already holds a link                                                                             | Nothing                                                            |
| `already-done`             | Handled in an earlier run (found in `results.json`)                                                                     | Nothing                                                            |
| `ambiguous`, `invalid`     | Account lookup failed, account archived or frozen, no contact address, or unparsable amount/frequency                   | Nothing, fix the row and rerun                                     |

Notes:

- **Balance contributions only work within one host**, which is why recipients on other hosts get an expense instead.
- **An expense invite is a payout, not a contribution.** It appears in the Fund's expenses, not as a donation on the recipient's page.
- **Invite flow.** The recipient gets an email, creates an account (or signs in), sets a payout method and submits. The amount and description are locked. The note depends on `Personal or Project?` and the frequency, and `{{amount}}` is filled in per row. Edit the files to change the wording:

  | Recipient | One-time                  | Monthly                                                                                      |
  | --------- | ------------------------- | -------------------------------------------------------------------------------------------- |
  | Project   | `invite-note.md`          | `invite-note-monthly.md`: asks them to create a Collective and share its URL                 |
  | Personal  | `invite-note-personal.md` | `invite-note-personal-monthly.md`: this month's payment, a new invitation follows each month |

  Individuals are not asked to create a Collective, they just accept the invitation. An individual cannot receive recurring contributions, so a monthly personal recipient gets a new invitation each month: rerun the script monthly (see Monthly re-runs).

- **Same account in several rows** (for example a monthly and a one-time payment): each row is handled on its own, and the script warns that the "already paid" checks cannot tell them apart, so check the Fund's activity for that account by hand.
- **Duplicate protection.** Besides `results.json`, the script asks the Open Collective API what the Fund has already paid this month, which monthly contributions are active and which expenses are open, and skips those recipients. Check that the rows you expect to be skipped show up in `already-contributed` or `already-done`.

## Monthly re-runs

Run the script again every month with the same command. A typical cycle:

1. **Update the CSV.** For recipients who were invited and have since created a Collective on Open Collective, put its URL in `Donation URL`. Add new recipients as new rows.
2. **Dry run.** Handled rows show as `already-done`, `already-contributed` or `skipped-sent`. Only new rows and follow-ups should be left to process.
3. **Run with `--run --update-csv`**, then use the `.with-links.csv` file as the CSV from now on.

What happens to rows from earlier runs:

- **One-time rows** that were paid or invited stay finished. They are never paid again, even in later months (this relies on `results.json`, or a link or `Sent` in `Status`).
- **Monthly rows that went out as an invite** are renewed on the first run of each later month, as long as the recipient has no account that can receive contributions yet. The run sends a **new invite for the current month**, and the newest invite **replaces** the old one: the ledger (the old entry is kept under `history`) and the `Status` link point at the new one, but the old expense itself is **never deleted or cancelled** by the script, including one that was never accepted (still `DRAFT`). Clean up old drafts by hand if you want to, so the recipient is not left with several open invites. The same run is a no-op later in the same month. In the dry run these rows say "Monthly invite #N (STATUS) is from an earlier month, sending this month's invite, the old one is left untouched".
- **Monthly rows whose recipient now has an account** that can receive contributions from the Fund (same host as the Fund, active) and whose URL is in the CSV get the **monthly contribution** instead of a new invite (the old invite is left untouched here too). This never happens in the same month as the invite, since the invite already pays that month. Once the monthly contribution is active the row is `already-done` or `already-contributed`.
- **Monthly rows that were set up as a contribution** keep running by themselves. Open Collective charges them every month, nothing to rerun. They show up as `already-done` or `already-contributed`.
- **Monthly recipients on a different host, and individuals** cannot receive balance contributions, so they get a new invite every month this way, for as long as they stay in the CSV.

Before a follow-up that starts a monthly contribution, check on the Fund's expenses page that the earlier invite expense was paid or cancelled. Since the script leaves old invites alone, one that is still open (draft or pending) when the contribution starts could still be accepted and paid, so the recipient could be paid twice for that month.

To redo a row that was handled by mistake, delete its entry from `results.json` (and clear its `Status` in the CSV), then rerun.

## Corrections and resends

Before skipping a row that is in `results.json`, the script checks what happened to the expense or contribution it created. If that payment **failed**, it is sent again, **but only when the row now has a different payee**. Failed means:

- an expense that was rejected, cancelled, declined (`INVITE_DECLINED`), in error, marked as spam or **deleted**
- a contribution that was rejected, cancelled, expired, in error or **deleted**
- an expense or contribution that was **refunded**

The payee is the Open Collective account in `Donation URL` when there is one, and the `contact address` (case-insensitive) otherwise. So to fix a mistake, correct the row in the CSV (a new contact address, or the URL of the right Collective) and rerun. In the dry run these rows show as `[resend]` reasons in their bucket (`ready`, `existing-account-expense` or `needs-invite`), for example "Resending, previous expense #123 (REJECTED) went to a different payee".

| Previous payment                         | Payee in the CSV | Result                                               |
| ---------------------------------------- | ---------------- | ---------------------------------------------------- |
| Failed                                   | Different        | Sent again                                           |
| Failed                                   | Same             | Not sent again (`already-done`)                      |
| Failed, `INVITE_DECLINED`, payee unknown | Any              | Not sent again, the recipient said no                |
| Failed, other status, payee unknown      | Any              | Sent again, the reason says "previous payee unknown" |
| Still alive (pending, approved, paid...) | Any              | Left alone                                           |

Things to know:

- **A resend ignores a link or `Sent` in `Status`**, since that link points at the failed payment.
- **The payee is recorded in `results.json` from now on.** Entries written by earlier versions of the script do not have it. For those, the script tries to work it out (the invited email of a draft, the account of an expense on an existing account), but a rejected or deleted invite no longer exposes the email. In that case the payee counts as unknown and the row is sent again even if the address did not change, so **read the dry run before `--run`**.
- **History is kept.** When a row is sent again, the old entry is stored under `history` in its new ledger entry.
- **A failed payment to the same payee is never retried automatically.** If you want it sent again anyway, delete its entry from `results.json` and clear its `Status`.
- **Deleted and refunded payments are only found through the ledger.** A payment that was never recorded there is not tracked.
- Each ledger row costs one extra API call per run, plus a full read of the Fund's transactions to find refunds.

## Links in the CSV

`--update-csv` writes a copy of the CSV (`<name>.with-links.csv`, the original is untouched) where the `Status` column holds a link to the order or expense for each row that has one. Links come from `results.json` and from activity the Fund already has:

- Expense invites: `https://opencollective.com/cloudflare/projects/vite-ecosystem-fund/expenses/<id>`
- Contributions: `https://opencollective.com/<recipient>/contributions/<id>` (projects and events include their parent in the path)

The domain follows `API_URL`. Rows without an order or expense are left as they were. Rows whose `Status` is `Sent` or a link are skipped on later runs, so use the `.with-links.csv` file as the input going forward. For monthly rows with an invite link, the follow-up described above still applies once the Donation URL is updated.
