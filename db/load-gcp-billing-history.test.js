const fs = require('fs');
const os = require('os');
const path = require('path');
const { toMonth, money, load } = require('./load-gcp-billing-history');

const csv = (text) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'billing-')), 'report.csv');
  fs.writeFileSync(file, text);
  return file;
};

test('reads the month formats Cloud Billing reports use', () => {
  expect(['2026-08', '202608', '2026-08-01', '8/1/2026', 'Aug 2026', 'August 1, 2026'].map(toMonth)).toEqual(Array(6).fill('202608'));
  expect(toMonth('Total')).toBeNull();
});

test('reads money with symbols, thousands separators and parentheses', () => {
  expect([money('$1,234.50'), money('-0.12'), money('($3.00)'), money('')]).toEqual([1234.5, -0.12, -3, 0]);
});

test('uses Subtotal as the net cost and skips total rows', () => {
  const rows = load([csv('\uFEFFMonth,Project ID,Service description,Cost ($),Discounts ($),Subtotal ($)\n'
    + '2026-06,athena-476423,Cloud Run,"1,000.00",-1.00,999.00\n'
    + '2026-06,athena-476423,Cloud Run,2.00,0,2.00\n'
    + '2026-06,athena-476423,Gemini API,0.50,0,0.50\n'
    + ',,Total,1002.50,-1.00,1001.50\n')], {});
  expect(rows).toEqual([
    { month: '202606', project: 'athena-476423', service: 'Cloud Run', currency: 'USD', cost: 1001 },
    { month: '202606', project: 'athena-476423', service: 'Gemini API', currency: 'USD', cost: 0.5 },
  ]);
});

test('without Subtotal, adds every credit column to cost; --month and --project fill what the CSV lacks', () => {
  const rows = load([csv('Service description,Cost,Promotions and others,Savings programs\nCloud Run,5,-2,-1\n')], { month: '202605', project: 'athena-476423' });
  expect(rows).toEqual([{ month: '202605', project: 'athena-476423', service: 'Cloud Run', currency: 'USD', cost: 2 }]);
});

test('refuses a CSV with no month rather than guessing one', () => {
  expect(() => load([csv('Project ID,Service description,Cost\nx,Cloud Run,1\n')], {})).toThrow(/--month/);
});
