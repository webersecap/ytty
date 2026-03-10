const YT_BASE        = 'https://www.youtube.com';
const INNERTUBE_BASE = `${YT_BASE}/youtubei/v1`;

const ANDROID_VERSION   = '19.44.38';
const ANDROID_SDK       = 30;
const ANDROID_UA        = `com.google.android.youtube/${ANDROID_VERSION} (Linux; U; Android 11) gzip`;
const ANDROID_CLIENT_ID = '3';

const WEB_VERSION       = '2.20241126.01.00';
const WEB_UA            = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WEB_CLIENT_ID     = '1';


async function generateSapisidHash(cookie) {
  try {
    const sapisid =
      cookie.match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/)?.[1] ??
      cookie.match(/(?:^|;\s*)SAPISID=([^;]+)/)?.[1];
    if (!sapisid) return null;

    const ts     = Math.floor(Date.now() / 1000);
    const crypto = await import('node:crypto');
    const hash   = crypto.createHash('sha1')
      .update(`${ts} ${sapisid} ${YT_BASE}`)
      .digest('hex');
    return `${ts}_${hash}`;
  } catch (_) { return null; }
}

function makeHeaders(clientId, clientVersion, ua, cookie, sapisidHash) {
  return {
    'Content-Type':              'application/json',
    'User-Agent':                ua,
    'X-YouTube-Client-Name':    clientId,
    'X-YouTube-Client-Version': clientVersion,
    'Accept-Language':           'en-US,en;q=0.9',
    'Origin':                    YT_BASE,
    'Referer':                   `${YT_BASE}/`,
    'Cookie':                    cookie,
    ...(sapisidHash ? { 'Authorization': `SAPISIDHASH ${sapisidHash}`, 'X-Origin': YT_BASE } : {}),
  };
}

// ─── Player Fetch ─────────────────────────────────────────────────────────────

async function fetchPlayerData(videoId, cookie) {
  if (!cookie) throw new Error('YT_COOKIE not set. Run: vercel env add YT_COOKIE');

  const sapisidHash = await generateSapisidHash(cookie);

  // Try ANDROID first — no PO token needed with cookie auth
  for (const [name, clientId, version, ua, extra] of [
    ['ANDROID', ANDROID_CLIENT_ID, ANDROID_VERSION, ANDROID_UA, { androidSdkVersion: ANDROID_SDK }],
    ['WEB',     WEB_CLIENT_ID,     WEB_VERSION,     WEB_UA,     {}],
  ]) {
    try {
      const res = await fetch(`${INNERTUBE_BASE}/player?prettyPrint=false`, {
        method:  'POST',
        headers: makeHeaders(clientId, version, ua, cookie, sapisidHash),
        body: JSON.stringify({
          context: {
            client: { clientName: name, clientVersion: version, ...extra, hl: 'en', gl: 'US', utcOffsetMinutes: 0 },
          },
          videoId, contentCheckOk: true, racyCheckOk: true,
        }),
      });

      if (!res.ok) { console.warn(`[${name}] HTTP ${res.status}`); continue; }

      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch (_) { console.warn(`[${name}] non-JSON response: ${text.slice(0, 80)}`); continue; }

      const formatCount = (data?.streamingData?.formats?.length ?? 0) +
                          (data?.streamingData?.adaptiveFormats?.length ?? 0);
      if (formatCount > 0) return { data, client: name };

      // Keep going if no streams but log the status
      console.warn(`[${name}] status=${data?.playabilityStatus?.status}, formats=0`);
    } catch (e) {
      console.warn(`[${name}] error: ${e.message}`);
    }
  }

  // Return best-effort even with no streams
  return { data: null, client: 'none' };
}

async function fetchPlaylistData(playlistId, cookie) {
  const sapisidHash = await generateSapisidHash(cookie ?? '');
  const res = await fetch(`${INNERTUBE_BASE}/browse?prettyPrint=false`, {
    method:  'POST',
    headers: makeHeaders(WEB_CLIENT_ID, WEB_VERSION, WEB_UA, cookie ?? '', sapisidHash),
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: WEB_VERSION, hl: 'en', gl: 'US' } },
      browseId: `VL${playlistId}`,
    }),
  });
  if (!res.ok) throw new Error(`Playlist fetch failed: ${res.status}`);
  return res.json();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractVideoId(raw) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = raw?.match(p);
    if (m) return m[1];
  }
  return null;
}

function extractPlaylistId(raw) {
  return raw?.match(/[?&]list=([a-zA-Z0-9_-]+)/)?.[1] ?? null;
}

