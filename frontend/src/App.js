import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import "./App.css";
import {
  BrowserRouter,
  Routes,
  Route,
  useParams,
  useNavigate,
  useLocation,
} from "react-router-dom";
import { ArrowLeft, Car, Compass, Globe2, Loader2, LocateFixed, Map as MapIcon, Mic, Play, Radio, Route as RouteIcon, Search, X } from "lucide-react";
import { Toaster, toast } from "sonner";
import { PlayerProvider, usePlayer } from "./context/PlayerContext";
import {
  getGeoStations,
  getStation,
  searchStations,
  getStationsByIds,
  getByTag,
} from "./lib/radioApi";
import { presetByKey } from "./data/presets";
import { failCount, BAD_THRESHOLD } from "./lib/health";
// The 3D engine is most of the bundle and none of it is needed to draw the shell. On
// demand, the header, player and genre bar are usable as soon as the small entry chunk
// lands, and the globe follows on its own request.
const GlobeView = React.lazy(() => import("./components/GlobeView"));

// The tiled deep view. Its own chunk, fetched only if someone actually goes there:
// Leaflet plus the imagery means a visitor who stays on the globe pays nothing for it.
const DeepMap = React.lazy(() => import("./components/DeepMap"));

// What fills the map area while the globe chunk arrives. Deliberately transparent: the
// rest of the shell is already interactive underneath it.
const GlobeSketch = () => (
  <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-center">
    <div className="h-9 w-9 animate-spin rounded-full border-2 border-[#2fe08a]/25 border-t-[#7bf0b8]" />
    <div className="text-xs text-[#8497a0]">Loading the globe and its stations&hellip;</div>
  </div>
);
import SwitchingChip from "./components/SwitchingChip";
import Header from "./components/Header";
import PlayerBar from "./components/PlayerBar";
import { idForSlug, slugForId, stationIdFromPage, stationPath, slugify } from "./lib/stationUrls";
import SidePanel from "./components/SidePanel";
import { getCountries } from "./lib/radioApi";
import NowPlayingCard from "./components/NowPlayingCard";
import GenreBar, { filterByGenre, GENRES } from "./components/GenreBar";
import DrivingMode from "./components/DrivingMode";
import ReactiveBackground from "./components/ReactiveBackground";
import InstallPrompt from "./components/InstallPrompt";
import AlarmWatcher from "./components/AlarmWatcher";
// The phone and car interface. Rendered instead of the globe, not on top of it —
// see hooks/useViewMode.js for why the decision cannot be a CSS breakpoint.
import MobileRadio from "./components/MobileRadio";
import useViewMode from "./hooks/useViewMode";
import EmbedPlayer from "./components/EmbedPlayer";
import PrivacyContent from "./components/PrivacyContent";
import { orderByHealth } from "./lib/health";
import { parseBackup } from "./lib/backup";
import { compactLink, decodeCompact } from "./lib/shareLink";
import { tap as hapticTap } from "./lib/haptics";

const hav = (la1, lo1, la2, lo2) => {
  const p = Math.PI / 180;
  const a =
    0.5 -
    Math.cos((la2 - la1) * p) / 2 +
    (Math.cos(la1 * p) * Math.cos(la2 * p) * (1 - Math.cos((lo2 - lo1) * p))) / 2;
  return 12742 * Math.asin(Math.sqrt(Math.max(0, a)));
};

// Voice is not only search. In a car the useful commands are transport controls,
// and they have to be recognised before anything is treated as a station name.
// Order matters: "exit driving" before "driving", "unpause" before "pause".
const matchVoiceCommand = (text) => {
  const t = ` ${text} `;
  const has = (...words) => words.some((w) => t.includes(w));
  if (has("exit driving", "stop driving", "leave driving", "normal mode")) return "exit-driving";
  if (has("driving mode", "car mode", "drive mode", "on the road")) return "driving";
  if (has("next station", "next track", "next one", "skip this", "skip", "next")) return "next";
  if (has("previous station", "previous one", "go back", "last station", "previous", "back"))
    return "prev";
  if (has("unpause", "resume", "play radio", "start playing", "carry on")) return "play";
  if (has("pause", "stop the radio", "stop music", "be quiet", "hold on")) return "pause";
  if (has("louder", "volume up", "turn it up", "increase volume", "turn up")) return "louder";
  if (has("quieter", "volume down", "turn it down", "lower the volume", "quieter", "softer"))
    return "quieter";
  if (has("mute", "silence")) return "mute";
  if (has("surprise", "random station", "shuffle", "anything")) return "surprise";
  return null;
};

