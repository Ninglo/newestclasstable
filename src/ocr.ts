import Tesseract from 'tesseract.js';
import { monthDayToDateKey } from './calendar';
import { COMMON_ENGLISH_NAMES } from './englishNames';
import { placeCentered } from './layouts';
import type { LayoutType, OCRSettings } from './types';

const MAX_GROUP_COUNT = 6;
const GROUP_CAPACITY = 6;
const THREE_ROWS = 3;
const MAX_THREE_ROW_COLS = 12;

const EN_STOP_WORDS = new Set([
  'group',
  'screen',
  'whiteboard',
  'school',
  'seating',
  'seat',
  'chart',
  'entrance',
  'exit',
  'friends',
  'lets',
  'let',
  'try',
  'week',
  'class',
  'room',
  'campus',
  'left',
  'right',
  'top',
  'bottom',
  'projector',
  'direction',
  'welcome',
  'special',
  'notice',
  'please'
]);

const CN_STOP_FRAGMENTS = [
  '座位',
  '班级',
  '班',
  '周',
  '星期',
  '校区',
  '教室',
  '楼',
  '入口',
  '出口',
  '投影',
  '方向',
  '屏幕',
  '白板',
  '课程',
  '时间',
  '请假',
  '请勿',
  '占座',
  '说明',
  '提醒'
];

const CN_NAME_NOISE_PATTERN = /^(第?[一二三四五六七八九十]+|[一二三四五六七八九十]+排|[左右][一二三四五六七八九十]?)$/;
const EN_NAME_NOISE_SET = new Set([
  'group',
  'row',
  'rows',
  'left',
  'right',
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six'
]);

export interface OCRWordBox {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
}

interface OCRRawCandidate {
  rawText: string;
  words: OCRWordBox[];
  candidates: OCRWordBox[][];
  source: string;
}

interface PositionedName {
  name: string;
  x: number;
  y: number;
  confidence: number;
}

interface NameCanvasResult {
  canvas: HTMLCanvasElement;
  cropX: number;
  cropY: number;
  scale: number;
}

interface ParsedCandidate {
  layout: LayoutType;
  groups: string[][];
  students: string[];
  confidence: number;
  rawText: string;
}

export interface OCRClassDraft {
  fileName: string;
  rawText: string;
  className: string;
  source: string;
  layout: LayoutType;
  groups: string[][];
  detectedStudentCount: number;
  placedStudentCount: number;
  confidence: number;
  info: {
    date: string;
    day: string;
    weekday: string;
    time: string;
    campus: string;
    floor: string;
    room: string;
    fullDate: string;
  };
}

const parseStudentNames = (input: string): string[] => {
  const lines = input.replace(/\r/g, '\n').split('\n');
  const names: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const firstCell = line.split(/[\t,，;；]/)[0]?.trim();
    if (!firstCell) continue;

    const normalized = firstCell.replace(/\s+/g, ' ').trim();
    if (!normalized) continue;

    const lowered = normalized.toLowerCase();
    if (normalized === '姓名' || lowered === 'name' || lowered === 'student') continue;

    if (!seen.has(normalized)) {
      names.push(normalized);
      seen.add(normalized);
    }
  }

  return names;
};