function fmtBytes(b) {
  if (!b) return 'unknown';
  const k = 1024, sizes = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(+b) / Math.log(k));
  return parseFloat((+b / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function send(res, data, status = 200) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.status(status).json(data);
}

function sendError(res, msg, status = 400) {
  send(res, { error: msg }, status);
}

// ─── Format Processing ────────────────────────────────────────────────────────

function parseFormats(playerData) {
  const sd = playerData?.streamingData;
  if (!sd) return { video: [], audio: [], muxed: [] };

  const muxed = (sd.formats ?? []).filter(f => f.url).map(f => ({
    itag: f.itag, mimeType: f.mimeType, quality: f.qualityLabel ?? f.quality,
    fps: f.fps, width: f.width, height: f.height,
    bitrate: f.bitrate, filesize: fmtBytes(f.contentLength), url: f.url, type: 'muxed',
  }));

  const videoOnly = (sd.adaptiveFormats ?? []).filter(f => f.mimeType?.startsWith('video/') && f.url).map(f => ({
    itag: f.itag, mimeType: f.mimeType, quality: f.qualityLabel ?? f.quality,
    fps: f.fps, width: f.width, height: f.height,
    bitrate: f.bitrate, filesize: fmtBytes(f.contentLength), url: f.url, type: 'video-only',
  }));

  const audioOnly = (sd.adaptiveFormats ?? []).filter(f => f.mimeType?.startsWith('audio/') && f.url).map(f => ({
    itag: f.itag, mimeType: f.mimeType,
    audioQuality: f.audioQuality, audioSampleRate: f.audioSampleRate,
    audioBitrate: f.averageBitrate ?? f.bitrate,
    filesize: fmtBytes(f.contentLength), url: f.url, type: 'audio-only',
  })).sort((a, b) => (b.audioBitrate ?? 0) - (a.audioBitrate ?? 0));

  return { video: videoOnly, audio: audioOnly, muxed };
}

function pickVideoFormat(formats, quality) {
  const q = parseInt(quality, 10);
  const all = [...formats.muxed, ...formats.video];
  if (!all.length) return null;
  if (!q || isNaN(q)) return all.sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
  return all.find(f => f.height === q)
    ?? all.filter(f => (f.height ?? 0) <= q).sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]
    ?? all.sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
}

function pickAudioFormat(formats) { return formats.audio[0] ?? null; }

// ─── Route Handlers ───────────────────────────────────────────────────────────

async function handleInfo(req, res, cookie) {
  const videoId = extractVideoId(req.query.url);
  if (!videoId) return sendError(res, 'Could not extract video ID from URL');

  const { data: playerData, client } = await fetchPlayerData(videoId, cookie);
  const details = playerData?.videoDetails;
  if (!details) return sendError(res, `Video unavailable: ${playerData?.playabilityStatus?.reason ?? 'Unknown'}`, 404);

  const formats = parseFormats(playerData);
  const secs    = parseInt(details.lengthSeconds ?? 0);
  send(res, {
    videoId, client,
    title:         details.title,
    author:        details.author,
    channelId:     details.channelId,
    description:   (details.shortDescription ?? '').slice(0, 300),
    duration:      `${Math.floor(secs / 60)}m ${secs % 60}s`,
    viewCount:     parseInt(details.viewCount ?? '0').toLocaleString(),
    isLiveContent: details.isLiveContent ?? false,
    thumbnail:     `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    availableFormats: {
      videoQualities: [...new Set([...formats.muxed, ...formats.video].map(f => f.quality).filter(Boolean))],
      audioFormats:   formats.audio.map(f => ({ itag: f.itag, mimeType: f.mimeType, audioQuality: f.audioQuality, bitrate: f.audioBitrate, filesize: f.filesize })),
      totalVideoFormats: formats.video.length + formats.muxed.length,
      totalAudioFormats: formats.audio.length,
    },
  });
}

async function handleFormats(req, res, cookie) {
  const videoId = extractVideoId(req.query.url);
  if (!videoId) return sendError(res, 'Could not extract video ID from URL');

  const { data: playerData, client } = await fetchPlayerData(videoId, cookie);
  if (!playerData?.videoDetails) return sendError(res, `Video unavailable: ${playerData?.playabilityStatus?.reason ?? 'Unknown'}`, 404);

  const formats = parseFormats(playerData);
  send(res, { videoId, client, title: playerData.videoDetails.title,
    formats: { muxed: formats.muxed, videoOnly: formats.video, audioOnly: formats.audio } });
}

async function handleDownload(req, res, cookie) {
  const videoId = extractVideoId(req.query.url);
  if (!videoId) return sendError(res, 'Could not extract video ID from URL');

  const { data: playerData } = await fetchPlayerData(videoId, cookie);
  const status = playerData?.playabilityStatus?.status;
  if (!playerData || (status && status !== 'OK')) {
    return sendError(res, `Video unavailable: ${playerData?.playabilityStatus?.reason ?? status ?? 'Unknown'}`, 404);
  }

  const formats = parseFormats(playerData);
  if (!formats.audio.length && !formats.video.length && !formats.muxed.length) {
    return sendError(res, 'No stream URLs found. Video may be a live stream or members-only.', 404);
  }

  const { type = 'video', quality = null } = req.query;

  if (type === 'audio') {
    const fmt = pickAudioFormat(formats);
    if (!fmt) return sendError(res, 'No audio stream found', 404);
    return res.redirect(302, fmt.url);
  }
  if (type === 'video') {
    const fmt = pickVideoFormat(formats, quality);
    if (!fmt) return sendError(res, 'No video stream found', 404);
    return res.redirect(302, fmt.url);
  }
  sendError(res, 'Invalid type. Use type=video or type=audio');
}

async function handlePlaylist(req, res, cookie) {
  const playlistId = extractPlaylistId(req.query.url);
  if (!playlistId) return sendError(res, 'Could not extract playlist ID from URL');

  const limit   = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
  const data    = await fetchPlaylistData(playlistId, cookie);
  const header  = data?.header?.playlistHeaderRenderer ?? data?.header?.interactiveTabbedHeaderRenderer;
  const content = data?.contents?.twoColumnBrowseResultsRenderer
                    ?.tabs?.[0]?.tabRenderer?.content
                    ?.sectionListRenderer?.contents?.[0]
                    ?.itemSectionRenderer?.contents?.[0]
                    ?.playlistVideoListRenderer;

  const rawItems = content?.contents ?? [];
  const items = rawItems.filter(i => i.playlistVideoRenderer).slice(0, limit).map(i => {
    const v = i.playlistVideoRenderer;
    return {
      videoId:   v.videoId,
      title:     v.title?.runs?.[0]?.text ?? 'Unknown',
      author:    v.shortBylineText?.runs?.[0]?.text ?? 'Unknown',
      duration:  v.lengthText?.simpleText ?? 'unknown',
      thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
      url:       `https://www.youtube.com/watch?v=${v.videoId}`,
    };
  });

  send(res, {
    playlistId,
    title:      header?.title?.simpleText ?? header?.title?.runs?.[0]?.text ?? 'Unknown Playlist',
    totalItems: rawItems.length,
    fetched:    items.length,
    items,
  });
}

