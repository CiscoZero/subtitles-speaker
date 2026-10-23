/**
 * Subtitle parsing: WebVTT, SRT, ASS/SSA and plain text fallback.
 * Timing is converted to seconds (float). Cues are always returned sorted by start time.
 * Files are decoded on the user's machine only.
 */

export type Cue = {
  id: number;
  start: number;
  end: number;
  text: string;
};

export type SubtitleFormat = "vtt" | "srt" | "ass" | "txt";

export type SubtitleParseResult = {
  format: SubtitleFormat;
  cues: Cue[];
  warnings: string[];
};

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function parseClock(raw: string | undefined): number | null {
  if (!raw) return null;
  const token = raw.trim().split(/\s+/)[0];
  if (!token) return null;
  const m = token.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const frac = m[4] ? Number(m[4]) / Math.pow(10, m[4].length) : 0;
  const value = h * 3600 + min * 60 + sec + frac;
  return Number.isFinite(value) ? value : null;
}

function joinLines(lines: string[]): string {
  return lines.reduce((acc, line) => {
    if (!acc) return line;
    const last = acc.slice(-1);
    const first = line.slice(0, 1);
    const needsSpace = !CJK.test(last) && !CJK.test(first);
    return acc + (needsSpace ? " " : "") + line;
  }, "");
}

function cleanCueText(body: string): string {
  const lines = body
    .split("\n")
    .map((line) =>
      line
        // ASS override blocks: {\an8}, {\pos(..)}
        .replace(/\{\\[^}]*\}/g, "")
        // HTML / VTT markup: <i>, <c.yellow>, <v Bob>, <00:00:01.000>
        .replace(/<\/?[^>]*>/g, "")
        .replace(/&nbsp;|&#160;/gi, " ")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&amp;/gi, "&")
        .replace(/[\u200b-\u200d\ufeff]/g, "")
        .trim(),
    )
    .filter((line) => line.length > 0);
  return joinLines(lines);
}

/** Block oriented parser (blank-line separated). Covers ~all real VTT/SRT files. */
function parseTimedBlocks(raw: string): Cue[] {
  const blocks = raw.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    let lines = block.split("\n").map((line) => line.replace(/\uFEFF/g, ""));
    const header = (lines[0] || "").trim();
    if (/^(NOTE|STYLE|REGION)\b/i.test(header)) continue;
    // Some files glue the first cue straight onto the "WEBVTT" header line block.
    if (/^WEBVTT\b/i.test(header)) {
      if (!lines.some((line) => line.includes("-->"))) continue;
      lines = lines.slice(1);
    }
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex === -1) continue;
    const [rawStart, rawEnd] = lines[timeIndex].split("-->");
    const start = parseClock(rawStart);
    if (start === null) continue;
    const end = parseClock(rawEnd) ?? start + 2;
    const text = cleanCueText(lines.slice(timeIndex + 1).join("\n"));
    if (!text) continue;
    cues.push({ id: cues.length, start, end, text });
  }
  return cues;
}

/** Line oriented fallback for files that use single newlines between entries. */
function parseLenientBlocks(raw: string): Cue[] {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const cues: Cue[] = [];
  let start = 0;
  let end = 0;
  let buffer: string[] = [];
  const flush = () => {
    const text = cleanCueText(buffer.join("\n"));
    if (text) cues.push({ id: cues.length, start, end, text });
    buffer = [];
  };
  for (const line of lines) {
    if (line.includes("-->")) {
      flush();
      const [rawStart, rawEnd] = line.split("-->");
      const parsedStart = parseClock(rawStart);
      if (parsedStart === null) continue;
      start = parsedStart;
      end = parseClock(rawEnd) ?? parsedStart + 2;
      continue;
    }
    if (!buffer.length && /^\d+$/.test(line.trim())) continue; // SRT index line
    if (line.trim() === "") continue;
    buffer.push(line);
  }
  flush();
  return cues;
}

