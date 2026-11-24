'use strict';

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const TYPE = 'hentai';
const UA = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const CATALOG_TTL = Number(process.env.CACHE_CATALOG_SECONDS || 600) * 1000;
const DETAIL_TTL = Number(process.env.CACHE_DETAIL_SECONDS || 1800) * 1000;
const STREAM_TTL = Number(process.env.CACHE_STREAM_SECONDS || 180) * 1000;
const MAMA_STREAM_TTL = Number(process.env.CACHE_STREAM_SECONDS || 25) * 1000;
const PAGE_SIZE = 20;
const PAGE_LIMIT = 100;
const MINOR_TERMS = /\b(loli(?:con)?|shota(?:con)?|underage|child porn|young girl|young boy)\b/i;
const GENRES = [
  '3D','Anal','Blowjob','Bondage','Boobjob','Cheating','Creampie','Demon','Exclusive','Exhibition',
  'Fantasy','Footjob','Futanari','Gangbang','Harem','Incest','Maid','Masturbation','Monster',
  'Motion Anime','Nurse','Preview','Rape','School','Season','Series','Sex Toy','Swimsuit',
  'Tentacle','Uncensored','Vanilla','Virgin','X-Ray','Yuri',
];
const PROVIDER_GENRES = {
  hentaigasm: GENRES,
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
    if (providerId === 'hentaimama') u.search = '';
    u.pathname = u.pathname.replace(/\/{2,}/g, '/');
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
    const hentaigasm = /hentaigasm/i.test(String(base || ''));
    if (hentaigasm) {
      // Preserve Hentaigasm's previous source ordering unchanged.
      for (const key of ['data-srcset','data-lazy-srcset','srcset']) {
        const value = $img.attr(key);
        if (value) for (const candidate of parseSrcset(value)) add(candidate);
      }
      for (const key of [
        'data-original','data-lazy-src','data-src','data-original-src','data-image',
        'data-thumb','data-poster','data-cfsrc','data-url','src',
      ]) add($img.attr(key));
    } else {
      // HentaiMama uses lazy image attributes; `src`/`srcset` may only be a
      // transparent placeholder. Prefer the actual image URL first.
      for (const key of [
        'data-original','data-lazy-src','data-src','data-original-src','data-image',
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

function candidatePagesEnhanced(config, { search, genre, page = 1 }) {
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
  return [...new Set((config.listPaths || ['/']).flatMap(path => {
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
function candidatePages(config, args) {
  if (config.id === 'hentaigasm') return candidatePagesLegacy(config, args);
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
          const label = normalizedTextKey($a.text() || $a.attr('title') || $a.attr('aria-label'));
          if (!label || map[label]) return;
          const href = absUrl($a.attr('href'), pageUrl);
          if (!href || !sameProviderHost(href, config.base)) return;
          let path = '';
          try { path = new URL(href).pathname; } catch { return; }
          if (!/^\/(?:genre|tag|category)\/[^/]+\/?$/i.test(path)) return;
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
    const hasPoster = node.find('img[src],img[data-src],img[data-original],img[data-lazy-src],img[srcset],[style*="background-image"]').length > 0;
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

function parseProviderCards(config, html, base) {
  if (config.id === 'hentaigasm') return parseCards(html, base);
  if (config.id === 'hentaimama') {
    const path = new URL(base).pathname;
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
  if (args.genre && !args.search) {
    const exactRoute = await discoverGenreRoute(config, args.genre);
    if (exactRoute) candidates = routePageCandidates(exactRoute, requestedPage);
  }
  if (requestedPage > 1 && config.id !== 'hentaigasm' && !args.genre && !args.search) {
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
  const name = hentaimamaTitle || metaText($, ['meta[property="og:title"]', 'meta[name="twitter:title"]', 'h1', 'title']) || titleFromUrl(url, config.id);
  const metaPoster = metaText($, ['meta[property="og:image"]', 'meta[name="twitter:image"]']);
  const imageBox = $('div.imagen,.poster,.cover,.thumb,.thumbnail').first();
  const poster = absUrl(metaPoster, url) || (imageBox.length ? cardPoster($, imageBox, imageBox.find('a').first(), url) : '');
  const description = metaText($, ['meta[property="og:description"]', 'meta[name="description"]']) || clean($('.entry-content p,.content p,.description p,.wp-content p,.summary').first().text());
  const genres = [...new Set($('.sgeneros a,.genres a,.genre a,a[rel="tag"],.tags a,[class*="genre"] a,a[href*="/genre/"],a[href*="/tag/"]').map((_, el) => clean($(el).text())).get().filter(x => x && x.length < 40))].slice(0, 20);
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
    const genre = normalizedTextKey(selectedGenre);
    return !genre || genre === 'all genres' || genre === '3d' ? 'landscape' : 'poster';
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
  return (streams || [])
    .filter(stream => stream?.url && isHentaiMamaMp4(stream.url))
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
  const streamUrls = new Set();
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
        if ((providerId !== 'hentaigasm' && isAdOrTracker(mediaUrl)) || streamUrls.has(mediaUrl)) continue;
        if (providerId === 'hentaimama' && !isHentaiMamaMp4(mediaUrl)) continue;
        streamUrls.add(mediaUrl);
        try { streams.push(streamObject(providerName, mediaUrl, current.url, providerId === 'hentaigasm', html)); }
        catch { /* Ignore malformed player URLs. */ }
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
  const seen = new Set();
  const addSources = (value, referer) => {
    for (const url of extractPlayerMedia(value, referer)) {
      // HentaiMama's third-party extractor documents 720p as its available
      // ceiling. Keep MP4 only and prefer the highest real player rendition;
      // never label a 720p/unknown source as 1080p.
      if (!isHentaiMamaMp4(url) || seen.has(url)) continue;
      seen.add(url);
      streams.push(streamObject('HentaiMama', url, referer, false, value));
    }
  };
  const addPlayerFrames = async (frames, referer, cookies = '') => {
    for (const frameUrl of frames.slice(0, 6)) {
      try {
        const response = await http.get(frameUrl, {
          responseType: 'text',
          headers: { Referer: referer, ...(cookies ? { Cookie: cookies } : {}) },
        });
        const playerHtml = String(response.data || '');
        addSources(playerHtml, frameUrl);
        if (!streams.length) {
          const nested = await resolveStreams('HentaiMama', frameUrl, 'hentaimama');
          for (const stream of nested) {
            if (isHentaiMamaMp4(stream.url) && !seen.has(stream.url)) { seen.add(stream.url); streams.push(stream); }
          }
        }
        if (streams.length >= 8) break;
      } catch (e) {
        console.warn(`[HentaiMama] player mirror failed (${frameUrl}): ${e.code || e.response?.status || e.message}`);
      }
    }
  };

  try {
    const pageResponse = await http.get(episodeUrl, { responseType: 'text' });
    const pageHtml = String(pageResponse.data || '');
    const cookies = (pageResponse.headers?.['set-cookie'] || []).map(v => String(v).split(';')[0]).filter(Boolean).join('; ');

    // Some mirrors expose a direct source without AJAX. Parse it before making requests.
    addSources(pageHtml, episodeUrl);
    if (streams.length) return sortHentaiMamaStreams(streams).slice(0, 8);

    // HentaiMama's player selector uses WordPress AJAX on the episode page. A single
    // `var data` object is not guaranteed; inspect all inline scripts for action + a.
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
        if (streams.length) return sortHentaiMamaStreams(streams).slice(0, 8);
        const frames = extractPlayerFrames(payload, base);
        if (frames.length) await addPlayerFrames(frames, episodeUrl, cookies);
        if (streams.length) return sortHentaiMamaStreams(streams).slice(0, 8);
      } catch (e) {
        console.warn(`[HentaiMama] AJAX candidate ${candidate.action}/${candidate.a} failed: ${e.code || e.response?.status || e.message}`);
      }
    }

    // Different templates place player iframes directly on the page or inside escaped embed code.
    const pageFrames = extractPlayerFrames(pageHtml, episodeUrl);
    if (pageFrames.length) await addPlayerFrames(pageFrames, episodeUrl, cookies);
    if (streams.length) return sortHentaiMamaStreams(streams).slice(0, 8);

    // Last resort: recurse through embedded players, but return only direct media URLs.
    const nested = await resolveStreams('HentaiMama', episodeUrl, 'hentaimama');
    for (const stream of nested) {
      if (isHentaiMamaMp4(stream.url) && !seen.has(stream.url)) { seen.add(stream.url); streams.push(stream); }
    }
  } catch (e) {
    console.warn(`[HentaiMama] stream extraction failed (${episodeUrl}): ${e.code || e.response?.status || e.message}`);
  }
  return sortHentaiMamaStreams(streams).slice(0, 8);
}

function htmlProvider(config) {
  return {
    ...config,
    async catalog(args) {
      const queryKey = `${config.id}|page:${Math.max(1, Number(args.page) || 1)}|genre:${clean(args.genre).toLowerCase()}|search:${clean(args.search).toLowerCase()}`;
      return cached(`parsed-catalog:${queryKey}`, CATALOG_TTL, () => fetchCatalog(config, args));
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
      if (config.id === 'hentaimama') return resolveHentaiMamaStreams(key);
      return resolveStreams(config.name, key, config.id);
    },
  };
}

const hentaimama = htmlProvider({ id: 'hentaimama', name: 'HentaiMama', base: process.env.HENTAIMAMA_BASE || 'https://hentaimama.io', listPaths: ['/recent-episodes/', '/'], genrePaths: ['/genre/{g}/'] });
const hentaigasm = htmlProvider({ id: 'hentaigasm', name: 'Hentaigasm', base: process.env.HENTAIGASM_BASE || 'https://hentaigasm.com', listPaths: ['/'], genrePaths: ['/genre/{g}/', '/tag/{g}/', '/category/{g}/'] });
// Only the two requested anime catalogs are registered in the Stremio manifest.
const PROVIDERS = { hentaimama, hentaigasm };
const makeExtra = genres => [
  { name: 'search', isRequired: false },
  { name: 'genre', isRequired: false, options: genres, optionsLimit: 1 },
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
  version: '2.6.9',
  name: 'Porn',
  description: 'HentaiMama and Hentaigasm catalogs. Adults 18+ only.',
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
    const ttl = parsed.providerId === 'hentaigasm' ? STREAM_TTL : MAMA_STREAM_TTL;
    const streams = await cached(`streams:${parsed.providerId}:${parsed.key}`, ttl, async () => {
      const resolved = await provider.streams(parsed.key);
      if (parsed.providerId === 'hentaimama') return sortHentaiMamaStreams(resolved || []);
      return expandHlsQualityStreams(resolved || []);
    });
    return { streams: (streams || []).slice(0, 20), cacheMaxAge: Math.floor(ttl / 1000) };
  } catch (e) { console.error(`[${provider.name}] streams failed: ${e.code || e.response?.status || e.message}`); return { streams: [], cacheMaxAge: 60 }; }
});

if (require.main === module) {
  serveHTTP(builder.getInterface(), { port: PORT });
  console.log(`Porn v2.6.9 listening on port ${PORT}`);
  console.log(`Manifest: http://127.0.0.1:${PORT}/manifest.json`);
}

module.exports = {
  TYPE,
  manifest,
  PROVIDERS,
  PROVIDER_GENRES,
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
  parseHentaiMamaGenreCards,
  parseHentaiMamaRecentEpisodeCards,
  parseProviderCards,
  collectProviderCatalog,
  canonicalContentUrl,
  blocked,
  resolveHentaiMamaStreams,
  resolveStreams,
};
