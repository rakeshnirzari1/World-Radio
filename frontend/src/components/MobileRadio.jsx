import React, { useMemo, useState } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Heart,
  Search,
  Car,
  Compass,
  LocateFixed,
  Route as RouteIcon,
  Globe2,
  Loader2,
  ArrowLeft,
  Radio,
  Music2,
  MapPin,
  X,
} from "lucide-react";
import { usePlayer } from "../context/PlayerContext";
import { GENRES, filterByGenre } from "./GenreBar";
import { prettyCountry } from "../lib/countryNames";

/**
 * The phone and car interface.
 *
 * The globe is the desktop product: a WebGL canvas you drag, with dots you pick.
 * It is also the worst possible thing on a phone and a genuinely unusable thing
 * in a car — tiny targets, a sheet over the map asking for a tap, six floating
 * pills stacked along both edges, and a 1.4 MB 3D engine competing with the
 * audio for a phone's CPU. So on a phone (and on a dashboard screen) we do not
 * mount it at all and draw an app instead: a scrolling feed, thumb-sized rows,
 * one bar to search, four tabs, and a player you can hit without looking.
 *
 * Everything here is driven by the same state App.js already owns — the same
 * catalogue, the same player, the same side panels (already full width below
 * `sm`). Nothing in this file plays audio by itself, so there is no second
 * source of truth to drift from the desktop one.
 */

const capitalise = (s) => {
  const t = String(s || "").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
};

// Where a station is, in words a person reads: the catalogue stores the state in
// whatever case it was typed ("tokyo") and the country in its formal name ("The
// United States Of America"), both of which look wrong on a 15px row.
const place = (station) =>
  [capitalise(station && station.state), prettyCountry(station && station.country)]
    .filter(Boolean)
    .join(", ") || "Worldwide";

const Art = ({ station, size = 48 }) => {
  const [err, setErr] = useState(false);
  const letter = (station.name || "?").trim().charAt(0).toUpperCase();
  const style = { width: size, height: size };
  // Station artwork is user-contributed and often an http:// URL, which the browser
  // blocks outright on an https page. Asking for it anyway leaves an empty box, so
  // only https artwork is attempted; everything else gets the letter tile.
  const usable = /^https:\/\//i.test(station.favicon || "");
  if (usable && !err) {
    return (
      <img
        src={station.favicon}
        alt=""
        style={style}
        onError={() => setErr(true)}
        className="flex-shrink-0 rounded-xl object-cover ring-1 ring-white/10"
      />
    );
  }
  return (
    <div
      className="flex flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#123a2b] to-[#0a1a14] font-display font-bold text-[#2fe08a] ring-1 ring-white/5"
      style={{ ...style, fontSize: Math.round(size * 0.42) }}
    >
      {letter}
    </div>
  );
};

