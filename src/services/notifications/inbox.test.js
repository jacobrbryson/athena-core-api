jest.mock('../../helpers/db', () => ({ query: jest.fn() }));
const pool = require('../../helpers/db');
const inbox = require('./inbox');

beforeEach(() => pool.query.mockReset());

describe('notification inbox', () => {
	test('records a push with its sender id, before and regardless of delivery', async () => {
		pool.query.mockResolvedValue([{ affectedRows: 1 }]);
		const out = await inbox.record(7, { title: 'Athena', body: 'Your 2pm is soon', data: { kind: 'nudge', uuid: 'abc' } });
		expect(out.created).toBe(true);
		const [sql, args] = pool.query.mock.calls[0];
		expect(sql).toMatch(/INSERT IGNORE INTO athena_notification/);
		expect(args[1]).toBe('abc');
		expect(args[2]).toBe(7);
	});

	test('does not keep the test notification', async () => {
		expect(await inbox.record(7, { title: 'Athena', body: 'test', data: { kind: 'test' } })).toBeNull();
		expect(pool.query).not.toHaveBeenCalled();
	});

	test('a database failure never fails the caller', async () => {
		pool.query.mockRejectedValue(new Error('down'));
		await expect(inbox.record(7, { title: 'a', body: 'b' })).resolves.toBeNull();
	});

	test('acknowledging matches our uuid or the sender\'s, scoped to the profile', async () => {
		pool.query.mockResolvedValue([{ affectedRows: 1 }]);
		expect(await inbox.acknowledge(7, 'abc', 'phone')).toBe(1);
		const [sql, args] = pool.query.mock.calls[0];
		expect(sql).toMatch(/profile_id = \? AND acknowledged_at IS NULL AND \(uuid = \? OR source_uuid = \?\)/);
		expect(args).toEqual(['phone', 7, 'abc', 'abc']);
	});

	test('only a safe same-site link survives into the list', async () => {
		const row = (url) => ({ uuid: 'u', kind: 'k', title: 't', body: 'b', data: JSON.stringify({ url }), created_at: 'x', acknowledged_at: null });
		pool.query.mockResolvedValueOnce([[row('//evil.example'), row('/work?run=1')]]).mockResolvedValueOnce([[]]);
		const out = await inbox.list(7);
		expect(out.unacknowledged.map(n => n.url)).toEqual([null, '/work?run=1']);
	});
});