async function handleDebug(req, res, cookie) {
  const videoId = extractVideoId(req.query.url);
  if (!videoId) return sendError(res, 'Could not extract video ID from URL');

  const sapisidHash = await generateSapisidHash(cookie ?? '');
  const results = {};

  for (const [name, clientId, version, ua, extra] of [
    ['ANDROID', ANDROID_CLIENT_ID, ANDROID_VERSION, ANDROID_UA, { androidSdkVersion: ANDROID_SDK }],
    ['WEB',     WEB_CLIENT_ID,     WEB_VERSION,     WEB_UA,     {}],
  ]) {
    try {
      const res2 = await fetch(`${INNERTUBE_BASE}/player?prettyPrint=false`, {
        method:  'POST',
        headers: makeHeaders(clientId, version, ua, cookie ?? '', sapisidHash),
        body: JSON.stringify({
          context: { client: { clientName: name, clientVersion: version, ...extra, hl: 'en', gl: 'US', utcOffsetMinutes: 0 } },
          videoId, contentCheckOk: true, racyCheckOk: true,
        }),
      });
      const text = await res2.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { results[name] = { httpStatus: res2.status, error: `Non-JSON: ${text.slice(0, 80)}` }; continue; }
      results[name] = {
        httpStatus:        res2.status,
        playabilityStatus: data?.playabilityStatus?.status,
        reason:            data?.playabilityStatus?.reason ?? null,
        hasVideoDetails:   !!data?.videoDetails,
        hasStreamingData:  !!data?.streamingData,
        formatCount:       (data?.streamingData?.formats?.length ?? 0) + (data?.streamingData?.adaptiveFormats?.length ?? 0),
      };
    } catch (e) {
      results[name] = { error: e.message };
    }
  }

  send(res, {
    videoId, platform: 'vercel',
    cookieSet:   !!cookie,
    hasSapisid:  !!(cookie?.match(/(?:__Secure-3PAPISID|SAPISID)=/)),
    sapisidHash: sapisidHash ? `${sapisidHash.slice(0, 20)}...` : null,
    clients: results,
  });
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'GET') return sendError(res, 'Only GET requests supported', 405);

  const cookie = process.env.YT_COOKIE ?? null;
  const path   = req.query.path ?? 'health';

  if (!req.query.url && path !== 'health') {
    return sendError(res, 'Missing ?url= parameter');
  }

  try {
    switch (path) {
      case 'health':
        return send(res, {
          status:    'ok',
          platform:  'vercel',
          cookieSet: !!cookie,
          setup:     cookie ? 'Ready ✓' : '⚠ Run: vercel env add YT_COOKIE',
          endpoints: [
            'GET /api?path=info&url=<youtube_url>',
            'GET /api?path=formats&url=<youtube_url>',
            'GET /api?path=download&url=<youtube_url>&type=video&quality=720',
            'GET /api?path=download&url=<youtube_url>&type=audio',
            'GET /api?path=playlist&url=<playlist_url>&limit=50',
            'GET /api?path=debug&url=<youtube_url>',
          ],
        });
      case 'info':     return await handleInfo(req, res, cookie);
      case 'formats':  return await handleFormats(req, res, cookie);
      case 'download': return await handleDownload(req, res, cookie);
      case 'playlist': return await handlePlaylist(req, res, cookie);
      case 'debug':    return await handleDebug(req, res, cookie);
      default:         return sendError(res, `Unknown path: ${path}. Visit /api?path=health`, 404);
    }
  } catch (err) {
    console.error(err);
    sendError(res, `Internal error: ${err.message}`, 500);
  }
}
