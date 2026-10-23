import { useEffect, useState } from "react";
import { isSpeechSupported, listNativeVoices, listVoices, nativeTts } from "@/lib/tts";

/**
 * SpeechSynthesis voices load asynchronously (and sometimes very late on
 * Windows), so we retry a few times and also listen to `voiceschanged`.
 * In the desktop build voices come from the SAPI bridge instead.
 */
export function useSpeechVoices() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const supported = isSpeechSupported();

  useEffect(() => {
    if (!supported) return;
    let alive = true;

    if (nativeTts()) {
      void listNativeVoices().then((next) => {
        if (alive && next.length) setVoices(next);
      });
      return () => {
        alive = false;
      };
    }

    const load = () => {
      if (!alive) return;
      const next = listVoices();
      if (next.length) setVoices(next);
    };
    load();
    const synth = window.speechSynthesis;
    synth.addEventListener("voiceschanged", load);
    const timers = [300, 900, 2000, 4000].map((delay) => window.setTimeout(load, delay));
    return () => {
      alive = false;
      synth.removeEventListener("voiceschanged", load);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [supported]);

  return { voices, supported };
}