const IntroLoader = ({ show }) => (
  <div
    className={`absolute inset-0 z-[60] flex flex-col items-center justify-center bg-[#05070a] transition-opacity duration-700 ${
      show ? "opacity-100" : "pointer-events-none opacity-0"
    }`}
  >
    <div className="relative mb-6 flex h-20 w-20 items-center justify-center">
      <span className="absolute inset-0 rounded-full border border-[#2fe08a]/30 rm-pulse" />
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[#2fe08a] text-[#05070a] shadow-[0_0_30px_rgba(47,224,138,0.6)]">
        <Radio size={28} />
      </span>
    </div>
    <div className="font-display text-2xl font-700 text-white">
      World<span className="text-[#2fe08a]"> Radio</span>
    </div>
    <div className="mt-2 flex items-center gap-2 text-sm text-[#8497a0]">
      <Loader2 size={15} className="rm-spin" /> Tuning into the world…
    </div>
  </div>
);

const Hint = ({ show }) => (
  <div
    className={`pointer-events-none absolute bottom-40 left-1/2 z-20 -translate-x-1/2 text-center transition-opacity duration-700 ${
      show ? "opacity-100" : "opacity-0"
    }`}
  >
    <p className="font-display text-sm text-[#cfe8dd] drop-shadow-[0_1px_4px_rgba(0,0,0,0.8)]">
      Drag the globe · tap a <span className="text-[#37f59a]">glowing dot</span> ·
      press <span className="text-[#37f59a]">Space</span> to play
    </p>
  </div>
);

const TapToPlay = () => {
  const { blocked, current, resume } = usePlayer();
  if (!blocked || !current) return null;
  return (
    <button
      onClick={() => resume()}
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/45 backdrop-blur-[2px]"
    >
      <div className="rm-fade-up flex flex-col items-center gap-4 px-6 text-center">
        <span className="flex h-20 w-20 items-center justify-center rounded-full bg-[#2fe08a] text-[#05070a] shadow-[0_0_40px_rgba(47,224,138,0.7)]">
          <Play size={34} fill="currentColor" className="ml-1" />
        </span>
        <div className="font-display text-xl font-600 text-white">
          Tap to play
        </div>
        <div className="max-w-xs text-sm text-[#cfe8dd]">
          {current.name}
          <span className="block text-[#9fb3aa]">
            Your browser needs one tap before it can start the sound.
          </span>
        </div>
      </div>
    </button>
  );
};

const RadioApp = () => {
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // "desktop" | "phone" | "car". Read before anything renders, because it decides
  // whether the WebGL globe is mounted at all.
  const viewMode = useViewMode();
  const compact = viewMode !== "desktop";
  const [stations, setStations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [panel, setPanel] = useState(null);
  const [focusStation, setFocusStation] = useState(null);
  const [cityStation, setCityStation] = useState(null);
  const [userLoc, setUserLoc] = useState(null);
  const [genre, setGenre] = useState("");
  const [listening, setListening] = useState(false);
  const {
    current,
    play,
    next,
    prev,
    toggle,
    resume,
    pause,
    setNeighbors,
    setListLabel,
    listLabel,
    importFavorites,
    favorites,
    volume,
    setVolume,
  } = usePlayer();

  const userChoseRef = useRef(false);
  const pendingAutoplayRef = useRef(false);
  const autoInitRef = useRef(false);
  const sharedQueueRef = useRef(false);

  // Road trip mode: Next/Previous walk your pinned favourites instead of the
  // stations around whatever is playing. It is a toggle — once you are in the
  // list you need a way back out to the wider world.
  const [roadTripOn, setRoadTripOn] = useState(false);
  // Which curated list Next/Back is walking, if any: a preset collection or the
  // pinned favourites. Shown on the button so the mode is never a mystery.
  const [collection, setCollection] = useState(null);

  // Driving mode is a preference, not a session: once you have used it in the car
  // you want it back the next time you get in.
  const [driving, setDriving] = useState(() => {
    try {
      return window.localStorage.getItem("rm_driving_v1") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("rm_driving_v1", driving ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [driving]);

  const filtered = useMemo(() => filterByGenre(stations, genre), [stations, genre]);

  // ---- country view -----------------------------------------------------------------
  // Entered by a parameter rather than a route, so the static country pages keep their
  // URLs, their crawlable lists and their ranking, and the worst case of a bug here is a
  // dead button rather than 146 broken pages.
  const [countryMode, setCountryMode] = useState(() => {
    const q = new URLSearchParams(window.location.search).get("country");
    return q ? q.trim() : "";
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  // Country the camera is currently over - drives the "can't find it?" prompt.
  const [viewCountry, setViewCountry] = useState("");
  // Last camera position the globe reported. Kept so the country can be resolved again
  // when the catalogue finishes streaming in - the globe is ready long before that.
  const viewPosRef = useRef(null);

  const countryKey = (name) =>
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  const countryStations = useMemo(() => {
    if (!countryMode) return null;
    const want = countryKey(countryMode);
    const list = (stations || []).filter((s) => countryKey(s.country) === want);
    return list.length ? list : null;
  }, [stations, countryMode]);

  // Every country in the catalogue, alphabetical, with a count — the picker's data. One
  // pass over the list that is already in memory.
  // The picker shows the same country table Explore shows, so its numbers agree with
  // what the listener sees after opening the country - and so the list covers every
  // country, not only those present in the station list the globe loads.
  const [countriesTable, setCountriesTable] = useState(null);

  useEffect(() => {
    let alive = true;
    getCountries()
      .then((c) => alive && setCountriesTable(Array.isArray(c) ? c : []))
      .catch(() => alive && setCountriesTable([]));
    return () => {
      alive = false;
    };
  }, []);

  const countryList = useMemo(() => {
    const rows = (countriesTable || []).filter((c) => c && c.name);
    if (rows.length) {
      return rows
        .map((c) => ({ key: countryKey(c.name), name: c.name, count: c.count || 0 }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    // Until the table arrives, or if it never does, fall back to the station list so the
    // picker is never empty.
    const seen = new Map();
    for (const s of stations || []) {
      const name = (s.country || "").trim();
      if (!name) continue;
      const key = countryKey(name);
      const cur = seen.get(key) || { key, name, count: 0 };
      cur.count += 1;
      seen.set(key, cur);
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [countriesTable, stations]);

  const shownCountries = countryList;


  // What the pill offers: the country the camera is over, else the one that is playing,
  // else nothing - and nothing reads the world line, which is always true.
  const promptCountry = viewCountry || (current && current.country ? current.country : "");

  // Numbers for the pill: this country's stations the globe can actually draw, against
  // the catalogue's full count - the same table the picker and Explore use, so the list
  // and the number agree. Reads of data already in memory: no request, no extra file on
  // the free plan. With no country named it is the same two numbers for the whole world,
  // which is the honest answer to "why can't I find my station".
  const promptInfo = useMemo(() => {
    const list = stations || [];
    // Everything the globe loads carries coordinates - that is what the fetch asks for -
    // so this is what is on the map worldwide, right now.
    const onMapWorld = list.filter((s) => s.lat != null && s.lng != null).length;
    if (!promptCountry) {
      const catalogue = (countryList || []).reduce((n, c) => n + (c.count || 0), 0);
      const worldTotal = Math.max(catalogue, onMapWorld);
      return { country: "", onMap: onMapWorld, total: worldTotal, missing: Math.max(0, worldTotal - onMapWorld) };
    }
    const want = countryKey(promptCountry);
    const onMap = list.filter((s) => countryKey(s.country) === want).length;
    const hit = countryList.find((c) => c.key === want) || countryList.find((c) => c.key.includes(want));
    const total = Math.max((hit && hit.count) || 0, onMap);
    return { country: promptCountry, onMap: onMap, total: total, missing: Math.max(0, total - onMap) };
  }, [promptCountry, stations, countryList]);

  // The globe tells us where the listener is looking; name the nearest loaded station's
  // country so the prompt can offer that country's full list. Mid-ocean clears it, and a
  // rough distance guard keeps the far side of the planet from claiming a country. One
  // pass over the loaded stations, on camera moves only.
  const nearestCountryFor = useCallback((lat, lng) => {
    const list = stations || [];
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < list.length; i += 1) {
      const s = list[i];
      if (s.lat == null || s.lng == null) continue;
      const dLat = s.lat - lat;
      let dLng = s.lng - lng;
      if (dLng > 180) dLng -= 360;
      else if (dLng < -180) dLng += 360;
      const d = dLat * dLat + dLng * dLng;
      if (d < bestD) { bestD = d; best = s; }
    }
    const named = best && bestD < 900 ? (best.country || "") : "";
    // DEBUG HOOK - remove once the camera link is confirmed on the live site. One read
    // from the page says whether the report arrived and what it resolved to.
    try {
      window.__wrPrompt = Object.assign({}, window.__wrPrompt, {
        at: Date.now(),
        view: { lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100 },
        nearest: best ? { name: best.name, country: best.country || null, d2: Math.round(bestD) } : null,
        viewCountry: named || null,
        loaded: list.length,
      });
    } catch (e) { /* no window in a test renderer */ }
    return named;
  }, [stations]);

  const handleViewChange = useCallback((lat, lng) => {
    viewPosRef.current = { lat: lat, lng: lng };
    setViewCountry(nearestCountryFor(lat, lng));
  }, [nearestCountryFor]);

  // The globe is ready before the catalogue has streamed in, so the first report can find
  // nothing to match against. Resolve again whenever the station list grows, or the pill
  // sits on the world line until the listener happens to drag the globe.
  useEffect(() => {
    const p = viewPosRef.current;
    if (!p) return;
    setViewCountry(nearestCountryFor(p.lat, p.lng));
  }, [nearestCountryFor]);

  // DEBUG HOOK (see above): what the pill is showing, and why.
  useEffect(() => {
    try {
      window.__wrPrompt = Object.assign({}, window.__wrPrompt, {
        at: Date.now(),
        viewCountry: viewCountry || null,
        promptCountry: promptCountry || null,
        onMap: promptInfo.onMap,
        total: promptInfo.total,
        loaded: (stations || []).length,
        countries: (countryList || []).length,
      });
    } catch (e) { /* no window in a test renderer */ }
  }, [viewCountry, promptCountry, promptInfo, stations, countryList]);

  const enterCountry = useCallback((name) => {
    setCountryMode(name);
    setPickerOpen(false);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("country", name);
      window.history.replaceState({}, "", u);
    } catch {
      /* history is best-effort */
    }
  }, []);

  const leaveCountry = useCallback(() => {
    setCountryMode("");
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete("country");
      window.history.replaceState({}, "", u);
    } catch {
      /* history is best-effort */
    }
  }, []);

  // The parameter arrives as a slug ("india"); the catalogue spells it "India". Adopt the
  // catalogue's spelling so the button reads properly, and keep the address in step.
  useEffect(() => {
    if (!countryMode) return;
    const want = countryKey(countryMode);
    const hit =
      countryList.find((c) => c.key === want) ||
      countryList.find((c) => c.key.replace(/^the-/, "").startsWith(want)) ||
      countryList.find((c) => c.key.includes(want));
    if (!hit || hit.name === countryMode) return;
    setCountryMode(hit.name);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("country", hit.name);
      window.history.replaceState({}, "", u);
    } catch {
      /* history is best-effort */
    }
  }, [countryList, countryMode]);

  // Opening a country puts its stations in front of the listener straight away: Explore
  // already lists one country's stations, with a way back.
  useEffect(() => {
    if (countryMode) setPanel("explore");
  }, [countryMode]);

  // The camera goes to the country's centre. The density-aware landing then picks the
  // altitude, which for any country-sized cluster is the wide end of its range.
  const countryFocus = useMemo(() => {
    if (!countryStations) return null;
    let lat = 0;
    let lng = 0;
    let n = 0;
    for (const s of countryStations) {
      if (s.lat == null || s.lng == null) continue;
      lat += s.lat;
      lng += s.lng;
      n += 1;
    }
    if (!n) return null;
    const id = "country-centre-" + countryKey(countryMode);
    return { id, name: countryMode, lat: lat / n, lng: lng / n, country: countryMode };
  }, [countryStations, countryMode]);



  const sortNearest = useCallback(
    (lat, lng) =>
      [...stations]
        .filter((s) => s.lat != null && s.lng != null)
        .sort((a, b) => hav(lat, lng, a.lat, a.lng) - hav(lat, lng, b.lat, b.lng)),
    [stations]
  );

  const buildQueue = useCallback(
    (station) => {
      if (station.lat != null && stations.length) {
        // Stations that have already failed on this device go to the back of the
        // queue (see lib/health) — a shorter queue beats a queue full of duds.
        const s = orderByHealth(sortNearest(station.lat, station.lng).slice(0, 60));
        if (!s.some((x) => x.id === station.id)) s.unshift(station);
        return s;
      }
      return [station, ...stations.slice(0, 59)];
    },
    [stations, sortNearest]
  );

  useEffect(() => {
    let mounted = true;
    const mergeIn = (batch) => {
      if (!mounted || !batch || !batch.length) return;
      setStations((prev) => {
        const byId = new Map(prev.map((s) => [s.id, s]));
        batch.forEach((s) => byId.set(s.id, s));
        return [...byId.values()];
      });
    };
    getGeoStations({ onBatch: mergeIn })
      .then((data) => mounted && setStations(data))
      .catch(() => {})
      .finally(() => mounted && setTimeout(() => setLoading(false), 900));
    return () => {
      mounted = false;
    };
  }, []);

  // Support/debug hook: how big the loaded catalogue actually is.
  useEffect(() => {
    window.__worldRadio = { stations: stations.length, updatedAt: Date.now() };
  }, [stations]);

  // Globe follows the current station
  useEffect(() => {
    if (current && current.lat != null) {
      setFocusStation({ ...current, _t: Date.now() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // SEO: page title + address bar reflect the current station — unless the listener has
  // just pressed the logo to go back to the front page, in which case the title still
  // follows the station that is playing but the URL stays at the app root. Without this
  // the logo's navigation was instantly undone by this very effect. The suppression is
  // bound to the station that was on air at the time, so the next station change starts
  // letting the URL follow again.
  const homeStationRef = useRef(null);
  useEffect(() => {
    if (current) {
      const place = [current.state, current.country].filter(Boolean).join(", ");
      document.title = `${current.name}${
        place ? ` — Live Radio from ${place}` : " — Live Radio"
      } | World Radio`;
      const atHome = homeStationRef.current === current.id;
      if (!atHome) {
        // The address bar carries the readable address, never the UUID. The exact
        // slug comes from the build's index, so this is asynchronous: the guessed
        // form goes in immediately, and is corrected a moment later once the
        // shard (about 15 KB, fetched once per session) arrives. Guessing wrong
        // is harmless — the correction is a replace, not a navigation, and the
        // station that is playing never depends on the address.
        const guess = stationPath(slugify(current.name));
        if (location.pathname !== guess) navigate(guess, { replace: true });
        let cancelled = false;
        slugForId(current.id).then((exact) => {
          if (cancelled || !exact || homeStationRef.current === current.id) return;
          navigate(stationPath(exact), { replace: true });
        });
        return () => {
          cancelled = true;
        };
      }
    } else {
      document.title = "World Radio — Listen to 50,000+ Live Radio Stations Free";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, location.pathname]);

  // Give shared links a proper nearby queue once stations load
  useEffect(() => {
    if (stations.length && sharedQueueRef.current && current) {
      setNeighbors(buildQueue(current), current.id);
      sharedQueueRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, current]);

  // Keyboard controls
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        prev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, next, prev]);

  // Resume autoplay on the first user gesture (browser autoplay policy)
  useEffect(() => {
    const onGesture = () => {
      if (pendingAutoplayRef.current) {
        resume();
        pendingAutoplayRef.current = false;
      }
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
  }, [resume]);

  // Resolve a shared station link. Three shapes, in the order they can be
  // answered: /station/<slug>/<id> carries the id outright, /station/<slug>/ from
  // a prerendered page carries it in a meta tag the build wrote, and any other
  // /station/<slug>/ costs one small index lookup.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const start = (id) => {
      if (!id) return;
      userChoseRef.current = true;
      sharedQueueRef.current = true;
      getStation(id)
        .then((s) => {
          if (s && s.id) {
            play(s);
            pendingAutoplayRef.current = true;
          }
        })
        .catch(() => {});
    };
    const sid = params.id || query.get("s");
    if (sid) {
      start(sid);
      return;
    }
    if (!params.slug) return;
    // The meta tag describes the page that was loaded, which is the page this
    // effect runs against — it is only read once, on mount, so it cannot go
    // stale behind a later in-app navigation.
    const baked = stationIdFromPage();
    if (baked) {
      start(baked);
      return;
    }
    let cancelled = false;
    idForSlug(params.slug).then((id) => {
      if (!cancelled) start(id);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shareable favourites link, in two shapes: the compact ?f=<packed ids> the share
  // button writes now, and the legacy ?favs=<backup code> already sitting in people's
  // messages. Either way the payload arrives from a stranger's URL, so records are
  // validated field by field before anything is stored, shown or played.
  //
  // The compact form carries ids only, so the records have to be fetched from the
  // catalogue first — and they go through the same validator as a pasted backup,
  // because having produced the ids is no reason to trust the records they resolve to.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const compact = query.get("f");
    const favs = compact ? null : query.get("favs");
    if (!favs && !compact) return;
    let cancelled = false;

    const finish = ({ items, error, dropped, blocked }) => {
      if (cancelled) return;
      if (error || !items || !items.length) {
        toast.error("That favourites link couldn't be read", {
          description: error || "No valid stations in it.",
        });
        return;
      }
      importFavorites(items);
      userChoseRef.current = true;
      setPanel("favorites");
      play(items[0], items);
      pendingAutoplayRef.current = true;
      const notes = [];
      if (dropped) notes.push(`${dropped} invalid entr${dropped === 1 ? "y" : "ies"} skipped`);
      if (blocked) notes.push(`${blocked} blocked station${blocked === 1 ? "" : "s"} skipped`);
      toast.success(
        `${items.length} station${items.length === 1 ? "" : "s"} imported from the link`,
        notes.length ? { description: notes.join(", ") } : undefined
      );
      // Leave the short form in the address bar, so copying it from there hands over
      // the same tidy link the share button would have produced.
      if (!compact) {
        const short = compactLink(items, window.location.origin);
        if (short) window.history.replaceState(null, "", short.replace(window.location.origin, ""));
      }
    };

    const run = async () => {
      if (compact) {
        const ids = decodeCompact(compact);
        if (!ids || !ids.length) {
          toast.error("That favourites link couldn't be read", {
            description: "The link looks cut short — ask for it again.",
          });
          return;
        }
        toast.message(`Fetching ${ids.length} station${ids.length === 1 ? "" : "s"}…`);
        const found = await getStationsByIds(ids);
        if (cancelled) return;
        if (!found.length) {
          toast.error("That favourites link couldn't be read", {
            description: "None of those stations answered from the catalogue — try again in a moment.",
          });
          return;
        }
        finish(parseBackup(JSON.stringify({ v: 1, s: found })));
        return;
      }
      finish(parseBackup(favs));
    };

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-play on load: nearest if location granted, else random (never silent)
  useEffect(() => {
    if (!stations.length || autoInitRef.current) return;
    autoInitRef.current = true;
    const query = new URLSearchParams(window.location.search);
    // A shared link names a station in one of two shapes: the legacy query form
    // (?id=, ?s=, ?favs=) and the static /station/<slug>/ pages. Only the query
    // form was checked here, so opening a shared station URL tuned that station
    // and then, seconds later, this effect replaced it with a random station
    // from the top 600 — and the address bar followed, so the link looked wrong.
    const onStationPage = /\/station\/[^/]+/i.test(window.location.pathname);
    if (
      params.id ||
      query.get("s") ||
      query.get("favs") ||
      query.get("preset") ||
      onStationPage
    )
      return;

    // A returning listener gets their own station back rather than a stranger.
    // Opening on a random station every time quietly undoes the choice someone
    // made yesterday, and this is a radio they leave on all day. A station the
    // health memory has already parked is skipped, so a dead favourite cannot
    // greet them with silence.
    let resumed = false;
    let remembered = null;
    try {
      const raw = window.localStorage.getItem("rm_last_station_v1");
      remembered = raw ? JSON.parse(raw) : null;
    } catch {
      remembered = null;
    }
    if (remembered && remembered.id && failCount(remembered) < BAD_THRESHOLD) {
      play(remembered, buildQueue(remembered));
      pendingAutoplayRef.current = true;
      resumed = true;
    } else {
      const rand = stations[Math.floor(Math.random() * Math.min(stations.length, 600))];
      if (rand) {
        play(rand, buildQueue(rand));
        pendingAutoplayRef.current = true;
      }
    }
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setUserLoc(loc);
          if (!userChoseRef.current && !resumed) {
            const near = sortNearest(loc.lat, loc.lng)[0];
            if (near) {
              play(near, buildQueue(near));
              pendingAutoplayRef.current = true;
            }
          }
        },
        () => {},
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 600000 }
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations]);

  // Remember what is playing, for the next visit. The whole station record, not
  // just an id: the player needs a stream URL and coordinates to build a nearby
  // queue from, and a bare id would need a catalogue round-trip before anything
  // could start.
  useEffect(() => {
    if (!current || !current.id) return;
    try {
      window.localStorage.setItem("rm_last_station_v1", JSON.stringify(current));
    } catch {
      /* private mode: resuming is a nicety, never a failure */
    }
  }, [current]);

  // A shared collection: /?preset=<key>. Built from the same tag query the Presets
  // panel runs, so a link to "80s Drive" plays 80s Drive instead of whatever the
  // catalogue happens to return first. Naming the list also lights up the
  // Next/Back chip, so the recipient can see where Next will go.
  useEffect(() => {
    const key = new URLSearchParams(window.location.search).get("preset");
    if (!key) return undefined;
    const preset = presetByKey(key);
    if (!preset) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const rows = await getByTag(preset.tag, 80);
        if (cancelled || !rows.length) return;
        userChoseRef.current = true;
        play(rows[0], rows);
        setCityStation(rows[0]);
        setListLabel(preset.label);
        setCollection({ label: preset.label });
        toast.success(`${preset.label} \u00b7 ${rows.length} stations`, {
          description: "Next and Back walk this collection.",
        });
      } catch {
        /* the panel is still one tap away */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpen = useCallback(
    (p) => setPanel((cur) => (cur === p ? null : p)),
    []
  );

  const handlePlayFocus = useCallback(() => {
    userChoseRef.current = true;
    setPanel(null);
  }, []);

  // The logo is the way home. It closes whatever panel is open, puts the URL back to
  // the app root (a deep link to a station is not the site's front page), and leaves
  // the audio alone — nobody expects the sound to stop because they tapped the brand.
  const goHome = useCallback(() => {
    // Remember which station is on air: the URL-sync effect above would otherwise put
    // the station path straight back into the address bar.
    homeStationRef.current = current ? current.id : null;
    setPanel(null);
    navigate("/");
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }, [navigate, current]);

  const handleStationClick = useCallback(
    (station) => {
      hapticTap();
      userChoseRef.current = true;
      // Tapping a station on the globe plays it, full stop. It used to also slide
      // open the "nearby stations" side panel, which buried the map you were
      // reading and had to be dismissed before you could pick another dot. The
      // queue is built from the stations around it, so Next/Previous still walk
      // the neighbourhood.
      play(station, buildQueue(station));
      setCityStation(station);
      // Walking the neighbourhood, not a curated list.
      setListLabel(null);
      // Picking a station by hand means you are done with the road trip list.
      setRoadTripOn(false);
    },
    [play, buildQueue]
  );

  // "Surprise me" is the one flow where the listener asked for *sound* rather
  // than for a named station, so a dead pick must not park on a message — it
  // picks again. Tried ids are remembered so the same dud cannot come back, and
  // the ladder is short: after that the ordinary recovery takes over and
  // something plays.
  const surpriseTriedRef = useRef(new Set());
  const [surprisePending, setSurprisePending] = useState(null);

  const surprise = useCallback(() => {
    if (!stations.length) return;
    userChoseRef.current = true;
    const pool = stations.slice(0, Math.min(stations.length, 800));
    const fresh = pool.filter((s) => !surpriseTriedRef.current.has(s.id));
    const list = fresh.length ? fresh : pool;
    const s = list[Math.floor(Math.random() * list.length)];
    if (!s) return;
    surpriseTriedRef.current.add(s.id);
    play(s, buildQueue(s));
    setCityStation(s);
    setRoadTripOn(false);
    setSurprisePending(s.id);
  }, [stations, play, buildQueue]);

  // Give a surprise pick a few seconds to produce sound; if it does not, pick
  // again. The audio element is read directly because "is it playing" is a
  // property of the DOM, not of the player's state.
  useEffect(() => {
    if (!surprisePending || !current || current.id !== surprisePending) return undefined;
    const timer = setTimeout(() => {
      const a = document.querySelector("audio");
      const audible = Boolean(a) && !a.paused && a.readyState >= 2 && a.currentTime > 0 && a.volume > 0;
      setSurprisePending(null);
      if (audible) {
        surpriseTriedRef.current.clear();
        return;
      }
      // A spin must never end on nothing. While the ladder lasts, spin again; when it is
      // spent, hand the job to the player, whose queue walk only commits to a station it
      // has actually verified — so either way a spin ends on sound.
      if (surpriseTriedRef.current.size < 5) {
        setSpinToken((n) => n + 1);
        toast.message("That one was down — spinning again…");
        surprise();
        return;
      }
      surpriseTriedRef.current.clear();
      toast.message("Those picks were down — trying the next station");
      next();
    }, 6000);
    return () => clearTimeout(timer);
  }, [surprisePending, current, surprise, next]);

  // "Spin the globe": the map spins down like a wheel and lands on a random
  // station. The station is chosen a moment in, while it is still slowing, because
  // the fly-in that frames it belongs to the player — running our own landing
  // animation as well would just fight it.
  const [spinToken, setSpinToken] = useState(0);
  // The globe hands over to the tiled map at its own camera floor, or on demand.
  const [deepView, setDeepView] = useState(false);
  const openDeepView = useCallback(() => setDeepView(true), []);
  const closeDeepView = useCallback(() => setDeepView(false), []);
  const spinTimerRef = useRef(null);
  const spinRetryRef = useRef(0);

  const spinTheGlobe = useCallback(() => {
    if (!stations.length) {
      // Nothing to land on yet. Retry instead of giving up, so a press in the first
      // seconds after load still ends somewhere.
      spinRetryRef.current += 1;
      if (spinRetryRef.current <= 6) {
        toast.message("Still loading stations…");
        clearTimeout(spinTimerRef.current);
        spinTimerRef.current = setTimeout(() => spinTheGlobe(), 1200);
      } else {
        spinRetryRef.current = 0;
        toast.error("Couldn't load the station list — check your connection");
      }
      return;
    }
    spinRetryRef.current = 0;
    setSpinToken((n) => n + 1);
    toast.message("Spinning the globe…", {
      description: "Wherever it stops is what you get.",
    });
    clearTimeout(spinTimerRef.current);
    spinTimerRef.current = setTimeout(() => surprise(), 1500);
  }, [stations.length, surprise]);

  useEffect(() => () => clearTimeout(spinTimerRef.current), []);

  const locateMe = useCallback(() => {
    if (!navigator.geolocation) {
      toast.error("Location isn't available on this device");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserLoc(loc);
        userChoseRef.current = true;
        const near = sortNearest(loc.lat, loc.lng)[0];
        if (near) {
          play(near, buildQueue(near));
          setCityStation(near);
          setRoadTripOn(false);
          toast.success("Playing the station nearest to you");
        } else {
          setFocusStation({ ...loc, _t: Date.now() });
        }
      },
      () => toast.error("Couldn't get your location"),
      { enableHighAccuracy: false, timeout: 8000 }
    );
  }, [sortNearest, play, buildQueue]);

  // App-shortcut entry points from the PWA manifest: long-press the installed icon
  // and pick "Driving mode", "Spin the globe" or "Explore".
  useEffect(() => {
    const go = new URLSearchParams(window.location.search).get("go");
    if (!go) return undefined;
    if (go === "driving") {
      setDriving(true);
      return undefined;
    }
    if (go === "explore") {
      setPanel("explore");
      return undefined;
    }
    if (go === "surprise") {
      // Wait for the catalogue, otherwise there is nothing to pick from.
      const t = setTimeout(() => spinTheGlobe(), 2500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [spinTheGlobe]);

  const runVoiceCommand = useCallback(
    (cmd) => {
      const step = (delta) => Number(Math.max(0, Math.min(1, volume + delta)).toFixed(2));
      switch (cmd) {
        case "next":
          next();
          toast.message("Next station");
          break;
        case "prev":
          prev();
          toast.message("Previous station");
          break;
        case "play":
          resume();
          toast.message("Playing");
          break;
        case "pause":
          pause();
          toast.message("Paused");
          break;
        case "louder":
          setVolume(step(0.1));
          toast.message("Louder");
          break;
        case "quieter":
          setVolume(step(-0.1));
          toast.message("Quieter");
          break;
        case "mute":
          setVolume(0);
          toast.message("Muted");
          break;
        case "surprise":
          spinTheGlobe();
          break;
        case "driving":
          setDriving(true);
          toast.success("Driving mode on");
          break;
        case "exit-driving":
          setDriving(false);
          toast.message("Driving mode off");
          break;
        default:
          break;
      }
    },
    [next, prev, resume, pause, volume, setVolume, surprise]
  );

  const startVoice = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      toast.error("Voice search isn't supported on this browser");
      return;
    }
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    setListening(true);

    // Silence the radio first — the microphone would otherwise pick up what the
    // speakers are playing and transcribe the song instead of the user.
    pause();

    let handled = false;
    toast.message("Listening…", { description: "Say a city, country or genre" });

    rec.onresult = async (e) => {
      const transcript = (e.results[0][0].transcript || "").trim();
      setListening(false);
      handled = true;
      if (!transcript) {
        resume();
        return;
      }
      toast.success(`Heard: “${transcript}”`);
      const lower = transcript.toLowerCase();
      // Transport commands first — see matchVoiceCommand.
      const cmd = matchVoiceCommand(lower);
      if (cmd) {
        runVoiceCommand(cmd);
        return;
      }
      const g = GENRES.find(
        (x) =>
          x.key &&
          (lower.includes(x.label.toLowerCase()) ||
            (x.match || []).some((m) => lower.includes(m)))
      );
      try {
        let results;
        if (g) {
          setGenre(g.key);
          results = await searchStations({ tag: g.match[0], limit: 40 });
        } else {
          results = await searchStations({ q: transcript, limit: 40 });
        }
        if (results && results.length) {
          userChoseRef.current = true;
          play(results[0], results);
          setCityStation(results[0]);
          setListLabel(`Search: ${transcript}`);
        } else {
          toast.error(`No stations found for “${transcript}”`);
          resume();
        }
      } catch {
        toast.error("Voice search failed, please try again");
        resume();
      }
    };
    rec.onerror = () => {
      setListening(false);
      handled = true;
      toast.error("Didn't catch that — tap the mic and try again");
      resume();
    };
    rec.onend = () => {
      setListening(false);
      // Stopped without a usable result — put the radio back on.
      if (!handled) resume();
    };
    try {
      rec.start();
    } catch {
      setListening(false);
      resume();
    }
  }, [play, pause, resume, runVoiceCommand]);

  const roadTrip = useCallback(() => {
    const pins = favorites.filter((s) => s.url);
    if (!pins.length) {
      toast.info("Pin some favorites first", {
        description: "Tap the heart on stations to build your road trip.",
      });
      setPanel("favorites");
      return;
    }
    userChoseRef.current = true;
    // Toggle: pressing it again leaves the pinned list, so Next/Back/Surprise go
    // back to walking the stations around whatever is playing.
    if (roadTripOn) {
      setRoadTripOn(false);
      setCollection(null);
      setListLabel(null);
      if (current) {
        setNeighbors(buildQueue(current), current.id);
        toast.success("Road trip off", {
          description: "Next and Back are wandering the nearby stations again.",
        });
      } else {
        toast.info("Road trip off");
      }
      return;
    }
    setRoadTripOn(true);
    setCollection({ label: "Pinned favorites" });
    setListLabel("Pinned favourites");
    play(pins[0], pins);
    toast.success(`Road trip · ${pins.length} pinned stations`, {
      description: "Next/Back travel between them. Press Road trip again to leave.",
    });
  }, [favorites, play, roadTripOn, current, buildQueue, setNeighbors]);

  // Leave whatever list Next/Back has been walking — a preset, a genre, the favourites
  // road trip — and go back to the whole catalogue. Without this, a preset quietly
  // becomes the list and a listener can sit on one country's stations for an hour
  // without a way to tell what happened or how to get out.
  const clearList = useCallback(() => {
    userChoseRef.current = true;
    setRoadTripOn(false);
    setCollection(null);
    setListLabel(null);
    setGenre("");
    if (current) setNeighbors(buildQueue(current), current.id);
    toast.success("Back to all stations", {
      description: "Next and Back walk the whole catalogue again.",
    });
  }, [current, buildQueue, setNeighbors, setListLabel]);

  return (
    <div className="App rm-star-field">
      <ReactiveBackground />
      <IntroLoader show={loading} />
      {compact ? (
        <MobileRadio
          stations={stations}
          countryStations={countryStations}
          countryMode={countryMode}
          countries={countryList}
          genre={genre}
          setGenre={setGenre}
          onEnterCountry={enterCountry}
          onLeaveCountry={leaveCountry}
          onOpen={handleOpen}
          onHome={goHome}
          onLocate={locateMe}
          onSurprise={spinTheGlobe}
          onRoadTrip={roadTrip}
          onPlayStation={handleStationClick}
          roadTripOn={roadTripOn}
          onDriving={() => setDriving(true)}
          car={viewMode === "car"}
        />
      ) : (
        <>
      <React.Suspense fallback={<GlobeSketch />}>
      <GlobeView
        stations={countryStations || filtered}
        focusStation={countryFocus || focusStation}
        userLoc={userLoc}
        pins={favorites}
        onStationClick={handleStationClick}
        spinToken={spinToken}
        onViewChange={handleViewChange}
      />
      </React.Suspense>
      {/* Not everything can be on a globe: most of the catalogue has no location
          recorded, so no zoom level can show it. This carries the honest count and a
          door to the full list. It renders for everyone now - naming the country the
          camera (or the playing station) gives it, and the world counts when there is
          no country to name - because gating it on the camera is how it went missing.
          Desktop only: the phone layout around the picker and the keyboard is
          deliberately untouched. data-rm-prompt is the test hook (never select new UI
          by its visible text - a title built from state once read as "india"). */}
      {!countryMode && promptInfo && (stations || []).length > 0 && (
        <button
          type="button"
          data-rm-prompt={promptInfo.country || "world"}
          onClick={() => (promptInfo.country ? enterCountry(promptInfo.country) : setPickerOpen(true))}
          className="fixed left-4 bottom-28 z-30 hidden max-w-[19rem] flex-col items-start gap-1 rounded-2xl border border-white/15 bg-black/70 px-4 py-3 text-left text-white backdrop-blur transition hover:border-white/35 sm:flex"
          title={promptInfo.country ? "See every station in " + promptInfo.country : "Pick a country"}
        >
          <span className="text-[11px] uppercase tracking-wide text-white/60">
            {promptInfo.country || "Worldwide"}
          </span>
          <span className="text-sm font-medium">
            {promptInfo.country ? "Can't find a station?" : "Not finding a station?"}
          </span>
          <span className="text-xs text-white/70">
            {promptInfo.onMap} on the map · {Math.max(0, promptInfo.missing)} not mapped
          </span>
          <span className="text-xs font-semibold text-emerald-300">
            {promptInfo.country ? "Browse all " + promptInfo.total + " →" : "Pick your country →"}
          </span>
        </button>
      )}

      {/* The tiled deep view. The globe stays mounted underneath, so coming back costs
          nothing and nothing about the 3D state is lost. */}
      {deepView && (
        <React.Suspense fallback={null}>
          <DeepMap
            stations={countryStations || filtered}
            current={current}
            pins={favorites}
            onStationClick={handleStationClick}
            onBack={closeDeepView}
          />
        </React.Suspense>
      )}
      <Hint show={!loading && !current} />
      <TapToPlay />

      <Header onOpen={handleOpen} activePanel={panel} onHome={goHome} />
      <GenreBar active={genre} onSelect={setGenre} />
      {/* Which list Next/Back is walking, and the way out of it. Every list that
          restricts Next/Back records itself on the player as listLabel — a preset, a
          genre chip, an Explorer country ("India"), Trending, a genre from Explore, a
          search, the favourites panel — so reading that here covers all of them rather
          than the two App happened to know about. Lifted off the bottom on small
          screens: the player bar sits there and was hiding it. */}
      {(listLabel || collection || roadTripOn || genre) && (
        <button
          onClick={clearList}
          className="pointer-events-auto absolute bottom-44 left-1/2 z-30 flex max-w-[92vw] -translate-x-1/2 items-center gap-2 rounded-full rm-glass px-3 py-2 text-xs font-500 text-[#eafff4] ring-1 ring-[#2fe08a]/40 transition-all hover:bg-[#2fe08a]/15 sm:bottom-32"
          title="Leave this list and go back to every station"
        >
          <Radio size={13} className="shrink-0 text-[#7bf0b8]" />
          <span className="max-w-[13rem] truncate">
            Playing:{" "}
            {listLabel ||
              (collection && collection.label) ||
              (genre && ((GENRES.find((g) => g.key === genre) || {}).label || genre)) ||
              "Pinned favourites"}
          </span>
          <X size={14} className="shrink-0 opacity-80" />
        </button>
      )}
      {/* The big left-hand now-playing card is gone on every screen: the horizontal player
          bar at the foot of the page already shows the station, and on desktop the two sat
          on top of each other. It was absolute, so nothing else reflows. The component is
          left in the tree so this is a one-line revert if the look is missed. */}
      {/* Fires a wake-up alarm if one is set. Renders nothing. */}
      <AlarmWatcher />
      {/* A switch keeps the old station on air, so this is the only sign a press
          registered. */}
      <SwitchingChip />


      {/* Country picker. Collapsed to one button until it is wanted, so the map keeps its
          space; expands into an alphabetical list with the search on top. */}
      <div className="rm-safe-bottom pointer-events-none absolute bottom-44 left-4 z-20 flex flex-col items-start gap-3 sm:bottom-auto sm:left-6 sm:top-24 sm:flex-col-reverse">
        {pickerOpen && (
          <div className="pointer-events-auto flex max-h-[60vh] w-[19rem] flex-col overflow-hidden rounded-2xl rm-glass">
            <div className="flex items-center justify-end border-b border-white/10 px-3 py-1.5">
              <button
                onClick={() => setPickerOpen(false)}
                aria-label="Close country list"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#9fb3aa] hover:bg-white/5 hover:text-white"
              >
                <X size={15} />
              </button>
            </div>
            <p className="border-b border-white/5 px-3 pb-2 text-xs font-500 uppercase tracking-wide text-[#6d837a]">Countries, A to Z</p>
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {shownCountries.length ? (
                shownCountries.map((c) => (
                  <button
                    key={c.key}
                    onClick={() => enterCountry(c.name)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-[#dceee6] transition-colors hover:bg-[#2fe08a]/10"
                  >
                    <span className="truncate">{c.name}</span>
                    <span className="shrink-0 text-xs text-[#6d837a]">{c.count}</span>
                  </button>
                ))
              ) : (
                <p className="px-3 py-3 text-sm text-[#9fb3aa]">No country matches that.</p>
              )}
            </div>
          </div>
        )}
        <button
          onClick={() => setPickerOpen((v) => !v)}
          className="group pointer-events-auto flex items-center gap-2 rounded-full rm-glass px-4 py-3 text-sm font-500 text-[#eafff4] transition-all hover:bg-[#2fe08a]/15"
          title="Choose a country to listen to"
        >
          <Globe2 size={17} className="transition-transform group-hover:scale-110" />
          <span className="hidden sm:inline">{countryMode ? countryMode : "Country"}</span>
        </button>
        {countryMode && (
          <button
            onClick={leaveCountry}
            className="pointer-events-auto flex items-center gap-2 rounded-full rm-glass px-4 py-3 text-sm font-500 text-[#7bf0b8] ring-1 ring-[#2fe08a]/40 transition-all hover:bg-[#2fe08a]/15"
            title="Leave this country and go back to the whole world"
          >
            <ArrowLeft size={16} />
            <span className="hidden sm:inline">View worldwide</span>
          </button>
        )}
      </div>

      <div className="rm-safe-bottom pointer-events-none absolute bottom-44 right-4 z-20 flex flex-col items-end gap-3 sm:bottom-6 sm:right-6">
        <button
          onClick={deepView ? closeDeepView : openDeepView}
          className="group pointer-events-auto flex items-center gap-2 rounded-full rm-glass px-4 py-3 text-sm font-500 text-[#7bf0b8] transition-all hover:bg-[#2fe08a]/15"
          title={deepView ? "Back to the spinning globe" : "Zoom into a city with real imagery"}
        >
          <MapIcon size={17} className="transition-transform group-hover:scale-110" />
          <span className="hidden sm:inline">{deepView ? "Globe view" : "Deep zoom"}</span>
        </button>
        <button
          onClick={spinTheGlobe}
          className="group pointer-events-auto flex items-center gap-2 rounded-full rm-glass px-4 py-3 text-sm font-500 text-[#eafff4] ring-1 ring-[#2fe08a]/40 transition-all hover:bg-[#2fe08a]/15"
          title="Spin the globe and land on a random station"
        >
          <Compass
            size={17}
            className="transition-transform duration-700 group-hover:rotate-180"
          />
          <span className="hidden sm:inline">Spin the globe</span>
        </button>
        <button
          onClick={startVoice}
          className={`group pointer-events-auto flex items-center gap-2 rounded-full rm-glass px-4 py-3 text-sm font-500 transition-all ${
            listening
              ? "bg-[#2fe08a]/20 text-[#2fe08a]"
              : "text-[#c9b4ff] hover:bg-[#b79cff]/15"
          }`}
          title="Voice search — say a city or genre"
        >
          <Mic size={17} className={listening ? "rm-pulse" : "transition-transform group-hover:scale-110"} />
          <span className="hidden sm:inline">{listening ? "Listening…" : "Say a station"}</span>
        </button>
        <button
          onClick={roadTrip}
          className={`group pointer-events-auto flex items-center gap-2 rounded-full rm-glass px-4 py-3 text-sm font-500 transition-all ${
            roadTripOn
              ? "bg-[#ffb454]/20 text-[#ffcf8a] ring-1 ring-[#ffb454]/50"
              : "text-[#ffcf8a] hover:bg-[#ffb454]/15"
          }`}
          title={
            roadTripOn
              ? "Road trip is on — next/back walk your pinned stations. Press to leave."
              : "Road trip through your pinned favorites"
          }
        >
          <RouteIcon size={17} className="transition-transform group-hover:scale-110" />
          <span className="hidden max-w-[9rem] truncate sm:inline">
            {roadTripOn ? (collection ? collection.label : "Road trip on") : "Road trip"}
          </span>
          {roadTripOn && !collection && (
            <span className="text-[11px] opacity-80">{favorites.filter((s) => s.url).length}</span>
          )}
        </button>
        <button
          onClick={locateMe}
          className="group pointer-events-auto flex items-center gap-2 rounded-full rm-glass px-4 py-3 text-sm font-500 text-[#9fd8ff] transition-all hover:bg-[#7fd4ff]/15"
          title="Find my location & play the nearest station"
        >
          <LocateFixed size={17} className="transition-transform group-hover:scale-110" />
          <span className="hidden sm:inline">Locate me</span>
        </button>
        <button
          onClick={() => setDriving(true)}
          className="group pointer-events-auto flex items-center gap-2 rounded-full rm-glass px-4 py-3 text-sm font-500 text-[#cfe8dd] transition-all hover:bg-white/10"
          title="Driving mode — three huge controls, screen stays awake"
        >
          <Car size={17} className="transition-transform group-hover:scale-110" />
          <span className="hidden sm:inline">Driving mode</span>
        </button>
      </div>

      <PlayerBar />
        </>
      )}
      {viewMode !== "car" && <InstallPrompt raised={viewMode === "phone"} />}
      {driving && <DrivingMode onExit={() => setDriving(false)} />}
      <SidePanel
        panel={panel}
        cityStation={cityStation}
        initialCountry={countryMode}
        onClose={() => setPanel(null)}
        onPlayFocus={handlePlayFocus}
        onPresetStarted={(preset, stations) => {
          // A preset becomes the Next/Back list, exactly like the favourites road
          // trip — same mechanism, different source.
          setRoadTripOn(true);
          setCollection({ label: preset.label });
          setListLabel(preset.label);
          if (stations && stations[0]) setCityStation(stations[0]);
        }}
        onOpenPrivacyPage={() => {
          setPanel(null);
          navigate("/privacy");
        }}
      />
      <Toaster
        position="top-center"
        theme="dark"
        toastOptions={{
          style: {
            background: "#0a1014",
            border: "1px solid rgba(47,224,138,0.25)",
            color: "#e8f0ec",
          },
        }}
      />
    </div>
  );
};

// The privacy note as a page of its own, so it can be linked to directly from the
// About panel, the footer of a shared card, or anywhere else.
const PrivacyPage = () => {
  const navigate = useNavigate();
  return (
    <div className="App rm-star-field min-h-screen">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-5 py-8 text-[#cfe8dd]">
        <button
          onClick={() => navigate("/")}
          className="mb-5 flex w-max items-center gap-2 rounded-full px-3 py-2 text-sm text-[#9fb3aa] transition-colors hover:bg-white/5 hover:text-white"
        >
          <ArrowLeft size={16} /> Back to the radio
        </button>
        <h1 className="font-display text-3xl font-700 text-white">Privacy</h1>
        <p className="mb-6 mt-1 text-sm text-[#8497a0]">
          The short version: there is nothing to opt out of.
        </p>
        <div className="flex-1">
          <PrivacyContent />
        </div>
        <p className="mt-8 text-xs text-[#5f7a6e]">
          World Radio · station data from the community-run Radio-Browser project ·
          static site on GitHub Pages.
        </p>
      </div>
    </div>
  );
};

function App() {
  return (
    <PlayerProvider>
      <BrowserRouter basename={process.env.PUBLIC_URL}>
        <Routes>
          <Route path="/" element={<RadioApp />} />
          {/* Two address shapes for one station: the readable /station/<slug>/
              that the build publishes and everything shares, and the older
              /station/<slug>/<id> that is already inside messages people sent. */}
          <Route path="/station/:slug" element={<RadioApp />} />
          <Route path="/station/:slug/:id" element={<RadioApp />} />
          {/* Embeddable single-station player for other people's websites. */}
          <Route path="/embed/:id" element={<EmbedPlayer />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="*" element={<RadioApp />} />
        </Routes>
      </BrowserRouter>
    </PlayerProvider>
  );
}

export default App;
