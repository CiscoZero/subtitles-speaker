import { useEffect, useState } from "react";
import { isSpeechSupported, listVoices } from "@/lib/tts";

/**
 * SpeechSynthesis voices load asynchronously (and sometimes very late on
 * Windows), so we retry a few times and also listen to `voiceschanged`.
 */
export function useSpeechVoices() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const supported = isSpeechSupported();

  useEffect(() => {
    if (!supported) return;
    let alive = true;
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
