import { useCallback, useEffect, useRef, useState } from "react";
import type { Cue } from "@/lib/subtitles";
import { speakText, stopSpeech, unlockSpeech } from "@/lib/tts";

export type Phase = "idle" | "playing" | "speaking" | "paused" | "ended";

export type PlayerSettings = {
  /** Subtitle timing correction in milliseconds (+ = subtitles later). */
  offsetMs: number;
  /** Original audio speed. */
  playbackRate: number;
  ttsRate: number;
  ttsVolume: number;
  ttsPitch: number;
  /** What to do when several cues were passed while the TTS was reading. */
  expiredPolicy: "read-all" | "skip";
};

export const DEFAULT_SETTINGS: PlayerSettings = {
  offsetMs: 0,
  playbackRate: 1,
  ttsRate: 1,
  ttsVolume: 1,
  ttsPitch: 1,
  expiredPolicy: "read-all",
};

type Args = {
  cues: Cue[];
  settings: PlayerSettings;
  voice: SpeechSynthesisVoice | null;
  onError: (message: string) => void;
};

/**
 * The playback engine.
 *
 * Trigger source of truth = `audio.currentTime`, sampled on every animation frame
 * (plus `timeupdate` as a safety net when the tab is throttled). The TTS pause is
 * `audio.pause()`, so reading time never advances the original audio timeline and
 * no original content is ever skipped.
 */
