jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn(() => ({ getClient: async () => ({ getAccessToken: async () => ({ token: 'tok' }) }) })),
}));
jest.mock('../config', () => ({ GCP_PROJECT_ID: 'athena-test' }));

const { getBilling, invoiceMonth } = require('./gcpBilling');

const TABLE = 'gcp_billing_export_v1_0000AA_BBBBBB_CCCCCC';
const rows = (fields, values) => ({
  jobComplete: true,
  schema: { fields: fields.map((name) => ({ name })) },
  rows: values.map((v) => ({ f: v.map((x) => ({ v: x })) })),
});

function bigQuery({ tables = [{ tableReference: { tableId: TABLE } }], datasetStatus = 200 } = {}) {
  return jest.fn(async (url, init) => {
    if (init.method === 'GET') {
      if (datasetStatus !== 200) return { ok: false, status: datasetStatus, json: async () => ({ error: { message: 'Not found' } }) };
      return { ok: true, json: async () => ({ tables }) };
    }
    const { query } = JSON.parse(init.body);
    if (query.includes('history_since') && query.includes('billing_history')) return { ok: true, json: async () => rows(['cost', 'data_since', 'data_through', 'history_since'], [['40', '2026-07-30', '1.7899E9', '202511']]) };
    if (query.includes('data_through')) return { ok: true, json: async () => rows(['cost', 'data_since', 'data_through'], [['12.345', '2026-07-30', '1.7899E9']]) };
    if (query.includes('sku.description')) return { ok: true, json: async () => rows(['service', 'name', 'cost', 'credits'], [['Cloud Run', 'CPU', '3.5', '-1']]) };
    if (query.includes('FORMAT_DATE')) return { ok: true, json: async () => rows(['date', 'cost'], [['2026-09-20', '2.5'], ['2026-09-21', '2']]) };
    if (query.includes('export_time')) return { ok: true, json: async () => rows(['currency', 'last_export'], [['USD', '1.7899E9']]) };
    return { ok: true, json: async () => rows(['name', 'cost', 'credits'], [['Cloud Run', '3.5', '-1'], ['Cloud SQL', '2', '0'], ['Gemini API', '0.75', '0']]) };
  });
}

afterEach(() => { delete global.fetch; });

test('reads month-to-date cost for this project from the billing export', async () => {
  global.fetch = bigQuery();
  const result = await getBilling(new Date('2026-09-27T12:00:00Z'));
  expect(result).toMatchObject({
    configured: true, project: 'athena-test', invoiceMonth: '202609', currency: 'USD',
    costThisMonth: 5.25, grossThisMonth: 6.25, creditsThisMonth: -1,
    llmThisMonth: 0.75, hostingThisMonth: 4.5,
    costAllTime: 12.35, dataSince: '2026-07-30', dataThrough: new Date(1.7899e12).toISOString(),
  });
  expect(result.services).toEqual([{ name: 'Cloud Run', cost: 2.5, gross: 3.5 }, { name: 'Cloud SQL', cost: 2, gross: 2 }, { name: 'Gemini API', cost: 0.75, gross: 0.75 }]);
  expect(result.topSkus[0]).toEqual({ service: 'Cloud Run', name: 'CPU', cost: 2.5, gross: 3.5 });
  const queries = global.fetch.mock.calls.filter(([, init]) => init.method === 'POST').map(([, init]) => JSON.parse(init.body));
  expect(queries).toHaveLength(5);
  for (const q of queries) {
    expect(q.query).toContain(`\`athena-test.billing_export.${TABLE}\``);
    expect(q.query).toContain('project.id = @project');
    expect(q.queryParameters).toEqual(expect.arrayContaining([{ name: 'project', parameterType: { type: 'STRING' }, parameterValue: { value: 'athena-test' } }]));
  }
});

test('lifetime takes the history table for the months it holds, and starts from its first month', async () => {
  global.fetch = bigQuery({ tables: [{ tableReference: { tableId: TABLE } }, { tableReference: { tableId: 'billing_history' } }] });
  const result = await getBilling(new Date('2026-09-27T12:00:00Z'));
  expect(result).toMatchObject({ costAllTime: 40, dataSince: '2025-11-01' });
  const lifetime = global.fetch.mock.calls.map(([, init]) => init.body && JSON.parse(init.body).query).find((q) => q?.includes('billing_history'));
  expect(lifetime).toContain('`athena-test.billing_export.billing_history`');
  expect(lifetime).toContain('NOT IN (SELECT month FROM history)');
});

test('says the export is not switched on yet when the table is missing', async () => {
  global.fetch = bigQuery({ tables: [] });
  expect(await getBilling()).toMatchObject({ configured: false, reason: 'no_export' });
});

test('says the dataset is missing on a 404', async () => {
  global.fetch = bigQuery({ datasetStatus: 404 });
  expect(await getBilling()).toMatchObject({ configured: false, reason: 'no_dataset' });
});

test('uses the Pacific-time invoice month', () => {
  expect(invoiceMonth(new Date('2026-10-01T03:00:00Z'))).toBe('202609');
  expect(invoiceMonth(new Date('2026-10-01T09:00:00Z'))).toBe('202610');
});
