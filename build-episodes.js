#!/usr/bin/env node
/**
 * build-episodes.js — generates episodes.json for the episodes page (Audioboom feed + YouTube videos).
 *
 * Runs on a server / your computer / GitHub Actions (NOT in the browser), so it is not
 * affected by CORS. Requires Node 18+ (built-in fetch). No npm packages.
 *
 * Environment variables:
 *   YT_API_KEY             YouTube Data API v3 key                (required for videos)
 *
 * Run:  YT_API_KEY=xxx node build-episodes.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CONFIG = {
  rssUrl: 'https://audioboom.com/channels/4056568.rss',
  fallbackImage: 'https://audioboom.com/i/43137101/600',
  // Which YouTube channel holds each range of episodes
  noVideoMax: 51,                       // episodes 1–51: audio only
  papoRange: [52, 214],                 // episodes 52–214: @PapoPistola
                                        // episodes 215+:   @DulcePodcast
  channels: { papo: { handle: 'PapoPistola' }, dulce: { handle: 'DulcePodcast' } },
  out: path.join(__dirname, 'episodes.json')
};
const YT_KEY = process.env.YT_API_KEY || '';

/* ---------------- helpers ---------------- */
async function getJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.replace(/key=[^&]+/, 'key=***')}`);
  return r.json();
}
function decodeEntities(s) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
          .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function htmlToText(h) {
  return decodeEntities(h.replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
}
function firstLine(text) {
  let line = (text || '').replace(/\r/g, '').trim().split('\n')[0] || '';
  const cut = line.search(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]|https?:\/\//u);
  if (cut >= 0) line = line.slice(0, cut);
  return line.trim();
}
const stripNum = (t) => t.replace(/^\s*\d+\s*[:.\-]\s*/, '');

const MONTHS = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const MONTH_RE = Object.keys(MONTHS).join('|');
const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function dateKey(s) {
  const n = norm(s);
  let m = n.match(new RegExp(`(${MONTH_RE}) (\\d{1,2}) (\\d{4})`));            // "octubre 26 2026"
  if (m) return `${m[3]}-${MONTHS[m[1]]}-${+m[2]}`;
  m = n.match(new RegExp(`(\\d{1,2}) de (${MONTH_RE}) (?:de )?(\\d{4})`));      // "26 de octubre de 2026"
  return m ? `${m[3]}-${MONTHS[m[2]]}-${+m[1]}` : '';
}
function typeKey(s) {
  const n = norm(s);
  if (n.includes('talent show')) return 'talent';
  if (n.includes('mordida')) return 'mordida';
  if (n.includes('open mic')) return 'openmic';
  if (n.includes('primetime')) return 'primetime';
  return '';
}
const STOP = new Set(['dulce', 'compania', 'podcast', 'con', 'angel', 'gonzalez', 'open', 'mic', 'papo', 'pistola', 'los', 'las', 'del', 'una', 'por', 'para', 'que', 'the']);
const tokens = (s) => norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w));
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0; A.forEach((w) => B.has(w) && inter++);
  const u = A.size + B.size - inter;
  return u ? inter / u : 0;
}
/** how much of the episode's title appears in the other title (video titles carry extra words) */
function containment(epTokens, otherTokens) {
  const O = new Set(otherTokens);
  const set = new Set(epTokens);
  let inter = 0; set.forEach((w) => O.has(w) && inter++);
  return { inter, ratio: set.size ? inter / set.size : 0 };
}
const ymd = (d) => d.toISOString().slice(0, 10);

/* ---------------- 1. Audioboom RSS ---------------- */
async function loadEpisodes() {
  const xml = await (await fetch(CONFIG.rssUrl)).text();
  const first = xml.search(/<item[\s>]/i);
  const head = first > -1 ? xml.slice(0, first) : xml;
  const chanImg = (head.match(/<itunes:image[^>]*href="([^"]+)"/i) || [])[1] || CONFIG.fallbackImage;
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  if (!items.length) throw new Error('RSS feed has no items');
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? htmlToText(m[1]) : '';
  };
  const total = items.length;
  return items.map((it, idx) => {
    const title = tag(it, 'title');
    const rawDesc = (it.match(/<description(?:\s[^>]*)?>([\s\S]*?)<\/description>/i) || [])[1] || '';
    const epTag = tag(it, 'itunes:episode');
    const m = title.match(/^\s*(\d+)\s*[:.\-]/);
    const num = epTag ? +epTag : m ? +m[1] : total - idx;       // last resort: position counted from the oldest
    const pub = tag(it, 'pubDate');
    return {
      num,
      title,
      bareTitle: stripNum(title),
      summary: firstLine(htmlToText(rawDesc)),
      date: pub ? new Date(pub).toISOString() : null,
      image: (it.match(/<itunes:image[^>]*href="([^"]+)"/i) || [])[1] || chanImg,
      link: tag(it, 'link'),
      channel: null,
      video: null
    };
  });
}

/* ---------------- 2. YouTube channels ---------------- */
async function loadChannel(handle) {
  const base = 'https://www.googleapis.com/youtube/v3';
  const ch = await getJson(`${base}/channels?part=contentDetails,snippet&forHandle=%40${handle}&key=${YT_KEY}`);
  if (!ch.items || !ch.items.length) throw new Error(`YouTube channel @${handle} not found`);
  const uploads = ch.items[0].contentDetails.relatedPlaylists.uploads;
  const videos = [];
  let token = '';
  do {
    const j = await getJson(`${base}/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${uploads}&key=${YT_KEY}${token ? '&pageToken=' + token : ''}`);
    (j.items || []).forEach((i) => {
      const s = i.snippet;
      if (!s || !s.resourceId || s.title === 'Private video' || s.title === 'Deleted video') return;
      videos.push({ id: s.resourceId.videoId, title: s.title, published: (i.contentDetails && i.contentDetails.videoPublishedAt) || s.publishedAt });
    });
    token = j.nextPageToken || '';
  } while (token);
  return { id: ch.items[0].id, uploads, url: `https://www.youtube.com/@${handle}`, videos };
}

