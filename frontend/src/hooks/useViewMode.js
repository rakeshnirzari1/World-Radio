import { useEffect, useState } from "react";

/**
 * Which layout the app should draw.
 *
 *   "phone"   the app-style interface: no globe, big rows, bottom tabs
 *   "car"     the same idea scaled up for a dashboard screen in landscape
 *   "desktop" the globe, unchanged
 *
 * Why not just Tailwind breakpoints: the globe is a WebGL canvas, not a layout
 * choice. On a phone it is a 1.4 MB download, a dead 3D scene behind a "Tap to
 * play" sheet, and floating pill buttons that overlap it. The decision to mount
 * it at all has to be made in JavaScript, before React draws, so it has to be a
 * mode, not a `hidden sm:block`.
 *
 * A phone in landscape is 844x390: too wide for `max-width: 767px`, far too
 * short for the globe. Hence the height test. `pointer: coarse` keeps a small
 * desktop window (a browser dragged short) from being mistaken for a car, and
 * the user-agent list catches the head units that report a fine pointer.
 *
 * `?view=phone|car|desktop` overrides everything for one session, which is how
 * this is tested and the escape hatch if a car browser lies about its screen.
 */

const PHONE = "(max-width: 767px)";
const CAR_SCREEN = "(max-height: 560px) and (max-width: 1500px)";
const COARSE = "(pointer: coarse)";
const CAR_UA = /(android auto|automotive|carplay|tesla|carbrowser|head unit)/i;

const media = (query) => {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
};

export const readViewMode = () => {
  if (typeof window === "undefined") return "desktop";
  try {
    const forced = new URLSearchParams(window.location.search).get("view");
    if (forced === "phone" || forced === "car" || forced === "desktop") return forced;
  } catch {
    /* no URL, no override */
  }
  if (media(PHONE)) return "phone";
  const shortLandscape = media(CAR_SCREEN) && media("(orientation: landscape)");
  if (shortLandscape && (media(COARSE) || CAR_UA.test(navigator.userAgent || ""))) return "car";
  return "desktop";
};

export default function useViewMode() {
  const [mode, setMode] = useState(readViewMode);

  useEffect(() => {
    const update = () => setMode(readViewMode());
    const lists = [PHONE, CAR_SCREEN, COARSE].map((q) => window.matchMedia(q));
    lists.forEach((l) => {
      if (l.addEventListener) l.addEventListener("change", update);
      else if (l.addListener) l.addListener(update);
    });
    window.addEventListener("orientationchange", update);
    window.addEventListener("resize", update);
    return () => {
      lists.forEach((l) => {
        if (l.removeEventListener) l.removeEventListener("change", update);
        else if (l.removeListener) l.removeListener(update);
      });
      window.removeEventListener("orientationchange", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return mode;
}
