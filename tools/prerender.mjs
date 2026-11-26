/**
 * Post-build prerender + static directory builder.
 *
 * Left alone, a single-page app serves one generic HTML file for every URL:
 * Google has nothing to index and a shared link shows a bare address. This runs
 * AFTER `npm run build` — so the bundle names and public path are resolved — and
 * writes real files for the things people search for and share:
 *
 *   build/station/<slug>/index.html         the app shell, per-station head
 *   build/station/<slug>/<uuid>/index.html  the old address, canonical to the new
 *                                           (top of the catalogue only — see
 *                                           LEGACY_ADDRESS_LIMIT)
 *   build/country/<country>/index.html      a real static directory page
 *   build/genre/<genre>/index.html          a real static directory page
 *   build/countries/, build/genres/         hubs linking every directory page
 *   build/sitemap.xml, build/robots.txt
 *
 * Station pages keep the id in a <meta>, so a link resolves with no lookup;
 * anything else resolves through the sharded index written by
 * tools/station-index.mjs, which must run first so the slugs agree.
 *
 * Directory pages deliberately do NOT boot the app. They are plain static HTML
 * with real content and internal links, so a visitor arriving from a search
 * engine gets a page that loads instantly and lists stations; the player is one
 * click away on a station page. A page that booted the SPA would have its
 * content wiped the instant React mounted, which is the whole reason these are
 * built this way.
 *
 * Nothing here is required for the site to work: on any failure it logs and
 * exits 0, and the deploy proceeds with the plain SPA.
 *
 *   node tools/prerender.mjs
 *   PRERENDER_LIMIT=200 node tools/prerender.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { byImportance, slugify } from "./stationSlug.mjs";

const BUILD_DIR = process.env.BUILD_DIR || "frontend/build";
const SITE = (process.env.SITE_URL || "https://worldradio.io").replace(/\/+$/, "");
const API = process.env.RB_API || "https://de1.api.radio-browser.info";
// Coverage is the single biggest SEO lever this site has. Every station page is a
// real, uniquely-titled HTML file; every station WITHOUT one is answered by the
// 404 shell, which carries the site's home title — and Google indexed thousands of
// those as duplicates (all titled "Live radio from around the world"). The cap is
// files, not bytes: Cloudflare Pages allows 20,000 per deployment, so the budget
// below buys ~10,000 stations by dropping the redundant <slug>/<uuid> copies for
// everything but the most-shared stations and trimming per-station OG cards.
const STATION_LIMIT = Number(process.env.PRERENDER_LIMIT || 10000);
const OG_STATION_CARDS = Number(process.env.OG_STATION_CARDS || 2200);
// The old `/station/<slug>/<uuid>/` address is only kept alive for links already
// sitting in people's messages. The SPA resolves both shapes, so a copy is only
// needed where a crawler or a chat preview reads the HTML — the top of the list.
const LEGACY_ADDRESS_LIMIT = Number(process.env.LEGACY_ADDRESS_LIMIT || 600);
const MIN_COUNTRY_STATIONS = Number(process.env.MIN_COUNTRY_STATIONS || 3);
const TAG_LIMIT = Number(process.env.TAG_LIMIT || 140);
const MIN_TAG_STATIONS = Number(process.env.MIN_TAG_STATIONS || 40);
const LISTED_PER_DIRECTORY = Number(process.env.LISTED_PER_DIRECTORY || 100);
const CARD_MANIFEST = path.join(os.tmpdir(), "worldradio-og-cards.json");

const escapeHtml = (s) =>
  String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const write = (relPath, html) => {
  const file = path.join(BUILD_DIR, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
};

// Meta descriptions are cut by Google at roughly 155-160 characters. Cutting on a
// word boundary here beats a search result ending in "…AAC+ at 64 kb".
const clamp = (s, max = 155) => {
  const text = String(s || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max - 1);
  return `${text.slice(0, cut > 80 ? cut : max - 1).trim()}…`;
};

// Tag names come from the catalogue in whatever case a contributor typed — "jazz",
// "hip hop", "80s". A heading reads better title-cased and the meta title has to
// look like something a person would click, so capitalise each word.
const titleCase = (s) =>
  String(s || "").replace(/(^|[\s/&-])([a-z\u00e0-\u024f])/g, (m, sep, ch) => sep + ch.toUpperCase());

const api = async (endpoint) => {
  const res = await fetch(`${API}${endpoint}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`radio-browser ${res.status} for ${endpoint}`);
  return res.json();
};

const readShell = () => {
  const file = path.join(BUILD_DIR, "index.html");
  if (!fs.existsSync(file)) {
    console.error(`prerender: ${file} not found — run the build first`);
    process.exit(0);
  }
  return fs.readFileSync(file, "utf8");
};

/** Slugs assigned by tools/station-index.mjs, read back so both agree exactly. */
const readSlugIndex = () => {
  const dir = path.join(BUILD_DIR, "station-index", "u");
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const shard = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    for (const [uuid, slug] of Object.entries(shard)) map.set(uuid, slug);
  }
  return map;
};

