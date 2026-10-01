import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import {
  streamUrl,
  registerClick,
  getNowPlaying,
  imgProxyUrl,
} from "../lib/radioApi";
import { AD_BASE_URL, adIntervalMs, pickAd, noteAdFailure } from "../lib/ads";
import { noteFailure, noteSuccess, failCount, BAD_THRESHOLD } from "../lib/health";
import { noteCountry } from "../lib/explored";
import { warn as hapticWarn } from "../lib/haptics";
import { isBlockedStation } from "../lib/radioApi";
import { sanitiseStation } from "../lib/backup";

// iPhone and iPad ship the Remote Playback API but do not implement it: prompt() rejects
// with "Operation is not supported" (or an NSOSStatusErrorDomain), which reads like a
// broken website. On those devices AirPlay belongs to the OS, and the media element has
// already opted in with x-webkit-airplay="allow" — so the route picker is in Control
// Centre, not here. Checked as a function rather than a module constant so it can be
// exercised in a test.
const isIOS = () =>
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

// Advertising volume contract: the radio is ducked, never silenced. Keeping the stream
// just audible is what holds the OS media session open while the advert plays, so the
// lock-screen card and its Next/Previous buttons are still there when the break ends.
const AD_DUCK_VOLUME = 0.04;
// iOS is excluded from breaks altogether: Safari ignores HTMLMediaElement.volume, so the
// duck above cannot be applied there, and a second audio element contends with the stream
// instead of sitting under it. Observed on a real iPhone: either the radio went silent with
// no advert and never recovered, or the Advertisement label appeared with no audio while the
// radio carried on. A few cents of ad revenue is not worth a silent player, so isIOS() stops
// the break before it starts and the timer is left dormant for the session.
// A stalled or unplayable advert must not hold the radio down forever.
const AD_MAX_MS = 150000;
import { toast } from "sonner";

const PlayerContext = createContext(null);
export const usePlayer = () => useContext(PlayerContext);

const FAV_KEY = "rm_favorites";
const HIST_KEY = "rm_history";

// The rescue ladder. The contract with the driver is that a station failure never
// leaves the player silent, because a silent media element is exactly what makes
// iOS tear down the lock-screen card and the Bluetooth Next/Back buttons with it.
// If the whole queue and the last good station have failed we park on one of these
// instead — and rotate through them, so a single flaky standby can never be the
// reason the player goes quiet. All three are https, so a rescue does not depend on
// the relay being up.
const RESCUE_STATIONS = [
  {
    id: "rm-rescue-1",
    name: "Sky News Australia Radio",
    url: "https://playerservices.streamtheworld.com/api/livestream-redirect/NOVA_SKYNEWSAAC.aac",
    country: "Australia",
    state: "NSW",
    tags: ["news"],
  },
  {
    id: "rm-rescue-2",
    name: "SomaFM Groove Salad",
    url: "https://ice1.somafm.com/groovesalad-128-mp3",
    country: "United States",
    state: "California",
    tags: ["ambient", "electronic"],
  },
  {
    id: "rm-rescue-3",
    name: "Radio Paradise",
    url: "https://stream.radioparadise.com/mp3-192",
    country: "United States",
    state: "California",
    tags: ["eclectic", "rock"],
  },
];

const FALLBACK_STATION = RESCUE_STATIONS[0];

// Station changes never point the live element at an unverified URL: a second
// element buffers the candidate and only then takes over (see bufferIncoming and
// promoteIncoming in PlayerContext). That is why there is no separate "probe"
// helper here any more — the incoming element IS the probe.

const load = (key, fallback) => {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
};

// Stored lists are treated as untrusted too. They may have been written by an older
// build (before a field was validated), or edited by hand in devtools; re-checking on
// load means a stored entry can never smuggle markup, a javascript: URL or a blocked
// station name into the player, and stale entries get cleaned up by themselves.
const cleanStoredFavorites = (list) => {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list.slice(0, 2000)) {
    const station = sanitiseStation(raw);
    if (!station || isBlockedStation(station) || seen.has(station.id)) continue;
    seen.add(station.id);
    out.push(station);
  }
  return out;
};

// History keeps whatever else the app put on the entry (play timestamps and so on),
// so this one only removes what must never be played or shown.
const filterStoredList = (list) =>
  Array.isArray(list)
    ? list
        .filter((s) => s && typeof s === "object" && s.id && s.url && !isBlockedStation(s))
        .slice(0, 2000)
    : [];

// Small rolling trace of player decisions, readable from the console as
// window.__rmTrace. Cheap, capped, and the only practical way to see why a
// station change took the path it did when the screen is locked.
const trace = (event, extra) => {
  try {
    const w = window;
    if (!w.__rmTrace) w.__rmTrace = [];
    w.__rmTrace.push({
      at: new Date().toISOString().slice(11, 23),
      event,
      els: document.querySelectorAll("audio").length,
      ...extra,
    });
    if (w.__rmTrace.length > 80) w.__rmTrace.shift();
  } catch {
    /* never let diagnostics break playback */
  }
};