/** score how well a video matches an episode (0 = no match) */
function scoreMatch(ep, v) {
  const epDK = dateKey(ep.bareTitle), vDK = dateKey(v.title);
  const epT = typeKey(ep.bareTitle), vT = typeKey(v.title);
  const et = tokens(ep.bareTitle), vt = tokens(stripNum(v.title));
  // 1) same date written in both titles, same kind of show (Open Mic / Talent Show / ...)
  if (epDK && epDK === vDK && (!epT || !vT || epT === vT)) return 1;
  // 2) episode number written in the video title, backed by some title overlap
  const nm = v.title.match(/(?:#|\bep\.?\s*|\bepisodio\s*)(\d{1,3})\b/i) || v.title.match(/^\s*(\d{1,3})\s*[:|\-–]/);
  if (nm && +nm[1] === ep.num && (jaccard(et, vt) >= 0.15 || et.length === 0)) return 0.9;
  // 3) the episode's title words appear in the video title (video titles add extra words)
  if (et.length >= 2) {
    const c = containment(et, vt);
    if (c.inter >= 2 && c.ratio >= 0.75) return 0.5 + 0.4 * c.ratio * Math.min(1, jaccard(et, vt) + 0.5);
  }
  return 0;
}

function matchVideos(episodes, channels) {
  const pairs = [];
  episodes.forEach((ep, ei) => {
    if (ep.num <= CONFIG.noVideoMax) return;
    const key = ep.num >= CONFIG.papoRange[0] && ep.num <= CONFIG.papoRange[1] ? 'papo' : 'dulce';
    ep.channel = key;
    const other = key === 'papo' ? 'dulce' : 'papo';
    [[key, 0], [other, -0.05]].forEach(([k, penalty]) => {       // preferred channel first, other channel as a fallback
      const c = channels[k];
      if (!c) return;
      c.videos.forEach((v, vi) => {
        const sc = scoreMatch(ep, v);
        if (sc > 0) pairs.push({ ei, k, vi, sc: sc + penalty });
      });
    });
  });
  pairs.sort((a, b) => b.sc - a.sc);
  const usedEp = new Set(), usedVid = new Set();
  let hits = 0;
  pairs.forEach((p) => {
    const vk = p.k + ':' + p.vi;
    if (usedEp.has(p.ei) || usedVid.has(vk)) return;       // each video / episode used once
    usedEp.add(p.ei); usedVid.add(vk);
    const ep = episodes[p.ei];
    ep.video = { id: channels[p.k].videos[p.vi].id, channel: p.k };
    ep.channel = p.k;
    hits++;
  });
  return hits;
}

/* ---------------- main ---------------- */
(async () => {
  console.log('Reading Audioboom feed…');
  const episodes = await loadEpisodes();
  console.log(`  ${episodes.length} episodes`);

  const meta = { generated: new Date().toISOString(), channels: {} };
  if (!YT_KEY) {
    console.warn('! YT_API_KEY not set — skipping YouTube videos');
  } else {
    const channels = {};
    for (const k of Object.keys(CONFIG.channels)) {
      try {
        console.log(`Reading YouTube @${CONFIG.channels[k].handle}…`);
        channels[k] = await loadChannel(CONFIG.channels[k].handle);
        meta.channels[k] = { id: channels[k].id, uploads: channels[k].uploads, url: channels[k].url };
        console.log(`  ${channels[k].videos.length} videos`);
      } catch (e) { console.warn('! YouTube failed:', e.message); }
    }
    console.log(`Matched ${matchVideos(episodes, channels)} videos to episodes`);
  }

  fs.writeFileSync(CONFIG.out, JSON.stringify({ meta, episodes }, null, 1));
  console.log('Wrote', CONFIG.out);

  const noVid = episodes.filter((e) => e.num > CONFIG.noVideoMax && !e.video).map((e) => e.num);
  if (YT_KEY) console.log(`Episodes (52+) without a matched video: ${noVid.length}${noVid.length ? ' → ' + noVid.join(', ') : ''}`);
})().catch((e) => { console.error(e); process.exit(1); });
