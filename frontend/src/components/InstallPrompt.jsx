import React, { useEffect, useState } from "react";
import { Download, Share, X, Plus } from "lucide-react";

const SNOOZE_KEY = "rm_install_snooze_v1";
const SNOOZE_DAYS = 14;

// Installing matters more than it looks: an installed app keeps its audio session
// alive far more reliably than a background browser tab, which is the whole point
// of this app on a locked phone. Android/desktop Chromium fires
// beforeinstallprompt; iOS Safari has no such event, so it gets instructions
// instead.
const InstallPrompt = ({ raised }) => {
  const [deferred, setDeferred] = useState(null);
  const [visible, setVisible] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    let snoozed = false;
    try {
      const at = Number(window.localStorage.getItem(SNOOZE_KEY) || 0);
      snoozed = at && Date.now() - at < SNOOZE_DAYS * 24 * 60 * 60 * 1000;
    } catch {
      /* ignore */
    }
    if (snoozed) return undefined;

    const standalone =
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true;
    if (standalone) return undefined;

    const ua = window.navigator.userAgent || "";
    const isIos = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    const isSafari = isIos && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);

    const onPrompt = (e) => {
      e.preventDefault();
      setDeferred(e);
      setTimeout(() => setVisible(true), 12000);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);

    // iOS never fires the event, so show the how-to once the app is clearly in use.
    let iosTimer;
    if (isSafari) {
      setIos(true);
      iosTimer = setTimeout(() => setVisible(true), 20000);
    }
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      clearTimeout(iosTimer);
    };
  }, []);

  const snooze = () => {
    try {
      window.localStorage.setItem(SNOOZE_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    setVisible(false);
  };

  const install = async () => {
    if (!deferred) return;
    try {
      deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice && choice.outcome === "accepted") setVisible(false);
      else snooze();
    } catch {
      snooze();
    }
  };

  if (!visible) return null;

  return (
    // `raised` is the phone/car shell, which has its own mini player and tab bar
    // across the bottom. At bottom-24 the banner sat on top of both.
    <div
      className={`pointer-events-none absolute inset-x-0 z-40 flex justify-center px-4 ${
        raised ? "bottom-[9.5rem]" : "bottom-24 sm:bottom-28"
      }`}
    >
      <div className="rm-glass pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl px-4 py-3 shadow-[0_16px_50px_rgba(0,0,0,0.5)]">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-[#2fe08a] text-[#05070a]">
          <Download size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-600 text-white">Keep World Radio handy</div>
          {ios ? (
            <div className="mt-0.5 text-xs leading-snug text-[#9fb3aa]">
              Tap <Share size={12} className="inline -mt-0.5" /> Share, then
              <span className="text-[#7bf0b8]"> Add to Home Screen </span>
              <Plus size={12} className="inline -mt-0.5" /> — it then runs full
              screen and holds your car controls better.
            </div>
          ) : (
            <div className="mt-0.5 text-xs leading-snug text-[#9fb3aa]">
              Install it as an app — it survives backgrounding better and keeps your
              lock-screen controls.
            </div>
          )}
        </div>
        {!ios && (
          <button
            onClick={install}
            className="flex-shrink-0 rounded-full bg-[#2fe08a] px-3.5 py-2 text-xs font-600 text-[#05070a] transition-transform hover:scale-105"
          >
            Install
          </button>
        )}
        <button
          onClick={snooze}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[#6f857b] transition-colors hover:bg-white/5 hover:text-white"
          title="Not now"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
};

export default InstallPrompt;