export const PlayerProvider = ({ children }) => {
  const audioRef = useRef(null);
  const userVolRef = useRef(0.9);
  const fadeRef = useRef(null);

  const [current, setCurrent] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [error, setError] = useState(null);
  const [blocked, setBlocked] = useState(false);
  const [volume, setVolume] = useState(0.9);
  const [nowPlaying, setNowPlaying] = useState(null);
  // Signal health for whatever is on air. `weak` is live (the stream is stalling
  // right now); `flaky` comes from this device's memory of the station. Both are
  // advisory only — the player still rescues itself, this just says so out loud.
  const [weakSignal, setWeakSignal] = useState(false);
  const [flakyStation, setFlakyStation] = useState(false);
  const [castState, setCastState] = useState("unsupported");
  // null = not known yet (so the prompt is still allowed), true/false = what the browser
  // says about receivers on this network.
  const [castAvailable, setCastAvailable] = useState(null);
  const [elementTick, setElementTick] = useState(0);

  const [sleepEndsAt, setSleepEndsAt] = useState(null);
  const [sleepRemaining, setSleepRemaining] = useState(0);
  const [favorites, setFavorites] = useState(() => cleanStoredFavorites(load(FAV_KEY, [])));
  const [history, setHistory] = useState(() => filterStoredList(load(HIST_KEY, [])));

  // Which curated list Next/Back is walking, if any - a country, a genre, a search,
  // the favourites. The player itself cannot know: all it ever receives is an array.
  // Whoever installs the list names it, and the player bar shows the name, so a
  // listener walking forty jazz stations is never left guessing whether Next will
  // stay in jazz or wander the whole 59,000-station catalogue.
  const [listLabel, setListLabel] = useState(null);

  // Refs used inside imperative audio event handlers
  const queueRef = useRef([]);
  // { name, source } while a station change is in flight. The old station keeps
  // playing through a switch, so without visible feedback a press looks ignored
  // and people press again. UI renders this as a "Tuning to …" chip.
  const [switching, setSwitching] = useState(null);
  const indexRef = useRef(0);
  const skipRef = useRef(0);
  const errorHandlerRef = useRef(null);
  // Which station we are currently trying to start, and the last one that
  // actually produced sound — used to fall back instead of going silent.
  const pendingRef = useRef(null);
  const lastGoodRef = useRef(null);
  // Latches the start watchdog: 0 = not watching, a timestamp while watching, -1 acted.
  const startWatchRef = useRef(0);
  // True when silence is deliberate (user pressed pause, or voice search is
  // listening) — the buffering watchdog must never "fix" that by playing.
  const userPausedRef = useRef(false);
  // Set when the PLATFORM paused the element without being asked — a phone call
  // taking the audio session, a Siri announcement, a car's Bluetooth pause button, a
  // wake from sleep. While it is in force nothing in this file restarts playback.
  const interruptionRef = useRef({ active: false, since: 0, why: null });

  // ---- Interruptions: obey the platform, don't race it ---------------------
  //
  // This player used to treat every unprompted pause as a fault to undo, from three
  // places at once: a 1.2s timer on the element's own pause, a 3s kick loop and a
  // widening backoff ladder. On an iPhone that is wrong, and expensively so: iOS pauses
  // this element when a call takes the audio session, and the restart that follows is
  // permitted often enough that the radio came back up *during* the call (measured on
  // the live bundle: one play() 1.2s after the pause, the element left playing). So the
  // pause is obeyed — every automatic restart stands down, and the station, its buffer
  // and the media session's buttons stay exactly where they are.
  //
  // The return is driven by evidence, never by a timer: the platform resuming the
  // element itself, the page becoming visible again (what happens when the listener
  // looks at the phone after a call), a lock-screen or car play press, or the listener
  // choosing a station. Silence during the interruption is what can be promised; a
  // ladder of play() attempts cannot be, because it is judged by an ear on a call.
  //
  // Said plainly because it cannot be fixed: no web API reports that a call is in
  // progress. If the platform never pauses the element, nothing in the page knows a
  // call is happening and the radio keeps playing.
  const startInterruption = useCallback((why) => {
    if (interruptionRef.current.active) return;
    interruptionRef.current = { active: true, since: Date.now(), why };
    trace("interrupt.obey", { why });
  }, []);

  const endInterruption = useCallback((why) => {
    if (!interruptionRef.current.active) return;
    trace("interrupt.end", {
      why,
      lastedMs: Date.now() - interruptionRef.current.since,
    });
    interruptionRef.current = { active: false, since: 0, why: null };
  }, []);

  // Both the element's own listener and the capture-phase document listener report the
  // same pause, so starting is idempotent. The settle delay is what keeps two innocent
  // events out of it: a gapless handover pauses the *outgoing* element, and a platform
  // that pauses and immediately resumes fires its own play within milliseconds. By the
  // time this runs, something has to actually still be silent.
  const handleUnpromptedPause = useCallback(
    (el) => {
      setTimeout(() => {
        const a = audioRef.current;
        if (!a || a !== el) return;
        if (!a.paused) return;
        if (!a.getAttribute("src") || a.ended) return;
        if (userPausedRef.current || adRef.current.active) return;
        startInterruption("platform");
      }, 400);
    },
    [startInterruption]
  );

  // The rescue ladder is walked in order, and the chime is created lazily: an
  // AudioContext created before any user gesture starts suspended.
  const rescueIdxRef = useRef(0);
  const stingCtxRef = useRef(null);

  // Stalls long enough to be heard, with timestamps, for the weak-signal warning.
  const stallRef = useRef([]);
  const stallStartRef = useRef(0);
  const weakWarnedRef = useRef(false);

  const nextRescue = useCallback(() => {
    const s = RESCUE_STATIONS[rescueIdxRef.current % RESCUE_STATIONS.length];
    rescueIdxRef.current += 1;
    return s;
  }, []);

  // A short two-note chime, played only on the rescue path. A station dying and a
  // stranger's stream suddenly appearing reads as a fault; the chime makes it read
  // as the app handling it. It can only play when the element is already silent,
  // and every failure is swallowed — it must never be the reason there is no sound.
  const playRescueSting = useCallback(() => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!stingCtxRef.current) stingCtxRef.current = new Ctx();
      const ctx = stingCtxRef.current;
      if (ctx.state === "suspended" && ctx.resume) {
        const p = ctx.resume();
        if (p && p.catch) p.catch(() => {});
      }
      const t0 = ctx.currentTime + 0.02;
      [
        [880, 0],
        [1174.66, 0.17],
      ].forEach(([freq, at], i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0 + at);
        gain.gain.exponentialRampToValueAtTime(i === 0 ? 0.17 : 0.13, t0 + at + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0 + at);
        osc.stop(t0 + at + 0.24);
      });
    } catch {
      /* a chime is a nicety, never a dependency */
    }
  }, []);

  // Advertisement break state.
  const [adPlaying, setAdPlaying] = useState(false);
  const adRef = useRef({ active: false, station: null, ad: null });
  const adTimerRef = useRef(null);
  const adElRef = useRef(null);
  const adWatchdogRef = useRef(null);
  const startAdRef = useRef(() => {});
  const adHandlerRef = useRef(null);
  const lastAdCheckRef = useRef(0);
  const adWarnedRef = useRef(false);
  // Latest station, readable from timers without stale closures.
  const currentStationRef = useRef(null);
  // How many times this session has failed to start a station, so the recovery
  // logic can tell "the listener's own first choice failed" from "the radio died
  // mid-listen" — two situations that want opposite answers.
  const askedRef = useRef(0);
  // Active hls.js instance (only ever used for .m3u8 stations in browsers
  // without native HLS).
  const hlsRef = useRef(null);

  const pushHistory = useCallback((station) => {
    setHistory((prev) => {
      const filtered = prev.filter((s) => s.id !== station.id);
      return [{ ...station, playedAt: Date.now() }, ...filtered].slice(0, 40);
    });
  }, []);

  const detachHls = useCallback(() => {
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch {
        /* already gone */
      }
      hlsRef.current = null;
    }
  }, []);

  // Plays a URL on the shared audio element.
  //
  // .m3u8 (HLS) stations play natively on Safari/iOS but not in Chrome, Firefox
  // or Android Chrome. There we lazily pull in hls.js — only at the moment an
  // HLS station is actually chosen, so the library costs nothing for the other
  // 90-odd percent of stations and stays out of the initial bundle.
  const attachSource = useCallback(
    (rawUrl, { autoplay = true } = {}) => {
      const a = audioRef.current;
      if (!a || !rawUrl) return;
      detachHls();

      const src = streamUrl(rawUrl);
      const isHls = /\.m3u8(\?|#|$)/i.test(rawUrl) || /\.m3u8(\?|#|$)/i.test(src);

      const play = () => {
        if (!autoplay) return;
        const p = a.play();
        if (p && p.catch) {
          p.catch((err) => {
            setIsBuffering(false);
            if (err && err.name === "NotAllowedError") setBlocked(true);
          });
        }
      };

      if (isHls) {
        // Let hls.js decide, not canPlayType: Chrome reports "maybe" for HLS
        // without being able to play it, so the old check skipped hls.js exactly
        // where it was needed. hls.js reports unsupported on iOS Safari (no
        // MediaSource on iPhone), which is where native HLS is used instead.
        import("hls.js")
          .then((mod) => {
            const Hls = mod.default || mod.Hls;
            if (!Hls || !Hls.isSupported()) throw new Error("no MSE");
            const hls = new Hls({ enableWorker: true });
            hlsRef.current = hls;
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (data && data.fatal) {
                detachHls();
                if (errorHandlerRef.current) errorHandlerRef.current();
              }
            });
            hls.loadSource(src);
            hls.attachMedia(a);
            play();
          })
          .catch(() => {
            // Safari / iOS: hand the playlist to the element and let WebKit's
            // own HLS stack deal with it.
            a.src = src;
            play();
          });
        return;
      }

      a.src = src;
      play();
    },
    [detachHls]
  );

  // State/history side of starting a station: everything except touching audio.
  // Kept separate so a handover can commit the new station at the exact moment the
  // new element becomes audible rather than seconds earlier.
  const commitStation = useCallback(
    (station, { buffering = true } = {}) => {
      setError(null);
      setBlocked(false);
      setNowPlaying(null);
      setCurrent(station);
      setIsBuffering(buffering);
      pendingRef.current = station;
      userPausedRef.current = false;
      // A station the listener chose is a request for sound, so it ends an
      // interruption rather than waiting for one of the resume signals.
      endInterruption("tune");
      // Selecting a station cancels any ad break in progress.
      adRef.current.active = false;
      adRef.current.station = null;
      setAdPlaying(false);
      pushHistory(station);
      registerClick(station.id);
      // Station health and the Around the World count: this is the single place a
      // station definitively becomes the one on air.
      // Read the station's history *before* a good play clears it. If it has failed on
      // this device before, the listener is told once — so that a rescue later reads as
      // the app handling something, rather than as a glitch.
      setFlakyStation(failCount(station) >= BAD_THRESHOLD);
      noteSuccess(station);
      const world = noteCountry(station);
      if (world && world.milestone) {
        toast.success(`${world.milestone} countries heard`, {
          description: "Your Around the World map just grew — see it in Explore.",
        });
      }
    },
    [pushHistory, endInterruption]
  );

  const _start = useCallback(
    (station) => {
      if (!station || !station.url) return;
      trace("_start", { station: station.name && station.name.slice(0, 24) });
      commitStation(station);
      attachSource(station.url);
    },
    [commitStation, attachSource]
  );

  const play = useCallback(
    (station, queue = null) => {
      if (!station) return;
      skipRef.current = 0;
      if (Array.isArray(queue) && queue.length) {
        queueRef.current = queue;
        const i = queue.findIndex((s) => s.id === station.id);
        indexRef.current = i >= 0 ? i : 0;
      } else {
        const cq = queueRef.current;
        const i = cq.findIndex((s) => s.id === station.id);
        if (i >= 0) {
          indexRef.current = i;
        } else {
          queueRef.current = [station];
          indexRef.current = 0;
        }
      }
      // Gapless when something is already playing, instant when nothing is.
      if (handoverRef.current) handoverRef.current(station);
      else _start(station);
    },
    [_start]
  );

  // (Removed: playAt() used to point the live element straight at the next
  // queue entry. Switching now goes through tuneTo/stepQueue so a dead station
  // is never allowed to interrupt what is playing.)

  // ---- Switching stations without ever going silent ----------------------
  //
  // The old path pointed the live element straight at the next candidate. If that
  // candidate was dead or slow, the driver got several seconds of silence — and
  // iOS treats silence on a locked screen as "the media session ended", so the
  // card disappeared along with the Bluetooth Next/Back buttons. Worse, the
  // element was left paused on the dead URL: play() on that same URL can never
  // succeed, so tapping play (or Next) again did nothing and only a page refresh
  // (a brand new element) brought the controls back.
  //
  // Now a candidate is verified on a throwaway element first, the current station
  // keeps playing the whole time, and if nothing verifies we stay on what is
  // already playing rather than switching to silence.
  // Shared element plumbing. Declared before the switching code because a
  // useCallback dependency array is evaluated during render, so anything
  // referenced there must already be initialised.
  const handlersRef = useRef(null);
  // Set once handoverTo exists, so earlier callbacks (play) can use it without a
  // dependency cycle.
  const handoverRef = useRef(null);
  // Bumped on every switch attempt so a slow candidate cannot take over after a
  // newer press has already started.
  const switchSeqRef = useRef(0);

  // Builds an element with the shared listeners attached. Kept in the document and
  // marked inline: iOS holds the lock-screen / Bluetooth session far more reliably
  // for an attached media element.
  const createElement = useCallback(({ muted = false, preload = "none" } = {}) => {
    const el = new Audio();
    el.preload = preload;
    el.muted = muted;
    // No crossOrigin: most radio servers don't send CORS headers, and asking for
    // CORS makes the browser refuse streams it would otherwise play fine.
    el.volume = userVolRef.current;
    el.setAttribute("playsinline", "");
    el.setAttribute("webkit-playsinline", "");
    el.setAttribute("x-webkit-airplay", "allow");
    el.style.display = "none";
    document.body.appendChild(el);
    const h = handlersRef.current;
    if (h) Object.keys(h).forEach((ev) => el.addEventListener(ev, h[ev]));
    return el;
  }, []);

  // Detaches an element for good: stops it, drops its source and removes it from
  // the document so no connection or listener is left behind.
  const discardElement = useCallback(({ el, hls } = {}) => {
    if (!el) return;
    try {
      el.pause();
    } catch {
      /* ignore */
    }
    try {
      el.removeAttribute("src");
      el.load();
    } catch {
      /* ignore */
    }
    if (hls) {
      try {
        hls.destroy();
      } catch {
        /* ignore */
      }
    }
    if (el.parentNode) el.parentNode.removeChild(el);
  }, []);

  // Buffers a station on a SECOND element without touching what is playing.
  //
  // Deliberately NOT muted: Chrome fails to decode some Icecast streams on a muted
  // element (MEDIA_ERR_DECODE) and refuses to start inaudible media in a background
  // tab, which is precisely the situation we need this for. Volume 0 is silent to
  // the ear but still a normal, decodable, playing element.
  const bufferIncoming = useCallback(
    async (rawUrl, timeoutMs = 8000) => {
      const el = createElement({ preload: "auto" });
      el.volume = 0;
      const src = streamUrl(rawUrl);
      const isHls = /\.m3u8(\?|#|$)/i.test(rawUrl) || /\.m3u8(\?|#|$)/i.test(src);
      let hls = null;

      const discard = () => discardElement({ el, hls });

      const ready = await new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(ok);
        };
        // Reading bytes is what counts, so a slow stream that has started is a
        // pass, not a failure.
        const timer = setTimeout(() => finish(el.readyState >= 2), timeoutMs);
        el.addEventListener("canplay", () => finish(true), { once: true });
        el.addEventListener("playing", () => finish(true), { once: true });
        el.addEventListener("error", () => finish(false), { once: true });
        const start = () => {
          const p = el.play();
          if (p && p.catch) {
            p.catch((err) => {
              // A refusal to start is not the same as a dead stream: the element
              // may still fill its buffer, and the timeout below decides. Only a
              // hard media error is fatal here.
              trace("buffer.playRejected", { err: err && err.name });
            });
          }
        };
        if (isHls) {
          import("hls.js")
            .then((mod) => {
              const Hls = mod.default || mod.Hls;
              if (Hls && Hls.isSupported()) {
                hls = new Hls({ enableWorker: true });
                hls.on(Hls.Events.ERROR, (_event, data) => {
                  if (data && data.fatal) finish(false);
                });
                hls.loadSource(src);
                hls.attachMedia(el);
              } else {
                el.src = src;
              }
              start();
            })
            .catch(() => {
              el.src = src;
              start();
            });
        } else {
          el.src = src;
          start();
        }
      });

      if (!ready) {
        discard();
        return null;
      }
      return { el, hls };
    },
    [createElement, discardElement]
  );

  // Hands the audible role to the buffered element. It is already producing audio
  // before the old one stops, so the changeover is a few milliseconds instead of
  // the seconds of silence that used to cost us the lock-screen card.
  const promoteIncoming = useCallback((incoming, station) => {
    const old = audioRef.current;
    const el = incoming.el;
    // The incoming element has been playing silently at volume 0 while it filled
    // its buffer; give it the real volume as it takes over.
    el.volume = userVolRef.current;
    audioRef.current = el;
    if (old && old !== el) {
      // Retire the old element with a very short fade so the change isn't a click.
      try {
        const steps = 3;
        const startVol = old.volume;
        let i = 0;
        const fade = setInterval(() => {
          i += 1;
          try {
            old.volume = Math.max(0, startVol * (1 - i / steps));
          } catch {
            /* ignore */
          }
          if (i >= steps) {
            clearInterval(fade);
            try {
              old.pause();
            } catch {
              /* ignore */
            }
            try {
              old.removeAttribute("src");
              old.load();
            } catch {
              /* ignore */
            }
            if (old.parentNode) old.parentNode.removeChild(old);
          }
        }, 45);
      } catch {
        /* ignore */
      }
    }
    if (hlsRef.current && hlsRef.current !== incoming.hls) {
      try {
        hlsRef.current.destroy();
      } catch {
        /* ignore */
      }
    }
    hlsRef.current = incoming.hls || null;
    // The new element is already playing, so its "playing" event fired before it
    // held the audible role — reflect that state here instead of waiting for an
    // event that will not come again.
    setIsPlaying(true);
    setIsBuffering(false);
    setError(null);
    setBlocked(false);
    skipRef.current = 0;
    lastGoodRef.current = station || pendingRef.current;
    trace("promoted", {
      station: (station && station.name && station.name.slice(0, 24)) || null,
      rs: el.readyState,
      vol: el.volume,
    });
  }, []);

  // Switch stations without a gap. Falls back to the direct source swap when
  // nothing is playing (nothing to protect) or when the candidate could not be
  // buffered (in which case the current station simply keeps playing).
  const handoverTo = useCallback(
    async (station, timeoutMs = 8000, source = "pick") => {
      if (!station || !station.url) return false;
      const seq = switchSeqRef.current + 1;
      switchSeqRef.current = seq;
      setSwitching({ name: station.name, id: station.id, source, at: Date.now() });
      const clearSwitching = () => {
        // Only the newest attempt may clear the indicator.
        if (seq === switchSeqRef.current) setSwitching(null);
      };
      const a = audioRef.current;
      const live = Boolean(a && !a.paused && a.readyState >= 2 && !adRef.current.active);
      trace("handoverTo", {
        station: station.name && station.name.slice(0, 24),
        live,
        paused: a ? a.paused : null,
        rs: a ? a.readyState : null,
      });
      if (!live) {
        trace("handover.skip", { reason: "nothing playing", station: station.name.slice(0, 24) });
        _start(station);
        clearSwitching();
        return true;
      }
      const incoming = await bufferIncoming(station.url, timeoutMs);
      // A newer press may have started while this one was buffering: a slow
      // candidate must never take over after the driver has already moved on.
      if (seq !== switchSeqRef.current) {
        if (incoming) discardElement(incoming);
        trace("handover.superseded", { station: station.name.slice(0, 24) });
        return false;
      }
      if (!incoming) {
        trace("handover.bufferFailed", { station: station.name.slice(0, 24) });
        // Remember the dud on this device so the queue stops offering it.
        noteFailure(station);
        clearSwitching();
        return false;
      }
      trace("handover.promote", { station: station.name.slice(0, 24) });
      commitStation(station, { buffering: false });
      promoteIncoming(incoming, station);
      clearSwitching();
      return true;
    },
    [_start, bufferIncoming, commitStation, promoteIncoming, discardElement]
  );

  const tuneTo = useCallback(
    async (station, { timeout = 8000, source = "pick" } = {}) =>
      handoverTo(station, timeout, source),
    [handoverTo]
  );

  // Expose the gapless switch to callbacks declared earlier in the component
  // (play), without creating a dependency cycle.
  useEffect(() => {
    handoverRef.current = handoverTo;
  }, [handoverTo]);

  // Re-open the station that is supposed to be on air, through the normal path.
  //
  // This is the answer to the two ways a stream dies while nobody is touching the
  // phone. The phone changes network — Wi-Fi handing over to mobile data as the car
  // leaves the driveway — and the connection the stream was riding on dies with it.
  // Or iOS takes the audio session away for a moment: a call, a Siri announcement,
  // waking from sleep. In both cases the element carries on believing it is playing
  // while nothing arrives, so the station is re-opened from here: same station, same
  // media session, no queue change, and nothing for the listener to unlock or press.
  const reconnect = useCallback(
    (why) => {
      const station = current;
      const a = audioRef.current;
      if (!station || !a || adRef.current.active || userPausedRef.current) return false;
      if (!a.getAttribute("src")) return false;
      trace("stream.reconnect", { why, station: station.name.slice(0, 24) });
      tuneTo(station, { source: "reconnect" }).catch(() => {});
      return true;
    },
    [current, tuneTo]
  );

  // Walks the queue until a candidate verifies. Stations that fail never get the
  // live element, so a run of dead stations costs the listener nothing.
  // Several walks in flight supersede each other's handovers, and a supersede counts as
  // a failed attempt — which starts another walk. That is a positive-feedback loop: it
  // cycled station names dozens of times a second, created an audio element every 80 ms
  // and starved the audio clock, which the watchdog then read as a frozen stream. Only
  // the newest walk may continue; a superseded one exits immediately.
  const walkSeqRef = useRef(0);
  const lastRecoverWalkRef = useRef(0);

  const stepQueue = useCallback(
    async (direction, source) => {
      const q = queueRef.current;
      if (!q.length) return;
      const from = source || (direction > 0 ? "next" : "prev");
      // Background recovery cannot re-enter in a burst. User presses are never limited.
      if (from === "recover" || from === "rescue") {
        const now = Date.now();
        if (now - lastRecoverWalkRef.current < 4000) {
          trace("stepQueue.rateLimited", { from });
          return;
        }
        lastRecoverWalkRef.current = now;
      }
      walkSeqRef.current += 1;
      const walk = walkSeqRef.current;
      const attempts = Math.min(q.length - 1, 6);
      for (let i = 1; i <= attempts; i += 1) {
        if (walk !== walkSeqRef.current) {
          trace("stepQueue.superseded", { from });
          return;
        }
        const n = (((indexRef.current + direction * i) % q.length) + q.length) % q.length;
        const candidate = q[n];
        if (!candidate || !candidate.url) continue;
        // eslint-disable-next-line no-await-in-loop
        const ok = await tuneTo(candidate, { source: from });
        trace("stepQueue.try", { station: candidate.name.slice(0, 24), ok });
        if (ok) {
          // Advance the queue cursor — without this every press retries the same
          // station (the old playAt() used to do it).
          indexRef.current = n;
          skipRef.current = 0;
          return;
        }
      }
      // Nothing nearby verified. If audio is still playing, stay exactly where we
      // are — never hand the driver silence.
      const a = audioRef.current;
      if (a && !a.paused && a.readyState >= 2 && !adRef.current.active) {
        setIsBuffering(false);
        return;
      }
      // Already silent, so there is nothing left to protect: get sound back by
      // any means available.
      const good = lastGoodRef.current;
      const currentId = currentStationRef.current && currentStationRef.current.id;
      if (good && good.url && good.id !== currentId) {
        _start(good);
        return;
      }
      const rescue = nextRescue();
      trace("rescue.ladder", { station: rescue.name.slice(0, 24), from: "queue" });
      playRescueSting();
      toast.message(`${rescue.name} — standing in until something better answers`);
      _start(rescue);
    },
    [tuneTo, _start, nextRescue, playRescueSting]
  );

  // A station that never starts must not hold the player in silence forever. The weak
  // signal path only warns on purpose - a station that is stalling, or playing something
  // quiet, is still playing, and skipping it would be wrong. This is the narrower case: no
  // audio has arrived at all and the clock has not moved, which is what a token-protected or
  // geo-blocked HLS stream leaves behind (every segment 403, so the element reports playing
  // with readyState 0 and raises no error anyone can react to).
  //
  // Guarded four ways so it can never become a skip cascade: it acts once per tuning, it only
  // acts while listening is not deliberate and no advert is on air, it stops after SKIP_LIMIT
  // consecutive failures, and skipRef is reset by onPlaying the moment real audio starts - so
  // a station that works always clears the budget.
  const SKIP_LIMIT = 3;
  const START_GRACE_MS = 12000;

  useEffect(() => {
    const id = setInterval(() => {
      if (adRef.current.active || userPausedRef.current) return;
      // Silence the platform asked for is not a station that failed to start:
      // advancing here would put a rescue stream on air during the call.
      if (interruptionRef.current.active) return;
      if (skipRef.current >= SKIP_LIMIT) return;
      const station = pendingRef.current;
      if (!station) return;
      const els = Array.from(document.querySelectorAll("audio"));
      const el = els.find((a) => !a.paused) || els[0];
      if (!el) return;
      if (el.readyState >= 2 || el.currentTime > 0.2) {
        startWatchRef.current = 0;
        return;
      }
      if (startWatchRef.current === -1) return;
      if (!startWatchRef.current) {
        startWatchRef.current = Date.now();
        return;
      }
      if (Date.now() - startWatchRef.current < START_GRACE_MS) return;
      startWatchRef.current = -1;
      skipRef.current += 1;
      noteFailure(station);
      trace("stall.advance", {
        station: (station.name || "").slice(0, 24),
        skips: skipRef.current,
      });
      if (skipRef.current >= SKIP_LIMIT) {
        const fallback = lastGoodRef.current || nextRescue();
        if (fallback && fallback.id !== station.id) {
          trace("stall.fallback", { to: (fallback.name || "").slice(0, 24) });
          handoverTo(fallback, 6000, "stall-fallback");
          return;
        }
      }
      stepQueue(1, "stall");
    }, 2000);
    return () => clearInterval(id);
  }, [stepQueue, handoverTo, nextRescue]);
  const next = useCallback(() => {
    stepQueue(1, "next");
  }, [stepQueue]);
  const prev = useCallback(() => {
    stepQueue(-1, "prev");
  }, [stepQueue]);

  const setNeighbors = useCallback(
    (list, currentId) => {
      if (!Array.isArray(list) || !list.length) return;
      queueRef.current = list;
      const i = list.findIndex((s) => s.id === currentId);
      indexRef.current = i >= 0 ? i : 0;
    },
    []
  );

  // ---- Audio element ------------------------------------------------------
  // (handlersRef and createElement are declared above, before the switching
  // code, because a dependency array is evaluated during render.)
  //
  // Exactly one element is audible at a time and it is the one that owns the
  // lock-screen session. A station change builds a SECOND element, lets it buffer
  // and start producing audio, and only then stops the first one (see
  // bufferIncoming/promoteIncoming). That is what removes the seconds of silence a
  // source swap caused — and silence on a locked screen is what makes iOS take the
  // Now Playing card and the car buttons away.

  // While handing over, two elements exist at once (one winding down, one
  // starting). Events from a retired element must be ignored.
  const isActive = (e) => Boolean(e) && e.currentTarget === audioRef.current;

  const onPlaying = useCallback((e) => {
    if (!isActive(e)) return;
    setIsPlaying(true);
    setIsBuffering(false);
    // Sound is flowing again, so whatever took the audio session has given it back:
    // a call ended, or Siri finished. Nothing needs restarting — the only casualty of
    // an interruption is the Now Playing card, and this is what puts it back.
    if (interruptionRef.current.active) {
      endInterruption("element");
      registerMediaActions();
    }
    setError(null);
    setBlocked(false);
    skipRef.current = 0;
    lastGoodRef.current = pendingRef.current;

    // Sound is back. Anything that was silent for more than a moment and a half is
    // worth telling the listener about — twice inside two minutes means the station
    // itself is struggling, not the connection to it.
    const started = stallStartRef.current;
    stallStartRef.current = 0;
    if (started) {
      const lasted = Date.now() - started;
      if (lasted > 1500) {
        const now = Date.now();
        const recent = [...stallRef.current.filter((t) => now - t < 120000), now];
        stallRef.current = recent;
        if (recent.length >= 2) {
          setWeakSignal(true);
          if (!weakWarnedRef.current) {
            weakWarnedRef.current = true;
            hapticWarn();
            trace("signal.weak", {
              station: (pendingRef.current?.name || "").slice(0, 24),
              stalls: recent.length,
            });
            toast.warning("Weak signal on this station", {
              description:
                "It is still playing. Next will pick a stronger one whenever you want.",
            });
          }
        }
      }
    }
  }, [endInterruption]);

  const onWaiting = useCallback((e) => {
    if (!isActive(e)) return;
    setIsBuffering(true);
    // A stall only matters if it lasts: every stream blips for a moment when it
    // first connects, and a blip is not a weak signal.
    if (!stallStartRef.current) stallStartRef.current = Date.now();
  }, []);

  const onPause = useCallback((e) => {
    if (!isActive(e)) return;
    setIsPlaying(false);
    // A pause we did not ask for is the platform's, not an instruction to fight.
    // iOS pauses this element for a phone call (and for Siri, a car's Bluetooth
    // pause button, a wake from sleep), and restarting it a second later is exactly
    // what made the radio audible right through a call — the play() that follows is
    // permitted often enough to matter. So it is obeyed here: the station stays
    // loaded, the element stays paused, and the resume comes from evidence that the
    // interruption is over.
    if (userPausedRef.current || adRef.current.active) return;
    handleUnpromptedPause(e.currentTarget);
  }, [handleUnpromptedPause]);

  const onError = useCallback((e) => {
    if (!isActive(e)) return;
    // A broken ad must never be mistaken for a broken station.
    if (adRef.current.active) {
      adHandlerRef.current && adHandlerRef.current();
      return;
    }
    if (errorHandlerRef.current) errorHandlerRef.current();
  }, []);

  const onEnded = useCallback((e) => {
    if (!isActive(e)) return;
    // An ad finishing is the signal to hand the stream back to the radio.
    if (adRef.current.active) adHandlerRef.current && adHandlerRef.current();
  }, []);

  // Background safety net for the ad cadence. While the screen is locked iOS may
  // throttle setTimeout, but a playing media element keeps raising timeupdate, so
  // an overdue break still happens.
  const onTimeUpdate = useCallback((e) => {
    if (!isActive(e)) return;
    if (adRef.current.active) return;
    const now = Date.now();
    if (now - lastAdCheckRef.current < 10000) return;
    lastAdCheckRef.current = now;
    if (adTimerRef.current) return; // the normal timer is alive and owns this
    const dueAt = adRef.current.dueAt;
    if (dueAt && now >= dueAt && !userPausedRef.current) {
      startAdRef.current && startAdRef.current();
    }
  }, []);

  useEffect(() => {
    handlersRef.current = {
      playing: onPlaying,
      waiting: onWaiting,
      pause: onPause,
      error: onError,
      ended: onEnded,
      timeupdate: onTimeUpdate,
    };
  }, [onPlaying, onWaiting, onPause, onError, onEnded, onTimeUpdate]);

  useEffect(() => {
    const a = createElement();
    audioRef.current = a;
    return () => {
      a.pause();
      if (a.parentNode) a.parentNode.removeChild(a);
      if (hlsRef.current) {
        try {
          hlsRef.current.destroy();
        } catch {
          /* ignore */
        }
        hlsRef.current = null;
      }
    };
  }, [createElement]);

  // ---- Casting --------------------------------------------------------------
  // Remote playback (Chromecast, and AirPlay via Safari's own picker) hangs off the
  // media element, and this player deliberately builds a new element for every station
  // change to keep the handover gapless — so the session is re-read whenever the
  // element is replaced, and the button never claims to be connected to an element
  // that has been retired.
  useEffect(() => {
    const el = audioRef.current;
    const remote = el && el.remote;
    const nativePicker = !!(el && typeof el.webkitShowPlaybackTargetPicker === "function");
    if (isIOS() && !nativePicker) {
      // AirPlay only. Offering the API here is what produced "operation is not supported".
      setCastState("airplay");
      return undefined;
    }
    if (!remote || typeof remote.prompt !== "function") {
      setCastState(nativePicker ? "airplay" : "unsupported");
      return undefined;
    }
    const sync = () => setCastState(remote.state || "disconnected");
    sync();
    remote.addEventListener("connect", sync);
    remote.addEventListener("connecting", sync);
    remote.addEventListener("disconnect", sync);
    // Chrome answers "supported" whether or not a Chromecast exists anywhere; this is the
    // only call that actually reports a receiver. Without it a cast button that can never
    // work sits there looking broken.
    let watchId = null;
    if (typeof remote.watchAvailability === "function") {
      remote
        .watchAvailability((available) => setCastAvailable(available))
        .then((id) => {
          watchId = id;
        })
        .catch(() => {
          /* availability unknown: leave it null and let the prompt have its say */
        });
    }
    return () => {
      remote.removeEventListener("connect", sync);
      remote.removeEventListener("connecting", sync);
      remote.removeEventListener("disconnect", sync);
      if (watchId !== null && typeof remote.cancelWatchAvailability === "function") {
        try {
          remote.cancelWatchAvailability(watchId).catch(() => {});
        } catch {
          /* ignore */
        }
      }
    };
  }, [elementTick]);

  useEffect(() => {
    setElementTick((t) => t + 1);
  }, [current]);

  // A new station resets the signal story: stalls and warnings belong to the stream
  // that caused them. (The "usually drops out" flag is set in commitStation, where the
  // station's history is read before a good play clears it.)
  useEffect(() => {
    setWeakSignal(false);
    stallRef.current = [];
    stallStartRef.current = 0;
    weakWarnedRef.current = false;
  }, [current]);

  const startCast = useCallback(async () => {
    const el = audioRef.current;
    if (!el) return;
    // The picker needs something loaded to hand over, and it must be the element that
    // is actually playing.
    if (!el.getAttribute("src")) {
      toast.info("Nothing playing to cast", {
        description: "Start a station, then try again.",
      });
      return;
    }
    if (isIOS() && typeof el.webkitShowPlaybackTargetPicker !== "function") {
      toast.info("AirPlay lives in Control Centre", {
        description:
          "Swipe down from the top-right corner, tap the AirPlay button on the now-playing card, then choose your TV or speaker. The website cannot open that picker.",
      });
      return;
    }
    try {
      if (el.remote && typeof el.remote.prompt === "function") {
        if (castAvailable === false) {
          toast.info("No cast receiver found", {
            description:
              "Chrome only shows a cast list when a Chromecast is on this Wi-Fi. Its own Cast button (⋮ → Cast) uses the same list.",
          });
          return;
        }
        await el.remote.prompt();
        return;
      }
      if (typeof el.webkitShowPlaybackTargetPicker === "function") {
        el.webkitShowPlaybackTargetPicker();
        return;
      }
      toast.info("This browser can't cast", {
        description: "On an iPhone, use the AirPlay button in Control Centre.",
      });
    } catch (err) {
      // Dismissing the picker rejects the promise (AbortError) and that is not a
      // failure. Reporting every rejection as "casting cancelled" is what turned a
      // missing device into a bug report — name what actually happened.
      const name = (err && err.name) || "";
      if (name === "AbortError") return;
      if (name === "NotFoundError") {
        toast.warning("No TV or speaker found", {
          description: "Turn it on and check it is on the same Wi-Fi, then try again.",
        });
        return;
      }
      if (name === "NotAllowedError") {
        // What desktop Chrome does when no receiver is reachable: the picker needs a
        // Chromecast on this network (or the Cast extension) before it will open at all.
        toast.warning("No cast list available here", {
          description:
            "Chrome only shows one when a Chromecast is on this Wi-Fi. Chrome's own Cast button (⋮ → Cast) uses the same list; on a phone, cast from the system controls.",
        });
        return;
      }
      if (name === "NotSupportedError") {
        toast.info("Casting isn't available in this browser", {
          description: "On a phone or tablet, use the AirPlay or Chromecast button in the system's media controls.",
        });
        return;
      }
      if (name === "InvalidStateError") {
        toast.info("Give the audio a moment", {
          description: "The stream has not loaded enough to hand over yet.",
        });
        return;
      }
      toast.warning("Couldn't start casting", {
        description: err && err.message ? String(err.message).slice(0, 120) : "The browser refused the request.",
      });
    }
  }, [castAvailable]);

  // Auto-skip broken streams (keep latest closure in a ref).
  //
  // Hands-free driving contract: a dead or stuck station must never leave the
  // player silent, because silence is what makes iOS drop the lock-screen card
  // and with it the Next/Previous buttons you are steering with. So we keep
  // moving through the queue, and when the whole queue has failed we fall back
  // to the last station that actually played rather than stopping.
  useEffect(() => {
    errorHandlerRef.current = () => {
      const el = audioRef.current;
      // Stopped on purpose — nothing to skip to.
      if (!el || !el.getAttribute("src")) return;
      // An ad is on air: its own handler deals with problems.
      if (adRef.current.active) return;
      // Paused on purpose — don't surprise the driver with a new station.
      if (userPausedRef.current) {
        setIsBuffering(false);
        return;
      }
      // Paused by the platform (a call): the station is not at fault, and starting a
      // rescue stream now would be audible on the call this is obeying.
      if (interruptionRef.current.active) {
        setIsBuffering(false);
        return;
      }
      setIsBuffering(false);
      setIsPlaying(false);
      // The element that erred is the live one, so the station worth scoring is
      // whatever we last asked it to play.
      noteFailure(pendingRef.current || currentStationRef.current);
      // Sound first, search second.
      //
      // iOS drops the Now Playing card and the Bluetooth buttons the moment the
      // page stops producing audio, and walking the queue on a second element
      // while this one sits in an error state can take tens of seconds — all of
      // them silent. That is how the lock screen was lost when a station went
      // down. So put audio back on the LIVE element immediately and only then
      // look for something better; the handover keeps that audio alive while the
      // search runs.
      // The first station of a session is the one somebody asked for by name —
      // opening a shared link, almost always. Answering that with an unrelated
      // rescue stream, and an address bar that follows it to the rescue station, is
      // exactly how a working link looks broken: the listener taps a Sydney station
      // and lands in Poland. So say what happened and leave the choice with them.
      // Once anything has played, a failure is a mid-listen problem and the
      // recovery paths below are the right answer.
      askedRef.current += 1;
      if (askedRef.current === 1 && !lastGoodRef.current) {
        const asked = pendingRef.current || currentStationRef.current;
        setError(
          `${asked?.name || "This station"} isn't playing here — press Next for another station.`
        );
        toast.message(`${asked?.name || "This station"} couldn't start`, {
          description: "Next will move on to another station.",
        });
        return;
      }

      const audible = el && !el.paused && el.readyState >= 2 && !el.error;
      const lastGood = lastGoodRef.current;
      const usingLastGood = Boolean(
        lastGood && lastGood.url && lastGood.id !== pendingRef.current?.id
      );
      const emergency = usingLastGood ? lastGood : nextRescue();
      if (!audible && pendingRef.current?.id !== emergency.id) {
        trace("recover.emergency", {
          station: emergency.name.slice(0, 24),
          ladder: !usingLastGood,
        });
        if (!usingLastGood) playRescueSting();
        skipRef.current = 0;
        _start(emergency);
        setIsBuffering(true);
        // Let the rescue stream actually start (readyState 2 is what makes the
        // next switch take the gapless handover path instead of a source swap),
        // then keep looking for a better station.
        setTimeout(() => stepQueue(1, "recover"), 1000);
        return;
      }
      const q = queueRef.current;
      // The station that just died is the current one, so walk forward from here.
      // stepQueue only commits to a candidate it has verified, so a run of dead
      // stations never reaches the speakers as silence.
      if (q.length > 1 && skipRef.current < 12) {
        skipRef.current += 1;
        stepQueue(1);
        return;
      }
      const good = lastGoodRef.current;
      if (good && good.url && good.id !== pendingRef.current?.id) {
        skipRef.current = 0;
        _start(good);
        return;
      }
      // Last resort: park on a stream that is known to work, so the lock-screen
      // card and the Bluetooth buttons survive the whole queue failing. Anything
      // already on the ladder counts as rescued, or the ladder could never advance
      // past its first rung.
      const onLadder = RESCUE_STATIONS.some((s) => s.id === pendingRef.current?.id);
      if (!onLadder) {
        const rescue = nextRescue();
        skipRef.current = 0;
        trace("rescue.ladder", { station: rescue.name.slice(0, 24), from: "exhausted" });
        playRescueSting();
        toast.message(`${rescue.name} — standing in until something better answers`);
        _start(rescue);
        return;
      }
      setError("This station couldn't be reached. Try another one.");
    };
  }, [stepQueue, _start, nextRescue, playRescueSting]);

  // Watchdog for stations that never fire an error: a stream that hangs on
  // "buffering" forever looks identical to a slow one, so give it 12 seconds
  // and then treat it as broken and move on.
  //
  // The first station of a session gets longer, because that is where hls.js is
  // pulled in for the first time — a lazy chunk racing a page load — and because
  // it is a station somebody asked for by name. A second station reached by
  // pressing Next is a different matter: they are already waiting on us.
  useEffect(() => {
    if (!current || blocked || isPlaying || userPausedRef.current) return;
    if (adRef.current.active) return;
    const patience = lastGoodRef.current ? 12000 : 22000;
    const timer = setTimeout(() => {
      // Re-check at fire time: pausing while a station is still buffering does
      // not change isPlaying, so this effect never re-runs to cancel the timer.
      if (userPausedRef.current || adRef.current.active) return;
      const a = audioRef.current;
      if (!a || a.readyState < 3) {
        errorHandlerRef.current && errorHandlerRef.current();
      }
    }, patience);
    return () => clearTimeout(timer);
  }, [current, isPlaying, blocked]);

  // ---- Advertisement breaks ----------------------------------------------
  //
  // An ad plays through the SAME audio element as the radio, never a second
  // one. A second element would take over the "now playing" session and iOS /
  // Android would drop the lock-screen and Bluetooth controls with it — the one
  // thing that must not happen mid-drive. Swapping src on the single element
  // keeps one continuous media session: the card stays, the buttons stay, and
  // when the ad ends the same element is pointed back at the live stream.

  // Smooth volume ramp. Cutting hard into an advert sounds like a fault; a short
  // fade reads as "the radio is pausing for a moment", and fading back in after
  // the break means the return to live radio is not a click either.
  const fadeTo = useCallback(
    (el, target, ms) =>
      new Promise((resolve) => {
        if (!el) return resolve();
        let from;
        try {
          from = el.volume;
        } catch {
          return resolve();
        }
        const steps = Math.max(3, Math.round((ms || 300) / 60));
        let i = 0;
        const timer = setInterval(() => {
          i += 1;
          try {
            el.volume = Math.max(0, Math.min(1, from + (target - from) * (i / steps)));
          } catch {
            /* element went away mid-fade */
          }
          if (i >= steps) {
            clearInterval(timer);
            resolve();
          }
        }, 60);
      }),
    []
  );

  const scheduleAd = useCallback((delay) => {
    if (adTimerRef.current) clearTimeout(adTimerRef.current);
    // Wall-clock deadline as well as a timer: iOS throttles or suspends timers
    // when the screen locks, so the media clock (timeupdate) double-checks this
    // deadline and fires a break that the timer slept through.
    adRef.current.dueAt = Date.now() + delay;
    adTimerRef.current = setTimeout(() => {
      adTimerRef.current = null;
      startAdRef.current && startAdRef.current();
    }, delay);
  }, []);

  const endAd = useCallback(() => {
    if (!adRef.current.active) return;
    adRef.current.active = false;
    setAdPlaying(false);
    adRef.current.station = null;
    adRef.current.ad = null;
    if (adWatchdogRef.current) {
      clearTimeout(adWatchdogRef.current);
      adWatchdogRef.current = null;
    }
    if (adRef.current.startTimer) {
      clearTimeout(adRef.current.startTimer);
      adRef.current.startTimer = null;
    }
    // Take the advert's own element down. The radio element was never touched — it has
    // been playing quietly the whole time — so there is nothing to re-attach and no
    // re-buffer: the volume simply comes back up.
    const adEl = adElRef.current;
    if (adEl) {
      try {
        adEl.pause();
        adEl.removeAttribute("src");
        adEl.load();
      } catch {
        /* element already gone */
      }
    }
    const a = audioRef.current;
    if (a) {
      if (userPausedRef.current) {
        try {
          a.volume = 0;
        } catch {
          /* ignore */
        }
      } else {
        fadeTo(a, userVolRef.current, 450);
      }
    }
    scheduleAd(adIntervalMs());
    trace("ad.end");
  }, [scheduleAd, fadeTo]);

  const startAd = useCallback(async () => {
    // iOS never gets an advert break, and it must be excluded here — before the probe.
    // Safari ignores HTMLMediaElement.volume, so the radio cannot be ducked under an
    // advert; worse, an off-DOM preload=metadata probe often never fires loadedmetadata
    // there, so discovery returned an empty list and told the listener the adverts were
    // missing. Excluded at the top: no probe request, no warning, no duck, radio untouched.
    if (isIOS()) return;
    if (adRef.current.active) return;
    const a = audioRef.current;
    if (!a || !a.getAttribute("src")) return;
    if (userPausedRef.current) {
      scheduleAd(Math.min(adIntervalMs(), 5 * 60 * 1000));
      return;
    }
    const station = currentStationRef.current;
    if (!station || !station.url) {
      scheduleAd(Math.min(adIntervalMs(), 5 * 60 * 1000));
      return;
    }
    const ad = await pickAd();
    if (!ad) {
      // Silence here is what makes "the ads never play" unreadable. Say it once, name
      // the folder, and retry on the normal cadence (nothing gets cached when the
      // discovery fails, so the next attempt really does look again).
      if (!adWarnedRef.current) {
        adWarnedRef.current = true;
        // Deliberately not a toast. A listener cannot act on this, and a warning banner on
        // an otherwise working site reads as breakage. Owner-side diagnostic only.
        console.warn(
          `[ads] nothing found at ${AD_BASE_URL} — adverts must be named ad1.mp3, ad2.mp3, ... ` +
            "(gaps are fine; six consecutive missing numbers end discovery)."
        );
      }
      trace("ad.none", { base: AD_BASE_URL });
      scheduleAd(adIntervalMs());
      return;
    }
    // Conditions can change while the ad list loads.
    if (isIOS()) {
      // No break, no duck, no second audio element. Left dormant rather than rescheduled,
      // so there is not even a probe request for the rest of the session.
      trace("ad.skip.ios", {});
      return;
    }
    if (adRef.current.active || userPausedRef.current) return;

    // The advert gets its own element and the radio is ducked underneath it rather than
    // replaced by it. Two reasons, and the second is the one that matters on a phone:
    //   1. the stream is never interrupted, so a break costs no re-buffer;
    //   2. the radio element keeps playing (barely audible), so Android and iOS keep the
    //      media session — hand the element over to the advert and the lock-screen
    //      player, with the Next/Previous buttons a driver steers by, can disappear.
    adRef.current.active = true;
    adRef.current.station = station;
    adRef.current.ad = ad;
    setAdPlaying(true);

    let el = adElRef.current;
    if (!el) {
      el = document.createElement("audio");
      el.preload = "auto";
      el.setAttribute("playsinline", "");
      el.style.display = "none";
      // Deliberately not muted: some servers refuse muted playback, and the radio
      // underneath is already down at AD_DUCK_VOLUME.
      el.addEventListener("ended", () => adHandlerRef.current && adHandlerRef.current());
      el.addEventListener("error", () => adHandlerRef.current && adHandlerRef.current());
      document.body.appendChild(el);
      adElRef.current = el;
    }
    try {
      el.volume = Math.max(0.05, Math.min(1, userVolRef.current));
    } catch {
      /* ignore */
    }
    // Duck the radio first, so the advert never lands on top of a loud stream.
    await fadeTo(a, AD_DUCK_VOLUME, 320);
    if (adRef.current.active !== true) return;
    try {
      el.src = ad;
    } catch {
      endAd();
      return;
    }
    // The advert has 8 seconds to prove it is actually playing. A break that neither
    // starts nor ends is the worst outcome available: the listener gets the
    // "Advertisement" label over a radio ducked to 4% and no way to tell what happened.
    if (adRef.current.startTimer) clearTimeout(adRef.current.startTimer);
    adRef.current.startTimer = setTimeout(() => {
      if (!adRef.current.active) return;
      const live = el.currentTime > 0.5 || (!el.paused && el.readyState >= 3);
      if (live) return;
      noteAdFailure(ad);
      endAd();
      scheduleAd(90 * 1000);
    }, 8000);

    const p = el.play();
    if (p && p.catch) {
      p.catch(() => {
        // Autoplay refused, or the file would not load. The radio is ducked underneath,
        // so the only thing that matters is getting the volume back. The alarm toast is
        // gone: a break that fails is retried in 90 seconds with a different advert, and
        // the failure is silently remembered so it cannot happen twice.
        noteAdFailure(ad);
        endAd();
        scheduleAd(90 * 1000);
      });
    }
    if (adWatchdogRef.current) clearTimeout(adWatchdogRef.current);
    adWatchdogRef.current = setTimeout(() => {
      if (adRef.current.active) endAd();
    }, AD_MAX_MS);
  }, [endAd, scheduleAd, fadeTo]);

  useEffect(() => {
    startAdRef.current = startAd;
  }, [startAd]);

  useEffect(() => {
    adHandlerRef.current = endAd;
  }, [endAd]);

  // Pausing mid-break means the listener asked for silence, not for the rest of an
  // advert — and switching station mid-advert should not carry the advert across.
  useEffect(() => {
    if (adPlaying && (!isPlaying || userPausedRef.current)) endAd();
  }, [adPlaying, isPlaying, endAd]);

  useEffect(() => {
    if (adPlaying) endAd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Latest station for timers, which must not read stale state.
  useEffect(() => {
    currentStationRef.current = current;
  }, [current]);

  // Arm the cadence once a station is playing. Deliberately not restarted on
  // every station change, so breaks still land every 5 minutes while you hop
  // between stations instead of resetting the clock each time.
  const armedIntervalRef = useRef(0);
  useEffect(() => {
    if (!isPlaying || adPlaying) return undefined;
    // Arm it here so the very first effect run does the arming...
    if (!adTimerRef.current) {
      const ms = adIntervalMs();
      armedIntervalRef.current = ms;
      scheduleAd(ms);
    }
    // ...and keep watching either way. The testing knob (rm_ad_interval_min) can change
    // while the app is running, so a shortened interval has to take effect on the spot:
    // a knob that silently does nothing is worse than having no knob at all. (Watching
    // only on later effect runs was the bug — with nothing else changing, there are no
    // later runs, so the knob was never noticed.)
    const watcher = setInterval(() => {
      if (adRef.current.active || adTimerRef.current === null) return;
      const want = adIntervalMs();
      if (want !== armedIntervalRef.current) {
        armedIntervalRef.current = want;
        scheduleAd(want);
      }
    }, 5000);
    return () => clearInterval(watcher);
  }, [isPlaying, adPlaying, scheduleAd]);

  useEffect(
    () => () => {
      if (adTimerRef.current) clearTimeout(adTimerRef.current);
      adTimerRef.current = null;
    },
    []
  );

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    if (volume > 0) userVolRef.current = volume;
  }, [volume]);

  useEffect(() => {
    localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
  }, [favorites]);
  useEffect(() => {
    localStorage.setItem(HIST_KEY, JSON.stringify(history));
  }, [history]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!current) return;
    if (isPlaying) {
      userPausedRef.current = true;
      a.pause();
    } else {
      userPausedRef.current = false;
      endInterruption("toggle");
      a.play().catch(() => {});
    }
  }, [current, isPlaying, endInterruption]);

  // Recover, don't just un-pause. If the element is parked on a URL that can
  // never play — the failure that used to require a page refresh — play()
  // rejects forever, so re-attach a station we actually believe in.
  const retune = useCallback(() => {
    const cur = currentStationRef.current;
    const good = lastGoodRef.current;
    const el = audioRef.current;
    const curBroken = !cur || !cur.url || Boolean(el && el.error);
    if (!curBroken && cur && cur.url) {
      _start(cur);
      return;
    }
    if (good && good.url) {
      _start(good);
      return;
    }
    _start(cur && cur.url ? cur : FALLBACK_STATION);
  }, [_start]);

  const resume = useCallback(() => {
    userPausedRef.current = false;
    // The listener — or their lock screen, or the car — has asked for sound.
    endInterruption("action");
    const a = audioRef.current;
    if (!a) return;
    const src = a.getAttribute("src");
    if (src && !a.error && a.readyState >= 1) {
      a.play().catch(() => retune());
      return;
    }
    retune();
  }, [retune, endInterruption]);

  // The slow safety net behind the player: it re-opens a stream whose connection died
  // without raising an error, and restarts an element that went silent for a reason
  // that is not a platform interruption — silence is what costs us the lock-screen
  // card and the car buttons. While an interruption is in force it stands down
  // completely: the platform asked for the quiet, and everything it would do here is
  // audible.
  useEffect(() => {
    // `lastTime`/`hits` live in this closure: they only need to survive between
    // ticks of this interval, and a ref would be one more thing to keep in step.
    let lastTime = -1;
    let hits = 0;
    const kick = () => {
      const a = audioRef.current;
      if (!a || adRef.current.active || userPausedRef.current) return;
      // While an interruption is in force the player is silent on purpose, so this
      // must neither restart the element nor re-open the stream: both are audible.
      if (interruptionRef.current.active) return;
      if (!a.getAttribute("src") || a.ended) return;
      if (a.paused) {
        a.play().catch(() => {});
        lastTime = -1;
        hits = 0;
        return;
      }
      // Not paused, and the browser still reports itself ready, but the clock has not
      // moved: a connection that died without raising an error. That is what a Wi-Fi
      // to mobile-data handover looks like from in here. Re-open the station rather
      // than waiting out the buffering watchdog — the listener should not have to
      // unlock the phone and press anything to keep hearing radio.
      const now = a.currentTime;
      if (a.readyState >= 3 && lastTime >= 0 && Math.abs(now - lastTime) < 0.01) {
        hits += 1;
        if (hits >= 3) {
          hits = 0;
          reconnectRef.current("frozen");
        }
      } else {
        hits = 0;
      }
      lastTime = now;
    };
    const id = setInterval(kick, 3000);
    return () => clearInterval(id);
  }, []);

  // Keep the reference current so the watchdog and the network listeners can call
  // it without being re-created on every station change.
  const reconnectRef = useRef(null);
  useEffect(() => {
    reconnectRef.current = reconnect;
  }, [reconnect]);

  // The platform's pause, caught on document in the capture phase: media events do not
  // bubble, and this is the listener that sees the pause from whichever element is
  // current — including one the app did not build (the advert's). The element's own
  // listener reports the same event; starting an interruption twice is a no-op.
  //
  // There is deliberately no timer here any more. A retry ladder cannot tell "iOS took
  // the audio session for a call" from "the stream glitched", and on a phone the first
  // case is the one that matters: every rung it climbed was a chance to be audible
  // during the call. The resume comes from the evidence paths instead (the element
  // playing again, the page becoming visible, a media-session press, a station chosen).
  useEffect(() => {
    const onPauseCapture = (e) => {
      const a = audioRef.current;
      if (!a || e.target !== a || a.ended) return;
      if (userPausedRef.current || adRef.current.active) return;
      handleUnpromptedPause(a);
    };
    document.addEventListener("pause", onPauseCapture, true);
    return () => document.removeEventListener("pause", onPauseCapture, true);
  }, [handleUnpromptedPause]);

  // The one moment execution is guaranteed to come back: the page becoming visible
  // again (the phone was unlocked, or the app was brought forward). A backgrounded
  // page on iOS has its timers frozen, so no retry chain can be relied on across a
  // locked screen — but this always fires, and it is what turns "the listener had to
  // unlock and press Next" into "the radio was already playing when they looked".
  //
  // It also re-asserts the media session on the way back, because iOS drops the Now
  // Playing card when the stream goes quiet and only honours handlers registered
  // after playback has restarted.
  useEffect(() => {
    const bringBack = () => {
      const a = audioRef.current;
      if (!a || !a.getAttribute("src")) return;
      if (userPausedRef.current || sleepEndsAt || adRef.current.active) return;
      if (!a.paused) {
        endInterruption("playing");
        registerMediaActions();
        return;
      }
      // The one trigger iOS always delivers after a call: the listener looked at the
      // phone. This is what ends the interruption and puts the sound back.
      trace("resume.visible", { readyState: a.readyState });
      endInterruption("visible");
      a.play()
        .then(() => registerMediaActions())
        .catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") bringBack();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", bringBack);
    window.addEventListener("focus", bringBack);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", bringBack);
      window.removeEventListener("focus", bringBack);
    };
  // Deliberately not a dependency. `registerMediaActions` is declared further down
  // this component, and a dependency array is evaluated during the render — naming
  // it here throws "cannot access before initialization" and blanks the whole app.
  // The effect body may still call it: by then it exists, and it is stable.
  }, [sleepEndsAt, endInterruption]);

  // The other half of a network change: the phone says it is back, so re-open the
  // stream now rather than waiting for a timeout to notice.
  useEffect(() => {
    const onOnline = () => {
      const a = audioRef.current;
      if (!a || !a.getAttribute("src") || a.ended) return;
      if (userPausedRef.current || sleepEndsAt || adRef.current.active) return;
      if (interruptionRef.current.active) return;
      if (!a.paused && a.readyState >= 3) return;
      reconnectRef.current("online");
    };
    const onOffline = () => trace("net.offline", {});
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [sleepEndsAt]);

  // Pause without forgetting the station (used by voice search and the sleep timer).
  // `stop` would clear the queue.
  const pause = useCallback(() => {
    userPausedRef.current = true;
    if (audioRef.current) audioRef.current.pause();
  }, []);

  const stop = useCallback(() => {
    const a = audioRef.current;
    a.pause();
    // removeAttribute rather than src="": assigning an empty string points the
    // element at the page URL and fires a spurious error, which the auto-skip
    // logic would treat as a dead station.
    a.removeAttribute("src");
    detachHls();
    pendingRef.current = null;
    adRef.current.active = false;
    adRef.current.station = null;
    setAdPlaying(false);
    if (adTimerRef.current) {
      clearTimeout(adTimerRef.current);
      adTimerRef.current = null;
    }
    adRef.current.dueAt = null;
    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.metadata = null;
      } catch {
        /* ignore */
      }
      try {
        navigator.mediaSession.playbackState = "none";
      } catch {
        /* ignore */
      }
    }
    setCurrent(null);
    setIsPlaying(false);
    setNowPlaying(null);
    setSleepEndsAt(null);
    queueRef.current = [];
    indexRef.current = 0;
  }, [detachHls]);

  // ---- Now Playing polling ----
  useEffect(() => {
    if (!current || !current.url || !isPlaying || adPlaying) return;
    let active = true;
    const fetchMeta = async () => {
      try {
        const data = await getNowPlaying(current.url);
        if (active) setNowPlaying(data && data.title ? data.title : null);
      } catch {
        /* ignore */
      }
    };
    fetchMeta();
    const id = setInterval(fetchMeta, 20000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [current, isPlaying, adPlaying]);

  // ---- Media Session API (lock screen / car bluetooth controls) ----
  useEffect(() => {
    if (!("mediaSession" in navigator) || !current) return;
    try {
      const artwork = current.favicon
        ? [96, 128, 192, 256, 384, 512].map((sz) => ({
            src: imgProxyUrl(current.favicon),
            sizes: `${sz}x${sz}`,
          }))
        : [];
      // eslint-disable-next-line no-undef
      navigator.mediaSession.metadata = new MediaMetadata({
        title: adPlaying
          ? "World Radio · advert"
          : nowPlaying || current.name || "Radio",
        artist: adPlaying
          ? `Back to ${current.name || "your station"} in a moment`
          : nowPlaying && current.name
            ? current.name
            : [current.state, current.country].filter(Boolean).join(", ") ||
              "World Radio",
        album: "World Radio",
        artwork,
      });
    } catch {
      /* ignore */
    }
  }, [current, nowPlaying, adPlaying]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    try {
      // Report "playing" for as long as a station is selected and the driver has
      // not asked for a pause — including while tuning or skipping. Silence plus
      // "paused" is what makes iOS take the card away; this is the honest signal
      // for a live-radio player that intends to be audible. An interruption is the
      // exception: the platform has taken the audio session away, so "paused" is the
      // truth, and claiming otherwise is what would strand the card on a phantom.
      navigator.mediaSession.playbackState =
        current && !blocked && !userPausedRef.current && !interruptionRef.current.active
          ? "playing"
          : "paused";
    } catch {
      /* ignore */
    }
  }, [isPlaying, isBuffering, blocked, current]);

  // Lock-screen / car controls (iOS Control Center, Android Auto, Bluetooth).
  //
  // Two things matter here:
  //  1. Re-register whenever a station changes, not just once on mount. iOS
  //     Safari ignores handlers registered before playback has actually begun,
  //     which is why the lock screen fell back to standard +/-10s seek buttons
  //     on an iPhone. Registering again once audio is playing makes it show
  //     Previous / Next station instead.
  //  2. Live radio has no timeline, so the seek actions are explicitly cleared.
  // Latest handlers, reachable from the registered callbacks without ever having
  // to re-register them (re-registering means clearing first, and a cleared
  // handler is a button that vanishes from the lock screen).
  const actionsRef = useRef({});
  useEffect(() => {
    actionsRef.current = { resume, pause, next, prev, stop, reconnect };
  }, [resume, pause, next, prev, stop, reconnect]);

  const registerMediaActions = useCallback(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action, handler) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* unsupported action */
      }
    };
    set("play", () => actionsRef.current.resume());
    // There is deliberately no pause handler here. Live radio has no timeline to
    // resume from, so pausing it only ever means losing the station: one press of a
    // car's Bluetooth pause button takes the stream down, the OS ends the Now Playing
    // session with it, and the lock-screen controls vanish. The action is answered by
    // staying on air — a deliberate silence is the sleep timer's job.
    // Handled, deliberately, even though the ONLY correct answer is "carry on". Live
    // radio has no timeline to pause, and a handled action is the one thing that keeps
    // a lock-screen or car pause press inside the page: declare it unsupported instead
    // and iOS pauses the element itself, then refuses to restart audio the user paused —
    // the station stays silent until the phone is unlocked. A 100ms resume is a visible
    // no-op, which is the intent, and an incoming call is unaffected: a call pauses the
    // *element*, not the session, and that pause is obeyed by the interruption path
    // (startInterruption) instead of being raced by a retry ladder.
    set("pause", () => {
      actionsRef.current.resume();
      registerMediaActions();
    });
    set("nexttrack", () => actionsRef.current.next());
    set("previoustrack", () => actionsRef.current.prev());
    set("stop", () => actionsRef.current.stop());
    // Live radio has no timeline, so clear the seek actions: that is what makes
    // the car and Control Center show Previous / Next instead of ±10 seconds.
    set("seekbackward", null);
    set("seekforward", null);
    set("seekto", null);
  }, []);

  // Register once and never tear them down again. The earlier version cleared
  // the handlers on every station change and re-registered afterwards, leaving a
  // window with no handlers at all — on iOS that window is exactly where the
  // Next/Back buttons disappear.
  useEffect(() => {
    registerMediaActions();
  }, [registerMediaActions]);

  // Re-assert once audio is actually playing: iOS Safari only honours handlers
  // registered after playback began.
  useEffect(() => {
    if (isPlaying) registerMediaActions();
  }, [isPlaying, registerMediaActions]);

  // ---- Sleep timer ----
  const startSleepTimer = useCallback((minutes) => {
    if (fadeRef.current) {
      clearInterval(fadeRef.current);
      fadeRef.current = null;
    }
    setSleepEndsAt(minutes ? Date.now() + minutes * 60000 : null);
  }, []);

  const cancelSleepTimer = useCallback(() => {
    if (fadeRef.current) {
      clearInterval(fadeRef.current);
      fadeRef.current = null;
    }
    setSleepEndsAt(null);
    if (audioRef.current) audioRef.current.volume = userVolRef.current;
    setVolume(userVolRef.current);
  }, []);

  useEffect(() => {
    if (!sleepEndsAt) {
      setSleepRemaining(0);
      return;
    }
    const tick = () => {
      const remaining = sleepEndsAt - Date.now();
      setSleepRemaining(Math.max(0, remaining));
      if (remaining <= 0) {
        clearInterval(id);
        const a = audioRef.current;
        const startVol = a ? a.volume : userVolRef.current;
        let step = 0;
        fadeRef.current = setInterval(() => {
          step += 1;
          const v = Math.max(0, startVol * (1 - step / 16));
          if (a) a.volume = v;
          if (step >= 16) {
            clearInterval(fadeRef.current);
            fadeRef.current = null;
            if (a) {
              a.pause();
              // Same reason as stop(): never leave the element pointing at "".
              a.removeAttribute("src");
              a.volume = userVolRef.current;
            }
            setIsPlaying(false);
            setCurrent(null);
            setNowPlaying(null);
            setVolume(userVolRef.current);
          }
        }, 500);
        setSleepEndsAt(null);
      }
    };
    const id = setInterval(tick, 1000);
    tick();
    return () => clearInterval(id);
  }, [sleepEndsAt]);

  const isFavorite = useCallback(
    (id) => favorites.some((s) => s.id === id),
    [favorites]
  );

  const toggleFavorite = useCallback((station) => {
    setFavorites((prev) => {
      if (prev.some((s) => s.id === station.id)) {
        return prev.filter((s) => s.id !== station.id);
      }
      return [{ ...station }, ...prev];
    });
  }, []);

  const importFavorites = useCallback((list) => {
    if (!Array.isArray(list) || !list.length) return;
    setFavorites((prev) => {
      const ids = new Set(prev.map((s) => s.id));
      const additions = list.filter((s) => s && s.id && !ids.has(s.id));
      return [...additions, ...prev];
    });
  }, []);

  const value = {
    current,
    switching,
    adPlaying,
    isPlaying,
    isBuffering,
    error,
    blocked,
    volume,
    setVolume,
    nowPlaying,
    sleepEndsAt,
    sleepRemaining,
    startSleepTimer,
    cancelSleepTimer,
    favorites,
    history,
    play,
    next,
    prev,
    setNeighbors,
    toggle,
    resume,
    pause,
    stop,
    isFavorite,
    toggleFavorite,
    importFavorites,
    setHistory,
    weakSignal,
    flakyStation,
    startCast,
    castState,
    castAvailable,
    listLabel,
    setListLabel,
  };
  return (
    <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
  );
};