const tagsOf = (station) =>
  String(station.tags || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

// ---------------------------------------------------------------------------
// Social cards: queued here, drawn by tools/og-cards.py afterwards
// ---------------------------------------------------------------------------

const cards = [];
// A share card is only worth pointing at if the file is actually in the build: the
// committed set covers the old catalogue, and the country/genre list grows. A
// missing card is a broken og:image in every chat app, so fall back to the site card.
const hasCard = (kind, slug) =>
  fs.existsSync(path.join(BUILD_DIR, "og", kind, `${slug}.jpg`));

const card = (kind, slug, title, subtitle, image) => {
  const rel = `/og/${kind}/${slug}.jpg`;
  cards.push({
    file: path.join(BUILD_DIR, rel.slice(1)),
    title,
    subtitle,
    // The station's own artwork, when it has any. tools/og-cards.py re-hosts it
    // inside the card, so a shared station link shows the station rather than a
    // generic globe — and nothing is hotlinked from the broadcaster's server.
    ...(image ? { image } : {}),
  });
  return `${SITE}${rel}`;
};

// ---------------------------------------------------------------------------
// Directory pages: plain static HTML, no app
// ---------------------------------------------------------------------------

const DIRECTORY_CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#05070a;color:#e7f3ee;font:16px/1.6 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:#e7f3ee;text-decoration:none}
a:hover{color:#2fe08a}
.wrap{max-width:900px;margin:0 auto;padding:0 20px}
header{border-bottom:1px solid #17251f;background:#070d0b}
header .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:14px;padding-bottom:14px}
.brand{font-weight:600;letter-spacing:-.02em;font-size:18px}
.brand span{color:#2fe08a}
.cta{background:#2fe08a;color:#04231a;font-weight:600;padding:8px 14px;border-radius:999px;font-size:14px;white-space:nowrap}
.cta:hover{color:#04231a;filter:brightness(1.08)}
main{padding:34px 0 10px}
h1{font-size:30px;line-height:1.2;margin:0 0 10px;letter-spacing:-.02em}
h2{font-size:17px;margin:34px 0 10px;color:#cfe8dd}
.lede{color:#a9c3b8;margin:0 0 6px;max-width:70ch}
.crumbs{font-size:13px;color:#7d968c;margin:0 0 18px}
.crumbs a{color:#9fb3aa}
ul.stations{list-style:none;padding:0;margin:22px 0 0}
ul.stations li{border-top:1px solid #12201a;padding:11px 0;display:flex;gap:10px;align-items:baseline;justify-content:space-between}
ul.stations li:last-child{border-bottom:1px solid #12201a}
ul.stations .meta{color:#7d968c;font-size:13px;text-align:right;flex:0 0 auto;padding-left:12px}
.note{color:#7d968c;font-size:14px;margin-top:18px}
ul.links{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:8px}
ul.links li a{display:inline-block;border:1px solid #1d3129;border-radius:999px;padding:6px 12px;font-size:14px;color:#cfe8dd}
ul.links li a:hover{border-color:#2fe08a}
footer{border-top:1px solid #17251f;margin-top:44px;padding:22px 0 40px;color:#7d968c;font-size:13px}
`;

const directoryPage = ({
  title,
  description,
  heading,
  lede,
  canonical,
  ogImage,
  crumbs,
  list,
  related,
  total,
}) => {
  const crumbHtml = crumbs
    .map((c, i) =>
      i === crumbs.length - 1
        ? escapeHtml(c.name)
        : `<a href="${escapeHtml(c.href)}">${escapeHtml(c.name)}</a>`
    )
    .join(" › ");
  const items = list
    .map(
      (s) =>
        `      <li><a href="${escapeHtml(s.href || `/station/${s.slug}/`)}">${escapeHtml(
          s.name
        )}</a><span class="meta">${escapeHtml(s.meta || "")}</span></li>`
    )
    .join("\n");
  const relatedHtml = related
    .map(
      (group) => `      <h2>${escapeHtml(group.title)}</h2>
      <ul class="links">
${group.items
  .map((it) => `        <li><a href="${escapeHtml(it.href)}">${escapeHtml(it.name)}</a></li>`)
  .join("\n")}
      </ul>`
    )
    .join("\n");
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: heading,
      description,
      url: canonical,
      isPartOf: { "@type": "WebSite", name: "World Radio", url: `${SITE}/` },
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: list.length,
        itemListElement: list.slice(0, 25).map((s, i) => ({
          "@type": "ListItem",
          position: i + 1,
          url: `${SITE}${s.href || `/station/${s.slug}/`}`,
          name: s.name,
        })),
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: crumbs.map((c, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: c.name,
        item: `${SITE}${c.href}`,
      })),
    },
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
<link rel="canonical" href="${escapeHtml(canonical)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="World Radio" />
<meta property="og:locale" content="en" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${escapeHtml(canonical)}" />
<meta property="og:image" content="${escapeHtml(ogImage)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(ogImage)}" />
<meta name="theme-color" content="#05070a" />
<link rel="icon" href="/favicon.png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>${DIRECTORY_CSS}</style>
</head>
<body>
<header><div class="wrap"><a class="brand" href="/">World<span>Radio</span></a><a class="cta" id="globe-cta" href="/">Open the live globe</a></div></header>
<main class="wrap">
<p class="crumbs">${crumbHtml}</p>
<h1>${escapeHtml(heading)}</h1>
<p class="lede">${escapeHtml(lede)}</p>
<ul class="stations">
${items}
</ul>
<p class="note">${escapeHtml(
  total && total > list.length
    ? `Showing ${list.length.toLocaleString("en-AU")} of ${total.toLocaleString(
        "en-AU"
      )} stations — the ones being played most. Open the live globe to browse every one of them.`
    : total
    ? `All ${total.toLocaleString("en-AU")} stations, most played first — tap any of them to listen.`
    : "Tap any station to play it. Open the live globe to browse the whole world."
)}</p>
${relatedHtml}
</main>
<footer><div class="wrap">World Radio — live radio from around the world. Free, no account, no tracking. <a href="/privacy/">Privacy</a> · <a href="/countries/">All countries</a> · <a href="/genres/">All genres</a></div></footer>
<script>
/* Send the button to this country's globe view. Derived from the URL so it needs no
   knowledge of how this page was generated, and it is a plain link rewrite: with
   JavaScript off the button still opens the live globe, which is where it pointed. */
(function () {
  var m = window.location.pathname.match(/\/country\/([^/]+)\//);
  var a = document.getElementById("globe-cta");
  if (m && a) a.href = "/?country=" + encodeURIComponent(decodeURIComponent(m[1]));
})();
</script>
</body>
</html>
`;
};

// ---------------------------------------------------------------------------
// Station pages: the app shell with a per-station head, so the player boots
// ---------------------------------------------------------------------------

const stationPage = ({ shell, station, canonical, ogImage, related }) => {
  // The formal country name is right for matching a station to its country page
  // and wrong for everything a human or a crawler reads.
  const countryName = (related.country && related.country.name) || station.country;
  // `state` is free text from the catalogue and arrives in whatever case the
  // broadcaster typed ("tokyo", "Gauteng/limpopo"). A title reads it back to you,
  // so it has to be title-cased; the country is already normalised.
  const place = [titleCase(station.state), countryName].filter(Boolean).join(", ");
  const genres = related.genres.map((g) => g.name).join(", ");

  // Title: the station name is what people type, so it goes first; "Live Radio"
  // and the place are what distinguish two stations that share a name. Long
  // names fall back to the country alone, then to dropping the brand — a
  // truncated brand costs nothing, a truncated station name loses the query.
  const titleFor = (where) =>
    `${station.name} — Live Radio${where ? ` from ${where}` : ""} | World Radio`;
  let title = titleFor(place);
  if (title.length > 68 && countryName) title = titleFor(countryName);
  if (title.length > 72) title = `${station.name} — Live Radio | World Radio`;

  // Description: what it is, where it is, what it plays, how it streams, and the
  // one promise that matters on a search result ("no app, no account"). Genre
  // tags are what make this paragraph different for every station rather than a
  // codec string repeated 10,000 times.
  const kind = genres
    ? `${genres} radio`
    : station.language
    ? `${station.language} radio`
    : "Live radio";
  // Radio-Browser uses the literal string "UNKNOWN" for a codec it could not
  // detect; printing it in a search result looks broken.
  const codec =
    station.codec && !/^unknown$/i.test(station.codec) ? station.codec.toUpperCase() : "";
  const tech = [codec, station.bitrate ? `${station.bitrate} kbps` : ""].filter(Boolean).join(" ");
  const desc = clamp(
    `${station.name}${place ? ` from ${place}` : ""} — ${kind}. Listen live and free${
      tech ? ` at ${tech}` : ""
    }, no app or account. Works on phone, desktop and in the car.`
  );

  const head = `
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(desc)}" />
    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
    <link rel="canonical" href="${escapeHtml(canonical)}" />
    <meta name="wr:station-id" content="${escapeHtml(station.stationuuid)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="World Radio" />
    <meta property="og:locale" content="en" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(desc)}" />
    <meta property="og:url" content="${escapeHtml(canonical)}" />
    <meta property="og:image" content="${escapeHtml(ogImage)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(desc)}" />
    <meta name="twitter:image" content="${escapeHtml(ogImage)}" />
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "RadioStation",
      name: station.name,
      url: canonical,
      identifier: station.stationuuid,
      description: desc,
      ...(station.homepage ? { sameAs: [station.homepage] } : {}),
      ...(station.favicon && /^https:/i.test(station.favicon) ? { logo: station.favicon } : {}),
      ...(station.country ? { areaServed: { "@type": "Country", name: countryName } } : {}),
      ...(station.language ? { inLanguage: station.language } : {}),
      ...(genres ? { genre: genres } : {}),
      isPartOf: { "@type": "WebSite", name: "World Radio", url: `${SITE}/` },
    })}</script>
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "World Radio", item: `${SITE}/` },
        ...(related.country
          ? [
              {
                "@type": "ListItem",
                position: 2,
                name: related.country.name,
                item: `${SITE}/country/${related.country.slug}/`,
              },
            ]
          : []),
        {
          "@type": "ListItem",
          position: related.country ? 3 : 2,
          name: station.name,
          item: canonical,
        },
      ],
    })}</script>`;

  // Real links, in plain HTML, outside #root so React cannot take them away and
  // inside <noscript> so no visitor ever sees them. Googlebot follows links in
  // the raw markup, which is what knits these pages to the directory pages.
  const noscript = `<noscript>
      <div style="max-width:720px;margin:0 auto;padding:24px;font:16px/1.6 system-ui,sans-serif;color:#e7f3ee;background:#05070a">
        <h1>${escapeHtml(station.name)}${place ? ` — ${escapeHtml(place)}` : ""}</h1>
        <p>${escapeHtml(desc)}${
          station.homepage
            ? ` Official site: <a href="${escapeHtml(
                station.homepage
              )}" rel="nofollow noopener">${escapeHtml(station.homepage)}</a>.`
            : ""
        }</p>
        <p>Live radio streams need JavaScript to play. <a href="${escapeHtml(
          canonical
        )}">Open ${escapeHtml(station.name)} on World Radio</a>.</p>
        <ul>
          ${
            related.country
              ? `<li><a href="/country/${escapeHtml(
                  related.country.slug
                )}/">More radio stations from ${escapeHtml(related.country.name)}</a></li>`
              : ""
          }
          ${related.genres
            .map((g) => `<li><a href="/genre/${escapeHtml(g.slug)}/">More ${escapeHtml(g.name)} stations</a></li>`)
            .join("\n          ")}
          <li><a href="/countries/">Radio stations by country</a></li>
          <li><a href="/genres/">Radio stations by genre</a></li>
        </ul>
      </div>
    </noscript>`;

  return shell
    .replace(/<title>[\s\S]*?<\/title>/, "")
    // Drop the shell's own description/OG/Twitter/robots tags: two sets of them
    // and a crawler picks whichever it happens to read first.
    .replace(
      /[ \t]*<meta (?:property|name)="(?:og:[^"]*|twitter:[^"]*|description|robots)"[^>]*>\r?\n?/g,
      ""
    )
    .replace(/[ \t]*<link rel="canonical"[^>]*>\r?\n?/g, "")
    .replace("</head>", `${head}\n  </head>`)
    .replace("<body>", `<body>\n${noscript}`);
};

// Rewrite the manifest's relative URLs to absolute ones. iOS resolves a relative
// start_url inconsistently — and treats the bare `id` as if it belonged to the
// origin root — so an installed app can end up opening the wrong address. Static
// hosting means the base is known at build time, so just say it outright.
const absolutiseManifest = () => {
  const file = path.join(BUILD_DIR, "manifest.json");
  if (!fs.existsSync(file)) return;
  let m;
  try {
    m = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`prerender: manifest not parseable (${err.message}) — leaving it alone`);
    return;
  }
  const abs = (u) =>
    typeof u === "string" && u && !/^https?:/i.test(u) ? new URL(u, `${SITE}/`).toString() : u;
  m.start_url = abs(m.start_url || "./");
  m.scope = abs(m.scope || "./");
  m.id = abs(m.id || "./");
  if (Array.isArray(m.icons)) m.icons = m.icons.map((i) => ({ ...i, src: abs(i.src) }));
  if (Array.isArray(m.shortcuts)) m.shortcuts = m.shortcuts.map((s) => ({ ...s, url: abs(s.url) }));
  fs.writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  console.log(`prerender: manifest absolutised (start_url ${m.start_url}, id ${m.id})`);
};

// ---------------------------------------------------------------------------

const main = async () => {
  const shell = readShell();
  absolutiseManifest();
  const slugById = readSlugIndex();
  console.log(
    `prerender: slug index has ${slugById.size} stations${
      slugById.size ? "" : " — run node tools/station-index.mjs first for clean URLs"
    }`
  );

  const [rawStations, rawCountries, rawTags] = await Promise.all([
    api(`/json/stations/search?hidebroken=true&order=clickcount&reverse=true&limit=${STATION_LIMIT}`),
    api("/json/countries?hidebroken=true"),
    // The whole tag list, sorted here rather than by the API: taking a window of
    // a sorted list still admits tags with a handful of stations, and those are
    // station names and dialects rather than genres.
    api("/json/tags?hidebroken=true&limit=20000"),
  ]);

  const stations = rawStations
    .filter((s) => s && s.stationuuid && s.name && s.name.trim())
    .map((s) => ({ ...s, slug: slugById.get(s.stationuuid) || slugify(s.name) }));
  stations.sort(byImportance);

  // Radio-Browser labels each country with its formal name, which makes for
  // terrible URLs and headings — "the-united-kingdom-of-great-britain-and-
  // northern-ireland". Shorten the formal ones, then drop a leading "The" and
  // sentence-case the small words. Stations carry the original name, so both are
  // kept: `raws` matches a station to its country, `name` is what people read.
  const COUNTRY_ALIASES = {
    "the united kingdom of great britain and northern ireland": "United Kingdom",
    "the united states of america": "United States",
    "the united states minor outlying islands": "US Minor Outlying Islands",
    "the russian federation": "Russia",
    "the republic of korea": "South Korea",
    "the democratic peoples republic of korea": "North Korea",
    "the democratic republic of the congo": "DR Congo",
    "the central african republic": "Central African Republic",
    "bolivarian republic of venezuela": "Venezuela",
    "islamic republic of iran": "Iran",
    "syrian arab republic": "Syria",
    "taiwan, republic of china": "Taiwan",
    "the lao peoples democratic republic": "Laos",
    "the republic of moldova": "Moldova",
    "republic of north macedonia": "North Macedonia",
    "united republic of tanzania": "Tanzania",
    "federated states of micronesia": "Micronesia",
    "state of palestine": "Palestine",
    "brunei darussalam": "Brunei",
    "the falkland islands malvinas": "Falkland Islands",
    "the cocos keeling islands": "Cocos (Keeling) Islands",
    "ascension and tristan da cunha saint helena": "Saint Helena",
    "dutch part sint maarten": "Sint Maarten",
    "french part saint martin": "Saint Martin",
    "the french southern territories": "French Southern Territories",
  };
  const countryDisplay = (raw) => {
    const cleaned = String(raw || "").trim();
    const aliased = COUNTRY_ALIASES[cleaned.toLowerCase()];
    return (aliased || cleaned.replace(/^the\s+/i, ""))
      .replace(/\s+And\s+/g, " and ")
      .replace(/\s+Of\s+/g, " of ")
      .replace(/\s+The\s+/g, " the ");
  };

  const bySlug = new Map();
  for (const c of rawCountries) {
    if (!c || !c.name || (c.stationcount || 0) <= 0) continue;
    const name = countryDisplay(c.name);
    const slug = slugify(name);
    const existing = bySlug.get(slug);
    if (existing) {
      existing.count += c.stationcount || 0; // two spellings, one country
      existing.raws.push(c.name);
    } else {
      bySlug.set(slug, {
        name,
        slug,
        code: c.iso_3166_1,
        count: c.stationcount || 0,
        raws: [c.name],
        stations: [],
      });
    }
  }
  const countries = [...bySlug.values()]
    .filter((c) => c.count >= MIN_COUNTRY_STATIONS)
    .sort((a, b) => b.count - a.count);
  const countryByRaw = new Map();
  for (const c of countries) for (const raw of c.raws) countryByRaw.set(raw, c);

  // A country tag is a duplicate of a country page that already exists, and a
  // continent tag duplicates nothing: "mexico radio stations" is answered by
  // /country/mexico/, so publishing /genre/mexico/ as well would split the very
  // signal these pages are meant to concentrate.
  const GEO_SLUGS = new Set([
    ...countries.map((c) => c.slug),
    "america",
    "central-america",
    "north-america",
    "south-america",
    "norteamerica",
    "latinoamerica",
    "sudamerica",
    "centroamerica",
    "europa",
    "asia",
    "africa",
    "oceania",
    "cdmx",
    "ciudad-de-mexico",
    "valle-de-mexico",
    "sureste",
    "mex",
    "greek",
    "usa",
    "uk",
    "us",
  ]);

  // Tags are free text contributed by users, so the tail is noise: "radio",
  // "fm", "128k" describe the medium rather than the station, and a page called
  // "radio radio stations" helps nobody. Keep the ones that name a format.
  const BLOCKED_TAGS = new Set([
    "radio", "fm", "am", "live", "online", "internet", "webradio", "web", "stream",
    "streaming", "hq", "hd", "mp3", "aac", "ogg", "128k", "128", "320", "64", "top",
    "local", "regional", "various", "misc", "other", "general", "full", "service",
    // Language names tag the audience, not the format: "español radio stations"
    // is not a thing anyone searches for.
    "español", "espanol", "english", "french", "german", "italian", "portuguese",
    "spanish", "russian", "arabic", "hindi", "chinese", "français", "deutsch",
  ]);
  const JUNK_TAG = /^(?:\d+|[a-z]|undefined|unknown|null|other|test)$/;
  const genres = rawTags
    .filter(
      (t) =>
        t &&
        t.name &&
        (t.stationcount || 0) >= MIN_TAG_STATIONS &&
        t.name.length >= 3 &&
        /^[\p{L}\p{N}][\p{L}\p{N} &'’.-]*$/u.test(t.name) &&
        !JUNK_TAG.test(t.name) &&
        !BLOCKED_TAGS.has(t.name) &&
        !GEO_SLUGS.has(slugify(t.name))
    )
    .sort((a, b) => (b.stationcount || 0) - (a.stationcount || 0))
    .slice(0, TAG_LIMIT)
    .map((t) => ({ name: t.name, count: t.stationcount, slug: slugify(t.name), stations: [] }));
  const genreByName = new Map(genres.map((g) => [g.name, g]));

  for (const s of stations) {
    const c = countryByRaw.get(s.country);
    if (c && c.stations.length < LISTED_PER_DIRECTORY) c.stations.push(s);
    for (const tag of tagsOf(s).slice(0, 6)) {
      const g = genreByName.get(tag);
      if (g && g.stations.length < LISTED_PER_DIRECTORY) g.stations.push(s);
    }
  }

  const countriesWithStations = countries.filter((c) => c.stations.length);
  const topGenres = genres.slice(0, 14);
  const topCountries = countriesWithStations.slice(0, 14);
  // The listener's own brand image, committed as a file rather than drawn here:
  // it is their artwork, so it ships as-is from public/ and every card that
  // stands for the site itself — home, the two hubs, privacy — uses it.
  const homeCard = `${SITE}/og/home/main.jpg`;

  // --- hubs ---------------------------------------------------------------
  write(
    "countries/index.html",
    directoryPage({
      title: "Radio Stations by Country — Listen Live Worldwide | World Radio",
      description: clamp(
        `Browse live radio from ${countriesWithStations.length} countries — ${countriesWithStations
          .reduce((n, c) => n + c.count, 0)
          .toLocaleString(
            "en-AU"
          )} stations in total. Pick a country to see its most-played stations and listen instantly, free, on phone, desktop or in the car.`
      ),
      heading: "Radio stations by country",
      lede: `Live radio from ${countriesWithStations.length} countries and ${countriesWithStations
        .reduce((n, c) => n + c.count, 0)
        .toLocaleString("en-AU")} stations. Pick a country to see what people are listening to there.`,
      canonical: `${SITE}/countries/`,
      ogImage: homeCard,
      crumbs: [
        { name: "World Radio", href: "/" },
        { name: "Countries", href: "/countries/" },
      ],
      list: countriesWithStations.map((c) => ({
        name: c.name,
        meta: `${c.count} stations`,
        href: `/country/${c.slug}/`,
      })),
      related: [],
    })
  );

  write(
    "genres/index.html",
    directoryPage({
      title: "Live Radio by Genre — Pop, Rock, News, Jazz & More | World Radio",
      description: clamp(
        `Browse live radio by genre: ${genres
          .slice(0, 7)
          .map((g) => g.name)
          .join(", ")} and more across ${genres.length} genres. Pick one to see its most-played stations and listen free, no account needed.`
      ),
      heading: "Radio stations by genre",
      lede: `${genres.length} genres, from pop and rock to news, jazz and classical. Pick one to see the stations people play most.`,
      canonical: `${SITE}/genres/`,
      ogImage: homeCard,
      crumbs: [
        { name: "World Radio", href: "/" },
        { name: "Genres", href: "/genres/" },
      ],
      list: genres.map((g) => ({
        name: g.name,
        meta: `${g.count} stations`,
        href: `/genre/${g.slug}/`,
      })),
      related: [],
    })
  );

  // --- country + genre directories ---------------------------------------
  // Every station in the country, not only the two thousand that get a page of
  // their own: a shared country link has to actually contain the country. This
  // list comes from the catalogue walk in tools/station-index.mjs, so it is the
  // same snapshot the slugs were assigned from, it costs no extra API calls here,
  // and it cannot disagree with the station links below it. Keyed by the slug of
  // the country's formal name — the one thing both scripts derive identically,
  // because both use the shared slugify().
  const directoryDir =
    process.env.STATION_DIRECTORY_DIR || path.join(os.tmpdir(), "wr-directory");
  const readDirectory = (country) => {
    const raws = Array.isArray(country.raws)
      ? country.raws
      : country.raws
      ? Array.from(country.raws)
      : [country.raw || country.name];
    const seen = new Set();
    const out = [];
    for (const raw of raws) {
      const file = path.join(directoryDir, `${slugify(raw)}.json`);
      if (!fs.existsSync(file)) continue;
      for (const row of JSON.parse(fs.readFileSync(file, "utf8"))) {
        if (seen.has(row.s)) continue;
        seen.add(row.s);
        out.push({ slug: row.s, name: row.n, state: row.st || "" });
      }
    }
    return out;
  };
  // raw country name -> country page slug, published so the app can build a
  // country share link that lands on the page rather than on a guessed URL.
  const countrySlugs = {};

  for (const c of countriesWithStations) {
    const listed = readDirectory(c);
    if (listed.length) {
      c.count = listed.length;
      c.stations = listed;
    }
    for (const raw of Array.isArray(c.raws) ? c.raws : c.raws ? Array.from(c.raws) : [c.name]) {
      countrySlugs[raw] = c.slug;
    }
    write("station-index/countries.json", JSON.stringify(countrySlugs));
    write(
      `country/${c.slug}/index.html`,
      directoryPage({
        title: `${c.name} Radio Stations — Listen Live Free | World Radio`,
        description: clamp(
          `${c.count} live radio stations in ${c.name}${
            c.stations.length
              ? `, including ${c.stations
                  .slice(0, 3)
                  .map((s) => s.name)
                  .join(", ")}`
              : ""
          }. Listen free in your browser — no app, no account, on phone, desktop and in the car.`
        ),
        heading: `${c.name} radio stations`,
        lede: `${c.count} live stations, most played first — tap any of them to listen instantly.`,
        canonical: `${SITE}/country/${c.slug}/`,
        ogImage: hasCard("country", c.slug)
          ? card("country", c.slug, c.name, `${c.count} live radio stations`)
          : homeCard,
        crumbs: [
          { name: "World Radio", href: "/" },
          { name: "Countries", href: "/countries/" },
          { name: c.name, href: `/country/${c.slug}/` },
        ],
        list: c.stations.map((s) => ({ slug: s.slug, name: s.name, meta: s.state || "" })),
        total: c.count,
        related: [
          {
            title: "Browse by genre",
            items: topGenres.map((g) => ({ name: g.name, href: `/genre/${g.slug}/` })),
          },
        ],
      })
    );
  }

  for (const g of genres) {
    write(
      `genre/${g.slug}/index.html`,
      directoryPage({
        title: `Live ${titleCase(g.name)} Radio Stations — Listen Free | World Radio`,
        description: clamp(
          `Listen live to ${g.name} radio: ${g.count} ${g.name} stations from around the world${
            g.stations.length
              ? `, including ${g.stations
                  .slice(0, 3)
                  .map((s) => s.name)
                  .join(", ")}`
              : ""
          }. Free, no account, and it keeps playing on your lock screen and in the car.`
        ),
        heading: `${titleCase(g.name)} radio stations`,
        lede: `${g.count} ${g.name} stations, worldwide. Tap one to listen instantly.`,
        canonical: `${SITE}/genre/${g.slug}/`,
        ogImage: hasCard("genre", g.slug)
          ? card("genre", g.slug, `${g.name} radio`, `${g.count} live stations`)
          : homeCard,
        crumbs: [
          { name: "World Radio", href: "/" },
          { name: "Genres", href: "/genres/" },
          { name: g.name, href: `/genre/${g.slug}/` },
        ],
        list: g.stations.map((s) => ({
          slug: s.slug,
          name: s.name,
          meta: (countryByRaw.get(s.country) || {}).name || s.country || "",
        })),
        total: g.count,
        related: [
          {
            title: "Browse by country",
            items: topCountries.map((c) => ({ name: c.name, href: `/country/${c.slug}/` })),
          },
        ],
      })
    );
  }

  // --- station pages ------------------------------------------------------
  const urls = [];
  let written = 0;
  const withOwnCard = new Set(stations.slice(0, OG_STATION_CARDS).map((s) => s.stationuuid));

  for (const s of stations) {
    const canonical = `${SITE}/station/${s.slug}/`;
    const country = countryByRaw.get(s.country) || null;
    const related = {
      country,
      genres: tagsOf(s)
        .map((t) => genreByName.get(t))
        .filter(Boolean)
        .slice(0, 3),
    };
    const ogImage =
      withOwnCard.has(s.stationuuid) && hasCard("station", s.slug)
        ? card(
            "station",
            s.slug,
            s.name,
            [titleCase(s.state), country ? country.name : s.country].filter(Boolean).join(", "),
            /^https?:\/\//i.test(s.favicon || "") ? s.favicon : undefined
          )
        : country && hasCard("country", country.slug)
        ? `${SITE}/og/country/${country.slug}.jpg`
        : homeCard;

    const html = stationPage({ shell, station: s, canonical, ogImage, related });
    write(`station/${s.slug}/index.html`, html);
    // The old address stays alive (it is inside messages people already sent) and
    // declares the short one canonical, so any signal consolidates there. Only the
    // top of the catalogue gets a physical copy: the app resolves both shapes for a
    // visitor, and a crawler needs the file only where a link is likely to exist.
    if (urls.length < LEGACY_ADDRESS_LIMIT) {
      write(`station/${s.slug}/${s.stationuuid}/index.html`, html);
    }
    urls.push(canonical);
    written += 1;
  }

  // --- privacy page -------------------------------------------------------
  write(
    "privacy/index.html",
    shell
      .replace(/<title>[\s\S]*?<\/title>/, "")
      .replace(
        /[ \t]*<meta (?:property|name)="(?:og:[^"]*|twitter:[^"]*|description|robots)"[^>]*>\r?\n?/g,
        ""
      )
      .replace(/[ \t]*<link rel="canonical"[^>]*>\r?\n?/g, "")
      .replace(
        "</head>",
        `
    <title>Privacy — World Radio</title>
    <meta name="description" content="World Radio has no accounts, no analytics and no tracking. Nothing is kept beyond your own favourites, history and settings, in your own browser." />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${SITE}/privacy/" />
    <meta property="og:title" content="Privacy — World Radio" />
    <meta property="og:description" content="No accounts, no analytics, no tracking. Your favourites and history stay in your own browser." />
    <meta property="og:url" content="${SITE}/privacy/" />
    <meta property="og:image" content="${homeCard}" />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />
  </head>`
      )
      .replace(
        "<body>",
        `<body>\n<noscript><p style="font-family:system-ui;padding:24px">World Radio stores nothing but your own favourites and history, in this browser. No accounts, no analytics.</p></noscript>`
      )
  );

  // --- home page ----------------------------------------------------------
  // Stamped last on purpose: build/index.html is the shell every station page is
  // cut from, and a home canonical leaking into 2,000 station pages would be
  // worse than having none at all.
  const homeFile = path.join(BUILD_DIR, "index.html");
  fs.writeFileSync(
    homeFile,
    fs
      .readFileSync(homeFile, "utf8")
      .replace(/[ \t]*<link rel="canonical"[^>]*>\r?\n?/g, "")
      // Idempotent on purpose: running the prerender twice must not double the
      // tags it adds, because every one of them is written back below. Anything a
      // previous run left behind is stripped first — including the structured
      // data, which is why this can be re-run over an existing build/deploy.
      .replace(
        /[ \t]*<meta (?:property|name)="(?:og:url|og:image[^"]*|twitter:image|robots)"[^>]*>\r?\n?/g,
        ""
      )
      .replace(/[ \t]*<script type="application\/ld\+json">[\s\S]*?<\/script>\r?\n?/g, "")
      .replace(
        "</head>",
        `  <link rel="canonical" href="${SITE}/" />
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />
  <meta property="og:url" content="${SITE}/" />
  <meta property="og:image" content="${homeCard}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:image" content="${homeCard}" />
  <script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "World Radio",
    url: `${SITE}/`,
    description:
      "Live radio from around the world on a 3D globe. Spin it, tap a glowing dot, and listen. Free, no account, no tracking.",
    publisher: { "@type": "Organization", name: "World Radio", url: `${SITE}/` },
    potentialAction: {
      "@type": "SearchAction",
      target: `${SITE}/?q={search_term_string}`,
      "query-input": "required name=search_term_string",
    },
  })}</script>
</head>`
      )
  );

  // --- SPA fallback -------------------------------------------------------
  // Every URL without a file of its own — a station outside the prerendered
  // set, a typo, an old link — is answered with this. It is a 404 status with a
  // real page inside, which is correct: the app decides what to render from the
  // address, and the content is genuinely not known in advance. It must not
  // carry the home page's canonical (that would tell Google every station link
  // is the home page) and must not be indexed.
  write(
    "404.html",
    shell
      .replace(/<title>[\s\S]*?<\/title>/, "")
      .replace(
        /[ \t]*<meta (?:property|name)="(?:og:[^"]*|twitter:[^"]*|description|robots)"[^>]*>\r?\n?/g,
        ""
      )
      .replace(/[ \t]*<link rel="canonical"[^>]*>\r?\n?/g, "")
      .replace(
        "</head>",
        `
    <title>World Radio — live radio from around the world</title>
    <meta name="robots" content="noindex, follow" />
    <meta name="description" content="This station page isn't available. Open World Radio to listen live to 50,000+ stations from every country — free, no account." />
    <meta property="og:title" content="World Radio — live radio from around the world" />
    <meta property="og:description" content="Spin the globe, tap a station, and listen. Free, no account, no tracking." />
    <meta property="og:image" content="${homeCard}" />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />
  </head>`
      )
      .replace("<body>", `<body>${shell.includes("<noscript>") ? "" : "\n<noscript><p style=\"font-family:system-ui;padding:24px;color:#e7f3ee;background:#05070a\">World Radio plays live radio from around the world and needs JavaScript.</p></noscript>"}`)
  );

  // --- sitemap + robots ---------------------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  const entry = (loc, priority, changefreq) =>
    `  <url><loc>${loc}</loc><lastmod>${today}</lastmod><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`;
  write(
    "sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entry(`${SITE}/`, "1.0", "daily")}
${entry(`${SITE}/countries/`, "0.9", "weekly")}
${entry(`${SITE}/genres/`, "0.9", "weekly")}
${countriesWithStations.map((c) => entry(`${SITE}/country/${c.slug}/`, "0.8", "weekly")).join("\n")}
${genres.map((g) => entry(`${SITE}/genre/${g.slug}/`, "0.7", "weekly")).join("\n")}
${urls.map((u) => entry(u, "0.6", "weekly")).join("\n")}
${entry(`${SITE}/privacy/`, "0.3", "yearly")}
</urlset>
`
  );
  write(
    "robots.txt",
    `User-agent: *\nAllow: /\n\n# The sharded slug index is fetched by the app, never read by a crawler.\nDisallow: /station-index/\nDisallow: /embed/\n\nSitemap: ${SITE}/sitemap.xml\n`
  );

  fs.writeFileSync(CARD_MANIFEST, JSON.stringify(cards, null, 1));
  console.log(
    `prerender: ${written} station pages (two addresses each), ${countriesWithStations.length} country pages, ${genres.length} genre pages, ${
      urls.length + countriesWithStations.length + genres.length + 3
    } sitemap urls, ${cards.length} og cards queued`
  );
};

main().catch((err) => {
  console.warn(`prerender: skipped (${err.message})`);
  process.exit(0);
});