function parseAss(raw: string): Cue[] {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const cues: Cue[] = [];
  let inEvents = false;
  let fields = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      inEvents = /^\[events\]$/i.test(trimmed);
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(trimmed)) {
      const parsed = trimmed
        .slice(trimmed.indexOf(":") + 1)
        .split(",")
        .map((f) => f.trim().toLowerCase())
        .filter(Boolean);
      if (parsed.length) fields = parsed;
      continue;
    }
    if (!/^dialogue\s*:/i.test(trimmed)) continue;
    const rest = trimmed.slice(trimmed.indexOf(":") + 1);
    const parts = rest.split(",");
    const startIdx = fields.indexOf("start");
    const endIdx = fields.indexOf("end");
    const textIdx = fields.indexOf("text");
    if (startIdx === -1 || endIdx === -1) continue;
    const start = parseClock(parts[startIdx]);
    if (start === null) continue;
    const end = parseClock(parts[endIdx]) ?? start + 2;
    const body = textIdx >= 0 ? parts.slice(textIdx).join(",") : parts.slice(startIdx + 2).join(",");
    const text = cleanCueText(body.replace(/\\N/gi, "\n").replace(/\\n/gi, "\n").replace(/\\h/gi, " "));
    if (!text) continue;
    cues.push({ id: cues.length, start, end, text });
  }
  return cues;
}

function parsePlainText(raw: string, warnings: string[]): Cue[] {
  const lines = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const cues: Cue[] = [];
  let cursor = 0.6;
  for (const line of lines) {
    const duration = Math.max(1.4, line.length / 4.5);
    cues.push({ id: cues.length, start: cursor, end: cursor + duration, text: line });
    cursor += duration + 0.2;
  }
  warnings.push("纯文本没有时间轴，已按文字长度估算，仅适合预读；请优先使用 .vtt / .srt / .ass。");
  return cues;
}

function normalize(cues: Cue[], warnings: string[]): Cue[] {
  const out = cues.filter((cue) => cue.text.trim().length > 0);
  const wasSorted = out.every((cue, i) => i === 0 || cue.start >= out[i - 1].start);
  out.sort((a, b) => a.start - b.start);
  if (!wasSorted) warnings.push("字幕时间轴顺序不连续，已按起始时间重新排序。");

  let overlaps = 0;
  let repaired = 0;
  out.forEach((cue, i) => {
    if (!Number.isFinite(cue.start) || cue.start < 0) {
      cue.start = 0;
      repaired += 1;
    }
    if (!Number.isFinite(cue.end) || cue.end <= cue.start) {
      cue.end = cue.start + Math.max(1.2, cue.text.length / 5);
      repaired += 1;
    }
    if (i > 0 && cue.start < out[i - 1].end - 0.001) overlaps += 1;
    cue.id = i;
  });
  if (repaired) warnings.push(`${repaired} 处时间戳缺失或无效，已按文字长度补足。`);
  if (overlaps) warnings.push(`${overlaps} 处字幕时间重叠，会按起始时间逐条朗读，不会跳过。`);
  return out;
}

export function parseSubtitles(raw: string, fileName: string): SubtitleParseResult {
  const warnings: string[] = [];
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  const format: SubtitleFormat =
    ext === "vtt"
      ? "vtt"
      : ext === "srt"
        ? "srt"
        : ext === "ass" || ext === "ssa"
          ? "ass"
          : ext === "txt"
            ? "txt"
            : /^\s*WEBVTT/i.test(raw)
              ? "vtt"
              : /\[Events\]/i.test(raw)
                ? "ass"
                : raw.includes("-->")
                  ? "srt"
                  : "txt";

  let cues: Cue[] = [];
  if (format === "ass") cues = parseAss(raw);
  else if (format === "txt") cues = parsePlainText(raw, warnings);
  else cues = parseTimedBlocks(raw);

  if (!cues.length && format !== "txt") {
    const lenient = parseLenientBlocks(raw);
    if (lenient.length) {
      cues = lenient;
      warnings.push("字幕排版不标准，已启用宽松解析，请核对前几句时间点。");
    }
  }

  return { format, cues: normalize(cues, warnings), warnings };
}

/** Decode a subtitle file, honouring BOMs and falling back to GB18030 for legacy CN files. */
export async function decodeTextFile(file: File): Promise<{ text: string; encoding: string }> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  const tryDecode = (label: string) => {
    try {
      return new TextDecoder(label).decode(buffer);
    } catch {
      return null;
    }
  };

  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: tryDecode("utf-8") ?? "", encoding: "UTF-8 BOM" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: tryDecode("utf-16le") ?? "", encoding: "UTF-16LE" };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: tryDecode("utf-16be") ?? "", encoding: "UTF-16BE" };
  }

  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "UTF-8" };
  } catch {
    const gb = tryDecode("gb18030");
    if (gb !== null) return { text: gb, encoding: "GB18030" };
    return { text: tryDecode("utf-8") ?? "", encoding: "UTF-8（容错）" };
  }
}
