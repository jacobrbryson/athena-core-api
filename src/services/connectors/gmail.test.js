jest.mock('./http', () => ({ providerGet: jest.fn(), providerRequest: jest.fn() }));
const { providerGet, providerRequest } = require('./http');
const gmail = require('./gmail');
beforeEach(() => jest.resetAllMocks());

test('unreadSummary reads only scoped unread inbox metadata, without mutating mail', async () => {
  providerGet
    .mockResolvedValueOnce({ emailAddress: 'person@example.com' })
    .mockResolvedValueOnce({ messages: [{ id: 'a/b' }] })
    .mockResolvedValueOnce({ payload: { headers: [{ name: 'Subject', value: 'Hello' }, { name: 'From', value: 'Sender' }] } });
  const result = await gmail.unreadSummary(42);
  expect(result.account).toBe('person@example.com');
  expect(result.messages[0].title).toBe('Hello');
  expect(providerGet).toHaveBeenNthCalledWith(2, 42, 'gmail', '/users/me/messages', { query: { q: 'in:inbox is:unread', maxResults: 5, pageToken: undefined } });
  expect(providerGet).toHaveBeenNthCalledWith(3, 42, 'gmail', '/users/me/messages/a%2Fb', { query: { format: 'metadata' } });
  expect(providerRequest).not.toHaveBeenCalled();
});

test('ensureLabel reuses an existing label case-insensitively instead of creating a duplicate', async () => {
  providerGet.mockResolvedValueOnce({ labels: [{ id: 'Label_1', name: 'Receipts', type: 'user' }] });
  const id = await gmail.ensureLabel(42, 'receipts');
  expect(id).toBe('Label_1');
  expect(providerRequest).not.toHaveBeenCalled();
});

test('ensureLabel creates the label when none matches', async () => {
  providerGet.mockResolvedValueOnce({ labels: [] });
  providerRequest.mockResolvedValueOnce({ id: 'Label_new' });
  const id = await gmail.ensureLabel(42, 'Travel');
  expect(id).toBe('Label_new');
  expect(providerRequest).toHaveBeenCalledWith(42, 'gmail', '/users/me/labels', {
    method: 'POST',
    body: { name: 'Travel', labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  });
});

test('fileMessage labels and archives (removes INBOX) in one modify call', async () => {
  providerGet.mockResolvedValueOnce({ labels: [{ id: 'Label_1', name: 'Receipts', type: 'user' }] });
  providerRequest.mockResolvedValueOnce({ id: 'msg1' });
  await gmail.fileMessage(42, 'msg1', 'Receipts');
  expect(providerRequest).toHaveBeenCalledWith(42, 'gmail', '/users/me/messages/msg1/modify', {
    method: 'POST',
    body: { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] },
  });
});

test('a scope-insufficient 403 on a write is re-typed as needs_reauth, not treated as a broken link', async () => {
  providerGet.mockResolvedValueOnce({ labels: [{ id: 'Label_1', name: 'Receipts', type: 'user' }] });
  providerRequest.mockRejectedValueOnce(Object.assign(new Error('insufficient permission'), { status: 403 }));
  await expect(gmail.fileMessage(42, 'msg1', 'Receipts')).rejects.toMatchObject({ code: 'needs_reauth', status: 409 });
});

test('trashMessage calls the trash endpoint, never users.messages.delete', async () => {
  providerRequest.mockResolvedValueOnce({ id: 'msg1', labelIds: ['TRASH'] });
  await gmail.trashMessage(42, 'msg1');
  expect(providerRequest).toHaveBeenCalledWith(42, 'gmail', '/users/me/messages/msg1/trash', { method: 'POST' });
});

test('a scope-insufficient 403 on trash is also re-typed as needs_reauth', async () => {
  providerRequest.mockRejectedValueOnce(Object.assign(new Error('insufficient scope'), { status: 403 }));
  await expect(gmail.trashMessage(42, 'msg1')).rejects.toMatchObject({ code: 'needs_reauth', status: 409 });
});