export function useEchoPlayer({ cues, settings, voice, onError }: Args) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [activeCue, setActiveCueState] = useState<number | null>(null);
  const [pointer, setPointerState] = useState(0);

  const phaseRef = useRef<Phase>("idle");
  const pointerRef = useRef(0);
  const activeCueRef = useRef<number | null>(null);
  const sessionRef = useRef(0);
  const cuesRef = useRef(cues);
  const settingsRef = useRef(settings);
  const voiceRef = useRef(voice);
  const errorRef = useRef(onError);

  cuesRef.current = cues;
  settingsRef.current = settings;
  voiceRef.current = voice;
  errorRef.current = onError;

  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const setActiveCue = useCallback((index: number | null) => {
    activeCueRef.current = index;
    setActiveCueState(index);
  }, []);

  const setPointer = useCallback((index: number) => {
    pointerRef.current = index;
    setPointerState(index);
  }, []);

  const offsetSeconds = () => settingsRef.current.offsetMs / 1000;

  /** First cue whose trigger time is still ahead of `t` (binary search, cues are sorted). */
  const findNextIndex = useCallback((t: number) => {
    const list = cuesRef.current;
    const offset = settingsRef.current.offsetMs / 1000;
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (list[mid].start + offset < t - 0.02) low = mid + 1;
      else high = mid;
    }
    return low;
  }, []);

  const resumeAudio = useCallback(
    async (session: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      try {
        await audio.play();
        if (session !== sessionRef.current) return;
        setPhase("playing");
      } catch {
        if (session !== sessionRef.current) return;
        setPhase("paused");
        errorRef.current("无法继续播放原声，请再点一次「继续」。");
      }
    },
    [setPhase],
  );

  /** Pause the original audio at the cue start, read the subtitle, then resume. */
  const startSpeak = useCallback(
    async (index: number) => {
      const audio = audioRef.current;
      const cue = cuesRef.current[index];
      if (!audio || !cue) return;

      const session = ++sessionRef.current;
      const triggerAt = Math.max(0, cue.start + offsetSeconds());
      const overshoot = audio.currentTime - triggerAt;
      // Do not let the animation-frame granularity cut a syllable: snap back to the cue start.
      if (overshoot > 0.02 && overshoot <= 1.2) audio.currentTime = triggerAt;

      audio.pause();
      setActiveCue(index);
      setPointer(index + 1);
      setPhase("speaking");

      const result = await speakText(cue.text, {
        voice: voiceRef.current,
        rate: settingsRef.current.ttsRate,
        pitch: settingsRef.current.ttsPitch,
        volume: settingsRef.current.ttsVolume,
      });

      if (session !== sessionRef.current) return;
      if (phaseRef.current !== "speaking") return;

      setActiveCue(null);

      if (result === "error") {
        setPhase("paused");
        errorRef.current(
          "中文朗读失败：可能是系统缺少中文语音，或语音引擎被占用。请在语音设置里换一个中文语音后继续。",
        );
        return;
      }

      if (settingsRef.current.expiredPolicy === "skip") {
        const list = cuesRef.current;
        const offset = offsetSeconds();
        let next = pointerRef.current;
        while (next < list.length && list[next].start + offset <= audio.currentTime + 0.02) next += 1;
        setPointer(next);
      }

      await resumeAudio(session);
    },
    [resumeAudio, setActiveCue, setPhase, setPointer],
  );

  /** Skip the current Chinese reading and continue the original audio. */
  const skipSpeech = useCallback(() => {
    if (phaseRef.current !== "speaking") return;
    const audio = audioRef.current;
    const session = ++sessionRef.current;
    stopSpeech();
    setActiveCue(null);
    if (audio) void resumeAudio(session);
  }, [resumeAudio, setActiveCue]);

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    unlockSpeech();

    const atEnd = audio.duration > 0 && audio.currentTime >= audio.duration - 0.05;
    if (phaseRef.current === "ended" || atEnd) {
      audio.currentTime = 0;
      setTime(0);
      setPointer(findNextIndex(0));
    }

    const session = ++sessionRef.current;
    setActiveCue(null);
    setPhase("playing");
    try {
      await audio.play();
      if (session !== sessionRef.current) return;
      setPhase("playing");
    } catch {
      setPhase("paused");
      errorRef.current("无法播放该音频文件，请确认格式受浏览器支持（MP3 / WAV / M4A / OGG / FLAC）。");
    }
  }, [findNextIndex, setActiveCue, setPhase, setPointer]);

  const pause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    ++sessionRef.current;
    stopSpeech();
    // Interrupted mid-reading: rewind the pointer so this cue is read in full on resume.
    if (phaseRef.current === "speaking" && activeCueRef.current !== null) {
      setPointer(activeCueRef.current);
    }
    audio.pause();
    setActiveCue(null);
    setPhase("paused");
  }, [setActiveCue, setPhase, setPointer]);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    ++sessionRef.current;
    stopSpeech();
    audio.pause();
    audio.currentTime = 0;
    setTime(0);
    setActiveCue(null);
    setPointer(0);
    setPhase("idle");
  }, [setActiveCue, setPhase, setPointer]);

  const seek = useCallback(
    (target: number, opts: { autoPlay?: boolean } = {}) => {
      const audio = audioRef.current;
      if (!audio) return;
      const max = audio.duration > 0 ? audio.duration : target;
      const next = Math.min(Math.max(0, target), Math.max(0, max - 0.03));

      ++sessionRef.current;
      stopSpeech();
      setActiveCue(null);
      audio.currentTime = next;
      setTime(next);
      setPointer(findNextIndex(next));

      const wasActive = phaseRef.current === "playing" || phaseRef.current === "speaking";
      const shouldPlay = opts.autoPlay ?? wasActive;
      if (shouldPlay) {
        setPhase("playing");
        audio.play().catch(() => setPhase("paused"));
      }
    },
    [findNextIndex, setActiveCue, setPhase, setPointer],
  );

  /** Click a cue in the list → jump there and read it immediately. */
  const jumpToCue = useCallback(
    (index: number) => {
      const cue = cuesRef.current[index];
      const audio = audioRef.current;
      if (!cue || !audio) return;
      const target = Math.max(0, cue.start + offsetSeconds() - 0.04);
      ++sessionRef.current;
      stopSpeech();
      setActiveCue(null);
      audio.currentTime = Number.isFinite(audio.duration) ? Math.min(target, Math.max(0, audio.duration - 0.03)) : target;
      setTime(audio.currentTime);
      setPointer(index);
      setPhase("playing");
      audio.play().catch(() => setPhase("paused"));
    },
    [setActiveCue, setPhase, setPointer],
  );

  /** Previous / next subtitle cue (list navigation, never skips silently). */
  const stepCue = useCallback(
    (direction: 1 | -1) => {
      const list = cuesRef.current;
      const audio = audioRef.current;
      if (!list.length || !audio) return;
      const offset = offsetSeconds();
      if (direction === 1) {
        const index = findNextIndex(audio.currentTime + 0.05);
        if (index < list.length) jumpToCue(index);
        return;
      }
      let index = list.length - 1;
      while (index >= 0 && list[index].start + offset > audio.currentTime - 1) index -= 1;
      jumpToCue(Math.max(0, index));
    },
    [findNextIndex, jumpToCue],
  );

  // ---- the trigger loop -------------------------------------------------
  const tick = useCallback(() => {
    if (phaseRef.current !== "playing") return;
    const audio = audioRef.current;
    if (!audio || audio.paused) return;
    const list = cuesRef.current;
    const index = pointerRef.current;
    if (index >= list.length) return;
    const triggerAt = list[index].start + offsetSeconds();
    if (audio.currentTime + 0.012 >= triggerAt) void startSpeak(index);
  }, [startSpeak]);

  useEffect(() => {
    let raf = 0;
    let lastPaint = 0;
    const frame = (stamp: number) => {
      raf = window.requestAnimationFrame(frame);
      const audio = audioRef.current;
      if (!audio) return;
      if (stamp - lastPaint >= 90) {
        lastPaint = stamp;
        if (Number.isFinite(audio.currentTime)) setTime(audio.currentTime);
        if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
      }
      tick();
    };
    raf = window.requestAnimationFrame(frame);
    return () => window.cancelAnimationFrame(raf);
  }, [tick]);

  // ---- element events ---------------------------------------------------
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => tick();
    const onEnded = () => {
      ++sessionRef.current;
      stopSpeech();
      setActiveCue(null);
      setPhase("ended");
    };
    const onLoaded = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
      setTime(audio.currentTime);
    };
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("durationchange", onLoaded);
    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("durationchange", onLoaded);
    };
  }, [setActiveCue, setPhase, tick]);

  // A file the browser cannot decode must fail loudly instead of sitting at 0:00.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onError = () => {
      if (!audio.getAttribute("src")) return;
      ++sessionRef.current;
      stopSpeech();
      setActiveCue(null);
      setPhase("paused");
      errorRef.current(
        "无法解码这个音频文件：浏览器可能不支持该编码（如 ALAC / APE / WMA）。请先转成 MP3 / M4A / WAV / OGG 再装入。",
      );
    };
    audio.addEventListener("error", onError);
    return () => audio.removeEventListener("error", onError);
  }, [setActiveCue, setPhase]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.playbackRate = settings.playbackRate;
  }, [settings.playbackRate]);

  // New subtitle file → realign the pointer, never auto-read old cues.
  useEffect(() => {
    const audio = audioRef.current;
    ++sessionRef.current;
    stopSpeech();
    setActiveCue(null);
    setPointer(findNextIndex(audio?.currentTime ?? 0));
    if (phaseRef.current === "speaking") {
      audio?.pause();
      setPhase("paused");
    }
  }, [cues, findNextIndex, setActiveCue, setPhase, setPointer]);

  // Offset change → keep the pointer monotonic so nothing is read twice.
  useEffect(() => {
    const audio = audioRef.current;
    const next = findNextIndex(audio?.currentTime ?? 0);
    if (next > pointerRef.current) setPointer(next);
  }, [settings.offsetMs, findNextIndex, setPointer]);

  useEffect(() => () => {
    stopSpeech();
  }, []);

  return {
    audioRef,
    phase,
    time,
    duration,
    activeCue,
    pointer,
    play,
    pause,
    stop,
    seek,
    jumpToCue,
    stepCue,
    skipSpeech,
    toggle: () => (phaseRef.current === "playing" ? pause() : void play()),
  };
}