const extractLikelyNamesFromText = (input: string): string[] => {
  const fromLines = parseStudentNames(input);
  const rawTokens = input.match(/[A-Za-z][A-Za-z'-.]{1,20}|[\u4e00-\u9fff]{2,4}/g) ?? [];
  return sanitizeStudentNames([...fromLines, ...rawTokens]);
};

const isNoiseName = (name: string): boolean => {
  const trimmed = name.trim();
  if (!trimmed) return true;

  const lower = trimmed.toLowerCase().replace(/[^a-z]/g, '');
  if (lower && EN_NAME_NOISE_SET.has(lower)) return true;
  if (/^(group|row)\d*$/i.test(trimmed)) return true;
  if (/^[左右][0-9一二三四五六七八九十]?$/.test(trimmed)) return true;
  if (/^第?[一二三四五六七八九十]+排$/.test(trimmed)) return true;

  return false;
};

const sanitizeStudentNames = (values: Array<string | null | undefined>): string[] =>
  uniqueStrings(
    values
      .map((value) => normalizeName(value || ''))
      .filter(Boolean)
      .filter((name) => (isLikelyEnglishName(name) || isLikelyChineseName(name)) && !isNoiseName(name))
  );

const prioritizeEnglishNames = (values: Array<string | null | undefined>): string[] => {
  const cleaned = sanitizeStudentNames(values);
  const englishOnly = uniqueStrings(cleaned.filter((name) => isLikelyEnglishName(name)));
  if (englishOnly.length >= 12 && englishOnly.length >= Math.floor(cleaned.length * 0.55)) {
    return englishOnly;
  }
  return cleaned;
};

const sanitizeSeatGroups = (groups: string[][]): string[][] =>
  groups.map((group) =>
    group.map((name) => {
      const normalized = normalizeName(name || '');
      if (!normalized) return '';
      if (isNoiseName(normalized)) return '';
      if (!isLikelyEnglishName(normalized) && !isLikelyChineseName(normalized)) return '';
      return normalized;
    })
  );

const buildFallbackGroupsByLayout = (layout: LayoutType, students: string[]): string[][] => {
  const normalized = sanitizeStudentNames(students).slice(0, 36);

  if (layout === 'arc') {
    const rows = [Array(18).fill(''), Array(18).fill('')];
    const half = Math.ceil(normalized.length / 2);
    placeCentered(rows[0], normalized.slice(0, half));
    placeCentered(rows[1], normalized.slice(half));
    return rows;
  }

  return Array.from({ length: MAX_GROUP_COUNT }, (_, index) =>
    normalized.slice(index * GROUP_CAPACITY, index * GROUP_CAPACITY + GROUP_CAPACITY)
  );
};

const cleanOCRToken = (raw: string): string =>
  raw
    .replace(/[|｜]/g, '')
    .replace(/[，,。.!?、:：;；]/g, '')
    .trim();

const normalizeName = (raw: string): string => {
  const cleaned = cleanOCRToken(raw)
    .replace(/[“”"()（）{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';

  if (/^[A-Za-z][A-Za-z'-.]*$/.test(cleaned)) {
    const normalized = cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
    const lowered = normalized.toLowerCase();
    if (COMMON_ENGLISH_NAMES.has(lowered)) return normalized;
    if (/^l[a-z]{2,}$/.test(lowered)) {
      const maybeI = `i${lowered.slice(1)}`;
      if (COMMON_ENGLISH_NAMES.has(maybeI)) {
        return `I${normalized.slice(1)}`;
      }
    }
    return normalized;
  }

  const englishPart = cleaned.match(/[A-Za-z][A-Za-z'-.]*/)?.[0];
  if (englishPart && /^[A-Za-z][A-Za-z'-.]*$/.test(englishPart)) {
    const normalized = englishPart.charAt(0).toUpperCase() + englishPart.slice(1).toLowerCase();
    const lowered = normalized.toLowerCase();
    if (COMMON_ENGLISH_NAMES.has(lowered)) return normalized;
    if (/^l[a-z]{2,}$/.test(lowered)) {
      const maybeI = `i${lowered.slice(1)}`;
      if (COMMON_ENGLISH_NAMES.has(maybeI)) {
        return `I${normalized.slice(1)}`;
      }
    }
    return normalized;
  }

  return cleaned;
};

const normalizeConfidence = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value <= 1) return value * 100;
  return value;
};

const hasEnglishVowel = (value: string): boolean => /[aeiouy]/i.test(value);

const isLikelyEnglishName = (name: string): boolean => {
  if (!/^[A-Za-z][A-Za-z'-.]{2,20}$/.test(name)) return false;

  const lower = name.toLowerCase();
  if (EN_STOP_WORDS.has(lower)) return false;

  const lettersOnly = lower.replace(/[^a-z]/g, '');
  if (lettersOnly.length < 3) return false;
  if (COMMON_ENGLISH_NAMES.has(lettersOnly)) return true;
  if (!hasEnglishVowel(lettersOnly)) return false;
  if (lettersOnly.length <= 4) return false;

  return true;
};

const isLikelyChineseName = (name: string): boolean => {
  if (!/^[\u4e00-\u9fff]{2,4}$/.test(name)) return false;
  if (CN_NAME_NOISE_PATTERN.test(name)) return false;
  return !CN_STOP_FRAGMENTS.some((fragment) => name.includes(fragment));
};

const uniqueStrings = (values: Array<string | null | undefined>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of values) {
    if (!raw) continue;
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }

  return result;
};

const cleanLine = (line: string): string => line.replace(/\s+/g, ' ').trim();

const compactText = (text: string): string => text.replace(/\r/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

const normalizeTimeText = (value: string): string =>
  value
    .replace(/\s*[:：]\s*/g, ':')
    .replace(/\s*[-~—至]\s*/g, '-')
    .replace(/\s*月\s*/g, '月')
    .replace(/\s*日\s*/g, '日 ')
    .replace(/\s*楼\s*/g, '楼')
    .replace(/\s+/g, ' ')
    .trim();

const detectLayoutByText = (text: string): LayoutType | null => {
  const normalized = text.replace(/\s+/g, ' ');

  if (/圆弧|弧形|两排/.test(normalized)) return 'arc';
  if (/[左右]\s*[1-9]/.test(normalized) || /[一二三123]\s*排/.test(normalized) || /三排|横排/.test(normalized)) {
    return 'rows';
  }
  if (/group\s*[1-6]/i.test(normalized) || /小组|组别/.test(normalized)) return 'circular';

  return null;
};

const parseClassName = (text: string): string => {
  const lines = text
    .replace(/\r/g, '\n')
    .split('\n')
    .map(cleanLine)
    .filter(Boolean);

  for (const line of lines) {
    if (!/(座位|座次|班)/.test(line)) continue;
    const withContext = line.match(/([A-Za-z]\d{2,4})\s*(?:班)?\s*(?:座位|座次|班)/);
    if (withContext?.[1]) return withContext[1].toUpperCase();

    const first = line.match(/\b([A-Za-z]\d{2,4})\b/);
    if (first?.[1] && !line.includes('校区')) return first[1].toUpperCase();
  }

  for (const line of lines) {
    if (line.includes('校区')) continue;
    const fallback = line.match(/\b([A-Za-z]\d{2,4})\b/);
    if (fallback?.[1]) return fallback[1].toUpperCase();
  }

  return '';
};

const parseClassTime = (text: string): string => {
  const compact = compactText(text).replace(/选择星期|选择校区/g, ' ').replace(/\bv\b/gi, ' ').replace(/\s+/g, ' ').trim();

  const patterns = [
    /\d{1,2}\s*月\s*\d{1,2}\s*日(?:\s*(?:星期|周)\s*[一二三四五六日天]?)?(?:\s*[-vV])*\s*\d{1,2}\s*[:：]\s*\d{2}(?:\s*[-~—至]\s*\d{1,2}\s*[:：]\s*\d{2})?/,
    /周[一二三四五六日天]\s*\d{1,2}\s*[:：]\s*\d{2}\s*[-~—至]\s*\d{1,2}\s*[:：]\s*\d{2}/,
    /\d{1,2}\s*月\s*\d{1,2}\s*日\s*(?:星期|周)?\s*[一二三四五六日天]?/,
    /\d{1,2}\s*[:：]\s*\d{2}\s*[-~—至]\s*\d{1,2}\s*[:：]\s*\d{2}/
  ];

  for (const pattern of patterns) {
    const match = compact.match(pattern);
    if (match?.[0]) return normalizeTimeText(match[0]);
  }

  return '';
};

const parseLocation = (text: string): { campus: string; building: string; room: string; floor: string } => {
  const compact = compactText(text);
  const lines = text
    .replace(/\r/g, '\n')
    .split('\n')
    .map(cleanLine)
    .filter(Boolean);

  const locationLine =
    lines.find((line) => /(校区|楼|座|教室)/.test(line)) ??
    compact;

  let campus = '';
  let building = '';
  let room = '';
  let floor = '';

  const campusMatch = compact.match(/([A-Za-z]?\d{1,3}\s*校区|七彩校区)/) ?? locationLine.match(/([A-Za-z]?\d{1,3}\s*校区|七彩校区)/);
  if (campusMatch?.[1]) {
    campus = cleanLine(campusMatch[1]).replace(/\s+/g, '');
  } else {
    const campusCode = compact.match(/\b(C\d{2,3})\b/i) ?? locationLine.match(/\b(C\d{2,3})\b/i);
    if (campusCode?.[1]) campus = campusCode[1].toUpperCase();
  }

  const afterCampus =
    campusMatch && typeof campusMatch.index === 'number'
      ? compact.slice(campusMatch.index + campusMatch[0].length)
      : locationLine;

  const buildingParts: string[] = [];
  const seatMatch = afterCampus.match(/([A-Za-z]\s*座)/) ?? compact.match(/([A-Za-z]\s*座)/);
  if (seatMatch?.[1]) buildingParts.push(seatMatch[1].replace(/\s+/g, ''));

  const floorMatch = afterCampus.match(/(\d+)\s*楼/) ?? compact.match(/(\d+)\s*楼/);
  if (floorMatch?.[1]) {
    floor = floorMatch[1];
    buildingParts.push(`${floorMatch[1]}楼`);
  }

  building = buildingParts.join(' ').trim();

  const afterFloor =
    floorMatch && typeof floorMatch.index === 'number'
      ? afterCampus.slice(floorMatch.index + floorMatch[0].length)
      : afterCampus;

  const roomWithSuffix = afterFloor.match(/(\d{2,4})\s*教室/) ?? compact.match(/(\d{2,4})\s*教室/);
  if (roomWithSuffix?.[1]) {
    room = roomWithSuffix[1];
  } else {
    const roomOnly = afterFloor.match(/(\d{2,4})(?!\s*[:：])/) ?? compact.match(/(?:楼|座)\s*(\d{2,4})(?!\s*[:：])/);
    if (roomOnly?.[1]) room = roomOnly[1];
  }

  return { campus, building, room, floor };
};

const kMeansOrdered = (values: number[], requestedK: number): number[] => {
  if (values.length === 0) return [];

  const k = Math.max(1, Math.min(requestedK, values.length));
  const sorted = [...values].sort((a, b) => a - b);

  let centers = Array.from({ length: k }, (_, index) => {
    const pos = Math.floor(((index + 0.5) / k) * (sorted.length - 1));
    return sorted[Math.max(0, pos)];
  });

  const assignment = new Array(values.length).fill(0);

  for (let iteration = 0; iteration < 12; iteration += 1) {
    for (let i = 0; i < values.length; i += 1) {
      let closest = 0;
      let closestDistance = Number.POSITIVE_INFINITY;

      for (let c = 0; c < centers.length; c += 1) {
        const distance = Math.abs(values[i] - centers[c]);
        if (distance < closestDistance) {
          closestDistance = distance;
          closest = c;
        }
      }

      assignment[i] = closest;
    }

    const sums = new Array(k).fill(0);
    const counts = new Array(k).fill(0);
    for (let i = 0; i < values.length; i += 1) {
      sums[assignment[i]] += values[i];
      counts[assignment[i]] += 1;
    }

    centers = centers.map((center, idx) => (counts[idx] > 0 ? sums[idx] / counts[idx] : center));
  }

  const ordered = centers
    .map((center, idx) => ({ center, idx }))
    .sort((a, b) => a.center - b.center);

  const remap = new Map<number, number>();
  ordered.forEach((item, orderIndex) => {
    remap.set(item.idx, orderIndex);
  });

  return assignment.map((clusterIndex) => remap.get(clusterIndex) ?? 0);
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const computeRange = (values: number[]): number => {
  if (values.length <= 1) return 1;
  return Math.max(1, Math.max(...values) - Math.min(...values));
};

const detectLayoutByGeometry = (tokens: PositionedName[]): LayoutType | null => {
  if (tokens.length < 12) return null;

  const allY = tokens.map((token) => token.y);
  const allX = tokens.map((token) => token.x);
  const totalYRange = computeRange(allY);
  const totalXRange = computeRange(allX);

  const threeRowAssignment = kMeansOrdered(allY, 3);
  const threeRows: PositionedName[][] = [[], [], []];

  for (let i = 0; i < tokens.length; i += 1) {
    threeRows[Math.min(2, Math.max(0, threeRowAssignment[i] ?? 0))].push(tokens[i]);
  }

  const threeRowCounts = threeRows.map((row) => row.length).sort((a, b) => a - b);
  const rowBalance = clamp01((threeRowCounts[0] ?? 0) / Math.max(1, threeRowCounts[2] ?? 1));

  const avgRowYSpread =
    threeRows
      .filter((row) => row.length > 1)
      .reduce((sum, row) => sum + computeRange(row.map((token) => token.y)) / totalYRange, 0) /
    Math.max(1, threeRows.filter((row) => row.length > 1).length);

  const avgRowXSpread =
    threeRows
      .filter((row) => row.length > 1)
      .reduce((sum, row) => sum + computeRange(row.map((token) => token.x)) / totalXRange, 0) /
    Math.max(1, threeRows.filter((row) => row.length > 1).length);

  const threeRowsScore =
    rowBalance * 45 +
    clamp01((0.35 - avgRowYSpread) / 0.35) * 25 +
    clamp01((avgRowXSpread - 0.45) / 0.55) * 30;

  const row2Assignment = kMeansOrdered(allY, 2);
  const col3Assignment = kMeansOrdered(allX, 3);
  const grouped: PositionedName[][] = Array.from({ length: 6 }, () => []);

  for (let i = 0; i < tokens.length; i += 1) {
    const row = Math.min(1, Math.max(0, row2Assignment[i] ?? 0));
    const col = Math.min(2, Math.max(0, col3Assignment[i] ?? 0));
    grouped[row * 3 + col].push(tokens[i]);
  }

  const nonEmptyGroupCount = grouped.filter((group) => group.length > 0).length;
  const avgGroupYSpread =
    grouped
      .filter((group) => group.length > 1)
      .reduce((sum, group) => sum + computeRange(group.map((token) => token.y)) / totalYRange, 0) /
    Math.max(1, grouped.filter((group) => group.length > 1).length);

  const groupScore =
    clamp01(nonEmptyGroupCount / 6) * 35 +
    clamp01((avgGroupYSpread - 0.16) / 0.24) * 50 +
    clamp01((tokens.length - 12) / 24) * 15;

  if (threeRowsScore >= groupScore + 8) return 'rows';
  if (groupScore >= threeRowsScore + 8) return 'circular';
  return null;
};

const trimExtremeY = (tokens: PositionedName[]): PositionedName[] => {
  if (tokens.length <= 8) return tokens;

  const ys = tokens.map((token) => token.y).sort((a, b) => a - b);
  const low = ys[Math.floor(ys.length * 0.05)] ?? ys[0];
  const high = ys[Math.floor(ys.length * 0.95)] ?? ys[ys.length - 1];

  return tokens.filter((token) => token.y >= low && token.y <= high);
};

const extractPositionedNames = (words: OCRWordBox[]): PositionedName[] => {
  const english: PositionedName[] = [];
  const chinese: PositionedName[] = [];

  for (const word of words) {
    const confidence = normalizeConfidence(word.confidence);
    if (confidence < 35) continue;

    const normalized = normalizeName(word.text);
    if (!normalized) continue;

    const x = (word.x0 + word.x1) / 2;
    const y = (word.y0 + word.y1) / 2;
    const token = { name: normalized, x, y, confidence };

    if (isLikelyEnglishName(normalized)) {
      english.push(token);
    } else if (isLikelyChineseName(normalized) && confidence >= 70) {
      chinese.push(token);
    }
  }

  let selected: PositionedName[] = [];
  if (english.length >= 6) {
    selected = english;
  } else if (chinese.length > english.length) {
    selected = chinese;
  } else {
    selected = [...english, ...chinese.filter((token) => token.confidence >= 78)];
  }

  selected.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
  selected = trimExtremeY(selected);

  const deduped: PositionedName[] = [];
  for (const token of selected) {
    const existingIndex = deduped.findIndex(
      (item) =>
        item.name === token.name &&
        Math.abs(item.x - token.x) <= 8 &&
        Math.abs(item.y - token.y) <= 8
    );

    if (existingIndex === -1) {
      deduped.push(token);
    } else if (token.confidence > deduped[existingIndex].confidence) {
      deduped[existingIndex] = token;
    }
  }

  return deduped;
};

const buildGroupSeatPlan = (tokens: PositionedName[]): string[][] => {
  const groups = Array.from({ length: MAX_GROUP_COUNT }, () => [] as string[]);
  if (tokens.length === 0) return groups;

  const rowClusters = kMeansOrdered(tokens.map((token) => token.y), 2);
  const colClusters = kMeansOrdered(tokens.map((token) => token.x), 3);
  const groupedTokens: PositionedName[][] = Array.from({ length: MAX_GROUP_COUNT }, () => []);

  for (let i = 0; i < tokens.length; i += 1) {
    const row = Math.min(1, Math.max(0, rowClusters[i] ?? 0));
    const col = Math.min(2, Math.max(0, colClusters[i] ?? 0));
    groupedTokens[row * 3 + col].push(tokens[i]);
  }

  groupedTokens.forEach((group, groupIndex) => {
    groups[groupIndex] = group
      .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))
      .slice(0, GROUP_CAPACITY)
      .map((token) => token.name);
  });

  return groups;
};

const countPlacedStudents = (groups: string[][]): number => sanitizeStudentNames(uniqueStrings(groups.flat())).length;

const fillEmptySeatsWithNames = (groups: string[][], names: string[]): string[][] => {
  const filled = groups.map((group) => [...group]);
  const used = new Set(
    sanitizeStudentNames(uniqueStrings(groups.flat())).map((name) => name.toLowerCase())
  );
  const remaining = sanitizeStudentNames(names).filter((name) => !used.has(name.toLowerCase()));
  let cursor = 0;

  for (let groupIndex = 0; groupIndex < filled.length; groupIndex += 1) {
    for (let seatIndex = 0; seatIndex < filled[groupIndex].length; seatIndex += 1) {
      if (filled[groupIndex][seatIndex]) continue;
      if (cursor >= remaining.length) {
        return filled;
      }
      filled[groupIndex][seatIndex] = remaining[cursor];
      used.add(remaining[cursor].toLowerCase());
      cursor += 1;
    }
  }

  return filled;
};

const shouldTrustGeometryLayout = (placedByGeometry: number, supplementalCount: number): boolean => {
  if (placedByGeometry >= 10) return true;
  if (placedByGeometry >= 6 && placedByGeometry >= Math.floor(supplementalCount * 0.45)) return true;
  return false;
};

const inferThreeRowsHalfCols = (text: string, sideBuckets: PositionedName[][]): number => {
  const labelMatches = Array.from(text.matchAll(/[左右]\s*([1-9]\d?)/g))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));

  const labelMax = labelMatches.length > 0 ? Math.max(...labelMatches) : 0;
  const bucketMax = Math.max(1, ...sideBuckets.map((bucket) => bucket.length));

  if (labelMax > 0) return Math.max(1, Math.min(6, labelMax));
  return Math.max(2, Math.min(6, bucketMax));
};

const buildThreeRowsSeatPlan = (text: string, tokens: PositionedName[]): string[][] => {
  const groups = Array.from({ length: MAX_GROUP_COUNT }, () => [] as string[]);
  if (tokens.length === 0) return groups;

  const rowClusters = kMeansOrdered(tokens.map((token) => token.y), THREE_ROWS);
  const sideClusters = kMeansOrdered(tokens.map((token) => token.x), 2);

  const buckets: PositionedName[][] = Array.from({ length: THREE_ROWS * 2 }, () => []);
  for (let i = 0; i < tokens.length; i += 1) {
    const row = Math.min(THREE_ROWS - 1, Math.max(0, rowClusters[i] ?? 0));
    const side = Math.min(1, Math.max(0, sideClusters[i] ?? 0));
    buckets[row * 2 + side].push(tokens[i]);
  }

  const halfCols = inferThreeRowsHalfCols(text, buckets);
  const cols = Math.max(2, Math.min(MAX_THREE_ROW_COLS, halfCols * 2));
  const leftSize = Math.ceil(cols / 2);
  const rightSize = cols - leftSize;

  for (let row = 0; row < THREE_ROWS; row += 1) {
    const leftBucket = [...buckets[row * 2]].sort((a, b) => a.x - b.x).slice(0, leftSize);
    const rightBucket = [...buckets[row * 2 + 1]].sort((a, b) => a.x - b.x).slice(0, rightSize);

    const leftNames = leftBucket.map((token) => token.name);
    const rightNames = rightBucket.map((token) => token.name).reverse();

    groups[row * 2] = leftNames.slice(0, GROUP_CAPACITY);
    groups[row * 2 + 1] = rightNames.slice(0, GROUP_CAPACITY);
  }

  return groups;
};

const buildArcPlan = (tokens: PositionedName[]): string[][] => {
  const rows = [Array(18).fill(''), Array(18).fill('')];

  if (tokens.length === 0) {
    return rows;
  }

  const rowClusters = kMeansOrdered(tokens.map((token) => token.y), 2);
  const buckets: PositionedName[][] = [[], []];

  for (let i = 0; i < tokens.length; i += 1) {
    const row = Math.min(1, Math.max(0, rowClusters[i] ?? 0));
    buckets[row].push(tokens[i]);
  }

  buckets.forEach((bucket, rowIndex) => {
    const names = bucket
      .sort((a, b) => a.x - b.x)
      .slice(0, 18)
      .map((token) => token.name);
    placeCentered(rows[rowIndex], names);
  });

  return rows;
};

const computeAverageConfidence = (words: OCRWordBox[]): number => {
  if (words.length === 0) return 0;
  const total = words.reduce((sum, word) => sum + normalizeConfidence(word.confidence), 0);
  return total / words.length;
};

const extractLikelyNamesFromWords = (words: OCRWordBox[], minConfidence: number): string[] => {
  const names: string[] = [];

  for (const word of words) {
    const confidence = normalizeConfidence(word.confidence);
    if (confidence < minConfidence) continue;

    const normalized = normalizeName(word.text);
    if (!normalized) continue;

    if (isLikelyEnglishName(normalized)) {
      names.push(normalized);
    } else if (isLikelyChineseName(normalized) && confidence >= Math.max(70, minConfidence)) {
      names.push(normalized);
    }
  }

  return uniqueStrings(names);
};

const estimateImageStudentCount = (rawText: string, words: OCRWordBox[]): number => {
  const fromWordsStrict = extractLikelyNamesFromWords(words, 55).length;
  const fromWordsLoose = extractLikelyNamesFromWords(words, 35).length;
  const fromText = parseStudentNames(rawText)
    .map((name) => normalizeName(name))
    .filter((name) => isLikelyEnglishName(name) || isLikelyChineseName(name)).length;

  return Math.max(fromWordsStrict, fromWordsLoose, Math.min(36, fromText));
};

const mapWords = (
  words: Array<{ text?: string; confidence?: number; bbox: { x0: number; y0: number; x1: number; y1: number } }>,
  transform: { offsetX?: number; offsetY?: number; scale?: number } = {}
): OCRWordBox[] => {
  const offsetX = transform.offsetX ?? 0;
  const offsetY = transform.offsetY ?? 0;
  const scale = transform.scale ?? 1;

  return words
    .map((word) => ({
      text: word.text ?? '',
      x0: (word.bbox.x0 ?? 0) / scale + offsetX,
      y0: (word.bbox.y0 ?? 0) / scale + offsetY,
      x1: (word.bbox.x1 ?? 0) / scale + offsetX,
      y1: (word.bbox.y1 ?? 0) / scale + offsetY,
      confidence: normalizeConfidence(word.confidence ?? 0)
    }))
    .filter((word) => word.text.trim().length > 0);
};

const createNameOCRCanvas = async (imageFile: File, layout: LayoutType): Promise<NameCanvasResult> => {
  const imageBitmap = await createImageBitmap(imageFile);
  const cropTopRatio = layout === 'rows' ? 0.34 : 0.30;
  const cropBottomRatio = 0.96;

  const cropX = 0;
  const cropY = Math.floor(imageBitmap.height * cropTopRatio);
  const cropWidth = imageBitmap.width;
  const cropHeight = Math.max(1, Math.floor(imageBitmap.height * (cropBottomRatio - cropTopRatio)));
  const scale = 2;

  const canvas = document.createElement('canvas');
  canvas.width = cropWidth * scale;
  canvas.height = cropHeight * scale;

  const context = canvas.getContext('2d');
  if (!context) {
    imageBitmap.close();
    throw new Error('无法初始化图片处理画布');
  }

  context.drawImage(imageBitmap, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
  imageBitmap.close();

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const boosted = gray > 188 ? 255 : gray < 88 ? 0 : Math.round((gray - 88) * (255 / 100));
    data[i] = boosted;
    data[i + 1] = boosted;
    data[i + 2] = boosted;
  }

  context.putImageData(imageData, 0, 0);

  return { canvas, cropX, cropY, scale };
};

const parseCandidate = (rawText: string, words: OCRWordBox[]): ParsedCandidate => {
  const textLayout = detectLayoutByText(rawText);
  const tokens = extractPositionedNames(words);
  const geometryLayout = detectLayoutByGeometry(tokens);
  const fallbackLikelyNames = prioritizeEnglishNames(extractLikelyNamesFromText(rawText)).slice(0, 36);
  const supplementalNames = prioritizeEnglishNames([
    ...fallbackLikelyNames,
    ...extractLikelyNamesFromWords(words, 50)
  ]).slice(0, 36);

  let layout: LayoutType = textLayout ?? geometryLayout ?? 'circular';
  if (textLayout && geometryLayout && textLayout !== geometryLayout) {
    layout = geometryLayout;
  }

  let groups: string[][] = [];

  if (tokens.length > 0) {
    if (layout === 'rows') {
      groups = buildThreeRowsSeatPlan(rawText, tokens);
    } else if (layout === 'arc') {
      groups = buildArcPlan(tokens);
    } else {
      groups = buildGroupSeatPlan(tokens);
    }

    groups = sanitizeSeatGroups(groups);
    const placedByGeometry = countPlacedStudents(groups);
    if (placedByGeometry === 0) {
      groups = buildFallbackGroupsByLayout(layout, fallbackLikelyNames);
    } else if (shouldTrustGeometryLayout(placedByGeometry, supplementalNames.length)) {
      groups = fillEmptySeatsWithNames(groups, supplementalNames);
    } else if (supplementalNames.length > placedByGeometry + 4) {
      groups = buildFallbackGroupsByLayout(layout, supplementalNames);
    }
  } else {
    const fallbackNames = fallbackLikelyNames.length > 0 ? fallbackLikelyNames : sanitizeStudentNames(parseStudentNames(rawText));
    groups = buildFallbackGroupsByLayout(layout, fallbackNames);
  }

  groups = sanitizeSeatGroups(groups);

  let students = prioritizeEnglishNames(uniqueStrings(groups.flat())).slice(0, 36);
  if (students.length === 0) {
    students = supplementalNames.length > 0 ? supplementalNames : prioritizeEnglishNames(parseStudentNames(rawText));
  }

  return {
    layout,
    groups,
    students,
    confidence: computeAverageConfidence(words),
    rawText
  };
};

const scoreCandidate = (candidate: ParsedCandidate, expectedCount: number): number => {
  const placedCount = uniqueStrings(candidate.groups.flat()).length;
  const studentCount = candidate.students.length;
  const mismatch = expectedCount > 0 ? Math.abs(expectedCount - studentCount) : 0;

  return placedCount * 25 + studentCount * 12 - mismatch * 10 + candidate.confidence * 0.4;
};

const chooseBestCandidate = (rawText: string, candidates: OCRWordBox[][], expectedCount: number): ParsedCandidate | null => {
  let best: ParsedCandidate | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const words of candidates) {
    try {
      const parsed = parseCandidate(rawText, words);
      const score = scoreCandidate(parsed, expectedCount);
      if (!best || score > bestScore) {
        best = parsed;
        bestScore = score;
      }
    } catch {
      continue;
    }
  }

  return best;
};

const readFileAsBase64 = async (file: File): Promise<string> => {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result || '');
        const encoded = value.includes(',') ? value.split(',')[1] : value;
        if (!encoded) {
          reject(new Error('图片读取失败'));
          return;
        }
        resolve(encoded);
      };
      reader.onerror = () => {
        reject(new Error('图片读取失败'));
      };
      reader.readAsDataURL(file);
    });
  }

  const arrayBuffer = await file.arrayBuffer();
  const bufferCtor = (globalThis as unknown as { Buffer?: { from: (input: ArrayBuffer) => { toString: (encoding: string) => string } } }).Buffer;
  if (bufferCtor) {
    return bufferCtor.from(arrayBuffer).toString('base64');
  }

  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
};