/** One station, thumb-sized. The whole row is the target, not a 44px icon. */
const StationRow = ({ station, onPlay, car = false }) => {
  const { current, isPlaying, isBuffering, isFavorite, toggleFavorite } = usePlayer();
  const active = current && current.id === station.id;
  const fav = isFavorite(station.id);

  return (
    <div
      className={`flex items-center gap-2 rounded-2xl pr-1 transition-colors ${
        car ? "min-h-[76px]" : "min-h-[64px]"
      } ${active ? "bg-[#2fe08a]/10" : "active:bg-white/[0.06]"}`}
    >
      <button
        onClick={() => onPlay(station)}
        className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left"
      >
        <Art station={station} size={car ? 56 : 46} />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate font-medium ${car ? "text-[17px]" : "text-[15px]"} ${
              active ? "text-[#7bf0b8]" : "text-white"
            }`}
          >
            {station.name || "Unknown"}
          </span>
          <span
            className={`mt-0.5 flex items-center gap-1 text-[#8fa79d] ${
              car ? "text-[14px]" : "text-[12.5px]"
            }`}
          >
            <MapPin size={12} className="flex-shrink-0" />
            <span className="truncate">{place(station)}</span>
          </span>
        </span>
        <span
          className={`flex flex-shrink-0 items-center justify-center rounded-full ${
            active ? "bg-[#2fe08a] text-[#04231a]" : "bg-white/[0.06] text-[#e8f0ec]"
          }`}
          style={{ width: car ? 48 : 42, height: car ? 48 : 42 }}
        >
          {active && isBuffering ? (
            <Loader2 size={18} className="rm-spin" />
          ) : active && isPlaying ? (
            <Pause size={18} fill="currentColor" />
          ) : (
            <Play size={18} fill="currentColor" className="ml-0.5" />
          )}
        </span>
      </button>
      <button
        onClick={() => toggleFavorite(station)}
        className={`flex flex-shrink-0 items-center justify-center rounded-full ${
          fav ? "text-rose-400" : "text-[#5f7a6e] active:text-white"
        }`}
        style={{ width: car ? 48 : 40, height: car ? 48 : 40 }}
        aria-label={fav ? "Remove from favourites" : "Add to favourites"}
      >
        <Heart size={car ? 22 : 19} fill={fav ? "currentColor" : "none"} />
      </button>
    </div>
  );
};

const Chip = ({ children, onClick, active, car }) => (
  <button
    onClick={onClick}
    className={`flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 ${
      car ? "h-12 text-[15px]" : "h-10 text-[13.5px]"
    } ${
      active
        ? "border-[#2fe08a] bg-[#2fe08a]/15 text-[#7bf0b8]"
        : "border-white/10 bg-white/[0.04] text-[#dceee6] active:bg-white/10"
    }`}
  >
    {children}
  </button>
);

const Tile = ({ icon: Icon, label, sub, onClick, active, car }) => (
  <button
    onClick={onClick}
    className={`flex flex-1 flex-col items-start justify-center gap-1 rounded-2xl border px-3.5 text-left transition-colors ${
      car ? "min-h-[84px]" : "min-h-[74px]"
    } ${
      active
        ? "border-[#ffb454]/50 bg-[#ffb454]/15 text-[#ffcf8a]"
        : "border-white/10 bg-white/[0.04] text-[#eafff4] active:bg-white/10"
    }`}
  >
    <Icon size={car ? 24 : 20} className={active ? "" : "text-[#7bf0b8]"} />
    <span className={`font-semibold leading-tight ${car ? "text-[15px]" : "text-[13.5px]"}`}>
      {label}
    </span>
    {sub && <span className="text-[11.5px] leading-tight text-[#7d968c]">{sub}</span>}
  </button>
);

const SectionTitle = ({ children, action, onAction }) => (
  <div className="mb-2 mt-5 flex items-baseline justify-between gap-3 px-1">
    <h2 className="font-display text-[15px] font-semibold text-[#cfe8dd]">{children}</h2>
    {action && onAction && (
      <button onClick={onAction} className="text-[12.5px] font-medium text-[#7bf0b8]">
        {action}
      </button>
    )}
  </div>
);

/** The little bar above the tabs: what is on, and the two controls you need. */
const MiniPlayer = ({ car = false }) => {
  const { current, isPlaying, isBuffering, toggle, next } = usePlayer();
  if (!current) return null;
  return (
    <div
      className={`flex items-center gap-3 border-t border-white/10 bg-[#080d10]/95 px-3 backdrop-blur ${
        car ? "h-[88px]" : "h-[64px]"
      }`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Art station={current} size={car ? 56 : 42} />
        <div className="min-w-0 flex-1">
          <div
            className={`truncate font-medium text-white ${car ? "text-[16px]" : "text-[14px]"}`}
          >
            {current.name}
          </div>
          <div className="truncate text-[12px] text-[#8fa79d]">{place(current)}</div>
        </div>
      </div>
      <button
        onClick={toggle}
        className="flex items-center justify-center rounded-full bg-[#2fe08a] text-[#04231a] active:scale-95"
        style={{ width: car ? 60 : 46, height: car ? 60 : 46 }}
        aria-label={isPlaying ? "Pause" : "Play"}
      >
        {isBuffering ? (
          <Loader2 size={car ? 26 : 20} className="rm-spin" />
        ) : isPlaying ? (
          <Pause size={car ? 26 : 20} fill="currentColor" />
        ) : (
          <Play size={car ? 26 : 20} fill="currentColor" className="ml-0.5" />
        )}
      </button>
      <button
        onClick={next}
        className="flex items-center justify-center rounded-full bg-white/[0.06] text-[#e8f0ec] active:bg-white/15"
        style={{ width: car ? 60 : 46, height: car ? 60 : 46 }}
        aria-label="Next station"
      >
        <SkipForward size={car ? 26 : 20} fill="currentColor" />
      </button>
    </div>
  );
};

/** "On air" card: the station, three controls you can hit while driving. */
const NowPlaying = ({ station, car = false, fill = false, onDriving }) => {
  const { isPlaying, isBuffering, toggle, next, prev, isFavorite, toggleFavorite, blocked, resume } =
    usePlayer();
  const fav = station ? isFavorite(station.id) : false;

  if (!station) {
    return (
      <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
        <div className="font-display text-lg font-semibold text-white">Nothing playing yet</div>
        <p className="mt-1 text-sm text-[#8fa79d]">
          Pick a station below, or let the globe pick for you.
        </p>
      </div>
    );
  }

  const big = car ? 116 : 76;
  const side = car ? 84 : 54;

  return (
    <div
      className={`rounded-3xl border border-[#2fe08a]/20 bg-gradient-to-br from-[#0c2a20] via-[#08130f] to-[#05070a] p-4 ${
        fill ? "flex h-full flex-col justify-center" : ""
      }`}
    >
      <div className="flex items-start gap-3">
        <Art station={station} size={car ? 72 : 56} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.18em] text-[#7bf0b8]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#2fe08a]" />
            {isPlaying ? "Live now" : isBuffering ? "Tuning in" : "Paused"}
          </div>
          <div
            className={`mt-1 line-clamp-2 font-display font-bold leading-tight text-white ${
              car ? "text-[28px]" : "text-[21px]"
            }`}
          >
            {station.name}
          </div>
          <div className={`truncate text-[#9fb3aa] ${car ? "text-[15px]" : "text-[13px]"}`}>
            {place(station)}
          </div>
        </div>
        <button
          onClick={() => toggleFavorite(station)}
          className={`flex flex-shrink-0 items-center justify-center rounded-full ${
            fav ? "text-rose-400" : "text-[#7d968c]"
          }`}
          style={{ width: 44, height: 44 }}
          aria-label={fav ? "Remove from favourites" : "Add to favourites"}
        >
          <Heart size={22} fill={fav ? "currentColor" : "none"} />
        </button>
      </div>

      <div className="mt-4 flex items-center justify-center gap-5">
        <button
          onClick={prev}
          className="flex items-center justify-center rounded-full bg-white/[0.07] text-[#e8f0ec] active:scale-95"
          style={{ width: side, height: side }}
          aria-label="Previous station"
        >
          <SkipBack size={car ? 32 : 22} fill="currentColor" />
        </button>
        <button
          onClick={toggle}
          className="flex items-center justify-center rounded-full bg-[#2fe08a] text-[#04231a] shadow-[0_0_34px_rgba(47,224,138,0.5)] active:scale-95"
          style={{ width: big, height: big }}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isBuffering ? (
            <Loader2 size={car ? 44 : 30} className="rm-spin" />
          ) : isPlaying ? (
            <Pause size={car ? 44 : 30} fill="currentColor" />
          ) : (
            <Play size={car ? 44 : 30} fill="currentColor" className="ml-1" />
          )}
        </button>
        <button
          onClick={next}
          className="flex items-center justify-center rounded-full bg-white/[0.07] text-[#e8f0ec] active:scale-95"
          style={{ width: side, height: side }}
          aria-label="Next station"
        >
          <SkipForward size={car ? 32 : 22} fill="currentColor" />
        </button>
      </div>

      {blocked && (
        <button
          onClick={resume}
          className="mt-3 w-full rounded-xl bg-[#2fe08a]/15 py-2.5 text-[13px] font-semibold text-[#7bf0b8]"
        >
          Tap to start the sound
        </button>
      )}

      {onDriving && (
        <button
          onClick={onDriving}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 py-2.5 text-[13px] font-medium text-[#cfe8dd] active:bg-white/10"
        >
          <Car size={16} /> Driving mode — three big buttons
        </button>
      )}
    </div>
  );
};

const MobileRadio = ({
  stations,
  countryStations,
  countryMode,
  countries,
  genre,
  setGenre,
  onEnterCountry,
  onLeaveCountry,
  onOpen,
  onHome,
  onLocate,
  onSurprise,
  onRoadTrip,
  onPlayStation,
  roadTripOn,
  onDriving,
  car,
}) => {
  const { current } = usePlayer();
  const [limit, setLimit] = useState(60);

  const pool = countryMode ? countryStations || [] : filterByGenre(stations, genre);
  const sorted = useMemo(
    () => [...pool].sort((a, b) => (b.clickcount || 0) - (a.clickcount || 0)),
    [pool]
  );
  const shown = sorted.slice(0, limit);
  const genreLabel = (GENRES.find((g) => g.key === genre) || {}).label || "";
  const topCountries = useMemo(
    () => [...(countries || [])].sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 14),
    [countries]
  );

  const heading = countryMode
    ? `${prettyCountry(countryMode)} stations`
    : genre
    ? `${genreLabel} stations`
    : "Popular right now";

  const body = car ? (
    // Dashboard layout: one screen, no scrolling. Left is what is playing, right
    // is the four places you might want to go. Everything is at least 76px tall.
    <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[1.05fr_0.95fr] items-stretch gap-4 p-4">
      {/* min-w-0 on both columns: a grid item's default min-width is its content,
          so one long station name widened the left pane and pushed the right-hand
          tiles off the screen edge. */}
      <div className="flex min-h-0 min-w-0">
        <NowPlaying station={current} car fill onDriving={onDriving} />
      </div>
      <div className="flex min-h-0 min-w-0 flex-col justify-center gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Tile icon={LocateFixed} label="Near me" sub="Closest station" onClick={onLocate} car />
          <Tile icon={Compass} label="Surprise me" sub="Anywhere" onClick={onSurprise} car />
          <Tile
            icon={RouteIcon}
            label={roadTripOn ? "Road trip on" : "Road trip"}
            sub="Your pins"
            onClick={onRoadTrip}
            active={roadTripOn}
            car
          />
          <Tile icon={Globe2} label="Browse" sub="Countries" onClick={() => onOpen("explore")} car />
        </div>
        <button
          onClick={() => onOpen("search")}
          className="flex h-16 items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-[16px] text-[#9fb3aa] active:bg-white/10"
        >
          <Search size={20} /> Search a station, city or genre
        </button>
        <div className="flex items-center gap-2 overflow-x-auto rm-no-bar">
          <Chip onClick={() => onOpen("favorites")} car>
            <Heart size={16} /> Favourites
          </Chip>
          <Chip onClick={() => onOpen("history")} car>
            <Music2 size={16} /> Recently played
          </Chip>
          <Chip onClick={onHome} car active={!countryMode && !genre}>
            <Radio size={16} /> All stations
          </Chip>
        </div>
      </div>
    </div>
  ) : (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 rm-no-bar">
      <div className="pt-3">
        <NowPlaying station={current} onDriving={onDriving} />
      </div>

      {/* Search is the second thing anyone wants on a phone; it gets its own row
          rather than a 16px icon in the corner. */}
      <button
        onClick={() => onOpen("search")}
        className="mt-3 flex h-12 w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-[15px] text-[#93a8a0] active:bg-white/10"
      >
        <Search size={19} />
        Search a station, city or genre
      </button>

      <div className="mt-3 flex gap-2.5">
        <Tile icon={LocateFixed} label="Near me" onClick={onLocate} />
        <Tile icon={Compass} label="Surprise" onClick={onSurprise} />
        <Tile icon={RouteIcon} label="Road trip" onClick={onRoadTrip} active={roadTripOn} />
      </div>

      {(countryMode || genre) && (
        <button
          onClick={() => {
            if (genre) setGenre("");
            if (countryMode) onLeaveCountry();
          }}
          className="mt-3 flex w-full items-center justify-between rounded-xl border border-[#2fe08a]/30 bg-[#2fe08a]/10 px-3 py-2 text-[13px] font-medium text-[#7bf0b8]"
        >
          <span className="truncate">
            {countryMode ? `Only ${prettyCountry(countryMode)}` : `Only ${genreLabel}`}
          </span>
          <span className="flex items-center gap-1">
            Clear <X size={14} />
          </span>
        </button>
      )}

      {!countryMode && (
        <>
          <SectionTitle action="All countries →" onAction={() => onOpen("explore")}>
            Browse by country
          </SectionTitle>
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 rm-no-bar">
            {topCountries.map((c) => (
              <Chip key={c.key} onClick={() => onEnterCountry(c.name)}>
                {prettyCountry(c.name)}
              </Chip>
            ))}
          </div>

          <SectionTitle>Browse by genre</SectionTitle>
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 rm-no-bar">
            {GENRES.filter((g) => g.key).map((g) => (
              <Chip
                key={g.key}
                active={genre === g.key}
                onClick={() => setGenre(genre === g.key ? "" : g.key)}
              >
                {g.label}
              </Chip>
            ))}
          </div>
        </>
      )}

      {countryMode && (
        <button
          onClick={onLeaveCountry}
          className="mt-3 flex items-center gap-2 text-[13.5px] font-medium text-[#9fb3aa]"
        >
          <ArrowLeft size={15} /> All countries
        </button>
      )}

      <SectionTitle>{heading}</SectionTitle>
      <div className="divide-y divide-white/[0.06]">
        {shown.map((s) => (
          <StationRow key={s.id} station={s} onPlay={onPlayStation} />
        ))}
      </div>

      {!sorted.length && (
        <p className="py-10 text-center text-sm text-[#7d968c]">
          Nothing listed here yet — try “Browse by country”.
        </p>
      )}

      {sorted.length > shown.length && (
        <button
          onClick={() => setLimit((n) => n + 80)}
          className="mt-3 w-full rounded-xl border border-white/10 py-3 text-[13.5px] font-medium text-[#cfe8dd] active:bg-white/10"
        >
          Show more ({sorted.length - shown.length} left)
        </button>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#05070a] rm-app-shell">
      {/* App bar: brand on the left, the two things a driver reaches for on the right. */}
      <div className="rm-safe-top flex flex-shrink-0 items-center gap-3 border-b border-white/[0.07] bg-[#05070a]/95 px-4 py-2.5">
        <button onClick={onHome} className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#2fe08a] text-[#05070a]">
            <Radio size={17} strokeWidth={2.4} />
          </span>
          <span className="font-display text-[16px] font-bold tracking-tight text-white">
            World<span className="text-[#2fe08a]"> Radio</span>
          </span>
        </button>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => onOpen("search")}
            className="flex h-10 w-10 items-center justify-center rounded-full text-[#cfe8dd] active:bg-white/10"
            aria-label="Search"
          >
            <Search size={20} />
          </button>
          <button
            onClick={onDriving}
            className="flex h-10 items-center gap-1.5 rounded-full border border-white/10 px-3 text-[13px] font-medium text-[#cfe8dd] active:bg-white/10"
            aria-label="Driving mode"
          >
            <Car size={17} /> <span>Car</span>
          </button>
        </div>
      </div>

      {body}

      {!car && (
        <>
          <MiniPlayer />
          <nav className="rm-safe-bottom flex flex-shrink-0 items-stretch border-t border-white/[0.07] bg-[#070c0e]">
            {[
              { key: "home", icon: Radio, label: "Home" },
              { key: "explore", icon: Globe2, label: "Browse" },
              { key: "search", icon: Search, label: "Search" },
              { key: "favorites", icon: Heart, label: "Favourites" },
            ].map((t) => (
              <button
                key={t.key}
                onClick={() => (t.key === "home" ? onHome() : onOpen(t.key))}
                className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2.5 text-[10.5px] font-medium text-[#8497a0] active:text-white"
              >
                <t.icon size={21} />
                {t.label}
              </button>
            ))}
          </nav>
        </>
      )}
    </div>
  );
};

export default MobileRadio;
