require('../env');

const fs = require('fs');

const { Command } = require('commander');
const csvParseSync = require('csv-parse/sync'); // eslint-disable-line node/no-missing-require

const { request, gql } = require('graphql-request');
const { pRateLimit } = require('p-ratelimit');

const endpoint = process.env.PERSONAL_TOKEN
  ? `${process.env.API_URL}/graphql?personalToken=${process.env.PERSONAL_TOKEN}`
  : `${process.env.API_URL}/graphql/${process.env.API_KEY}`;

const rateLimiter = pRateLimit({
  interval: 60 * 1000, // 1 minute
  rate: 60, // 60 calls per interval
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_RETRIES = 5;

// Network errors from fetch include the request URL, which contains the personal token
const redact = (text) =>
  String(text)
    .replace(/personalToken=[^&\s"')]+/g, 'personalToken=***')
    .replace(/(\/graphql\/)[A-Za-z0-9_-]{16,}/g, '$1***');

const errorMessage = (err) => redact(err?.response?.errors?.[0]?.message || err?.message || err);

const isRetryable = (err) =>
  err?.response?.status === 429 ||
  (!err?.response && /fetch failed|socket hang up|network|timed? ?out|ECONN|ETIMEDOUT|ENOTFOUND/i.test(err?.message));

// Read-only queries, so it is always safe to send them again
async function rateLimitedRequest(query, variables) {
  for (let retry = 0; ; retry++) {
    try {
      return await rateLimiter(() => request(endpoint, query, variables));
    } catch (err) {
      if (!isRetryable(err) || retry >= MAX_RETRIES) {
        throw err;
      }
      const waitMs = 5000 * 2 ** retry;
      console.log(`  Request failed (${errorMessage(err)}), waiting ${waitMs / 1000}s before retry ${retry + 1}...`);
      await sleep(waitMs);
    }
  }
}

const fetchAll = async (query, variables, getPage) => {
  const nodes = [];
  for (let offset = 0; ; offset += 100) {
    const page = getPage(await rateLimitedRequest(query, { ...variables, offset }));
    nodes.push(...page.nodes);
    if (nodes.length >= page.totalCount || page.nodes.length === 0) {
      return nodes;
    }
  }
};

const readyToPayExpensesQuery = gql`
  query ReadyToPayExpenses($slug: String!, $offset: Int!) {
    expenses(
      account: { slug: $slug }
      includeChildrenExpenses: true
      status: READY_TO_PAY
      limit: 100
      offset: $offset
      orderBy: { field: CREATED_AT, direction: ASC }
    ) {
      totalCount
      nodes {
        id
        legacyId
        amountV2 {
          valueInCents
          currency
        }
        account {
          slug
        }
        payoutMethod {
          type
          name
          data
        }
      }
    }
  }
`;

// Payout methods hold either github.com/<user> or github.com/sponsors/<user>
const GITHUB_URL_REGEX = /github\.com\/(?:sponsors\/)?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/i;

/** GitHub username from a link in the payout method (name first, then the raw data), lowercased */
const getGithubUsername = (payoutMethod) => {
  for (const text of [payoutMethod?.name, payoutMethod?.data && JSON.stringify(payoutMethod.data)]) {
    const match = text && String(text).match(GITHUB_URL_REGEX);
    if (match) {
      return match[1].toLowerCase();
    }
  }
  return null;
};

const parseAmountInCents = (s) => {
  const cleaned = String(s ?? '').replace(/[$,\s]/g, '');
  return /^\d+(\.\d+)?$/.test(cleaned) ? Math.round(parseFloat(cleaned) * 100) : null;
};

const normalizeUsername = (s) =>
  String(s ?? '')
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^@/, '')
    .replace(/\/+$/, '')
    .toLowerCase();

const formatCents = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

/** Returns the CSV rows (username, cents, line) and the rows that could not be read */
const parseCsv = (input) => {
  const records = csvParseSync.parse(input, { columns: true, bom: true, skip_empty_lines: true, trim: true });
  const rows = [];
  const malformed = [];
  records.forEach((record, i) => {
    const line = i + 2; // header is line 1
    const username = normalizeUsername(record['Maintainer username']);
    const cents = parseAmountInCents(record['Sponsorship amount in USD']);
    if (!username || cents === null) {
      malformed.push({ line, reason: !username ? 'missing username' : 'invalid amount' });
    } else {
      rows.push({ username, cents, line });
    }
  });
  return { rows, malformed };
};

const groupBy = (items, key) => {
  const groups = new Map();
  for (const item of items) {
    groups.set(item[key], [...(groups.get(item[key]) || []), item]);
  }
  return groups;
};

/**
 * Matches expenses to CSV rows on username AND amount, never summing. Amounts are compared as whole dollars (floored). Per username, expenses and rows with an equal
 * amount are paired one-to-one first. Whatever is left is paired in order as amount mismatches, and the remainder is
 * reported as missing on one side.
 */
const compare = (expenses, rows) => {
  const result = { matched: [], mismatched: [], missingFromCsv: [], missingOnOC: [] };
  const expensesByUser = groupBy(expenses, 'username');
  const rowsByUser = groupBy(rows, 'username');

  for (const username of new Set([...expensesByUser.keys(), ...rowsByUser.keys()])) {
    const leftoverExpenses = [...(expensesByUser.get(username) || [])];
    const leftoverRows = [...(rowsByUser.get(username) || [])];

    for (const expense of [...leftoverExpenses]) {
      const rowIndex = leftoverRows.findIndex((row) => Math.floor(row.cents / 100) === Math.floor(expense.cents / 100));
      if (rowIndex !== -1) {
        result.matched.push({ expense, row: leftoverRows[rowIndex] });
        leftoverRows.splice(rowIndex, 1);
        leftoverExpenses.splice(leftoverExpenses.indexOf(expense), 1);
      }
    }

    const pairs = Math.min(leftoverExpenses.length, leftoverRows.length);
    for (let i = 0; i < pairs; i++) {
      result.mismatched.push({ expense: leftoverExpenses[i], row: leftoverRows[i] });
    }
    result.missingFromCsv.push(...leftoverExpenses.slice(pairs));
    result.missingOnOC.push(...leftoverRows.slice(pairs));
  }
  return result;
};

const expenseUrl = (expense) => `https://opencollective.com/${expense.account}/expenses/${expense.legacyId}`;

const csvField = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const REPORT_COLUMNS = [
  'status',
  'username',
  'csv_amount_usd',
  'csv_line',
  'oc_amount',
  'oc_currency',
  'expense_id',
  'expense_url',
];

/** One line per CSV row / expense, with its status, so the result can be sorted and filtered in a spreadsheet */
const buildReportCsv = ({ matched, mismatched, missingFromCsv, missingOnOC, unmatchable, malformed }) => {
  const line = (status, { expense, row, malformedRow } = {}) => ({
    status,
    username: expense?.username || row?.username || '',
    csv_amount_usd: row ? row.cents / 100 : '',
    csv_line: row?.line ?? malformedRow?.line ?? '',
    oc_amount: expense ? expense.cents / 100 : '',
    oc_currency: expense?.currency || '',
    expense_id: expense?.legacyId || '',
    expense_url: expense ? expenseUrl(expense) : '',
  });
  const lines = [
    ...matched.map(({ expense, row }) => line('matched', { expense, row })),
    ...mismatched.map(({ expense, row }) => line('amount_mismatch', { expense, row })),
    ...missingFromCsv.map((expense) => line('missing_from_csv', { expense })),
    ...missingOnOC.map((row) => line('missing_on_open_collective', { row })),
    ...unmatchable.map((expense) => line('cannot_be_checked', { expense })),
    ...malformed.map((malformedRow) => line(`malformed_csv_row: ${malformedRow.reason}`, { malformedRow })),
  ];
  return [REPORT_COLUMNS, ...lines.map((l) => REPORT_COLUMNS.map((c) => l[c]))]
    .map((fields) => fields.map(csvField).join(','))
    .join('\n');
};

const printSection = (title, items, format) => {
  console.log(`\n${title} (${items.length})`);
  if (items.length === 0) {
    console.log('  none');
  }
  items.forEach((item) => console.log(`  - ${format(item)}`));
};

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program
    .description('Check the ready to pay expenses of an account against a GitHub Sponsors payments CSV (read-only)')
    .argument('<csv>', "CSV with the columns 'Maintainer username' and 'Sponsorship amount in USD'")
    .option('--account <slug>', 'Account whose ready to pay expenses (and its children) are checked', 'ecosystem-funds')
    .option(
      '--output <file>',
      'Also write the results (one line per row or expense, with its status) to this CSV file',
    );
  program.parse(argv);
  return program;
};

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const [csvPath] = program.args;
  const { account, output } = program.opts();

  const { rows, malformed } = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  console.log(`Read ${rows.length} rows from the CSV`);
  console.log(`Fetching ready to pay expenses of ${account} (including children) from ${process.env.API_URL}...`);

  const nodes = await fetchAll(readyToPayExpensesQuery, { slug: account }, (data) => data.expenses);
  const all = nodes.map((node) => ({
    id: node.id,
    legacyId: node.legacyId,
    account: node.account.slug,
    cents: node.amountV2.valueInCents,
    currency: node.amountV2.currency,
    username: getGithubUsername(node.payoutMethod),
  }));
  const unmatchable = all.filter((expense) => !expense.username || expense.currency !== 'USD');
  const expenses = all.filter((expense) => !unmatchable.includes(expense));
  console.log(`Found ${all.length} ready to pay expenses`);

  const { matched, mismatched, missingFromCsv, missingOnOC } = compare(expenses, rows);

  printSection(
    'Ready to pay on Open Collective but MISSING FROM THE CSV',
    missingFromCsv,
    (e) => `${e.username}  ${formatCents(e.cents)}  ${expenseUrl(e)}`,
  );
  printSection(
    'In the CSV but MISSING ON OPEN COLLECTIVE',
    missingOnOC,
    (r) => `${r.username}  ${formatCents(r.cents)}  (CSV line ${r.line})`,
  );
  printSection(
    'AMOUNT MISMATCHES',
    mismatched,
    ({ expense, row }) =>
      `${expense.username}  Open Collective ${formatCents(expense.cents)} vs CSV ${formatCents(row.cents)} (line ${row.line})  ${expenseUrl(expense)}`,
  );
  printSection(
    'Expenses that CANNOT BE CHECKED (no GitHub link in the payout method, or not USD)',
    unmatchable,
    (e) => `${e.username || 'no GitHub link'}  ${e.cents / 100} ${e.currency}  ${expenseUrl(e)}`,
  );
  printSection('Malformed CSV rows', malformed, (m) => `line ${m.line}: ${m.reason}`);
  printSection(
    'MATCHED (CSV row and Open Collective expense)',
    matched,
    ({ expense, row }) =>
      `${expense.username}  CSV $${row.cents / 100} (line ${row.line})  Open Collective ${formatCents(expense.cents)}  ${expenseUrl(expense)}`,
  );

  const sum = (items) => items.reduce((total, item) => total + item.cents, 0);
  console.log('\nSummary');
  console.log(`  Maintainers matched:      ${matched.length}`);
  console.log(`  Open Collective total:    ${formatCents(sum(expenses))} (${expenses.length} expenses)`);
  console.log(`  CSV total:                ${formatCents(sum(rows))} (${rows.length} rows)`);

  if (output) {
    const report = { matched, mismatched, missingFromCsv, missingOnOC, unmatchable, malformed };
    fs.writeFileSync(output, `${buildReportCsv(report)}\n`);
    console.log(`\nWrote the results to ${output}`);
  }

  const problems =
    missingFromCsv.length + missingOnOC.length + mismatched.length + unmatchable.length + malformed.length;
  console.log(
    problems === 0 ? '\nAll good: the CSV matches the ready to pay queue.' : `\n${problems} discrepancies found.`,
  );
  process.exit(problems === 0 ? 0 : 1);
}

module.exports = { getGithubUsername, parseAmountInCents, parseCsv, compare };

if (!module.parent) {
  main().catch((e) => {
    if (e instanceof Error && e.name === 'CommanderError') {
      return;
    }
    console.error(errorMessage(e));
    process.exit(1);
  });
}