const runTencentOCR = async (imageFile: File, settings: OCRSettings): Promise<OCRRawCandidate> => {
  const base64 = await readFileAsBase64(imageFile);
  const endpoint = settings.tencentEndpoint.replace(/\/$/, '');
  const response = await fetch(`${endpoint}/api/tencent-ocr`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      imageBase64: base64,
      action: settings.tencentAction,
      region: settings.tencentRegion
    })
  });

  const payload = (await response.json().catch(() => ({}))) as {
    rawText?: string;
    words?: OCRWordBox[];
    error?: string;
    action?: string;
  };

  if (!response.ok) {
    throw new Error(payload.error || `腾讯 OCR 请求失败(${response.status})`);
  }

  const words = (payload.words || []).map((word) => ({
    text: String(word.text || '').trim(),
    confidence: normalizeConfidence(Number(word.confidence) || 88),
    x0: Number(word.x0) || 0,
    y0: Number(word.y0) || 0,
    x1: Number(word.x1) || 0,
    y1: Number(word.y1) || 0
  })).filter((word) => word.text);

  const rawText = String(payload.rawText || '');
  if (!rawText.trim() && words.length === 0) {
    throw new Error('腾讯 OCR 返回为空');
  }

  return {
    rawText,
    words,
    candidates: words.length > 0 ? [words] : [],
    source: `tencent:${payload.action || settings.tencentAction}`
  };
};

