/**
 * Refreshes data/live.json with current follower counts + reach.
 * Runs inside GitHub Actions. No npm packages needed (Node 20+ has fetch).
 *
 * Secrets it looks for (all optional — whatever is missing is skipped):
 *   IG_USER_ID          Instagram Business/Creator account ID (numeric)
 *   IG_ACCESS_TOKEN     Long-lived Meta access token
 *   TIKTOK_CLIENT_KEY   TikTok app client key
 *   TIKTOK_CLIENT_SECRET
 *   TIKTOK_REFRESH_TOKEN
 *   TIKTOK_USERNAME     used only for the public fallback (e.g. rachelljova)
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'data', 'live.json');
const today = new Date().toISOString().slice(0, 10);

function readPrev() {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); }
  catch { return { instagram: {}, tiktok: {}, history: [] }; }
}

/* ---------------- Instagram ---------------- */
const GRAPH = 'https://graph.facebook.com/v21.0';

/* Account-level insights. Meta keeps renaming these (impressions -> views),
   so each metric is tried three ways and whatever answers first wins.
   Needs the instagram_manage_insights permission on the token. */
async function igInsights(id, tok) {
  const out = {};
  const metrics = ['reach', 'views', 'profile_views', 'accounts_engaged'];

  for (const m of metrics) {
    const attempts = [
      `metric=${m}&period=days_28&metric_type=total_value`,
      `metric=${m}&metric_type=total_value&period=day`,
      `metric=${m}&period=day`
    ];
    for (const qs of attempts) {
      try {
        const j = await fetch(`${GRAPH}/${id}/insights?${qs}&access_token=${tok}`).then(r => r.json());
        if (j.error) continue;
        const d = j.data && j.data[0];
        if (!d) continue;
        let v = d.total_value && typeof d.total_value.value === 'number' ? d.total_value.value : null;
        if (v == null && Array.isArray(d.values)) {
          v = d.values.reduce((a, x) => a + (Number(x.value) || 0), 0);
        }
        if (v != null) { out[m] = v; break; }
      } catch { /* next attempt */ }
    }
  }
  return out;
}

async function instagram() {
  const id = process.env.IG_USER_ID, tok = process.env.IG_ACCESS_TOKEN;
  if (!id || !tok) return null;

  const j = await fetch(
    `${GRAPH}/${id}?fields=username,followers_count,media_count&access_token=${tok}`
  ).then(r => r.json());
  if (j.error) throw new Error('Instagram: ' + j.error.message);

  const base = { followers: j.followers_count, posts: j.media_count, handle: j.username };

  try {
    const ins = await igInsights(id, tok);
    if (ins.reach != null) base.reach = ins.reach;
    if (ins.views != null) base.views = ins.views;
    if (ins.profile_views != null) base.profileViews = ins.profile_views;
    if (ins.accounts_engaged != null) base.engaged = ins.accounts_engaged;
    base.window = '28d';
  } catch { /* followers still returned */ }

  return base;
}

/* ---------------- TikTok (official API) ---------------- */
async function tiktokOfficial() {
  const key = process.env.TIKTOK_CLIENT_KEY;
  const secret = process.env.TIKTOK_CLIENT_SECRET;
  const refresh = process.env.TIKTOK_REFRESH_TOKEN;
  if (!key || !secret || !refresh) return null;

  const tr = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: key, client_secret: secret,
      grant_type: 'refresh_token', refresh_token: refresh
    })
  }).then(r => r.json());

  if (!tr.access_token) throw new Error('TikTok token: ' + JSON.stringify(tr));

  const u = await fetch(
    'https://open.tiktokapis.com/v2/user/info/?fields=display_name,follower_count,likes_count,video_count',
    { headers: { Authorization: 'Bearer ' + tr.access_token } }
  ).then(r => r.json());

  const d = u && u.data && u.data.user;
  if (!d) throw new Error('TikTok user info: ' + JSON.stringify(u));
  return { followers: d.follower_count, likes: d.likes_count, videos: d.video_count, handle: d.display_name };
}

/* ---------------- TikTok (public page fallback) ---------------- */
/* Best effort only. TikTok changes their page markup often — if it stops
   working the dashboard simply keeps the last known number. */
async function tiktokPublic() {
  const user = process.env.TIKTOK_USERNAME;
  if (!user) return null;
  const r = await fetch(`https://www.tiktok.com/@${user}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  if (!r.ok) return null;
  const html = await r.text();
  const m = html.match(/"followerCount":\s*(\d+)/);
  return m ? { followers: +m[1], handle: user } : null;
}

/* ---------------- main ---------------- */
const prev = readPrev();
const out = {
  instagram: prev.instagram || {},
  tiktok: prev.tiktok || {},
  history: Array.isArray(prev.history) ? prev.history : [],
  updated: new Date().toISOString(),
  notes: []
};

try {
  const ig = await instagram();
  if (ig) out.instagram = ig; else out.notes.push('instagram: no credentials, kept previous');
} catch (e) { out.notes.push(String(e.message).slice(0, 200)); }

try {
  let tt = await tiktokOfficial();
  if (!tt) tt = await tiktokPublic();
  if (tt) out.tiktok = tt; else out.notes.push('tiktok: no credentials, kept previous');
} catch (e) {
  out.notes.push(String(e.message).slice(0, 200));
  try { const f = await tiktokPublic(); if (f) out.tiktok = f; } catch {}
}

/* daily history point, one per day */
out.history = out.history.filter(h => h.d !== today);
out.history.push({
  d: today,
  ig: out.instagram.followers || 0,
  tt: out.tiktok.followers || 0,
  reach: out.instagram.reach || 0,
  views: out.instagram.views || 0
});
out.history = out.history.slice(-365);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log('wrote', OUT, JSON.stringify({ ig: out.instagram.followers, tt: out.tiktok.followers, reach: out.instagram.reach, notes: out.notes }));
