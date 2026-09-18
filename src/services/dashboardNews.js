const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const pool = require('../helpers/db');
const { parseFeed } = require('./memoryStore/news');

function feedUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) throw Object.assign(new Error('Enter a valid HTTPS RSS or Atom feed URL.'), { status: 400 });
  let url;
  try { url = new URL(value); } catch { throw Object.assign(new Error('Enter a valid HTTPS RSS or Atom feed URL.'), { status: 400 }); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || net.isIP(url.hostname) || !url.hostname.includes('.') || /[\[\]]/.test(url.hostname)) {
    throw Object.assign(new Error('Use a public HTTPS feed without credentials or a custom port.'), { status: 400 });
  }
  url.hash = '';
  return url.toString();
}
function publicIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
async function fetchPublicFeed(value) {
  const url = new URL(feedUrl(value));
  const addresses = await dns.lookup(url.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(a => !publicIPv4(a.address))) throw new Error('Feed must resolve to a public address.');
  // Pin the checked address to this connection. No redirect following, cookies,
  // credentials, proxy environment, or second DNS lookup (rebinding).
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      family: 4, lookup: (_host, options, callback) => options.all
        ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, 4),
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', 'User-Agent': 'Athena Dashboard/1.0' },
    }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Use the direct feed URL; this source did not return a feed.')); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) request.destroy(new Error('Feed is too large.')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    const deadline = setTimeout(() => request.destroy(new Error('Feed timed out.')), 10000);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', reject);
  });
}
async function getSources(profileId) {
  const [rows] = await pool.query('SELECT news_sources FROM dashboard_preference WHERE profile_id = ?', [profileId]);
  if (!rows.length) return [];
  const sources = rows[0].news_sources;
  return typeof sources === 'string' ? JSON.parse(sources) : sources;
}
async function saveSources(profileId, values) {
  if (!Array.isArray(values) || values.length > 8) throw Object.assign(new Error('Choose up to eight feed URLs.'), { status: 400 });
  const sources = [...new Set(values.map(feedUrl))];
  await pool.query('INSERT INTO dashboard_preference (profile_id, news_sources) VALUES (?, ?) ON DUPLICATE KEY UPDATE news_sources = VALUES(news_sources)', [profileId, JSON.stringify(sources)]);
  return sources;
}
async function getNews(profileId) {
  const sources = await getSources(profileId);
  const feeds = await Promise.all(sources.map(async url => {
    try {
      const xml = await fetchPublicFeed(url);
      if (!/<(?:rss|feed|rdf:RDF)[\s>]/i.test(xml)) throw new Error('Not a feed');
      const items = parseFeed(xml).slice(0, 8).filter(item => item.title).map(item => {
        let link = null;
        try { link = feedUrl(new URL(item.link, url).toString()); } catch { /* no unsafe links */ }
        const date = new Date(item.published);
        return { title: item.title.slice(0, 300), url: link, published: item.published && Number.isFinite(date.getTime()) ? date.toISOString() : null, source: new URL(url).hostname };
      });
      return { url, status: 'ready', items };
    } catch { return { url, status: 'error', items: [] }; }
  }));
  return { sources, feeds, checkedAt: new Date().toISOString() };
}
module.exports = { getSources, saveSources, getNews, feedUrl, publicIPv4, fetchPublicFeed };