const runLocalOCR = async (imageFile: File): Promise<OCRRawCandidate> => {
  const fullResult = await Tesseract.recognize(imageFile, 'chi_sim+eng', {
    logger: (message: { status?: string; progress?: number }) => {
      if (message.status === 'recognizing text') {
        const percent = Math.round((message.progress ?? 0) * 100);
        console.log(`[OCR-main] ${percent}%`);
      }
    }
  });

  const fullData = fullResult.data as typeof fullResult.data & {
    words?: Array<{ text?: string; confidence?: number; bbox: { x0: number; y0: number; x1: number; y1: number } }>;
  };

  const rawText = fullData.text ?? '';
  const layoutHint = detectLayoutByText(rawText) ?? 'circular';
  const mainWords = mapWords(fullData.words ?? []);
  const nameCanvas = await createNameOCRCanvas(imageFile, layoutHint);

  const nameResult = await Tesseract.recognize(
    nameCanvas.canvas,
    'eng',
    {
      tessedit_pageseg_mode: '6',
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'-.",
      logger: (message: { status?: string; progress?: number }) => {
        if (message.status === 'recognizing text') {
          const percent = Math.round((message.progress ?? 0) * 100);
          console.log(`[OCR-name] ${percent}%`);
        }
      }
    } as unknown as Record<string, unknown>
  );

  const nameData = nameResult.data as typeof nameResult.data & {
    words?: Array<{ text?: string; confidence?: number; bbox: { x0: number; y0: number; x1: number; y1: number } }>;
  };

  const nameWords = mapWords(nameData.words ?? [], {
    offsetX: nameCanvas.cropX,
    offsetY: nameCanvas.cropY,
    scale: nameCanvas.scale
  });

  const candidates: OCRWordBox[][] = [];
  if (nameWords.length > 0) candidates.push(nameWords);
  if (nameWords.length > 0 && mainWords.length > 0) candidates.push([...nameWords, ...mainWords]);
  if (mainWords.length > 0) candidates.push(mainWords);

  const expectedCount = estimateImageStudentCount(rawText, [...nameWords, ...mainWords]);
  const firstBest = chooseBestCandidate(rawText, candidates, expectedCount);
  const firstStudentCount = firstBest?.students.length ?? 0;
  const firstPlacedCount = firstBest ? uniqueStrings(firstBest.groups.flat()).length : 0;
  const mismatchTooLarge =
    expectedCount > 0 && (firstStudentCount + 1 < expectedCount || firstPlacedCount + 1 < expectedCount);

  if (mismatchTooLarge) {
    const retryNameResult = await Tesseract.recognize(
      nameCanvas.canvas,
      'eng',
      {
        tessedit_pageseg_mode: '11',
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'-.",
        logger: (message: { status?: string; progress?: number }) => {
          if (message.status === 'recognizing text') {
            const percent = Math.round((message.progress ?? 0) * 100);
            console.log(`[OCR-name-retry] ${percent}%`);
          }
        }
      } as unknown as Record<string, unknown>
    );

    const retryData = retryNameResult.data as typeof retryNameResult.data & {
      words?: Array<{ text?: string; confidence?: number; bbox: { x0: number; y0: number; x1: number; y1: number } }>;
    };

    const retryNameWords = mapWords(retryData.words ?? [], {
      offsetX: nameCanvas.cropX,
      offsetY: nameCanvas.cropY,
      scale: nameCanvas.scale
    });

    if (retryNameWords.length > 0) {
      candidates.push(retryNameWords);
      if (mainWords.length > 0) {
        candidates.push([...retryNameWords, ...mainWords]);
      }
      if (nameWords.length > 0) {
        candidates.push([...retryNameWords, ...nameWords]);
      }
    }
  }

  return {
    rawText,
    words: [...nameWords, ...mainWords],
    candidates,
    source: 'local:tesseract'
  };
};

