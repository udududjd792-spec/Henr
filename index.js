'use strict';

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const nativeHttp = require('node:http');
const axios = require('axios');
const cheerio = require('cheerio');
const http2 = require('node:http2');
const net = require('node:net');

const HOST = '0.0.0.0';
const DEFAULT_PORT = 28925; // Enzonic primary port shown in the panel.
function getListenPortSource(env = process.env) {
  // Enzonic Deploy sets PORT for the allocated public listener.
  if (env.PORT != null && String(env.PORT).trim() !== '') return 'PORT';
  if (env.SERVER_PORT != null && String(env.SERVER_PORT).trim() !== '') return 'SERVER_PORT';
  if (env.ENZONIC_PORT != null && String(env.ENZONIC_PORT).trim() !== '') return 'ENZONIC_PORT';
  return 'fallback';
}
function getListenConfig(env = process.env) {
  // Use Enzonic's documented PORT first; retain SERVER_PORT for older panel
  // allocations and the visible primary port as a final fallback.
  const rawPort = [env.PORT, env.SERVER_PORT, env.ENZONIC_PORT]
    .find(value => value != null && String(value).trim() !== '') ?? DEFAULT_PORT;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid listen port in ${getListenPortSource(env)}: ${rawPort}`);
  }
  return { host: HOST, port };
}
const { port: PORT } = getListenConfig();

function createAddonServer(addonInterface, config = getListenConfig()) {
  // getRouter() returns an Express Router, not a raw Node request listener.
  // Mount it inside an Express app before attaching the app to Node's HTTP server.
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('ok');
  });
  app.use(getRouter(addonInterface));
  return nativeHttp.createServer(app).listen(config.port, config.host);
}
const TYPE = 'hentai';
const UA = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const CATALOG_TTL = Number(process.env.CACHE_CATALOG_SECONDS || 600) * 1000;
const DETAIL_TTL = Number(process.env.CACHE_DETAIL_SECONDS || 1800) * 1000;
const STREAM_TTL = Number(process.env.CACHE_STREAM_SECONDS || 180) * 1000;
const FRESH_STREAM_TTL = Number(process.env.CACHE_STREAM_SECONDS || 25) * 1000;
const PAGE_SIZE = 20;
const PAGE_LIMIT = 100;
const MINOR_TERMS = /\b(loli(?:con)?|shota(?:con)?|underage|child porn|young girl|young boy)\b/i;
const GENRES = [
  '3D','Anal','Blowjob','Bondage','Boobjob','Cheating','Creampie','Demon','Exclusive','Exhibition',
  'Fantasy','Footjob','Futanari','Gangbang','Harem','Incest','Maid','Masturbation','Monster',
  'Motion Anime','Nurse','Preview','Rape','School','Season','Series','Sex Toy','Swimsuit',
  'Tentacle','Uncensored','Vanilla','Virgin','X-Ray','Yuri',
];
const HSTREAM_GENRES = [
  // Browse > Genres
  'Ahegao','Bestiality','Bondage','Creampie','Gore','Harem','Incest','Lactation','Lq',
  'Mind Break','Mind Control','Orc','Scat','Tentacle','Toys','Tsundere','Virgin','Yuri',
  // Browse > Actions
  'Anal','Bdsm','Facial','Blow Job','Boob Job','Foot Job','Hand Job','Rimjob','Inflation',
  'Masturbation','Public Sex','Rape','Reverse Rape','Threesome','Orgy','Gangbang',
  // Browse > Appearance
  'Milf','Futanari','Big Boobs','Small Boobs','Dark Skin','Cosplay','Elf','Maid','Nekomimi',
  'Nurse','School Girl','Succubus','Teacher','Trap','Pregnant','Glasses','Swim Suit',
  'Ugly Bastard','Monster',
  // Browse > Types
  '3D','4K','48Fps','4K 48Fps','Censored','Uncensored','Comedy','Fantasy','Horror','Vanilla',
  'Ntr','Pov','Filmed','X-Ray',
];
const PROVIDER_GENRES = {
  hentaigasm: GENRES,
  hstream: HSTREAM_GENRES,
  rule34video: ['New', 'Most Viewed', 'Top Rated', 'Longest', 'Random'],
  hentaimama: [
    '3D','Action','Adventure','Ahegao','Anal','Animal Girls','Armpit fetish','BDSM','Blackmail','Blonde',
    'Blowjob','Bondage','Brainwashed','Bunny Girl','Cat Girl','Comedy','Condom','Cosplay','Creampie',
    'Cross-dressing','Cunnilingus','Cute & Funny','Dark Skin','DeepThroat','Demi-Human','Demons','Doctor',
    'Domination','Double Penetration','Drama','Dubbed','Ecchi','Elf','Facesitting','Facial','Family','Fantasy',
    'Female Doctor','Female Teacher','Femdom','Filmed','Fisting','Footjob','Furry','Futanari','Gangbang',
    'Gyaru','Hand Job','Harem','Historical','Horny Slut','Horror','Housewife','Humiliation','Incest',
    'Inflation','Internal Cumshot','Kiss','Lactation','Large Breasts','Magical Girls','Maid','Martial Arts',
    'Masturbation','Megane','MILF','Mind Break','Molestation','Monsters','Nekomimi','Nipple Fuck',
    'Non-Japanese','NTR','Nuns','Nurses','Office Ladies','Orc/Goblin','Orgy','Piercing','Police','POV',
    'Pregnant','Princess','Public Sex','Rape','Rim job','Romance','Scat','School Girls','Sci-Fi',
    'Sci-Fi & Fantasy','Shimapan','Short','Shoutacon','Sleeping','Small Breasts','Sports','Squirting',
    'Stand Sex','Step Daughter','Step Mother','Step Sister','Stocking','Strap-on','Succubus','Super Power',
    'Supernatural','Swimsuit','Tentacles','Three some','Tits Fuck','Toys','Train Molestation','Trap',
    'Tsundere','Ugly Bastard','Uncensored','Urination','Vampire','Vanilla','Virgins','Watersports',
    'Widow','Womb Tattoo','X-Ray','Yuri',
  ],
};

const http = axios.create({
  timeout: Number(process.env.HTTP_TIMEOUT_MS || 15000),
  maxRedirects: 5,
  headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  validateStatus: status => status >= 200 && status < 400,
});

const cache = new Map();
async function cached(key, ttl, fn) {
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && entry.expires > now) return entry.value;

  // Store the in-flight promise immediately so simultaneous catalog, genre,
  // poster and metadata requests share the same upstream fetch.
  const pending = Promise.resolve().then(fn);
  cache.set(key, { value: pending, expires: now + Math.max(ttl, 30000) });
  try {
    const value = await pending;
    cache.set(key, { value, expires: Date.now() + ttl });
    if (cache.size > 1500) {
      for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k);
      while (cache.size > 1500) cache.delete(cache.keys().next().value);
    }
    return value;
  } catch (error) {
    if (cache.get(key)?.value === pending) cache.delete(key);
    throw error;
  }
}

const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
const stripHtml = v => clean(String(v || '').replace(/<[^>]*>/g, ' '));
const slugify = v => clean(v).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const encodeKey = v => Buffer.from(String(v), 'utf8').toString('base64url');
const decodeKey = v => Buffer.from(String(v), 'base64url').toString('utf8');

function canonicalHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}
function sameProviderHost(url, base) {
  try {
    const a = new URL(url);
    const b = new URL(base);
    return canonicalHost(a.hostname) === canonicalHost(b.hostname);
  } catch { return false; }
}
function absUrl(value, base) {
  try {
    if (!value) return '';
    const u = new URL(String(value).replace(/&amp;/g, '&'), base);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : '';
  } catch { return ''; }
}
function canonicalContentUrl(providerId, value, base) {
  const resolved = absUrl(value, base);
  if (!resolved) return '';
  try {
    const u = new URL(resolved);
    u.hash = '';
    // Normalize www/non-www aliases into a single catalog ID per provider.
    if (base && providerId !== 'hentaigasm') {
      try { const b = new URL(base); if (canonicalHost(u.hostname) === canonicalHost(b.hostname)) u.hostname = b.hostname; } catch {}
    }
    if (providerId === 'hentaimama' || providerId === 'hstream') u.search = '';
    u.pathname = u.pathname.replace(/\/{2,}/g, '/');
    if (providerId === 'hstream') {
      // HStream episode URLs are slug endpoints without a required trailing slash.
      u.pathname = u.pathname.replace(/\/+$/, '');
      return u.href;
    }
    if (!/\.[a-z0-9]{2,5}$/i.test(u.pathname) && u.pathname !== '/') u.pathname = `${u.pathname.replace(/\/+$/, '')}/`;
    return u.href;
  } catch { return resolved; }
}
function normalizedTextKey(value) {
  return clean(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function matchesCatalogSearch(item, query) {
  const q = normalizedTextKey(query);
  if (!q) return true;
  const title = normalizedTextKey(item?.name || '');
  if (!title) return false;
  if (title.includes(q)) return true;
  const tokens = q.split(' ').filter(Boolean);
  return tokens.length > 0 && tokens.every(token => title.includes(token));
}
function titleFromUrl(value, providerId) {
  try {
    const u = new URL(value);
    let parts = u.pathname.split('/').filter(Boolean);
    let slug = parts[parts.length - 1] || '';
    if (providerId === 'hstream' && /^\d+$/.test(slug) && parts.length > 1) slug = parts[parts.length - 2] || slug;
    slug = slug.replace(/\.(?:html?|php)$/i, '');
    if (providerId === 'hentaimama') slug = slug.replace(/-episode-?\d+.*$/i, '');
    slug = decodeURIComponent(slug).replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
    return slug ? slug.replace(/\b\w/g, c => c.toUpperCase()) : '';
  } catch { return ''; }
}
function cleanVideoTitle(value) {
  return clean(value)
    .replace(/^(?:HD\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*/i, '')
    .replace(/\b\d+(?:[.,]\d+)?\s*[kKmM]?\s*views?\b/gi, '')
    .replace(/\b\d{1,3}%(?=\s|$)/g, '')
    .replace(/^[\s|·•–—-]+|[\s|·•–—-]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function titleFromEpisodeUrl(value) {
  try {
    const u = new URL(value);
    let slug = u.pathname.split('/').filter(Boolean).pop() || '';
    slug = slug.replace(/\.(?:html?|php)$/i, '');
    try { slug = decodeURIComponent(slug); } catch {}
    return clean(slug.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ')).replace(/\b\w/g, c => c.toUpperCase());
  } catch { return ''; }
}

function blocked(item) {
  return MINOR_TERMS.test([item.name, item.description, ...(item.genres || [])].join(' '));
}
function isNoise(url) {
  // Content-link/player filter: image assets are not catalog entries or media streams.
  return /\.(?:jpe?g|png|gif|webp|svg|css|js|ico|woff2?)(?:[?#]|$)|wp-json|wp-content|gravatar|schema\.org/i.test(url || '');
}
function isPosterNoise(url) {
  // Poster filter must allow real image extensions (jpg/png/webp); only reject
  // non-image assets and known tracking/schema endpoints here.
  return /\.(?:css|js|ico|woff2?)(?:[?#]|$)|wp-json|schema\.org/i.test(url || '');
}
async function getHtml(url, referer, timeout = undefined) {
  const requestTimeout = Number(timeout || process.env.HTTP_TIMEOUT_MS || 15000);
  return cached(`html:${url}|ref:${referer || ''}|timeout:${requestTimeout}`, CATALOG_TTL, async () => {
    const response = await http.get(url, { headers: referer ? { Referer: referer } : {}, responseType: 'text', timeout: requestTimeout });
    return String(response.data || '');
  });
}
async function getHtmlFresh(url, referer, extraHeaders = {}, timeout = undefined) {
  const headers = { ...extraHeaders };
  if (referer) headers.Referer = referer;
  const response = await http.get(url, { headers, responseType: 'text', timeout: Number(timeout || process.env.HTTP_TIMEOUT_MS || 15000) });
  return String(response.data || '');
}
function metaText($, selectors) {
  for (const selector of selectors) {
    const n = $(selector).first();
    const value = clean(n.attr('content') || n.text());
    if (value) return value;
  }
  return '';
}
function cardPoster($, $card, $a, base) {
  const candidates = [];
  const seen = new Set();
  const add = value => {
    const raw = clean(value);
    if (!raw || /^(?:data:|blob:|javascript:|about:)/i.test(raw)) return;
    const resolved = absUrl(raw, base);
    if (!resolved || seen.has(resolved)) return;
    let parsed;
    try { parsed = new URL(resolved); } catch { return; }
    if (isPosterNoise(resolved) || /\.(?:mp4|m4v|webm|m3u8|mpd)(?:$|[?#])/i.test(parsed.pathname + parsed.search)) return;
    if (/(?:placeholder|no[-_]?image|blank\.|spacer\.|loading|default[-_]?thumb|avatar|logo|sprite)/i.test(parsed.pathname)) return;
    seen.add(resolved);
    candidates.push(resolved);
  };
  const parseSrcset = value => {
    const entries = [];
    for (const part of String(value || '').split(',')) {
      const bits = clean(part).split(/\s+/);
      if (!bits[0]) continue;
      const descriptor = bits[1] || '';
      const width = descriptor.endsWith('w') ? Number.parseInt(descriptor, 10)
        : descriptor.endsWith('x') ? Math.round(Number.parseFloat(descriptor) * 480) : 0;
      entries.push({ url: bits[0], width });
    }
    entries.sort((a, b) => {
      const score = w => w >= 320 && w <= 640 ? 0 : w > 640 ? 1 : 2;
      const ar = score(a.width), br = score(b.width);
      if (ar !== br) return ar - br;
      if (ar === 0) return Math.abs(a.width - 480) - Math.abs(b.width - 480);
      return ar === 1 ? a.width - b.width : b.width - a.width;
    });
    return entries.map(x => x.url);
  };

  const images = $card.find('img').toArray();
  if (!images.length && $a && $a.length) images.push(...$a.find('img').toArray());
  for (const el of images) {
    const $img = $(el);
    // Read uncommon lazy-load attributes too. Site themes frequently rename
    // these between releases; restrict to image-related attribute names so
    // unrelated metadata does not become a poster URL.
    for (const [key, value] of Object.entries(el.attribs || {})) {
      if (/(?:srcset|src|image|poster|thumb|background)/i.test(key)) {
        if (/srcset/i.test(key)) for (const candidate of parseSrcset(value)) add(candidate);
        else add(value);
      }
    }
    const hentaigasm = /hentaigasm/i.test(String(base || ''));
    if (hentaigasm) {
      // Preserve Hentaigasm's previous source ordering unchanged.
      for (const key of ['data-srcset','data-lazy-srcset','srcset']) {
        const value = $img.attr(key);
        if (value) for (const candidate of parseSrcset(value)) add(candidate);
      }
      for (const key of [
        'data-rd-jpg','data-rd-src','data-original','data-lazy-src','data-src','data-original-src','data-image',
        'data-thumb','data-poster','data-cfsrc','data-url','src',
      ]) add($img.attr(key));
    } else {
      // HentaiMama uses lazy image attributes; `src`/`srcset` may only be a
      // transparent placeholder. Prefer the actual image URL first.
      for (const key of [
        'data-rd-jpg','data-rd-src','data-original','data-lazy-src','data-src','data-original-src','data-image',
        'data-thumb','data-poster','data-cfsrc','data-url','data-lazy','data-lazyload','data-echo',
      ]) add($img.attr(key));
      for (const key of ['data-srcset','data-lazy-srcset','srcset']) {
        const value = $img.attr(key);
        if (value) for (const candidate of parseSrcset(value)) add(candidate);
      }
      add($img.attr('src'));
    }
  }

  // Some templates keep poster URLs on a wrapper instead of an <img>.
  const wrappers = [$card, $a].filter(node => node && node.length);
  for (const $node of wrappers) {
    for (const key of ['data-bg','data-background','data-thumb','data-poster','data-src']) add($node.attr(key));
    const style = $node.attr('style') || '';
    const matches = style.matchAll(/url\((?:\s*["']?)([^"')]+)(?:["']?\s*)\)/gi);
    for (const match of matches) add(match[1]);
    $node.find('[style*="background"],[data-bg],[data-background],[data-thumb],[data-poster]').each((_, el) => {
      const $child = $(el);
      for (const key of ['data-bg','data-background','data-thumb','data-poster']) add($child.attr(key));
      const childStyle = $child.attr('style') || '';
      for (const match of childStyle.matchAll(/url\((?:\s*["']?)([^"')]+)(?:["']?\s*)\)/gi)) add(match[1]);
    });
  }
  const $source = $card.find('source[srcset],source[src],video[poster]').first();
  if ($source.length) {
    for (const key of ['data-src','src','poster']) add($source.attr(key));
    for (const key of ['srcset','data-srcset']) {
      const value = $source.attr(key);
      if (value) for (const candidate of parseSrcset(value)) add(candidate);
    }
  }
  return candidates[0] || '';
}

function parseStructuredCards($, base) {
  const out = [];
  const seen = new Set();
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try { data = JSON.parse($(el).contents().text() || $(el).text()); } catch { return; }
    const walk = value => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      const type = Array.isArray(value['@type']) ? value['@type'].join(' ') : String(value['@type'] || '');
      if (/VideoObject|Movie|TVEpisode|CreativeWork/i.test(type)) {
        const rawUrl = value.url || value['@id'] || value.embedUrl;
        const key = absUrl(typeof rawUrl === 'object' ? (rawUrl.url || rawUrl['@id']) : rawUrl, base);
        const imageValue = Array.isArray(value.image) ? value.image[0] : (value.image || value.thumbnailUrl || value.thumbnail || value.poster);
        const poster = absUrl(typeof imageValue === 'object' ? (imageValue.url || imageValue.contentUrl || imageValue['@id']) : imageValue, base);
        const name = clean(value.name || value.headline);
        const item = { key, name, poster, genres: Array.isArray(value.genre) ? value.genre.map(clean) : value.genre ? [clean(value.genre)] : [], description: clean(value.description) };
        if (key && name && poster && !seen.has(key) && !blocked(item) && !isNoise(key)) {
          try {
            if (sameProviderHost(key, base)) {
              seen.add(key); out.push(item);
            }
          } catch {}
        }
      }
      for (const [key, child] of Object.entries(value)) if (key !== '@context') walk(child);
    };
    walk(data);
  });
  return out;
}

function parseCards(html, base) {
  const $ = cheerio.load(html);
  const out = parseStructuredCards($, base);
  const seen = new Set(out.map(item => item.key));
  const selectors = ['article a[href]', '.video-item a[href]', '.video-card a[href]', '[class*="video-card"] a[href]', '[class*="video-item"] a[href]', '.movie-item a[href]', '[class*="movie-item"] a[href]', '.video a[href]', '.item a[href]', '.thumb a[href]', '.thumb-block a[href]', '.post a[href]', '.result-item a[href]', '.animposx a[href]', '.bs a[href]', '.entry a[href]', '.grid-item a[href]', '.movie a[href]', 'li a[href]', 'a[href]'];
  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const $a = $(el);
      const href = absUrl($a.attr('href'), base);
      if (!href || seen.has(href) || isNoise(href)) return;
      let parsed;
      try { parsed = new URL(href); } catch { return; }
      if (!sameProviderHost(href, base)) return;
      if (/\/(?:page|genre|genres|category|tag|author|search|login|register|contact|about)(?:\/|$)/i.test(parsed.pathname)) return;
      const $closest = $a.closest('article,.video-item,.video-card,[class*=\"video-card\"],[class*=\"video-item\"],.movie-item,[class*=\"movie-item\"],.video,.item,.thumb,.thumb-block,.post,.result-item,.animposx,.bs,.entry,.grid-item,.movie,li,figure');
      const $card = $closest.length ? $closest : tightCard($, $a, base);
      const poster = cardPoster($, $card, $a, base);
      if (!poster) return;
      const name = clean($card.find('.title,.tt,.entry-title,.video-title,.name,h2,h3,h4').first().text()) || clean($a.attr('title')) || clean($a.find('img').first().attr('alt')) || clean($a.text());
      if (!name || name.length < 2 || /^(watch|play|view|more|next|previous)$/i.test(name)) return;
      const genres = $card.find('.genre a,.genres a,.sgeneros a,a[rel="tag"],.tags a,a[href*="/genre/"],a[href*="/tag/"]').map((__, tag) => clean($(tag).text())).get().filter(Boolean).slice(0, 16);
      const description = clean($card.find('.description,.excerpt,.summary').first().text());
      const item = { key: href, name, poster, genres, description };
      if (blocked(item)) return;
      seen.add(href);
      out.push(item);
    });
    if (out.length >= PAGE_LIMIT) break;
  }
  return out;
}
function pagePath(base, path, page) {
  const root = base.replace(/\/$/, '');
  const p = path || '/';
  if (page <= 1) return `${root}${p.startsWith('/') ? p : `/${p}`}`;
  const route = `${root}${p.startsWith('/') ? p : `/${p}`}`;
  if (/\.html?$/i.test(route)) return route.replace(/\.html?$/i, '') + `-${page}.html`;
  return `${route}${p.endsWith('/') ? '' : '/'}page/${page}/`;
}
function genreSlug(config, genre) {
  const raw = clean(genre).toLowerCase();
  const aliases = {
    'big breasts': 'large-breasts', 'dark skin': 'dark-skin', 'monster': 'monsters',
    'deep throat': 'deepthroat', 'internal cumshot': 'internal-cumshot',
    'netorare': 'ntr', 'office lady': 'office-ladies', 'school': 'school-girls',
    'tentacle': 'tentacles', 'threesome': 'three-some', 'virgin': 'virgins',
    'succubus': 'succubus', 'maid': 'maid', 'sci-fi': 'sci-fi',
  };
  return config.id === 'hentaimama' ? (aliases[raw] || slugify(genre)) : slugify(genre);
}

function candidatePagesEnhanced(config, { search, genre, page = 1, mode = '' }) {
  const base = config.base.replace(/\/$/, '');
  const n = Math.max(1, Number(page) || 1);
  const q = encodeURIComponent(clean(search));
  const g = genreSlug(config, genre);



  if (search) {
    return [...new Set([
      `${base}/?s=${q}${n > 1 ? `&paged=${n}` : ''}`,
      `${base}/?search=${q}${n > 1 ? `&page=${n}` : ''}`,
      `${base}/?title=${q}${n > 1 ? `&paged=${n}` : ''}`,
      `${base}/search/${q.replace(/%20/g, '+')}/${n > 1 ? `page/${n}/` : ''}`,
      ...(config.searchPaths || []).map(path => `${base}${path.replace('{q}', q).replace('{page}', n)}`),
    ])];
  }
  if (genre) {
    // HentaiMama's 3D archive is /genre/3d/, not /3d/. Uncensored is a top-level archive.
    const paths = config.id === 'hentaimama' && g === 'uncensored'
      ? ['/uncensored/']
      : (config.genrePaths || ['/genre/{g}/', '/tag/{g}/', '/category/{g}/']);
    return [...new Set(paths.flatMap(path => {
      const route = `${base}${path.replace('{g}', g)}`;
      if (n === 1) return [route];
      if (/\.html?$/i.test(route)) return [route.replace(/\.html?$/i, '') + `-${n}.html`, `${route}?page=${n}`];
      return [pagePath(base, path.replace('{g}', g), n), `${route}?page=${n}`, `${route}?paged=${n}`];
    }))];
  }
  // HentaiMama's current Latest feed is a series catalogue (with real
  // cover artwork), not the /recent-episodes/ feed whose cards use episode
  // preview frames. Keep the normal All Genres/list route untouched.
  if (config.id === 'hentaimama' && mode === 'new') {
    return [n === 1
      ? `${base}/hentai-series/?filter=recent`
      : `${base}/hentai-series/page/${n}/?filter=recent`];
  }
  const listPaths = mode === 'new' && config.newPaths?.length ? config.newPaths : (config.listPaths || ['/']);
  return [...new Set(listPaths.flatMap(path => {
    const route = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    if (n === 1) return [route];
    if (/\.html?$/i.test(route)) return [route.replace(/\.html?$/i, '') + `-${n}.html`, `${route}?page=${n}`, `${route}?paged=${n}`];
    return [pagePath(base, path, n), `${route}?page=${n}`, `${route}?paged=${n}`];
  }))];
}
function candidatePagesLegacy(config, { search, genre, page }) {
  const base = config.base.replace(/\/$/, '');
  if (search) {
    const q = encodeURIComponent(search);
    return [...new Set([
      `${base}/?s=${q}${page > 1 ? `&paged=${page}` : ''}`,
      `${base}/?search=${q}${page > 1 ? `&page=${page}` : ''}`,
      `${base}/?title=${q}${page > 1 ? `&paged=${page}` : ''}`,
      `${base}/search/${q.replace(/%20/g, '+')}/${page > 1 ? `page/${page}/` : ''}`,
      ...(config.searchPaths || []).map(path => `${base}${path.replace('{q}', q).replace('{page}', page)}`),
    ])];
  }
  if (genre) {
    const g = slugify(genre);
    return [...new Set((config.genrePaths || ['/genre/{g}/', '/tag/{g}/', '/category/{g}/']).flatMap(path => {
      const route = `${base}${path.replace('{g}', g)}`;
      return page > 1 ? [pagePath(base, path.replace('{g}', g), page), `${route}${route.includes('?') ? '&' : '?'}page=${page}`, `${route}${route.includes('?') ? '&' : '?'}paged=${page}`] : [route];
    }))];
  }
  return [...new Set((config.listPaths || ['/']).flatMap(path => {
    const route = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    if (page <= 1) return [route];
    const queryPath = `${route}${route.includes('?') ? '&' : '?'}page=${page}`;
    const pagedPath = `${route}${route.includes('?') ? '&' : '?'}paged=${page}`;
    return [pagePath(base, path, page), queryPath, pagedPath];
  }))];
}
function candidatePages(config, args = {}) {
  // Preserve Hentaigasm's existing search/genre/list routing. Its New option
  // uses the site's dedicated New Hentai Release archive.
  if (config.id === 'hentaigasm') {
    if (args.mode === 'new' && !args.search && !args.genre) {
      const path = (config.newPaths || ['/hentai/new-hentai-release/'])[0];
      const route = `${config.base.replace(/\/$/, '')}${path}`;
      return routePageCandidates(route, Math.max(1, Number(args.page) || 1));
    }
    return candidatePagesLegacy(config, args);
  }
  if (config.id === 'hstream') {
    const base = config.base.replace(/\/$/, '');
    const n = Math.max(1, Number(args.page) || 1);
    const search = clean(args.search);
    const genre = clean(args.genre);
    // HStream's own search form sends selected tags as tags[0], with order
    // and page parameters. Do not guess /genre/<slug>/ routes (they do not exist).
    if (search || (genre && normalizedTextKey(genre) !== 'new')) {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      params.set('page', String(n));
      params.set('order', 'recently-uploaded');
      if (genre && normalizedTextKey(genre) !== 'new') params.set('tags[0]', genre);
      return [`${base}/search?${params.toString()}`];
    }
    if (n > 1) return [`${base}/search?order=recently-uploaded&page=${n}`];
    return [`${base}/`];
  }
  if (config.id === 'rule34video') {
    const base = config.base.replace(/\/$/, '');
    const n = Math.max(1, Number(args.page) || 1);
    if (args.search) {
      const route = `${base}/search/${slugify(args.search)}/`;
      return [n > 1 ? `${route}?from_videos=${n}` : route];
    }
    const sortMap = { 'most viewed': 'video_viewed', 'top rated': 'rating', longest: 'duration', random: 'pseudo_rand' };
    const sort = sortMap[normalizedTextKey(args.genre)] || '';
    if (sort) return [`${base}/search/?sort_by=${encodeURIComponent(sort)}${n > 1 ? `&from_videos=${n}` : ''}`];
    return [`${base}/latest-updates/${n}/`];
  }
  return candidatePagesEnhanced(config, args);
}

async function discoverGenreRoute(config, genre) {
  const wanted = normalizedTextKey(genre);
  if (!wanted) return '';
  return cached(`genre-route-map:${config.id}`, config.id === 'hentaimama' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000, async () => {
    const sourcePages = config.id === 'hentaimama'
      ? [`${config.base.replace(/\/$/, '')}/genres-filter/`, config.base]
      : [config.base];
    const map = {};
    for (const pageUrl of sourcePages) {
      try {
        const html = await getHtml(pageUrl, config.base, config.timeout);
        const $ = cheerio.load(html);
        $('a[href]').each((_, el) => {
          const $a = $(el);
          const rawLabel = clean($a.text() || $a.attr('title') || $a.attr('aria-label'));
          const label = normalizedTextKey(rawLabel);
          if (!label || map[label]) return;
          const href = absUrl($a.attr('href'), pageUrl);
          if (!href || !sameProviderHost(href, config.base)) return;
          let path = '';
          try { path = new URL(href).pathname; } catch { return; }
          const validTaxonomyPath = /^\/(?:genre|tag|category)\/[^/]+\/?$/i.test(path);
          if (!validTaxonomyPath) return;
          map[label] = href;
        });
        if (Object.keys(map).length) break;
      } catch { /* Try the provider's other public taxonomy page. */ }
    }
    return map;
  }).then(map => map[wanted] || '');
}
function routePageCandidates(route, page = 1) {
  const cleanRoute = String(route || '').split('#')[0];
  if (page <= 1) return [cleanRoute];
  try {
    const u = new URL(cleanRoute);
    const path = u.pathname.replace(/\/+$/, '');
    if (/\.html?$/i.test(path)) return [`${u.origin}${path.replace(/\.html?$/i, '')}-${page}.html`, `${cleanRoute}?page=${page}`];
    return [`${u.origin}${path}/page/${page}/`, `${cleanRoute}?page=${page}`, `${cleanRoute}?paged=${page}`];
  } catch { return [cleanRoute]; }
}

function tightCard($, $a, base) {
  const itemLinks = 'a[href]';
  let node = $a.parent();
  for (let depth = 0; depth < 6 && node.length; depth++, node = node.parent()) {
    const hasPoster = node.find('img[src],img[data-src],img[data-original],img[data-lazy-src],img[data-rd-jpg],img[data-rd-src],img[srcset],[style*="background-image"]').length > 0;
    const count = node.find(itemLinks).length;
    const classes = `${node.attr('class') || ''} ${node.attr('id') || ''}`;
    const looksLikeItem = /(?:^|[\s_-])(?:video-item|video-card|video-thumb|thumb-block|thumb|movie-item|item|post|entry|bs|bsx|card)(?:$|[\s_-])/i.test(classes) || node.is('article,li');
    if (hasPoster && count > 0 && count <= 3 && (looksLikeItem || depth >= 1)) return node;
  }
  return $a.parent().length ? $a.parent() : $a;
}
function parseHentaiMamaGenreCards(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  const seenKeys = new Set();
  const seenTitles = new Set();
  $('a[href]').each((_, el) => {
    const $a = $(el);
    const raw = absUrl($a.attr('href'), base);
    if (!raw || !sameProviderHost(raw, base)) return;
    let parsed;
    try { parsed = new URL(raw); } catch { return; }
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    if (path === '/' || /^\/(?:episodes?|genre|genres|tag|category|recent-episodes|list|uncensored|login|register|wp-admin|wp-content|wp-json)(?:\/|$)/i.test(path)) return;
    const key = canonicalContentUrl('hentaimama', raw, base);
    if (!key || seenKeys.has(key)) return;
    const $card = $a.closest('article,.bs,.bsx,.item,.video-item,.video-card,.thumb,.thumb-block,.post,[class*="item"],[class*="series"],li');
    const $box = $card.length ? $card : tightCard($, $a, base);
    const poster = cardPoster($, $box, $a, base);
    if (!poster) return;
    const candidates = [
      clean($box.find('.tt,.title,.entry-title,.name,h2,h3,h4,[class*="title"]').first().text()),
      clean($a.attr('title') || $a.attr('aria-label')),
      clean($a.find('img').first().attr('alt')),
      clean($a.text()),
      titleFromUrl(key, 'hentaimama'),
    ];
    let name = candidates.find(v => v && v.length > 2 && !/^(image|thumbnail|watch|play|view)$/i.test(v)) || '';
    name = clean(name.replace(/\s+(?:episode|ep)\s*#?\d+.*$/i, ''));
    const titleKey = normalizedTextKey(name);
    const posterKey = String(poster).split('?')[0].replace(/^https?:\/\/(?:www\.)?/i, '').toLowerCase();
    const dedupe = `${titleKey}|${posterKey}`;
    if (!name || blocked({ name }) || seenTitles.has(dedupe)) return;
    seenKeys.add(key); seenTitles.add(dedupe);
    out.push({ key, name, poster, genres: [...new Set($box.find('.genre a,.genres a,.tags a,a[rel="tag"]').map((__, tag) => clean($(tag).text())).get().filter(Boolean))].slice(0, 16), description: clean($box.find('.description,.excerpt,.summary').first().text()) });
    if (out.length >= PAGE_LIMIT) return false;
  });
  return out;
}
function hentaiMamaSeriesPoster($, $card, $link, base) {
  const $img = $link.find('img').first();
  const candidates = [];
  const add = value => {
    const raw = clean(value);
    if (!raw || /^(?:data:|blob:|javascript:|about:)/i.test(raw)) return;
    const url = absUrl(raw, base);
    if (!url || isPosterNoise(url)) return;
    let parsed;
    try { parsed = new URL(url); } catch { return; }
    if (/\.(?:mp4|m4v|webm|m3u8|mpd)(?:$|[?#])/i.test(parsed.pathname + parsed.search)) return;
    if (/(?:placeholder|no[-_]?image|blank\.|spacer\.|loading|default[-_]?thumb|avatar|logo|sprite)/i.test(parsed.pathname)) return;
    if (!candidates.includes(url)) candidates.push(url);
  };
  if ($img.length) {
    // The current HentaiMama series cards expose their actual cover in the
    // lazy-load fields. Prefer those over src, which can be a tiny placeholder.
    for (const key of ['data-original', 'data-src', 'data-lazy-src', 'data-image', 'data-thumb', 'data-poster', 'src']) {
      add($img.attr(key));
    }
    const srcsets = ['data-srcset', 'data-lazy-srcset', 'srcset'];
    for (const key of srcsets) {
      const value = $img.attr(key);
      if (!value) continue;
      const entries = String(value).split(',').map(part => {
        const bits = clean(part).split(/\s+/);
        const descriptor = bits[1] || '';
        const width = descriptor.endsWith('w') ? Number.parseInt(descriptor, 10)
          : descriptor.endsWith('x') ? Math.round(Number.parseFloat(descriptor) * 480) : 0;
        return { url: bits[0], width };
      }).filter(entry => entry.url).sort((a, b) => b.width - a.width);
      for (const entry of entries) add(entry.url);
    }
  }
  // A few theme variants put the cover on the anchor/card instead of the img.
  for (const $node of [$link, $card]) {
    for (const key of ['data-poster', 'data-thumb', 'data-src', 'data-bg', 'data-background']) add($node.attr(key));
    const style = $node.attr('style') || '';
    for (const match of style.matchAll(/url\((?:\s*["']?)([^"')]+)(?:["']?\s*)\)/gi)) add(match[1]);
  }
  return candidates[0] || '';
}

function parseHentaiMamaSeriesCards(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('article.series-card').each((_, el) => {
    const $card = $(el);
    const $link = $card.find('a.sc-poster[href]').first();
    const $titleLink = $card.find('h3.sc-title a[href]').first();
    const rawKey = $link.attr('href') || $titleLink.attr('href');
    const raw = absUrl(rawKey, base);
    if (!raw || !sameProviderHost(raw, base)) return;
    const key = canonicalContentUrl('hentaimama', raw, base);
    if (!key || seen.has(key)) return;

    const name = clean($card.find('h3.sc-title a').first().text())
      || clean($card.find('h3.sc-title').first().text())
      || clean($titleLink.attr('title'))
      || clean($link.attr('title'))
      || clean($link.find('img').first().attr('alt'))
      || titleFromUrl(key, 'hentaimama');
    const poster = hentaiMamaSeriesPoster($, $card, $link, base)
      || cardPoster($, $card, $link, base);
    if (!name || !poster || blocked({ name })) return;

    const genres = [...new Set($card.find('.sc-genres a,.dsc-genres a,.genre a,.genres a,[rel="tag"]')
      .map((__, tag) => clean($(tag).text())).get().filter(Boolean))].slice(0, 16);
    const description = clean($card.find('.sc-description,.sc-desc,.description,.excerpt').first().text());
    const item = { key, name, poster, genres, description };
    if (blocked(item)) return;
    seen.add(key);
    out.push(item);
    if (out.length >= PAGE_LIMIT) return false;
  });
  return out;
}

function parseHentaiMamaRecentEpisodeCards(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a[href*="/episodes/"]').each((_, el) => {
    const $a = $(el);
    const raw = absUrl($a.attr('href'), base);
    if (!raw || !sameProviderHost(raw, base)) return;
    let parsed; try { parsed = new URL(raw); } catch { return; }
    if (!/^\/episodes\/[^/]+\/?$/i.test(parsed.pathname)) return;
    const key = canonicalContentUrl('hentaimama', raw, base);
    if (!key || seen.has(key)) return;
    const $card = $a.closest('article,.bs,.bsx,.item,.video-item,.video-card,.thumb,.thumb-block,.post,[class*="item"],li');
    const $box = $card.length ? $card : tightCard($, $a, base);
    const poster = cardPoster($, $box, $a, base);
    if (!poster) return;
    const urlTitle = titleFromEpisodeUrl(key);
    const candidates = [
      clean($a.attr('title') || $a.attr('aria-label')),
      clean($a.text()),
      clean($box.find('img').first().attr('alt')),
      clean($box.find('.episode-title,.tt,.title,.entry-title,.name,h2,h3,h4,[class*="title"]').first().text()),
      urlTitle,
    ].map(cleanVideoTitle).filter(v => v && v.length > 2 && !/^(image|thumbnail|watch|play|view)$/i.test(v));
    const name = candidates.find(v => /\b(?:episode|ep)\s*#?\d+\b/i.test(v)) || urlTitle || candidates[0] || '';
    if (!name || blocked({ name })) return;
    seen.add(key);
    out.push({ key, name, poster, genres: [], description: clean($box.find('.description,.excerpt,.summary').first().text()) });
    if (out.length >= PAGE_LIMIT) return false;
  });
  return out;
}

function parseRule34VideoCards(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('div.item.thumb a.th[href*="/video/"], a.th[href*="/video/"], a[href*="/video/"]').each((_, el) => {
    const $a = $(el);
    const href = absUrl($a.attr('href'), base);
    if (!href || !sameProviderHost(href, base)) return;
    let parsed;
    try { parsed = new URL(href); } catch { return; }
    if (!/^\/video(?:s)?\/\d+(?:\/[^/]*)?\/?$/i.test(parsed.pathname)) return;
    const key = canonicalContentUrl('rule34video', href, base);
    if (!key || seen.has(key)) return;
    const $closest = $a.closest('div.item.thumb,article,.video-item,.video-card,.item,.thumb,.post,li');
    const $card = $closest.length ? $closest : tightCard($, $a, base);
    const poster = cardPoster($, $card, $a, base);
    if (!poster) return;
    const title = clean($a.attr('title'))
      || clean($a.find('.thumb_title').first().text())
      || clean($card.find('.thumb_title,.title,.video-title,h2,h3,h4').first().text())
      || clean($a.find('img').first().attr('alt'))
      || titleFromUrl(key, 'rule34video');
    const name = cleanVideoTitle(title);
    if (!name || blocked({ name })) return;
    const genres = [...new Set($card.find('a[href*="/tags/"],a[href*="/categories/"]').map((__, tag) => clean($(tag).text())).get().filter(Boolean))].slice(0, 20);
    const item = { key, name, poster, genres, description: clean($card.find('.description,.excerpt,.summary').first().text()) };
    if (blocked(item)) return;
    seen.add(key);
    out.push(item);
    if (out.length >= PAGE_LIMIT) return false;
  });
  return out;
}

function cleanHStreamTitle(value) {
  return clean(value)
    .replace(/^(?:(?:4k|2160p|1080p|720p|fhd\s*\d+fps|4k\s*\d+fps)\s*(?:\|\s*)?)+/i, '')
    .replace(/\s+\d+(?:[.,]\d+)?\s*[kKmM]\s+\d+\s+\d+\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function parseHStreamCards(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  // The live HStream browse cards use div.p-1 > a[href*="/hentai/"] and
  // keep their thumbnail in a nested div.relative > img.
  $('div.p-1 a[href*="/hentai/"],a[href*="/hentai/"]').each((_, el) => {
    const $a = $(el);
    const raw = absUrl($a.attr('href'), base);
    if (!raw || !sameProviderHost(raw, base)) return;
    let parsed;
    try { parsed = new URL(raw); } catch { return; }
    if (!/^\/hentai\/[\w-]+(?:\/\d+)?\/?$/i.test(parsed.pathname)) return;
    const key = canonicalContentUrl('hstream', raw, base);
    if (!key || seen.has(key)) return;
    const $card = $a.closest('div.p-1');
    const $box = $card.length ? $card : tightCard($, $a, base);
    const $image = $box.find('div.relative img,img').first();
    const poster = cardPoster($, $box, $a, base)
      || absUrl($image.attr('src') || $image.attr('data-src') || $image.attr('data-lazy-src'), base);
    if (!poster || isPosterNoise(poster)) return;
    const titleCandidates = [
      $image.attr('alt'), $a.attr('title'), $a.attr('aria-label'),
      $box.find('[class*="title"],h2,h3,h4').first().text(), $a.text(),
      titleFromUrl(key, 'hstream'),
    ].map(cleanHStreamTitle).filter(Boolean);
    const name = titleCandidates.find(value => value.length > 2) || '';
    if (!name || blocked({ name })) return;
    const genres = [...new Set($box.find('a[href*="/tag/"],a[href*="/genre/"]').map((__, tag) => clean($(tag).text())).get().filter(Boolean))].slice(0, 20);
    const item = { key, name, poster, genres, description: clean($box.find('.description,.excerpt,.summary').first().text()) };
    if (blocked(item)) return;
    seen.add(key);
    out.push(item);
    if (out.length >= PAGE_LIMIT) return false;
  });
  return out;
}

function parseProviderCards(config, html, base) {
  if (config.id === 'hstream') return parseHStreamCards(html, base);
  if (config.id === 'hentaigasm') return parseCards(html, base);
  if (config.id === 'rule34video') return parseRule34VideoCards(html, base);
  if (config.id === 'hentaimama') {
    const path = new URL(base).pathname;
    if (/^\/hentai-series(?:\/|$)/i.test(path)) return parseHentaiMamaSeriesCards(html, base);
    if (/\/genre\//i.test(path) || /^\/uncensored\/?$/i.test(path)) return parseHentaiMamaGenreCards(html, base);
    if (/\/recent-episodes(?:\/|$)/i.test(path)) {
      const episodeCards = parseHentaiMamaRecentEpisodeCards(html, base);
      return episodeCards.length ? episodeCards : parseCards(html, base);
    }
  }
  return parseCards(html, base).map(item => ({ ...item, key: canonicalContentUrl(config.id, item.key, base) || item.key }));
}

function catalogPageFingerprint(items) {
  return (items || []).map(item => `${normalizedTextKey(item.name)}|${String(item.poster || '').split('?')[0].replace(/^https?:\/\/(?:www\.)?/i, '').toLowerCase()}`).sort().join('\n');
}
function discoverPaginationUrls(html, base, targetPage, providerId) {
  const $ = cheerio.load(html);
  const candidates = [];
  const target = String(targetPage);
  $('a[href], link[rel="next"]').each((_, el) => {
    const $a = $(el);
    const raw = absUrl($a.attr('href'), base);
    if (!raw || !sameProviderHost(raw, base) || raw.split('#')[0] === String(base).split('#')[0]) return;
    let url;
    try { url = new URL(raw); } catch { return; }
    const text = clean($a.text());
    const aria = clean($a.attr('aria-label') || $a.attr('title') || '');
    const isNumericTarget = text === target || new RegExp(`^page\\s*${target}$`, 'i').test(aria) || new RegExp(`^${target}\\s*(?:of|/)\\s*\\d+$`, 'i').test(text);
    const isNextLink = /^(?:next|next page|›|»|→)$/i.test(text) || /next/i.test(aria) || String($a.attr('rel') || '').toLowerCase() === 'next';
    if (!isNumericTarget && !(isNextLink && targetPage === 2)) return;
    const path = url.pathname.toLowerCase();
    if (providerId === 'hentaimama' && /\/episodes\//i.test(path)) return;
    if (/\/(?:login|register|sign-up|wp-admin|wp-json)\//i.test(path)) return;
    const parents = $a.parents().toArray().slice(0, 5).map(node => `${node.attribs?.class || ''} ${node.attribs?.id || ''}`).join(' ');
    const score = (isNumericTarget ? 10 : 0) + (/pagination|pager|page-nav|pages-list|nav-links/i.test(`${parents} ${$a.attr('class') || ''}`) ? 5 : 0);
    candidates.push({ url: url.href, score });
  });
  const seen = new Set();
  return candidates.sort((a, b) => b.score - a.score).map(x => x.url).filter(url => !seen.has(url) && seen.add(url));
}
async function fetchCatalog(config, args) {
  let lastError;
  let reachedPage = false;
  const tried = [];
  let firstPageFingerprint = '';
  if ((Number(args.page) || 1) > 1) {
    const firstPageUrl = candidatePages(config, { ...args, page: 1 })[0];
    try { firstPageFingerprint = catalogPageFingerprint(parseProviderCards(config, await getHtml(firstPageUrl, config.base, config.timeout), firstPageUrl)); } catch { /* First page may have become unavailable. */ }
  }
  const seenOnPage = new Set();
  let candidates = candidatePages(config, args);
  const requestedPage = Math.max(1, Number(args.page) || 1);
  if (args.genre && !args.search && !['rule34video', 'hstream'].includes(config.id)) {
    const exactRoute = await discoverGenreRoute(config, args.genre);
    if (exactRoute) candidates = routePageCandidates(exactRoute, requestedPage);
  }
  if (requestedPage > 1 && (config.id !== 'hentaigasm' || args.mode === 'new')
    && !(config.id === 'hentaimama' && args.mode === 'new') && !args.genre && !args.search) {
    const firstPageCandidates = candidatePages(config, { ...args, page: 1 });
    for (const firstUrl of firstPageCandidates.slice(0, 3)) {
      try {
        const firstHtml = await getHtml(firstUrl, config.base, config.timeout);
        const discovered = discoverPaginationUrls(firstHtml, firstUrl, requestedPage, config.id);
        if (discovered.length) {
          candidates = [...discovered, ...candidates].filter((url, index, all) => all.indexOf(url) === index);
          break;
        }
      } catch { /* Fall back to the provider-specific route candidates. */ }
    }
  }
  for (const url of candidates) {
    tried.push(url);
    try {
      const html = await getHtml(url, config.base, config.timeout);
      reachedPage = true;
      const parsed = parseProviderCards(config, html, url);
      const searchFiltered = args.search ? parsed.filter(item => matchesCatalogSearch(item, args.search)) : parsed;
      const items = [];
      for (const item of searchFiltered) {
        const key = canonicalContentUrl(config.id, item.key, url) || item.key;
        const dedupeKey = config.id === 'hentaimama'
          ? `${normalizedTextKey(item.name)}|${String(item.poster || '').split('?')[0].toLowerCase()}`
          : key;
        if (!key || seenOnPage.has(dedupeKey)) continue;
        seenOnPage.add(dedupeKey);
        items.push({ ...item, key });
      }
      // Some sites silently serve page 1 for an invalid page URL. Do not return the same page again.
      if ((Number(args.page) || 1) > 1 && items.length && firstPageFingerprint && catalogPageFingerprint(items) === firstPageFingerprint) continue;
      if (items.length) return items;
    } catch (e) {
      lastError = e;
      // A 404 for one guessed route is normal; continue through the known candidates.
    }
  }
  // Search form endpoints differ between the two sites. If none returned an
  // actual title match, scan a small window of the provider's real catalogue
  // pages rather than returning unrelated homepage cards as search results.
  if (args.search && requestedPage === 1) {
    const listRoutes = candidatePages(config, { page: 1 }).slice(0, 2);
    const jobs = [];
    for (const route of listRoutes) {
      for (let page = 1; page <= 4; page++) {
        const pageUrl = page === 1 ? route : routePageCandidates(route, page)[0];
        jobs.push((async () => {
          const html = await getHtml(pageUrl, config.base, config.timeout);
          return parseProviderCards(config, html, pageUrl).filter(item => matchesCatalogSearch(item, args.search));
        })());
      }
    }
    const settled = await Promise.allSettled(jobs);
    const matches = [];
    const seen = new Set();
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      for (const item of result.value || []) {
        const key = canonicalContentUrl(config.id, item.key, config.base) || item.key;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        matches.push({ ...item, key });
      }
      if (matches.length >= PAGE_LIMIT) break;
    }
    if (matches.length) return matches.slice(0, PAGE_LIMIT);
  }
  if (!reachedPage && lastError) throw lastError;
  if (!reachedPage) console.warn(`[${config.name}] no candidate page could be fetched: ${tried.join(' | ')}`);
  else console.warn(`[${config.name}] no matching title found for page ${Math.max(1, Number(args.page) || 1)}${args.genre ? `, genre ${args.genre}` : ''}${args.search ? `, search ${args.search}` : ''}`);
  return [];
}

async function pageMeta(url, config) {
  const html = await getHtml(url, config.base, config.timeout);
  const $ = cheerio.load(html);
  const hentaimamaTitle = config.id === 'hentaimama' ? clean($('input[name="title"]').first().attr('value')) : '';
  const hstreamTitle = config.id === 'hstream' ? cleanHStreamTitle($('h1').first().text()) : '';
  const name = hentaimamaTitle || hstreamTitle || metaText($, ['meta[property="og:title"]', 'meta[name="twitter:title"]', 'h1', 'title']) || titleFromUrl(url, config.id);
  const metaPoster = metaText($, ['meta[property="og:image"]', 'meta[name="twitter:image"]']);
  const imageBox = $('div.imagen,.poster,.cover,.thumb,.thumbnail').first();
  const videoPoster = config.id === 'rule34video' ? absUrl($('video#player_html5_api,video').first().attr('poster'), url) : '';
  const schemaPoster = (() => {
    try {
      const data = JSON.parse($('script[type="application/ld+json"]').first().contents().text() || 'null');
      const image = Array.isArray(data?.image) ? data.image[0] : data?.image;
      return absUrl(typeof image === 'object' ? (image.url || image.contentUrl) : image, url);
    } catch { return ''; }
  })();
  const poster = absUrl(metaPoster, url) || videoPoster || schemaPoster || (imageBox.length ? cardPoster($, imageBox, imageBox.find('a').first(), url) : '');
  const description = metaText($, ['meta[property="og:description"]', 'meta[name="description"]']) || clean($('.entry-content p,.content p,.description p,.wp-content p,.summary').first().text());
  const genreSelector = '.sgeneros a,.genres a,.genre a,a[rel="tag"],.tags a,[class*="genre"] a,a[href*="/genre/"],a[href*="/tag/"],a[href*="/tags/"],a[href*="/categories/"]';
  const genres = [...new Set($(genreSelector).map((_, el) => clean($(el).text())).get().filter(x => x && x.length < 40))].slice(0, 20);
  const episodes = [];
  const seen = new Set();
  const hentaimamaEpisodePage = config.id === 'hentaimama' && /\/episodes\//i.test(new URL(url).pathname);
  const episodeSelector = config.id === 'hentaimama'
    ? 'a[href*="/episodes/"]'
    : '.episodes a[href],#episodes a[href],.episodios a[href],.episode-list a[href],.playlist a[href],.eplist a[href],[class*="episode-list"] a[href]';
  if (!hentaimamaEpisodePage) $(episodeSelector).each((_, el) => {
    const $a = $(el); const key = config.id === 'hentaigasm' ? absUrl($a.attr('href'), url) : canonicalContentUrl(config.id, $a.attr('href'), url); const title = clean($a.text() || $a.attr('title'));
    const currentKey = config.id === 'hentaigasm' ? url : canonicalContentUrl(config.id, url, url);
    if (!key || key === currentKey || seen.has(key) || !title || isNoise(key)) return;
    if (config.id === 'hentaimama' && !/\/episodes\//i.test(new URL(key).pathname)) return;
    seen.add(key); episodes.push({ key, title });
  });
  return { name: name || config.name, poster, background: poster, description, genres, episodes };
}
function normalizePlayerText(value) {
  return String(value || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=')
    .replace(/\\u003a/gi, ':').replace(/\\u002f/gi, '/')
    .replace(/\\x3a/gi, ':').replace(/\\x2f/gi, '/')
    .replace(/&amp;/gi, '&').replace(/&#038;/g, '&').replace(/&quot;/g, '"');
}

const MEDIA_URL_RE = /\.(?:m3u8|mp4|m4v|mpd|webm)(?:[?#]|$)/i;
function expandEncodedPlayerText(value) {
  let source = normalizePlayerText(value)
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#0?39;/gi, "'")
    .replace(/&#x2f;/gi, '/').replace(/&#x3a;/gi, ':');
  try { source += '\n' + decodeURIComponent(source.replace(/\+/g, '%20')); } catch { /* Most source text isn't URL-encoded. */ }
  const decoded = [];
  const base64Candidates = source.match(/(?:["'`])([A-Za-z0-9+/_=-]{40,})(?:["'`])/g) || [];
  for (const wrapped of base64Candidates.slice(0, 150)) {
    const token = wrapped.slice(1, -1);
    if (token.length % 4 === 1) continue;
    try {
      const candidate = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (/https?:|m3u8|\.mp4|<iframe|jwplayer|source\s*[:=]|video_url/i.test(candidate) && /[\x20-\x7e]{12}/.test(candidate)) decoded.push(candidate);
    } catch { /* Ignore non-base64 strings. */ }
  }
  return source + (decoded.length ? '\n' + decoded.join('\n') : '');
}
function extractMediaLegacy(html, base = '') {
  const source = normalizePlayerText(html);
  const urls = new Set();
  const add = raw => {
    if (!raw) return;
    let candidate = String(raw).trim().replace(/[),;]+$/, '').replace(/["'\\]+$/, '');
    candidate = candidate.replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&');
    const absolute = absUrl(candidate, base || 'https://invalid.local/');
    if (absolute && MEDIA_URL_RE.test(absolute) && !isNoise(absolute)) urls.add(absolute);
  };
  const absolutePattern = /https?:\\?\/\\?\/[^\s"'<>\\)]+?\.(?:m3u8|mp4|m4v|mpd|webm)(?:\?[^\s"'<>\\)]*)?/gi;
  for (const match of source.matchAll(absolutePattern)) add(match[0]);
  const configPattern = /(?:file|src|url|hls|mp4|video_url|stream_url|playlist|source)\s*["']?\s*[:=]\s*["']([^"']+)["']/gi;
  for (const match of source.matchAll(configPattern)) add(match[1]);
  if (base) {
    const $ = cheerio.load(source);
    $('video, video source, source, [data-file], [data-hls], [data-mp4]').each((_, el) => {
      const node = $(el);
      for (const key of ['src', 'data-src', 'data-file', 'data-hls', 'data-mp4']) {
        const value = node.attr(key);
        if (value && MEDIA_URL_RE.test(value)) add(value);
      }
    });
  }
  return [...urls];
}
function candidateStreamsLegacy(html, base) {
  const $ = cheerio.load(normalizePlayerText(html));
  const media = new Set(extractMediaLegacy(html, base));
  const embeds = new Set();
  const addEmbed = raw => {
    const src = absUrl(normalizePlayerText(raw), base);
    if (!src || isNoise(src) || /\.(?:jpe?g|png|gif|webp|svg)(?:[?#]|$)/i.test(src)) return;
    try { const parsed = new URL(src); if (parsed.protocol === 'http:' || parsed.protocol === 'https:') embeds.add(src); } catch {}
  };
  const rawEmbedText = normalizePlayerText(html).replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'");
  for (const match of rawEmbedText.matchAll(/<iframe\b[^>]*\b(?:src|data-src)\s*=\s*["']([^"']+)["']/gi)) addEmbed(match[1]);
  for (const match of rawEmbedText.matchAll(/(?:embed(?:_url)?|player(?:_url)?|iframe_url)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi)) addEmbed(match[1]);
  $('video source, video, source, [data-file], [data-hls], [data-mp4]').each((_, el) => {
    const node = $(el);
    for (const key of ['src', 'data-src', 'data-file', 'data-hls', 'data-mp4']) { const src = absUrl(node.attr(key), base); if (src && MEDIA_URL_RE.test(src)) media.add(src); }
  });
  $('iframe[src], iframe[data-src], [data-embed], [data-player], [data-video]').each((_, el) => {
    const node = $(el);
    for (const key of ['src', 'data-src', 'data-embed', 'data-player', 'data-video']) {
      const src = absUrl(node.attr(key), base);
      if (!src || isNoise(src) || /^(?:about:|javascript:|data:)/i.test(src)) continue;
      try { const parsed = new URL(src); if (sameProviderHost(src, base) && /\/(?:category|genre|tag|search|login|register)\//i.test(parsed.pathname)) continue; } catch { continue; }
      if (MEDIA_URL_RE.test(src)) media.add(src); else embeds.add(src);
    }
  });
  return { media: [...media], embeds: [...embeds] };
}

function extractMedia(html, base = '') {
  const source = expandEncodedPlayerText(html);
  const urls = new Set();
  const add = (raw) => {
    if (!raw) return;
    let candidate = String(raw).trim().replace(/[),;]+$/, '').replace(/["'\\]+$/, '');
    candidate = candidate.replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&');
    const absolute = absUrl(candidate, base || 'https://invalid.local/');
    if (absolute && MEDIA_URL_RE.test(absolute) && !isNoise(absolute)) urls.add(absolute);
  };

  // Plain and JSON-escaped absolute URLs.
  const absolutePattern = /https?:\\?\/\\?\/[^\s"'<>\\)]+?\.(?:m3u8|mp4|m4v|mpd|webm)(?:\?[^\s"'<>\\)]*)?/gi;
  for (const match of source.matchAll(absolutePattern)) add(match[0]);

  // Common player config forms: file, src, url, hls, and source lists.
  const configPattern = /(?:file|src|url|hls|mp4|video_url|stream_url|playlist|source)\s*["']?\s*[:=]\s*["']([^"']+)["']/gi;
  for (const match of source.matchAll(configPattern)) add(match[1]);

  // HTML video tags and source tags, including relative links.
  if (base) {
    const $ = cheerio.load(source);
    $('video, video source, source, [data-file], [data-hls], [data-mp4]').each((_, el) => {
      const node = $(el);
      for (const key of ['src', 'data-src', 'data-file', 'data-hls', 'data-mp4']) {
        const value = node.attr(key);
        if (value && MEDIA_URL_RE.test(value)) add(value);
      }
    });
  }
  return [...urls];
}

function candidateStreams(html, base) {
  const expandedText = expandEncodedPlayerText(html);
  const $ = cheerio.load(expandedText);
  const media = new Set(extractMedia(expandedText, base));
  const embeds = new Set();
  const addEmbed = raw => {
    const src = absUrl(normalizePlayerText(raw), base);
    if (!src || isNoise(src) || /\.(?:jpe?g|png|gif|webp|svg)(?:[?#]|$)/i.test(src)) return;
    try {
      const parsed = new URL(src);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') embeds.add(src);
    } catch {}
  };
  // Some sites expose their player iframe only inside a textarea/input value or escaped embed-code string.
  const rawEmbedText = expandedText.replace(/&quot;/gi, '"').replace(/\\\"/g, '"');
  for (const match of rawEmbedText.matchAll(/<iframe\b[^>]*\b(?:src|data-src)\s*=\s*["']([^"']+)["']/gi)) addEmbed(match[1]);
  for (const match of rawEmbedText.matchAll(/(?:embed(?:_url)?|player(?:_url)?|iframe_url)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi)) addEmbed(match[1]);
  $('video source, video, source, [data-file], [data-hls], [data-mp4]').each((_, el) => {
    const node = $(el);
    for (const key of ['src', 'data-src', 'data-file', 'data-hls', 'data-mp4']) {
      const src = absUrl(node.attr(key), base);
      if (src && MEDIA_URL_RE.test(src)) media.add(src);
    }
  });

  // Player iframes are often one or two levels away from the actual manifest.
  $('iframe[src], iframe[data-src], [data-embed], [data-player], [data-video]').each((_, el) => {
    const node = $(el);
    for (const key of ['src', 'data-src', 'data-embed', 'data-player', 'data-video']) {
      const src = absUrl(node.attr(key), base);
      if (!src || isNoise(src) || isAdOrTracker(src) || /^(?:about:|javascript:|data:)/i.test(src)) continue;
      try {
        const parsed = new URL(src);
        if (sameProviderHost(src, base) && /\/(?:category|genre|tag|search|login|register)\//i.test(parsed.pathname)) continue;
      } catch { continue; }
      if (MEDIA_URL_RE.test(src)) media.add(src);
      else embeds.add(src);
    }
  });
  return { media: [...media], embeds: [...embeds] };
}

function qualityFromLabel(value, allowBareNumber = false) {
  const text = String(value || '');
  const dimension = text.match(/(?:^|[^0-9])\d{3,5}\s*[x×]\s*(2160|1440|1080|720|576|540|480|360|240)(?:$|[^0-9])/i);
  if (dimension) return `${dimension[1]}p`;
  const match = text.match(/(?:^|[^0-9])(2160|1440|1080|720|576|540|480|360|240)\s*p\b/i);
  if (match) return `${match[1]}p`;
  if (/(?:^|[^a-z0-9])4k(?:$|[^a-z0-9])/i.test(text)) return '2160p';
  if (/(?:^|[^a-z0-9])2k(?:$|[^a-z0-9])/i.test(text)) return '1440p';
  if (allowBareNumber) {
    const bare = text.trim().match(/^(2160|1440|1080|720|576|540|480|360|240)$/);
    if (bare) return `${bare[1]}p`;
  }
  return '';
}
function sourceAssignments(source) {
  const assignments = [];
  const pattern = /(?:[\"'`])?([A-Za-z_$][\w$]*)[\"'`]?\s*[:=]\s*([\"'`])([^\"'`]+)\2/g;
  for (const match of String(source || '').matchAll(pattern)) assignments.push({ key: match[1], value: match[3], index: match.index });
  return assignments;
}
function detectExplicitQuality(url, source = '') {
  try {
    const parsed = new URL(url);
    const pathQuality = qualityFromLabel(parsed.pathname);
    if (pathQuality) return pathQuality;
    for (const [key, value] of parsed.searchParams) {
      if (/(?:quality|resolution|\bres\b)/i.test(key)) {
        const quality = qualityFromLabel(value, true);
        if (quality) return quality;
      }
    }
  } catch { /* The URL is validated by streamObject; source metadata can still be checked. */ }

  let sourceText = '';
  try { sourceText = typeof source === 'string' ? source : JSON.stringify(source ?? ''); }
  catch { sourceText = String(source || ''); }
  const normalized = sourceText
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&');
  const targetUrl = (() => { try { return new URL(url).href; } catch { return String(url || ''); } })();
  const tagPattern = /<(?:source|video|a|track)\b[^>]*>/gi;
  for (const tag of normalized.matchAll(tagPattern)) {
    const attrs = {};
    for (const attr of tag[0].matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g)) attrs[attr[1].toLowerCase()] = attr[3];
    const rawUrl = attrs.src || attrs.href || attrs['data-src'] || attrs.file || attrs.url;
    if (!rawUrl) continue;
    const resolved = absUrl(rawUrl, url);
    if (!resolved || resolved !== targetUrl) continue;
    const qualityText = [
      attrs.label, attrs.title, attrs.quality, attrs['data-quality'], attrs.res, attrs['data-res'],
      attrs.resolution, attrs['data-resolution'], attrs.size, attrs.height, attrs['data-height'],
      attrs['aria-label'], attrs.type,
    ].filter(Boolean).join(' ');
    const tagQuality = qualityFromLabel(qualityText, true);
    if (tagQuality) return tagQuality;
  }

  const assignments = sourceAssignments(normalized);
  const matching = assignments.find(entry => {
    const raw = entry.value.replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
    try { return new URL(raw, url).href === new URL(url).href; } catch { return raw === url; }
  });
  if (!matching) return '';

  const siblingNames = [
    `${matching.key}_text`, `${matching.key}_quality`, `${matching.key}_label`,
    `${matching.key.replace(/_url$/i, '')}_quality`, `${matching.key.replace(/_url$/i, '')}_label`,
  ];
  for (const name of siblingNames) {
    const entry = assignments.find(item => item.key.toLowerCase() === name.toLowerCase());
    if (entry) {
      const quality = qualityFromLabel(entry.value, true);
      if (quality) return quality;
    }
  }

  // For generic player configs such as {file: URL, label: '1080p'}, read only
  // explicit quality metadata belonging to the same containing object.
  const start = normalized.lastIndexOf('{', matching.index);
  const end = normalized.indexOf('}', matching.index);
  if (start >= 0 && end > matching.index && end - start <= 12000) {
    const objectText = normalized.slice(start, end + 1);
    for (const item of sourceAssignments(objectText)) {
      if (/^(?:quality|resolution|label|title|name|height|res)$/i.test(item.key)) {
        const quality = qualityFromLabel(item.value, true);
        if (quality) return quality;
      }
    }
    // JWPlayer often stores resolution as a numeric field, e.g. height: 1080,
    // rather than a string label. Keep the check scoped to the source object
    // that contains this exact media URL so another rendition cannot match.
    for (const field of objectText.matchAll(/["'`]?(?:quality|resolution|res|label|title|name|height)["'`]?\s*[:=]\s*([^,}\]\n]+)/gi)) {
      const raw = field[1].trim().replace(/^["'`]|["'`]$/g, '');
      const quality = qualityFromLabel(raw, true);
      if (quality) return quality;
    }
  }
  return '';
}

function posterShapeFor(item, selectedGenre = '') {
  if (item?.providerId === 'hentaimama') {
    const selected = normalizedTextKey(selectedGenre);
    return !selected || selected === 'all genres' || selected === '3d' ? 'landscape' : 'poster';
  }
  return 'landscape';
}

// A master HLS playlist can list real variant playlists at explicit resolutions.
// Convert those listed variants to separate Stremio stream choices; never guess URLs.
function parseHlsVariantPlaylist(playlist, baseUrl) {
  const lines = String(playlist || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.some(line => line === '#EXTM3U')) return [];
  const variants = [];
  const seenQualities = new Set();
  const seenUrls = new Set();
  let pendingQuality = '';
  for (const line of lines) {
    if (/^#EXT-X-STREAM-INF:/i.test(line)) {
      pendingQuality = qualityFromLabel(line);
      continue;
    }
    if (!pendingQuality || line.startsWith('#')) continue;
    try {
      const url = new URL(line, baseUrl).href;
      if (!/^https?:$/.test(new URL(url).protocol) || seenQualities.has(pendingQuality) || seenUrls.has(url)) {
        pendingQuality = '';
        continue;
      }
      variants.push({ quality: pendingQuality, url });
      seenQualities.add(pendingQuality);
      seenUrls.add(url);
    } catch { /* Skip malformed variant entries instead of creating links. */ }
    pendingQuality = '';
  }
  return variants.sort((a, b) => Number(b.quality.replace('p', '')) - Number(a.quality.replace('p', '')));
}

async function expandHlsQualityStreams(streams) {
  const sourceStreams = Array.isArray(streams) ? streams : [];
  const expanded = new Map();
  let checked = 0;
  await Promise.all(sourceStreams.map(async (stream, index) => {
    expanded.set(index, [stream]);
    if (!stream?.url || !/\.m3u8(?:[?#]|$)/i.test(stream.url) || qualityFromLabel(stream.title) || checked >= 4) return;
    checked++;
    try {
      const requestHeaders = stream.behaviorHints?.proxyHeaders?.request || { 'User-Agent': UA };
      const response = await http.get(stream.url, { responseType: 'text', headers: requestHeaders });
      const finalUrl = response.request?.res?.responseUrl || response.request?.responseURL || stream.url;
      const variants = parseHlsVariantPlaylist(String(response.data || ''), finalUrl);
      // Keep the original master unless at least two different, explicitly labelled variants exist.
      if (variants.length < 2) return;
      expanded.set(index, variants.map(variant => {
        let filename = '';
        try { filename = decodeURIComponent(new URL(variant.url).pathname.split('/').pop() || ''); } catch {}
        return {
          ...stream,
          title: `${variant.quality} · HLS`,
          url: variant.url,
          behaviorHints: {
            ...(stream.behaviorHints || {}),
            notWebReady: true,
            ...(filename ? { filename } : {}),
          },
        };
      }));
    } catch { /* Keep the original valid master URL if variant lookup fails. */ }
  }));
  return [...expanded.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, group]) => group).slice(0, 20);
}

function isAdOrTracker(url) {
  try {
    const u = new URL(url);
    return /(?:doubleclick|googlesyndication|google-analytics|googletagmanager|trackwilltrk|xhubtraffic|zlink|yandex|popads|adservice|exoclick|trafficjunky|adsterra|onclickads|juicyads|push-notification)/i.test(u.hostname)
      || /\/(?:ads?|advert|banner|tracking|analytics|promo)(?:\/|\.|$)/i.test(u.pathname);
  } catch { return true; }
}
function scorePlayerUrl(url) {
  try {
    const u = new URL(url);
    let score = 0;
    if (/\.(?:m3u8|mp4|m4v|mpd|webm)(?:[?#]|$)/i.test(url)) score += 100;
    if (/\/(?:embed|player|video|watch|stream|iframe|jwplayer)(?:\/|$)/i.test(u.pathname)) score += 20;
    if (/(?:player|embed|stream|video)/i.test(`${u.hostname}${u.pathname}`)) score += 8;
    if (isAdOrTracker(url)) score -= 1000;
    return score;
  } catch { return -1000; }
}
function streamIdentity(value) {
  const raw = typeof value === 'string' ? value : value?.url;
  try {
    const u = new URL(raw);
    u.hash = '';
    const ignored = /^(?:token|expires?|exp|signature|sig|auth|authorization|key|hash|jwt|session|nonce|timestamp|policy|hdnts|hdnea|download|download_filename|e|s)$/i;
    const stable = [...u.searchParams.entries()]
      .filter(([key]) => !ignored.test(key))
      .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
    u.search = '';
    for (const [key, val] of stable) u.searchParams.append(key, val);
    return u.href;
  } catch { return String(raw || '').split('#')[0]; }
}
function dedupeStreams(streams) {
  const byIdentity = new Map();
  for (const stream of streams || []) {
    if (!stream?.url) continue;
    const identity = streamIdentity(stream);
    if (!identity) continue;
    const existing = byIdentity.get(identity);
    // The same media endpoint may be returned with different expiring tokens or
    // labels. Keep only its best explicit quality, while URL quality parameters
    // remain part of streamIdentity and therefore remain distinct variants.
    if (!existing || streamQualityRank(stream) > streamQualityRank(existing)) byIdentity.set(identity, stream);
  }
  return [...byIdentity.values()];
}
function streamQualityRank(stream) {
  const label = String(stream?.title || '');
  if (/\b(?:source|original|4k|uhd)\b/i.test(label) && !qualityFromLabel(label)) return 10000;
  const q = qualityFromLabel(label) || detectExplicitQuality(stream?.url || '', label);
  return Number.parseInt(q, 10) || 0;
}
function sortQualityStreams(streams) {
  return dedupeStreams(streams).sort((a, b) => streamQualityRank(b) - streamQualityRank(a));
}

function isHentaiMamaMp4(url) {
  return /\.mp4(?:[?#]|$)/i.test(String(url || ''));
}
function isHentaiMama1080pMp4(url, source = '') {
  const label = String(source || '').trim();
  return isHentaiMamaMp4(url) && (
    detectExplicitQuality(url, source) === '1080p' || /^1080p(?:\s|[·|_-]|$)/i.test(label)
  );
}
function hentaiMamaQualityRank(stream) {
  const quality = qualityFromLabel(stream?.title || '') || detectExplicitQuality(stream?.url || '', stream?.title || '');
  const value = Number.parseInt(quality, 10);
  return Number.isFinite(value) ? value : 0;
}
function sortHentaiMamaStreams(streams) {
  return dedupeStreams((streams || []).filter(stream => stream?.url && isHentaiMamaMp4(stream.url)))
    .sort((a, b) => hentaiMamaQualityRank(b) - hentaiMamaQualityRank(a));
}

function streamObject(providerName, url, referer, preserveHentaigasm = false, source = '') {
  const parsed = new URL(url);
  const ext = parsed.pathname.toLowerCase();
  const type = ext.endsWith('.m3u8') ? 'HLS' : ext.endsWith('.mpd') ? 'DASH' : ext.endsWith('.webm') ? 'WEBM' : 'MP4';
  const quality = detectExplicitQuality(url, source);
  let filename = ext.split('/').pop() || `stream.${type.toLowerCase()}`;
  try { filename = decodeURIComponent(filename); } catch { /* Preserve the raw filename if the URL contains invalid escapes. */ }
  return {
    name: providerName,
    title: quality ? `${quality} · ${type}` : type,
    url,
    behaviorHints: {
      notWebReady: true,
      filename,
      proxyHeaders: { request: preserveHentaigasm
        ? { Referer: referer, 'User-Agent': UA }
        : { Referer: referer, Origin: (() => { try { return new URL(referer).origin; } catch { return undefined; } })(), 'User-Agent': UA } },
    },
  };
}

async function resolveStreams(providerName, pageUrl, providerId = '') {
  const streams = [];
  const streamUrls = new Map();
  const visited = new Set();
  const queue = [{ url: pageUrl, referer: pageUrl, depth: 0, html: null }];
  const defaultDepth = providerId === 'hentaigasm' ? 3 : 5;
  const defaultPageLimit = providerId === 'hentaigasm' ? 18 : 24;
  const maxDepth = Number(process.env.EMBED_DEPTH || defaultDepth);
  const maxPages = Number(process.env.EMBED_PAGE_LIMIT || defaultPageLimit);

  while (queue.length && visited.size < maxPages) {
    const current = queue.shift();
    if (!current?.url || visited.has(current.url) || current.depth > maxDepth) continue;
    visited.add(current.url);
    try {
      const html = current.html ?? (providerId === 'hentaigasm'
        ? await getHtml(current.url, current.referer)
        : await getHtmlFresh(current.url, current.referer));
      const found = providerId === 'hentaigasm'
        ? candidateStreamsLegacy(html, current.url)
        : candidateStreams(html, current.url);
      const mediaCandidates = found.media.map(url => ({ url, quality: detectExplicitQuality(url, html) }));
      for (const candidate of mediaCandidates) {
        const mediaUrl = candidate.url;
        const identity = streamIdentity(mediaUrl);
        if ((providerId !== 'hentaigasm' && isAdOrTracker(mediaUrl))) continue;
        if (providerId === 'hentaimama' && !isHentaiMamaMp4(mediaUrl)) continue;
        try {
          const stream = streamObject(providerName, mediaUrl, current.url, providerId === 'hentaigasm', html);
          const existingIndex = streamUrls.get(identity);
          if (existingIndex == null) { streamUrls.set(identity, streams.length); streams.push(stream); }
          else if (streamQualityRank(stream) > streamQualityRank(streams[existingIndex])) streams[existingIndex] = stream;
        } catch { /* Ignore malformed player URLs. */ }
      }
      const embedUrls = providerId === 'hentaigasm' ? found.embeds : [...found.embeds].sort((a, b) => scorePlayerUrl(b) - scorePlayerUrl(a));
      for (const embedUrl of embedUrls) {
        if ((providerId !== 'hentaigasm' && isAdOrTracker(embedUrl)) || visited.has(embedUrl) || queue.some(item => item.url === embedUrl)) continue;
        if (current.depth < maxDepth) queue.push({ url: embedUrl, referer: current.url, depth: current.depth + 1, html: null });
      }
    } catch (e) {
      console.warn(`[${providerName}] player fetch failed (${current.url}): ${e.code || e.response?.status || e.message}`);
    }
  }

  console.log(`[${providerName}] stream resolver: ${streams.filter(s => s.url).length} direct, ${visited.size} pages checked`);
  return streams;
}

function extractJsObject(source, variableName = 'data') {
  const re = new RegExp(`(?:(?:var|let|const)\\s+|window\\.)${variableName}\\s*=\\s*`, 'm');
  const m = re.exec(String(source || ''));
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 0, quote = '', escaped = false, objectStart = -1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') { if (depth === 0) objectStart = i; depth++; }
    if (ch === '}') {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        const raw = source.slice(objectStart, i + 1);
        try { return JSON.parse(raw); } catch { /* Normalize ordinary JS object syntax below. */ }
        try {
          const jsonish = raw
            .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
            .replace(/'/g, '"')
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/\bundefined\b/g, 'null');
          return JSON.parse(jsonish);
        } catch { return null; }
      }
    }
  }
  return null;
}
function flattenPayloadTexts(value, out = [], depth = 0) {
  if (depth > 6 || value == null) return out;
  if (typeof value === 'string') {
    out.push(value);
    // AJAX endpoints sometimes double-encode a JSON payload.
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { flattenPayloadTexts(JSON.parse(trimmed), out, depth + 1); } catch { /* It may be HTML rather than JSON. */ }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) flattenPayloadTexts(item, out, depth + 1);
  } else if (typeof value === 'object') {
    for (const item of Object.values(value)) flattenPayloadTexts(item, out, depth + 1);
  }
  return out;
}
function extractPlayerFrames(value, base) {
  const frames = new Set();
  for (const textValue of flattenPayloadTexts(value)) {
    const source = normalizePlayerText(textValue)
      .replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'")
      .replace(/\\"/g, '"');
    const matches = [
      ...[...source.matchAll(/<(?:iframe|frame)\b[^>]*\b(?:src|data-src)\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]),
      ...[...source.matchAll(/(?:iframe_url|player_url|embed_url)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi)].map(m => m[1]),
    ];
    for (const candidate of matches) {
      const url = absUrl(candidate, base);
      if (url && !isNoise(url) && !isAdOrTracker(url)) frames.add(url);
    }
  }
  return [...frames];
}
function extractPlayerFrame(value, base) {
  return extractPlayerFrames(value, base)[0] || '';
}
function extractPlayerMedia(value, base) {
  const texts = flattenPayloadTexts(value);
  const urls = new Set();
  for (const textValue of texts) {
    const expanded = expandEncodedPlayerText(textValue);
    for (const url of extractMedia(expanded, base)) {
      if (!isAdOrTracker(url)) urls.add(url);
    }
    // Some JWPlayer configs use a JS object, single quotes, or escaped JSON.
    const normalized = normalizePlayerText(expanded).replace(/\\"/g, '"').replace(/&quot;/gi, '"');
    for (const match of normalized.matchAll(/(?:["']?(?:file|src|hls|video_url|stream_url)["']?)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi)) {
      const url = absUrl(match[1], base);
      if (url && MEDIA_URL_RE.test(url) && !isNoise(url) && !isAdOrTracker(url)) urls.add(url);
    }
  }
  return [...urls];
}
function extractHentaiMamaAjaxCandidates(html) {
  const page = String(html || '');
  const scripts = [...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const sources = scripts.length ? scripts : [page];
  const found = [];
  const byKey = new Map();

  // The yt-dlp HentaiMama extractor posts the complete `var data = {...}`
  // object. Preserve every field (nonce/post ID/etc.), not just action + a.
  const data = extractJsObject(page, 'data');
  if (data && typeof data === 'object' && !Array.isArray(data) && data.action) {
    const candidate = {
      action: String(data.action),
      a: String(data.a ?? data.id ?? ''),
      payload: data,
    };
    const key = `${candidate.action}|${candidate.a}`;
    byKey.set(key, candidate);
    found.push(candidate);
  }

  // Fallback for templates that expose only individual action/a assignments.
  for (const script of sources) {
    const actions = [...script.matchAll(/(?:["']action["']\s*:\s*|\baction\s*[:=]\s*)["']([^"']+)["']/gi)];
    const ids = [...script.matchAll(/(?:["']a["']\s*:\s*|\ba\s*[:=]\s*)["']?(\d+)["']?/gi)];
    for (const action of actions) {
      const id = ids.map(m => ({ value: m[1], distance: Math.abs(m.index - action.index) }))
        .filter(m => m.distance <= 500).sort((a, b) => a.distance - b.distance)[0];
      if (!id) continue;
      const candidate = { action: action[1], a: id.value };
      const key = `${candidate.action}|${candidate.a}`;
      if (!byKey.has(key)) {
        byKey.set(key, candidate);
        found.push(candidate);
      }
    }
  }
  return found.slice(0, 5);
}

function buildHentaiMamaAjaxBody(candidate) {
  const body = new URLSearchParams();
  const payload = candidate?.payload && typeof candidate.payload === 'object'
    ? { ...candidate.payload }
    : {};
  if (payload.action == null) payload.action = candidate?.action || '';
  if (payload.a == null && payload.id == null) payload.a = candidate?.a || '';
  for (const [key, value] of Object.entries(payload)) {
    if (value == null) continue;
    body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return body.toString();
}

function parsePayload(value) {
  if (typeof value !== 'string') return value;
  let payload = value.trim();
  for (let i = 0; i < 2; i++) {
    try { payload = JSON.parse(payload); } catch { break; }
    if (typeof payload !== 'string') break;
  }
  return payload;
}
async function resolveHentaiMamaStreams(episodeUrl) {
  const base = new URL(episodeUrl).origin;
  const streams = [];
  const addStream = stream => {
    if (!stream?.url || !isHentaiMamaMp4(stream.url)) return;
    const identity = streamIdentity(stream);
    const existingIndex = streams.findIndex(item => streamIdentity(item) === identity);
    if (existingIndex >= 0) {
      if (hentaiMamaQualityRank(stream) > hentaiMamaQualityRank(streams[existingIndex])) streams[existingIndex] = stream;
      return;
    }
    streams.push(stream);
  };
  const addSources = (value, referer) => {
    for (const url of extractPlayerMedia(value, referer)) {
      if (!isHentaiMamaMp4(url)) continue;
      try { addStream(streamObject('HentaiMama', url, referer, false, value)); }
      catch { /* Ignore malformed media URLs. */ }
    }
  };
  const addPlayerFrames = async (frames, referer, cookies = '') => {
    for (const frameUrl of frames.slice(0, 8)) {
      try {
        const response = await http.get(frameUrl, {
          responseType: 'text',
          headers: { Referer: referer, ...(cookies ? { Cookie: cookies } : {}) },
        });
        const playerHtml = String(response.data || '');
        addSources(playerHtml, frameUrl);
        // Keep following nested players even when a 360p/480p source was already
        // found. The higher rendition is commonly exposed only by the inner player.
        const nested = await resolveStreams('HentaiMama', frameUrl, 'hentaimama');
        for (const stream of nested) addStream(stream);
        if (streams.length >= 12) break;
      } catch (e) {
        console.warn(`[HentaiMama] player mirror failed (${frameUrl}): ${e.code || e.response?.status || e.message}`);
      }
    }
  };

  try {
    const pageResponse = await http.get(episodeUrl, { responseType: 'text' });
    const pageHtml = String(pageResponse.data || '');
    const cookies = (pageResponse.headers?.['set-cookie'] || []).map(v => String(v).split(';')[0]).filter(Boolean).join('; ');

    // Direct sources are useful, but they are not necessarily the best quality.
    addSources(pageHtml, episodeUrl);

    // Inspect every WordPress player candidate before deciding which rendition
    // to return; a direct 480p source must not prevent the AJAX player from being tried.
    const ajaxCandidates = extractHentaiMamaAjaxCandidates(pageHtml);
    for (const candidate of ajaxCandidates) {
      try {
        const postBody = buildHentaiMamaAjaxBody(candidate);
        const ajaxResponse = await http.post(`${base}/wp-admin/admin-ajax.php`, postBody, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Referer: episodeUrl,
            Origin: base,
            ...(cookies ? { Cookie: cookies } : {}),
            'X-Requested-With': 'XMLHttpRequest',
          },
        });
        const payload = parsePayload(ajaxResponse.data);
        addSources(payload, episodeUrl);
        const frames = extractPlayerFrames(payload, base);
        if (frames.length) await addPlayerFrames(frames, episodeUrl, cookies);
        if (streams.length >= 12) break;
      } catch (e) {
        console.warn(`[HentaiMama] AJAX candidate ${candidate.action}/${candidate.a} failed: ${e.code || e.response?.status || e.message}`);
      }
    }

    // Some templates place the player iframe directly in the episode HTML.
    const pageFrames = extractPlayerFrames(pageHtml, episodeUrl);
    if (pageFrames.length) await addPlayerFrames(pageFrames, episodeUrl, cookies);

    // Last-resort breadth-first player walk catches nonstandard embeds missed by
    // WordPress payload parsing. It is still constrained to actual MP4 URLs.
    if (!streams.some(stream => hentaiMamaQualityRank(stream) >= 720)) {
      const nested = await resolveStreams('HentaiMama', episodeUrl, 'hentaimama');
      for (const stream of nested) addStream(stream);
    }
  } catch (e) {
    console.warn(`[HentaiMama] stream extraction failed (${episodeUrl}): ${e.code || e.response?.status || e.message}`);
  }
  return sortHentaiMamaStreams(streams).slice(0, 12);
}


function isRule34VideoMediaUrl(value) {
  try {
    const pathname = new URL(String(value || ''), 'https://rule34video.com/').pathname;
    // The redesigned site serves media through paths ending in .mp4/ (with a
    // trailing slash) and signed query strings. Keep that original URL intact.
    return /\.(?:m3u8|mp4|m4v|mpd|webm)\/?$/i.test(pathname);
  } catch { return false; }
}

function completeRule34VideoUrl(value, postfix, baseUrl) {
  const raw = normalizePlayerText(String(value || '')).trim().replace(/["'`]+$/g, '');
  if (!raw) return '';
  let url = absUrl(raw, baseUrl);
  if (!url) return '';
  if (isRule34VideoMediaUrl(url)) return url;

  // Some kt_player responses expose the common file path separately from the
  // postfix (for example `_360.mp4`). Only append a literal media suffix from
  // the same flashvars object; never synthesize a host, token, or quality URL.
  const suffix = clean(postfix);
  if (/^_[A-Za-z0-9._-]+\.(?:mp4|m4v|webm|m3u8)$/i.test(suffix)) {
    try {
      const parsed = new URL(url);
      parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}${suffix}`;
      url = parsed.href;
    } catch { return ''; }
  }
  return isRule34VideoMediaUrl(url) ? url : '';
}

function rule34VideoExactIdentity(value) {
  try {
    const url = new URL(typeof value === 'string' ? value : value?.url);
    url.hash = '';
    // The generic media scanner can truncate the site's `.mp4/` path at `.mp4`.
    // Treat only that slash difference as the same path while retaining every
    // query parameter, including v-acctoken and download flags.
    if (/\.(?:mp4|m4v|webm|m3u8|mpd)\/$/i.test(url.pathname)) url.pathname = url.pathname.slice(0, -1);
    // Unlike generic deduplication, download=true, download_filename and
    // v-acctoken are functional parts of Rule34Video's signed file endpoint.
    return url.href;
  } catch { return String(typeof value === 'string' ? value : value?.url || '').split('#')[0]; }
}

function dedupeRule34VideoStreams(streams) {
  const byUrl = new Map();
  for (const stream of streams || []) {
    if (!stream?.url) continue;
    const identity = rule34VideoExactIdentity(stream.url);
    const current = byUrl.get(identity);
    if (!current || streamQualityRank(stream) > streamQualityRank(current)) byUrl.set(identity, stream);
  }
  return [...byUrl.values()].sort((a, b) => streamQualityRank(b) - streamQualityRank(a));
}

function parseRule34VideoFlashvars(html, baseUrl) {
  const normalized = normalizePlayerText(String(html || '')).replace(/&quot;/gi, '"');
  const assignments = sourceAssignments(normalized);
  const postfix = assignments.find(item => item.key.toLowerCase() === 'postfix')?.value || '';
  const urls = [];
  const seen = new Set();
  for (const entry of assignments) {
    if (!/^video(?:_alt)?_url\d*$/i.test(entry.key)) continue;
    const url = completeRule34VideoUrl(entry.value, postfix, baseUrl);
    if (!url || isAdOrTracker(url)) continue;
    const labelEntry = assignments.find(item => item.key.toLowerCase() === `${entry.key.toLowerCase()}_text`);
    const qualityLabel = clean(labelEntry?.value) || qualityFromLabel(url) || '';
    const identity = rule34VideoExactIdentity(url);
    if (seen.has(identity)) continue;
    seen.add(identity);
    urls.push({ url, label: qualityLabel || 'MP4' });
  }
  return urls;
}

function parseRule34VideoDownloadLinks(html, baseUrl) {
  const source = normalizePlayerText(String(html || '')).replace(/&quot;/gi, '"');
  const out = [];
  const seen = new Set();
  const anchors = source.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
  for (const anchor of anchors) {
    const attrs = {};
    const tag = anchor.match(/^<a\b[^>]*>/i)?.[0] || anchor;
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gi)) attrs[match[1].toLowerCase()] = match[3];
    const href = attrs.href;
    if (!href) continue;
    const url = absUrl(href, baseUrl);
    if (!url || isAdOrTracker(url)) continue;
    let parsed;
    try { parsed = new URL(url); } catch { continue; }
    const downloadFilename = parsed.searchParams.get('download_filename') || '';
    const label = clean([
      anchor.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' '),
      attrs.title, attrs['aria-label'], attrs.download, downloadFilename,
      parsed.pathname,
    ].filter(Boolean).join(' '));
    const quality = qualityFromLabel(label, true) || qualityFromLabel(url, true);
    const looksLikeMediaDownload = isRule34VideoMediaUrl(url)
      || parsed.searchParams.has('download')
      || parsed.searchParams.has('download_filename')
      || /\/get_file\//i.test(parsed.pathname);
    if (!looksLikeMediaDownload) continue;
    // `download` and `download_filename` are presentation/download flags, not
    // the session token. The site's current extractor strips those two only.
    parsed.searchParams.delete('download');
    parsed.searchParams.delete('download_filename');
    const cleanUrl = parsed.href;
    const identity = rule34VideoExactIdentity(cleanUrl);
    if (!seen.has(identity)) {
      seen.add(identity);
      out.push({ url: cleanUrl, label: quality || 'MP4' });
    }
  }
  return out;
}

function parseRule34VideoSources(html, baseUrl) {
  const all = [
    ...parseRule34VideoFlashvars(html, baseUrl),
    ...parseRule34VideoDownloadLinks(html, baseUrl),
  ];
  const rawSource = normalizePlayerText(String(html || ''));
  const extracted = extractMedia(html, baseUrl);
  for (const url of extracted) {
    // The generic scanner stops at `.mp4` on the new `.mp4/?token` format;
    // discard that truncated prefix instead of creating an unsigned duplicate.
    let truncated = false;
    try {
      const parsedUrl = new URL(url);
      const rawPathWithSlash = `${parsedUrl.pathname}/`;
      if (rawPathWithSlash.endsWith('.mp4//')) truncated = false;
      else if (rawSource.toLowerCase().includes(rawPathWithSlash.toLowerCase())) truncated = true;
    } catch {}
    if (truncated) continue;
    const identity = rule34VideoExactIdentity(url);
    if (!all.some(item => rule34VideoExactIdentity(item.url) === identity)) {
      all.push({ url, label: qualityFromLabel(url, true) || 'MP4' });
    }
  }
  const byUrl = new Map();
  for (const item of all) {
    const title = `${qualityFromLabel(item.label, true) || item.label} · MP4`;
    const identity = rule34VideoExactIdentity(item.url);
    const current = byUrl.get(identity);
    if (!current || streamQualityRank({ title }) > streamQualityRank({ title: `${qualityFromLabel(current.label, true) || current.label} · MP4` })) {
      byUrl.set(identity, item);
    }
  }
  return [...byUrl.values()];
}

function parseRule34VideoSessionCookies(setCookieHeaders) {
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : (setCookieHeaders ? [setCookieHeaders] : []);
  const cookies = [];
  for (const header of headers) {
    const cookie = String(header || '').split(';', 1)[0].trim();
    if (!cookie || /^__ddg(?:id|mark)_/i.test(cookie)) continue;
    cookies.push(cookie);
  }
  const xsrfCookie = cookies.find(cookie => /^XSRF-TOKEN=/i.test(cookie));
  let xsrfToken = xsrfCookie ? xsrfCookie.slice(xsrfCookie.indexOf('=') + 1) : '';
  if (xsrfToken) {
    try { xsrfToken = decodeURIComponent(xsrfToken); } catch { /* Keep the raw cookie token. */ }
    xsrfToken = xsrfToken.replace(/%3D/gi, '=');
  }
  return { cookie: cookies.join('; '), xsrfToken };
}

async function fetchRule34VideoPage(pageUrl) {
  const origin = new URL(pageUrl).origin;
  const response = await http.get(pageUrl, {
    headers: { Referer: pageUrl, Origin: origin, 'User-Agent': UA },
    responseType: 'text',
  });
  return {
    html: String(response.data || ''),
    session: parseRule34VideoSessionCookies(response.headers?.['set-cookie']),
  };
}

function rule34VideoHeadersForUrl(targetUrl, pageUrl, session = {}) {
  const page = new URL(pageUrl);
  const target = new URL(targetUrl);
  const pageHost = page.hostname.toLowerCase().replace(/^www\./, '');
  const targetHost = target.hostname.toLowerCase().replace(/^www\./, '');
  const trusted = targetHost === pageHost || targetHost.endsWith(`.${pageHost}`);
  const headers = {
    Referer: pageUrl,
    Origin: page.origin,
    'User-Agent': UA,
    Accept: 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
    'Accept-Language': 'en-US,en;q=0.5',
  };
  if (trusted && session.cookie) headers.Cookie = session.cookie;
  if (trusted && session.xsrfToken) headers['X-XSRF-TOKEN'] = session.xsrfToken;
  return headers;
}

async function requestRule34VideoHttp2(url, headers, timeout = 12000) {
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error('HTTP/2 probe requires HTTPS');
  return new Promise((resolve, reject) => {
    let session;
    let request;
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { request?.close(http2.constants.NGHTTP2_CANCEL); } catch {}
      try { if (error) session?.destroy(); else session?.close(); } catch {}
      if (error) reject(error); else resolve(result);
    };
    try {
      session = http2.connect(target.origin, { settings: { enablePush: false } });
      session.once('error', error => finish(error));
      const requestHeaders = {
        ':method': 'GET',
        ':scheme': 'https',
        ':authority': target.host,
        ':path': `${target.pathname}${target.search}`,
      };
      for (const [name, value] of Object.entries(headers || {})) {
        const key = name.toLowerCase();
        if (value != null && !['host', 'connection', 'transfer-encoding'].includes(key)) requestHeaders[key] = String(value);
      }
      request = session.request(requestHeaders);
      request.once('response', responseHeaders => {
        finish(null, {
          status: Number(responseHeaders[':status'] || 0),
          location: responseHeaders.location ? String(responseHeaders.location) : '',
        });
      });
      request.once('error', error => finish(error));
      request.setTimeout(timeout, () => finish(new Error('Rule34Video HTTP/2 probe timed out')));
      timer = setTimeout(() => finish(new Error('Rule34Video HTTP/2 probe timed out')), timeout + 1000);
      request.end();
    } catch (error) { finish(error); }
  });
}

async function requestRule34VideoHttp1(url, headers) {
  try {
    const response = await http.get(url, {
      maxRedirects: 0,
      responseType: 'stream',
      headers,
      timeout: 12000,
    });
    if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
    return { status: Number(response.status || 0), location: response.headers?.location || '' };
  } catch (error) {
    if (error.response) {
      if (error.response.data && typeof error.response.data.destroy === 'function') error.response.data.destroy();
      return { status: Number(error.response.status || 0), location: error.response.headers?.location || '' };
    }
    throw error;
  }
}

async function probeRule34VideoRedirects(sourceUrl, pageUrl, session = {}) {
  let currentUrl = sourceUrl;
  const visited = new Set();
  for (let hop = 0; hop < 6; hop++) {
    if (visited.has(currentUrl)) break;
    visited.add(currentUrl);
    const headers = rule34VideoHeadersForUrl(currentUrl, pageUrl, session);
    let response;
    try {
      // The current tokenized file server rejects HTTP/1.1 probes with 403.
      // Resolve redirects over HTTP/2 and cancel the media body immediately.
      response = await requestRule34VideoHttp2(currentUrl, headers);
    } catch (http2Error) {
      try { response = await requestRule34VideoHttp1(currentUrl, headers); }
      catch (http1Error) {
        console.warn(`[Rule34Video] redirect probe failed: ${http2Error.code || http1Error.code || http1Error.message}`);
        break;
      }
    }
    const status = Number(response?.status || 0);
    const location = response?.location;
    if (![301, 302, 303, 307, 308].includes(status) || !location) break;
    const nextUrl = absUrl(location, currentUrl);
    if (!nextUrl || nextUrl === currentUrl) break;
    currentUrl = nextUrl;
  }
  return currentUrl;
}

async function resolveRule34VideoStreams(pageUrl) {
  const { html, session } = await fetchRule34VideoPage(pageUrl);
  const sources = parseRule34VideoSources(html, pageUrl);
  const streams = await Promise.all(sources.map(async source => {
    try {
      const mediaUrl = await probeRule34VideoRedirects(source.url, pageUrl, session);
      const stream = streamObject('Rule34Video', mediaUrl, pageUrl, false, source.label);
      stream.behaviorHints.proxyHeaders.request = rule34VideoHeadersForUrl(mediaUrl, pageUrl, session);
      const labelQuality = qualityFromLabel(source.label, true);
      if (labelQuality) stream.title = `${labelQuality} · MP4`;
      else if (/\b(?:source|original)\b/i.test(source.label)) stream.title = 'Source · MP4';
      return stream;
    } catch { return null; }
  }));
  return dedupeRule34VideoStreams(streams.filter(Boolean)).slice(0, 20);
}

const HSTREAM_SITE = 'https://hstream.moe/';
const HSTREAM_API = 'https://hstream.moe/player/api';

function parseHStreamEpisodeId(html) {
  const source = normalizePlayerText(String(html || ''));
  const exact = source.match(/e_id"\s+type="hidden"\s+value="([^"]+)"/i);
  if (exact?.[1]) return clean(exact[1]);
  for (const tag of source.matchAll(/<input\b[^>]*>/gi)) {
    const attrs = {};
    for (const match of tag[0].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gi)) attrs[match[1].toLowerCase()] = match[3];
    if ((attrs.name === 'e_id' || attrs.id === 'e_id') && (!attrs.type || attrs.type.toLowerCase() === 'hidden')) {
      return clean(attrs.value || '');
    }
  }
  return '';
}

function parseHStreamCookieHeader(value) {
  const out = {};
  for (const item of String(value || '').split(';')) {
    const part = item.trim();
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const val = part.slice(index + 1).trim();
    if (key && val) out[key] = val;
  }
  return out;
}

function hstreamCookiesFromResponse(setCookie = []) {
  const out = {};
  const values = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  for (const cookie of values) {
    const first = String(cookie || '').split(';', 1)[0];
    const index = first.indexOf('=');
    if (index <= 0) continue;
    out[first.slice(0, index).trim()] = first.slice(index + 1).trim();
  }
  return out;
}

function isPublicHStreamHttpsDomain(value) {
  try {
    const parsed = new URL(/^https:\/\//i.test(String(value || '')) ? String(value) : `https://${String(value || '').replace(/^\/\//, '')}`);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    const kind = net.isIP(host);
    if (kind === 4) {
      const octets = host.split('.').map(Number);
      const [a, b] = octets;
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19))) return false;
    } else if (kind === 6) {
      if (host === '::' || host === '::1' || /^f[cd]/i.test(host) || /^fe[89ab]/i.test(host)) return false;
    } else if (!host.includes('.') || !/^[a-z0-9.-]+$/i.test(host)) return false;
    return true;
  } catch { return false; }
}

function hstreamPathUrl(domain, streamPath, suffix) {
  try {
    if (!isPublicHStreamHttpsDomain(domain)) return '';
    const root = new URL(/^https:\/\//i.test(domain) ? domain : `https://${String(domain).replace(/^\/\//, '')}`);
    const rawPath = String(streamPath || '').trim();
    if (!rawPath || /^(?:https?:)?\/\//i.test(rawPath) || /(?:^|\/)\.\.(?:\/|$)/.test(rawPath)) return '';
    const result = new URL(rawPath.replace(/^\/+/, ''), `${root.origin}/`);
    if (result.origin !== root.origin) return '';
    result.pathname = `${result.pathname.replace(/\/+$/, '')}/${suffix}`;
    result.hash = '';
    return result.href;
  } catch { return ''; }
}

function hstreamResolutionLimit(value) {
  const text = clean(value).toLowerCase().replace(/\s+/g, '');
  if (!text) return 0;
  if (/(?:4k|2160|uhd)/i.test(text)) return 2160;
  const match = text.match(/(?:^|\D)(1080|720)(?:p|$|\D)/i);
  return match ? Number(match[1]) : 0;
}

function buildHStreamSourceCandidates(apiData) {
  const data = apiData?.data && !apiData.stream_url ? apiData.data : apiData;
  if (!data || typeof data !== 'object' || !data.stream_url || !Array.isArray(data.stream_domains)) return null;
  const domains = [...new Set(data.stream_domains.filter(isPublicHStreamHttpsDomain))];
  if (!domains.length) return null;

  // Match the GetSauce/yt-dlp HStream format map: 720p H.264 MP4 and
  // 1080p AV1 WEBM are the regular set. 2160p is attempted only when the
  // player API explicitly reports 4K/2160p; it is never inferred from a title.
  const maximum = hstreamResolutionLimit(data.resolution);
  const qualities = [720, 1080];
  if (maximum >= 2160) qualities.push(2160);
  const preferredQualities = qualities.slice().sort((a, b) => b - a);
  const direct = preferredQualities.map(q => q === 720
    ? { suffix: 'x264.720p.mp4', quality: '720p', format: 'MP4' }
    : { suffix: `av1.${q}p.webm`, quality: `${q}p`, format: 'WEBM' });
  const legacy = Number(data.legacy ?? 0) !== 0;
  // Probe every DASH rung like GetSauce does; the manifest itself decides
  // whether 2160p, 1080p, or 720p actually exists for this episode.
  const dash = legacy ? [] : [2160, 1080, 720].map(q => ({ suffix: `${q}/manifest.mpd`, quality: `${q}p`, format: 'DASH' }));
  const results = [];
  for (const variant of dash) for (const domain of domains) {
    const url = hstreamPathUrl(domain, data.stream_url, variant.suffix);
    if (url) results.push({ ...variant, url, domain });
  }
  const directResults = [];
  for (const variant of direct) for (const domain of domains) {
    const url = hstreamPathUrl(domain, data.stream_url, variant.suffix);
    if (url) directResults.push({ ...variant, url, domain });
  }
  return {
    dash: results,
    direct: directResults,
    title: clean(data.title || ''),
    poster: clean(data.poster || ''),
    legacy,
    resolutionLimit: maximum,
  };
}

async function fetchHStreamEpisodeData(episodeUrl) {
  const configuredCookies = parseHStreamCookieHeader(process.env.HSTREAM_COOKIE || process.env.HSTREAM_COOKIES || '');
  const configuredCookieHeader = Object.entries(configuredCookies).map(([key, value]) => `${key}=${value}`).join('; ');
  const response = await http.get(episodeUrl, {
    responseType: 'text',
    timeout: Number(process.env.HSTREAM_TIMEOUT_MS || 20000),
    validateStatus: status => status >= 200 && status < 500,
    headers: { Referer: HSTREAM_SITE, Accept: 'text/html,application/xhtml+xml', ...(configuredCookieHeader ? { Cookie: configuredCookieHeader } : {}) },
  });
  let html = String(response.data || '');
  let pageCookies = { ...configuredCookies, ...hstreamCookiesFromResponse(response.headers?.['set-cookie']) };
  if (/DDOS-GUARD/i.test(html)) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const retry = await http.get(episodeUrl, {
      responseType: 'text',
      timeout: Number(process.env.HSTREAM_TIMEOUT_MS || 20000),
      validateStatus: status => status >= 200 && status < 500,
      headers: { Referer: HSTREAM_SITE, Accept: 'text/html,application/xhtml+xml', ...(Object.keys(pageCookies).length ? { Cookie: Object.entries(pageCookies).map(([k, v]) => `${k}=${v}`).join('; ') } : {}) },
    });
    html = String(retry.data || '');
    pageCookies = { ...pageCookies, ...hstreamCookiesFromResponse(retry.headers?.['set-cookie']) };
  }
  const episodeId = parseHStreamEpisodeId(html);
  if (!episodeId) throw new Error('HStream page did not expose hidden e_id');
  const xsrf = pageCookies['XSRF-TOKEN'];
  const session = pageCookies.hstream_session;
  if (!xsrf || !session) {
    throw new Error('HStream requires XSRF-TOKEN and hstream_session cookies; set HSTREAM_COOKIE if the host blocks guest requests');
  }
  let decodedXsrf;
  try { decodedXsrf = decodeURIComponent(xsrf); } catch { decodedXsrf = xsrf; }
  const cookieHeader = Object.entries(pageCookies).map(([key, value]) => `${key}=${value}`).join('; ');
  const apiResponse = await http.post(HSTREAM_API, { episode_id: episodeId }, {
    timeout: Number(process.env.HSTREAM_TIMEOUT_MS || 20000),
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
      Referer: episodeUrl,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Xsrf-Token': decodedXsrf,
      Accept: 'application/json, text/plain, */*',
    },
  });
  const apiData = apiResponse?.data;
  if (!apiData || typeof apiData !== 'object' || !apiData.stream_url || !Array.isArray(apiData.stream_domains)) {
    throw new Error('HStream player API returned no stream_domains/stream_url');
  }
  return { data: apiData, episodeId, cookies: pageCookies };
}

function parseHStreamDashQuality(xml, fallbackQuality = '') {
  const source = String(xml || '');
  if (!/<MPD\b/i.test(source) || !/<(?:Representation|SegmentTemplate|SegmentList)\b/i.test(source)) return '';
  const heights = [];
  for (const rep of source.matchAll(/<Representation\b([^>]*)>/gi)) {
    const attrs = rep[1];
    const height = attrs.match(/\bheight\s*=\s*["'](\d+)["']/i);
    if (height) {
      const n = Number(height[1]);
      if (n >= 144 && n <= 4320) heights.push(n);
    }
  }
  if (heights.length) {
    const actual = Math.max(...heights);
    // Convert exact MPD height to standard consumer quality labels.
    if (actual >= 2000) return '2160p';
    if (actual >= 1000) return '1080p';
    if (actual >= 700) return '720p';
    if (actual >= 400) return '480p';
    if (actual >= 300) return '360p';
    return `${actual}p`;
  }
  // Some single-resolution manifests omit Representation@height. In that
  // case, the GetSauce URL path itself is explicitly resolution-scoped.
  return fallbackQuality || '';
}

async function fetchHStreamDashManifest(url, referer = HSTREAM_SITE, fallbackQuality = '') {
  try {
    const response = await http.get(url, {
      responseType: 'text',
      timeout: Number(process.env.HSTREAM_TIMEOUT_MS || 20000),
      maxContentLength: 1024 * 1024,
      headers: { Referer: referer, Accept: 'application/dash+xml,application/xml,text/xml,*/*' },
    });
    const quality = parseHStreamDashQuality(response.data, fallbackQuality);
    return quality ? { quality, xml: String(response.data || '') } : null;
  } catch { return null; }
}

async function isHStreamDashManifest(url) {
  return Boolean(await fetchHStreamDashManifest(url, HSTREAM_SITE, ''));
}

function hstreamMediaContentType(value) {
  return /^video\/(?:mp4|webm|x-matroska)(?:\s*;|$)/i.test(String(value || '').trim());
}

function hstreamMediaSignature(url, payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  if (bytes.length < 4) return false;
  let extension = '';
  try { extension = new URL(url).pathname.toLowerCase().split('.').pop(); } catch {}
  if (extension === 'webm') return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (extension === 'mp4') {
    const atom = bytes.subarray(4, 8).toString('ascii');
    return atom === 'ftyp' || atom === 'styp';
  }
  return false;
}

async function isHStreamDirectSourceAvailable(url, referer = HSTREAM_SITE) {
  const timeout = Number(process.env.HSTREAM_TIMEOUT_MS || 20000);
  const headers = { Referer: referer, Accept: '*/*' };
  // Do not trust a bare 200 response: anti-bot/login HTML can masquerade as a
  // media URL. Accept declared video/octet-stream, otherwise inspect a few
  // signature bytes after a tiny Range GET.
  try {
    const response = await http.head(url, { timeout, maxRedirects: 5, headers });
    const status = Number(response?.status || 0);
    const responseHeaders = response?.headers || {};
    const contentType = String(responseHeaders['content-type'] || responseHeaders['Content-Type'] || '').toLowerCase();
    const contentLengthHeader = responseHeaders['content-length'] || responseHeaders['Content-Length'];
    const hasNonzeroLength = !contentLengthHeader || Number(contentLengthHeader) > 0;
    if (status >= 200 && status < 400 && hstreamMediaContentType(contentType) && hasNonzeroLength) return true;
  } catch { /* fall through to Range GET */ }

  try {
    const response = await http.get(url, {
      timeout,
      maxRedirects: 5,
      responseType: 'arraybuffer',
      maxContentLength: 64,
      maxBodyLength: 64,
      headers: { ...headers, Range: 'bytes=0-15' },
    });
    const status = Number(response?.status || 0);
    const responseHeaders = response?.headers || {};
    const contentRange = String(responseHeaders['content-range'] || responseHeaders['Content-Range'] || '');
    const contentType = String(responseHeaders['content-type'] || responseHeaders['Content-Type'] || '').toLowerCase();
    const rangeOk = status === 206 || /^bytes\s+\d+-\d+\//i.test(contentRange);
    if (!rangeOk || /(?:text\/html|application\/json)/i.test(contentType)) return false;
    return hstreamMediaContentType(contentType) || hstreamMediaSignature(url, response.data);
  } catch { return false; }
}

async function resolveHStreamStreams(episodeUrl) {
  const { data } = await fetchHStreamEpisodeData(episodeUrl);
  const candidates = buildHStreamSourceCandidates(data);
  if (!candidates) throw new Error('HStream player API response is missing stream data');

  const byQuality = new Map();
  const addStream = (variant, quality, prefer = false) => {
    if (!quality) return;
    const stream = streamObject('HStream', variant.url, episodeUrl, false, quality);
    stream.title = `${quality} · ${variant.format}`;
    stream.behaviorHints.proxyHeaders.request = {
      Referer: HSTREAM_SITE,
      Origin: new URL(HSTREAM_SITE).origin,
      'User-Agent': UA,
    };
    const current = byQuality.get(quality);
    if (!current || prefer) byQuality.set(quality, stream);
  };

  // Probe each DASH rendition independently and read Representation@height.
  // One valid 720p MPD must not suppress an available 1080p direct fallback.
  for (const variant of candidates.dash) {
    const info = await fetchHStreamDashManifest(variant.url, HSTREAM_SITE, variant.quality);
    if (info) addStream(variant, info.quality, true);
  }

  // Always check direct H.264/AV1 files too. The API may expose a usable 1080p
  // AV1 file even when only one of the DASH manifests responds successfully.
  for (const variant of candidates.direct) {
    if (await isHStreamDirectSourceAvailable(variant.url, HSTREAM_SITE)) {
      addStream(variant, variant.quality, false);
    }
  }

  return sortQualityStreams([...byQuality.values()]).slice(0, 12);
}

function htmlProvider(config) {
  return {
    ...config,
    async catalog(args) {
      const selectedGenre = clean(args.genre);
      const isNewFeed = normalizedTextKey(selectedGenre) === 'new';
      const normalizedArgs = { ...args, genre: isNewFeed ? '' : selectedGenre, mode: isNewFeed ? 'new' : (args.mode || '') };
      const queryKey = `${config.id}|page:${Math.max(1, Number(args.page) || 1)}|mode:${normalizedArgs.mode}|genre:${normalizedArgs.genre.toLowerCase()}|search:${clean(args.search).toLowerCase()}`;
      return cached(`parsed-catalog:${queryKey}`, CATALOG_TTL, () => fetchCatalog(config, normalizedArgs));
    },
    async meta(key) {
      const data = await pageMeta(key, config);
      if (!data.poster) {
        const cards = parseCards(await getHtml(key, config.base, config.timeout), key);
        if (cards[0]) data.poster = cards[0].poster;
      }
      return data;
    },
    async streams(key) {
      if (config.id === 'hstream') return resolveHStreamStreams(key);
      if (config.id === 'hentaimama') return resolveHentaiMamaStreams(key);
      if (config.id === 'rule34video') return resolveRule34VideoStreams(key);
      return resolveStreams(config.name, key, config.id);
    },
  };
}

const hentaimama = htmlProvider({ id: 'hentaimama', name: 'HentaiMama', base: process.env.HENTAIMAMA_BASE || 'https://hentaimama.io', listPaths: ['/recent-episodes/', '/'], newPaths: ['/hentai-series/?filter=recent'], genrePaths: ['/genre/{g}/'] });
const hentaigasm = htmlProvider({ id: 'hentaigasm', name: 'Hentaigasm', base: process.env.HENTAIGASM_BASE || 'https://hentaigasm.com', listPaths: ['/'], newPaths: ['/hentai/new-hentai-release/'], genrePaths: ['/genre/{g}/', '/tag/{g}/', '/category/{g}/'] });
const rule34video = htmlProvider({ id: 'rule34video', name: 'Rule34Video', base: process.env.RULE34VIDEO_BASE || 'https://rule34video.com', listPaths: ['/latest-updates/'], newPaths: ['/latest-updates/'] });
const hstream = htmlProvider({ id: 'hstream', name: 'HStream', base: process.env.HSTREAM_BASE || 'https://hstream.moe', listPaths: ['/'], newPaths: ['/'] });

const PROVIDERS = { hentaimama, hentaigasm, rule34video, hstream };
const makeExtra = genres => [
  { name: 'search', isRequired: false },
  { name: 'genre', isRequired: false, options: ['New', ...genres.filter(genre => normalizedTextKey(genre) !== 'new')], optionsLimit: 1 },
  { name: 'skip', isRequired: false },
];
const catalogs = Object.values(PROVIDERS).map(provider => ({
  type: TYPE,
  id: `hn-${provider.id}`,
  name: provider.name,
  extra: makeExtra(PROVIDER_GENRES[provider.id] || GENRES),
}));
const manifest = {
  id: 'community.hentai.hub',
  version: '2.7.12',
  name: 'Hentai',
  description: 'HentaiMama, Hentaigasm, Rule34Video, and HStream catalogs. Adults 18+ only.',
  resources: ['catalog', 'meta', 'stream'],
  types: [TYPE],
  idPrefixes: ['hn:'],
  catalogs,
  behaviorHints: { adult: true, configurable: false },
};
const builder = new addonBuilder(manifest);
const makeId = (providerId, key) => `hn:${providerId}:${encodeKey(key)}`;
function parseId(id) {
  const parts = String(id || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'hn') return null;
  try { return { providerId: parts[1], key: decodeKey(parts[2]) }; } catch { return null; }
}
function selectedProviders(id) {
  const name = String(id || '').replace(/^hn-/, '');
  return PROVIDERS[name] ? [PROVIDERS[name]] : [];
}

async function collectProviderCatalog(provider, { search = '', genre = '', target = PAGE_SIZE, maxPages } = {}) {
  const desired = Math.max(1, Number(target) || PAGE_SIZE);
  const pageCap = Math.min(3000, Math.max(1, Number(maxPages) || Math.ceil(desired / 8) + 2));
  const list = [];
  const seenKeys = new Set();
  const seenPages = new Set();
  for (let page = 1; page <= pageCap; page++) {
    let pageItems;
    try {
      pageItems = await provider.catalog({ search, genre, page });
    } catch (e) {
      console.error(`[${provider.name}] catalog failed at ${provider.catalogUrl || provider.base || 'unknown URL'} (source page ${page}): ${e.code || e.response?.status || e.message}`);
      break;
    }
    if (!pageItems || !pageItems.length) break;
    const fingerprint = catalogPageFingerprint(pageItems);
    if (seenPages.has(fingerprint)) break;
    seenPages.add(fingerprint);
    let newItems = 0;
    for (const item of pageItems) {
      const key = String(item.key || '');
      if (!key || !item.name || !item.poster || blocked(item)) continue;
      let duplicateKey = key;
      if (provider.id === 'hentaimama') {
        let posterKey = String(item.poster).split('?')[0].split('#')[0].toLowerCase();
        try {
          const posterUrl = new URL(posterKey);
          posterUrl.hostname = canonicalHost(posterUrl.hostname);
          posterKey = posterUrl.href;
        } catch {}
        duplicateKey = `${normalizedTextKey(item.name)}|${posterKey}`;
      }
      if (seenKeys.has(duplicateKey)) continue;
      seenKeys.add(duplicateKey);
      list.push({ ...item, providerId: provider.id });
      newItems++;
    }
    if (list.length >= desired || newItems === 0) break;
  }
  return list;
}
function interleaveCatalogLists(providerLists) {
  const combined = [];
  for (let i = 0; providerLists.some(list => i < list.length); i++) {
    for (const list of providerLists) if (list[i]) combined.push(list[i]);
  }
  return combined;
}

builder.defineCatalogHandler(async ({ id, extra = {} }) => {
  const selected = selectedProviders(id);
  if (!selected.length) return { metas: [], cacheMaxAge: 300 };
  const search = clean(extra.search);
  const genre = clean(extra.genre);
  const skip = Math.max(0, Number(extra.skip) || 0);

  // Fetch enough source pages to cover Stremio pagination, then apply skip.
  const targetPerProvider = Math.ceil((skip + PAGE_SIZE) / selected.length);
  const maxSourcePages = Math.min(3000, Math.max(2, Math.ceil(targetPerProvider / 8) + 2));
  const providerLists = await Promise.all(selected.map(provider => collectProviderCatalog(provider, {
    search, genre, target: targetPerProvider, maxPages: maxSourcePages,
  })));
  const combined = interleaveCatalogLists(providerLists);
  const metas = combined.slice(skip, skip + PAGE_SIZE).map(item => ({
    id: makeId(item.providerId, item.key),
    type: TYPE,
    name: item.name,
    poster: item.poster,
    posterShape: posterShapeFor(item, genre),
    ...(item.description ? { description: item.description } : {}),
    ...(item.genres?.length ? { genres: item.genres } : {}),
  }));
  return { metas, cacheMaxAge: Math.floor(CATALOG_TTL / 1000) };
});

builder.defineMetaHandler(async ({ id }) => {
  const parsed = parseId(id); if (!parsed) return { meta: null };
  const provider = PROVIDERS[parsed.providerId]; if (!provider) return { meta: null };
  try {
    const data = await provider.meta(parsed.key);
    if (!data || data.blocked || blocked(data)) return { meta: null };
    const episodes = Array.isArray(data.episodes) && data.episodes.length ? data.episodes : [{ key: parsed.key, title: data.name }];
    const seen = new Set();
    const videos = episodes.filter(ep => ep.key && !seen.has(ep.key) && seen.add(ep.key)).map((ep, index) => ({ id: makeId(parsed.providerId, ep.key), title: clean(ep.title) || `Part ${index + 1}`, season: 1, episode: index + 1, released: new Date(Date.UTC(2000, 0, 1 + index)).toISOString() }));
    return { meta: { id, type: TYPE, name: clean(data.name) || 'Untitled', ...(data.poster ? { poster: data.poster } : {}), ...(data.background || data.poster ? { background: data.background || data.poster } : {}), ...(data.description ? { description: data.description } : {}), ...(data.genres?.length ? { genres: data.genres } : {}), videos }, cacheMaxAge: Math.floor(DETAIL_TTL / 1000) };
  } catch (e) { console.error(`[${provider.name}] metadata failed: ${e.code || e.response?.status || e.message}`); return { meta: null, cacheMaxAge: 60 }; }
});

builder.defineStreamHandler(async ({ id }) => {
  const parsed = parseId(id); if (!parsed) return { streams: [] };
  const provider = PROVIDERS[parsed.providerId]; if (!provider) return { streams: [] };
  try {
    const ttl = parsed.providerId === 'hentaigasm' ? STREAM_TTL : FRESH_STREAM_TTL;
    const streams = await cached(`streams:${parsed.providerId}:${parsed.key}`, ttl, async () => {
      const resolved = await provider.streams(parsed.key);
      return parsed.providerId === 'hentaimama'
        ? sortHentaiMamaStreams(resolved || [])
        : expandHlsQualityStreams(resolved || []);
    });
    return { streams: (streams || []).slice(0, 20), cacheMaxAge: Math.floor(ttl / 1000) };
  } catch (e) { console.error(`[${provider.name}] streams failed: ${e.code || e.response?.status || e.message}`); return { streams: [], cacheMaxAge: 60 }; }
});

if (require.main === module) {
  let server;
  try {
    const config = getListenConfig();
    console.log(`Starting Hentai v2.7.12; PORT=${process.env.PORT || '(unset)'}, SERVER_PORT=${process.env.SERVER_PORT || '(unset)'}, selected=${config.port} (${getListenPortSource()})`);
    server = createAddonServer(builder.getInterface(), config);
    server.on('listening', () => {
      const address = server.address();
      console.log(`Hentai v2.7.12 listening on ${HOST}:${address.port}`);
      console.log(`Health: http://127.0.0.1:${address.port}/health`);
      console.log(`Manifest: http://127.0.0.1:${address.port}/manifest.json`);
    });
    server.on('error', (error) => {
      console.error(`Addon HTTP server error on ${HOST}:${config.port}: ${error.code || error.message}`);
      process.exitCode = 1;
    });
    const shutdown = (signal) => {
      console.log(`${signal} received; closing HTTP server`);
      if (!server || !server.listening) return;
      server.close((error) => {
        if (error) {
          console.error(`HTTP server shutdown failed: ${error.message}`);
          process.exitCode = 1;
        } else {
          console.log('HTTP server closed cleanly');
        }
      });
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error(`Addon startup failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  TYPE,
  HOST,
  PORT,
  getListenConfig,
  getListenPortSource,
  createAddonServer,
  manifest,
  PROVIDERS,
  PROVIDER_GENRES,
  HSTREAM_GENRES,
  posterShapeFor,
  isHentaiMamaMp4,
  isHentaiMama1080pMp4,
  sortHentaiMamaStreams,
  isPosterNoise,
  detectExplicitQuality,
  extractHentaiMamaAjaxCandidates,
  buildHentaiMamaAjaxBody,
  matchesCatalogSearch,
  discoverGenreRoute,
  selectedProviders,
  candidatePages,
  fetchCatalog,
  parseCards,
  parseRule34VideoCards,
  parseRule34VideoFlashvars,
  parseRule34VideoDownloadLinks,
  parseRule34VideoSources,
  parseHentaiMamaGenreCards,
  parseHentaiMamaRecentEpisodeCards,
  parseHentaiMamaSeriesCards,
  parseProviderCards,
  collectProviderCatalog,
  canonicalContentUrl,
  blocked,
  resolveHentaiMamaStreams,
  resolveRule34VideoStreams,
  parseHStreamEpisodeId,
  parseHStreamCookieHeader,
  hstreamCookiesFromResponse,
  isPublicHStreamHttpsDomain,
  hstreamPathUrl,
  parseHStreamDashQuality,
  fetchHStreamDashManifest,
  isHStreamDashManifest,
  isHStreamDirectSourceAvailable,
  buildHStreamSourceCandidates,
  fetchHStreamEpisodeData,
  resolveHStreamStreams,
  streamIdentity,
  dedupeStreams,
  sortQualityStreams,
  qualityFromLabel,
  resolveStreams,
};
