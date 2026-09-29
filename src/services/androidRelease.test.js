const release = require('./androidRelease');

const SHA = 'a'.repeat(64);
const manifest = { versionCode: 262721530, versionName: '2026.09.29.1530', object: 'android/Athena-2026.09.29.1530.apk', sha256: SHA, size: 128470920 };

function fakeStorage({ body = JSON.stringify(manifest), missing = false } = {}) {
  const signed = jest.fn(async () => ['https://storage.googleapis.com/signed']);
  const files = {};
  const bucket = jest.fn(() => ({
    file: (name) => (files[name] = files[name] || {
      download: jest.fn(async () => {
        if (missing) throw Object.assign(new Error('No such object'), { code: 404 });
        return [Buffer.from(body)];
      }),
      getSignedUrl: signed,
    }),
  }));
  release._setStorage({ bucket });
  return { bucket, signed, files };
}

test('describes the published release without its storage path', async () => {
  fakeStorage();
  const shown = release.describe(await release.latest());
  expect(shown).toMatchObject({ available: true, versionCode: 262721530, versionName: '2026.09.29.1530', size: 128470920 });
  expect(shown).not.toHaveProperty('object');
});

test('says nothing is available before the first publish', async () => {
  fakeStorage({ missing: true });
  expect(release.describe(await release.latest())).toEqual({ available: false });
  await expect(release.downloadLink()).rejects.toMatchObject({ status: 404 });
});

test('mints a short-lived V4 read link that downloads as an APK', async () => {
  const { signed, files } = fakeStorage();
  const now = Date.parse('2026-09-29T15:30:00Z');
  const link = await release.downloadLink(now);
  expect(link.url).toBe('https://storage.googleapis.com/signed');
  expect(link.expiresAt).toBe(new Date(now + release.LINK_TTL_MS).toISOString());
  expect(files[manifest.object].getSignedUrl).toBe(signed);
  expect(signed).toHaveBeenCalledWith(expect.objectContaining({
    version: 'v4',
    action: 'read',
    expires: now + 15 * 60 * 1000,
    responseType: 'application/vnd.android.package-archive',
    responseDisposition: 'attachment; filename="Athena-2026.09.29.1530.apk"',
  }));
});

test('refuses a manifest that points outside the release folder', () => {
  expect(() => release.parseManifest({ ...manifest, object: 'dreams/secret.png' })).toThrow(/object path/);
  expect(() => release.parseManifest({ ...manifest, object: 'android/../x.apk' })).toThrow(/object path/);
  expect(() => release.parseManifest({ ...manifest, sha256: 'nope' })).toThrow(/sha256/);
  expect(() => release.parseManifest({ ...manifest, versionCode: '5' })).toThrow(/versionCode/);
});

test('caches the manifest for a minute', async () => {
  const { files } = fakeStorage();
  await release.latest();
  await release.latest();
  expect(files['android/latest.json'].download).toHaveBeenCalledTimes(1);
  await release.latest({ fresh: true });
  expect(files['android/latest.json'].download).toHaveBeenCalledTimes(2);
});