const buildDraft = (imageFile: File, rawText: string, bestResult: ParsedCandidate, source: string): OCRClassDraft => {
  const className = parseClassName(rawText);
  const classTime = parseClassTime(rawText);
  const location = parseLocation(rawText);

  const compact = compactText(rawText).replace(/选择星期|选择校区/g, ' ').replace(/\bv\b/gi, ' ');
  const monthDayMatch = (classTime || compact).match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const weekdayMatch = (classTime || compact).match(/(?:星期|周)\s*([一二三四五六日天])/);
  const timeMatch = (classTime || compact).match(/(\d{1,2}\s*[:：]\s*\d{2}(?:\s*-\s*\d{1,2}\s*[:：]\s*\d{2})?)/);

  const date = monthDayMatch?.[1] ?? '';
  const day = monthDayMatch?.[2] ?? '';
  const weekday = weekdayMatch?.[1] ? `星期${weekdayMatch[1].replace('天', '日')}` : '';
  const time = timeMatch?.[1] ? normalizeTimeText(timeMatch[1]) : '';
  const fullDate = date ? monthDayToDateKey(date, day) ?? '' : '';

  return {
    fileName: imageFile.name,
    rawText,
    className,
    source,
    layout: bestResult.layout,
    groups: bestResult.groups,
    detectedStudentCount: bestResult.students.length,
    placedStudentCount: uniqueStrings(bestResult.groups.flat()).length,
    confidence: bestResult.confidence,
    info: {
      date,
      day,
      weekday,
      time,
      campus: location.campus,
      floor: location.floor,
      room: location.room,
      fullDate
    }
  };
};

const parseDraftFromRaw = (imageFile: File, raw: OCRRawCandidate): OCRClassDraft => {
  const expectedCount = estimateImageStudentCount(raw.rawText, raw.words);
  const candidateList = raw.candidates.length > 0 ? raw.candidates : [raw.words];
  let best = chooseBestCandidate(raw.rawText, candidateList, expectedCount);

  if (!best) {
    best = parseCandidate(raw.rawText, raw.words);
  }

  return buildDraft(imageFile, raw.rawText, best, raw.source);
};

export const recognizeClassFromImage = async (imageFile: File, settings?: OCRSettings): Promise<OCRClassDraft> => {
  const engine = settings?.engine || 'hybrid';
  const activeSettings: OCRSettings = {
    engine,
    allowLocalFallback: settings?.allowLocalFallback ?? false,
    tencentEndpoint: settings?.tencentEndpoint?.trim() || 'http://127.0.0.1:8787',
    tencentRegion: settings?.tencentRegion?.trim() || 'ap-guangzhou',
    tencentAction: settings?.tencentAction || 'Auto'
  };

  try {
    if (engine === 'local') {
      const localRaw = await runLocalOCR(imageFile);
      return parseDraftFromRaw(imageFile, localRaw);
    }

    if (engine === 'tencent') {
      const cloudRaw = await runTencentOCR(imageFile, activeSettings);
      return parseDraftFromRaw(imageFile, cloudRaw);
    }

    let cloudError: Error | null = null;
    try {
      const cloudRaw = await runTencentOCR(imageFile, activeSettings);
      return parseDraftFromRaw(imageFile, cloudRaw);
    } catch (error) {
      cloudError = error instanceof Error ? error : new Error('腾讯 OCR 请求失败');
    }

    if (activeSettings.allowLocalFallback) {
      console.warn('[OCR] Tencent failed, fallback to local:', cloudError);
      const localRaw = await runLocalOCR(imageFile);
      return parseDraftFromRaw(imageFile, localRaw);
    }

    throw cloudError || new Error('腾讯 OCR 请求失败');
  } catch (error) {
    throw new Error(`OCR识别失败: ${error instanceof Error ? error.message : '未知错误'}`);
  }
};
