import type { ArcGroups, LayoutType, RowGroups } from './types';
import { ARC_ROW_SIZE, CIRCULAR_GROUP_SIZE, ROW_GROUP_SIZE, makeEmptyArcGroups, makeEmptyCircularGroups, makeEmptyRowGroups } from './state';

const CIRCULAR_THRESHOLD = [
  { min: 31, groups: 6 },
  { min: 25, groups: 5 },
  { min: 19, groups: 4 },
  { min: 1, groups: 3 }
] as const;

const ROW_THRESHOLD = [
  { min: 31, groups: 6 },
  { min: 25, groups: 5 },
  { min: 1, groups: 4 }
] as const;

const copyGroup = (group: string[], size: number): string[] => {
  const normalized = group
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, size);
  return [...normalized, ...Array(size - normalized.length).fill('')];
};

export const normalizeStudentList = (students: string[]): string[] =>
  students
    .map((name) => name.trim())
    .filter(Boolean);

export const getCircularGroupCount = (totalStudents: number): number => {
  for (const item of CIRCULAR_THRESHOLD) {
    if (totalStudents >= item.min) {
      return item.groups;
    }
  }
  return 0;
};

export const getRowGroupCount = (totalStudents: number): number => {
  for (const item of ROW_THRESHOLD) {
    if (totalStudents >= item.min) {
      return item.groups;
    }
  }
  return 0;
};

export const getCircularSlotMap = (groupCount: number): Array<number | null> => {
  if (groupCount >= 6) return [0, 1, 2, 3, 4, 5];
  if (groupCount === 5) return [0, 1, 2, 3, 4, null];
  if (groupCount === 4) return [0, 1, 2, null, 3, null];
  if (groupCount === 3) return [0, 1, 2, null, null, null];
  if (groupCount === 2) return [0, 1, null, null, null, null];
  if (groupCount === 1) return [0, null, null, null, null, null];
  return [null, null, null, null, null, null];
};

export const getRowsSlotMap = (groupCount: number): Array<number | null> => {
  if (groupCount >= 6) return [0, 1, 2, 3, 4, 5];
  if (groupCount === 5) return [0, 1, 2, 3, 4, null];
  if (groupCount === 4) return [0, 1, 2, 3, null, null];
  if (groupCount === 3) return [0, 1, 2, null, null, null];
  if (groupCount === 2) return [0, 1, null, null, null, null];
  if (groupCount === 1) return [0, null, null, null, null, null];
  return [null, null, null, null, null, null];
};

const splitEvenly = (students: string[], groupCount: number, capacity: number): string[][] => {
  const normalized = normalizeStudentList(students);
  if (groupCount <= 0) {
    return [];
  }

  if (normalized.length > groupCount * capacity) {
    throw new Error(`人数超出限制：${groupCount}组每组最多${capacity}人，当前${normalized.length}人`);
  }

  const base = Math.floor(normalized.length / groupCount);
  const extra = normalized.length % groupCount;

  const groups: string[][] = [];
  let cursor = 0;

  for (let index = 0; index < groupCount; index += 1) {
    const thisCount = base + (index < extra ? 1 : 0);
    const chunk = normalized.slice(cursor, cursor + thisCount);
    cursor += thisCount;
    groups.push(chunk);
  }

  return groups;
};

const countNonEmptyGroups = (groups: string[][]): number => groups.filter((group) => group.some((name) => name.trim())).length;

export const placeCentered = (targetArray: string[], names: string[]): void => {
  const width = targetArray.length;
  let centerLeft = Math.floor((width - 1) / 2);
  let centerRight = centerLeft + 1;
  let useLeft = true;
  let idx = 0;

  while (idx < names.length && (centerLeft >= 0 || centerRight < width)) {
    if (useLeft && centerLeft >= 0) {
      targetArray[centerLeft--] = names[idx++];
    } else if (!useLeft && centerRight < width) {
      targetArray[centerRight++] = names[idx++];
    }
    useLeft = !useLeft;
  }
};

export const convertStudentsToCircular = (students: string[], forcedGroupCount?: number): string[][] => {
  const normalized = normalizeStudentList(students);
  const groupCount = forcedGroupCount ?? getCircularGroupCount(normalized.length);
  if (groupCount <= 0) {
    return makeEmptyCircularGroups();
  }

  const logicalGroups = splitEvenly(normalized, groupCount, CIRCULAR_GROUP_SIZE);
  const groups = makeEmptyCircularGroups();

  logicalGroups.forEach((group, index) => {
    groups[index] = copyGroup(group, CIRCULAR_GROUP_SIZE);
  });

  return groups;
};

const slotGroupsToRowGroups = (slotGroups: string[][]): RowGroups => ({
  rows: [
    { left: copyGroup(slotGroups[0] ?? [], ROW_GROUP_SIZE), right: copyGroup(slotGroups[1] ?? [], ROW_GROUP_SIZE) },
    { left: copyGroup(slotGroups[2] ?? [], ROW_GROUP_SIZE), right: copyGroup(slotGroups[3] ?? [], ROW_GROUP_SIZE) },
    { left: copyGroup(slotGroups[4] ?? [], ROW_GROUP_SIZE), right: copyGroup(slotGroups[5] ?? [], ROW_GROUP_SIZE) }
  ]
});

export const rowGroupsToSlotGroups = (rowGroups: RowGroups): string[][] => {
  const rows = rowGroups.rows;
  return [
    copyGroup(rows[0]?.left ?? [], ROW_GROUP_SIZE),
    copyGroup(rows[0]?.right ?? [], ROW_GROUP_SIZE),
    copyGroup(rows[1]?.left ?? [], ROW_GROUP_SIZE),
    copyGroup(rows[1]?.right ?? [], ROW_GROUP_SIZE),
    copyGroup(rows[2]?.left ?? [], ROW_GROUP_SIZE),
    copyGroup(rows[2]?.right ?? [], ROW_GROUP_SIZE)
  ];
};

export const convertStudentsToRows = (students: string[], forcedGroupCount?: number): RowGroups => {
  const normalized = normalizeStudentList(students);
  const groupCount = forcedGroupCount ?? getRowGroupCount(normalized.length);
  if (groupCount <= 0) {
    return makeEmptyRowGroups();
  }

  const logicalGroups = splitEvenly(normalized, groupCount, ROW_GROUP_SIZE);
  const slotMap = getRowsSlotMap(groupCount);
  const slotGroups = Array.from({ length: 6 }, () => Array(ROW_GROUP_SIZE).fill(''));

  slotMap.forEach((logicalIndex, slotIndex) => {
    if (logicalIndex === null) {
      return;
    }
    slotGroups[slotIndex] = copyGroup(logicalGroups[logicalIndex] ?? [], ROW_GROUP_SIZE);
  });

  return slotGroupsToRowGroups(slotGroups);
};

export const convertStudentsToArc = (students: string[], forcedGroupCount?: number): ArcGroups => {
  const normalized = normalizeStudentList(students).slice(0, 36);
  const autoGroupCount = Math.max(1, Math.min(4, Math.ceil(normalized.length / 9)));
  const groupCount = Math.max(1, Math.min(4, forcedGroupCount ?? autoGroupCount));
  const logicalGroups = splitEvenly(normalized, groupCount, 9);

  const arc = makeEmptyArcGroups();
  const firstRow = [...(logicalGroups[0] || []), ...(logicalGroups[1] || [])].slice(0, 18);
  const secondRow = [...(logicalGroups[2] || []), ...(logicalGroups[3] || [])].slice(0, 18);

  placeCentered(arc.rows[0], firstRow);
  placeCentered(arc.rows[1], secondRow);
  return arc;
};

export const collectStudentsFromCircular = (groups: string[][]): string[] => {
  return groups.flatMap((group) => group.map((name) => name.trim()).filter(Boolean));
};

export const collectStudentsFromRows = (rowGroups: RowGroups): string[] => {
  return rowGroupsToSlotGroups(rowGroups).flatMap((group) => group.map((name) => name.trim()).filter(Boolean));
};

export const collectStudentsFromArc = (arcGroups: ArcGroups): string[] => {
  return arcGroups.rows.flatMap((row) => row.map((name) => name.trim()).filter(Boolean));
};

export const getCircularGroupCountFromGroups = (groups: string[][]): number => countNonEmptyGroups(groups);

export const getRowsGroupCountFromGroups = (rowGroups: RowGroups): number =>
  countNonEmptyGroups(rowGroupsToSlotGroups(rowGroups));

export const rotateCircularLayoutForWeek = (groups: string[][]): string[][] => {
  const internalRotated = groups.map((group) => copyGroup(group, CIRCULAR_GROUP_SIZE));
  const activeCount = getCircularGroupCountFromGroups(internalRotated);
  if (activeCount <= 1) {
    return internalRotated;
  }

  const slotMap = getCircularSlotMap(activeCount);
  const clockwiseOrder = [0, 1, 2, 3, 4, 5];
  const activeSlots = clockwiseOrder.filter((slot) => slotMap[slot] !== null);

  const rotated = makeEmptyCircularGroups();
  rotated.forEach((_, index) => {
    rotated[index] = copyGroup(internalRotated[index], CIRCULAR_GROUP_SIZE);
  });

  activeSlots.forEach((targetSlot, index) => {
    const sourceSlot = activeSlots[(index - 1 + activeSlots.length) % activeSlots.length];
    const targetGroup = slotMap[targetSlot];
    const sourceGroup = slotMap[sourceSlot];
    if (targetGroup === null || sourceGroup === null) {
      return;
    }
    rotated[targetGroup] = copyGroup(internalRotated[sourceGroup], CIRCULAR_GROUP_SIZE);
  });

  return rotated;
};

export const rotateCircularGroupOrderForWeek = (groupOrder: number[], activeCount: number): number[] => {
  const slotMap = getCircularSlotMap(activeCount);
  const clockwiseOrder = [0, 1, 2, 3, 4, 5];
  const activeSlots = clockwiseOrder.filter((slot) => slotMap[slot] !== null);
  const rotated = [...groupOrder];

  activeSlots.forEach((targetSlot, index) => {
    const sourceSlot = activeSlots[(index - 1 + activeSlots.length) % activeSlots.length];
    const targetGroup = slotMap[targetSlot];
    const sourceGroup = slotMap[sourceSlot];
    if (targetGroup === null || sourceGroup === null) {
      return;
    }
    rotated[targetGroup] = groupOrder[sourceGroup] || sourceGroup + 1;
  });

  return rotated;
};

export const rotateRowsLayoutForWeek = (rowGroups: RowGroups): RowGroups => {
  const slotGroups = rowGroupsToSlotGroups(rowGroups);
  const activeCount = countNonEmptyGroups(slotGroups);
  if (activeCount <= 1) {
    return rowGroups;
  }

  const slotMap = getRowsSlotMap(activeCount);
  const internalRotated = slotGroups.map((group) => copyGroup(group, ROW_GROUP_SIZE));
  const rotationPath = [0, 2, 4, 1, 3, 5];
  const activeSlots = rotationPath.filter((slotIndex) => slotMap[slotIndex] !== null);
  const rotatedSlots = Array.from({ length: 6 }, () => Array(ROW_GROUP_SIZE).fill(''));

  activeSlots.forEach((targetSlot, index) => {
    const sourceSlot = activeSlots[(index - 1 + activeSlots.length) % activeSlots.length];
    rotatedSlots[targetSlot] = copyGroup(internalRotated[sourceSlot], ROW_GROUP_SIZE);
  });

  return slotGroupsToRowGroups(rotatedSlots);
};

export const rotateArcLayoutForWeek = (arcGroups: ArcGroups): ArcGroups => {
  const rows = arcGroups.rows.map((row) => copyGroup(row, ARC_ROW_SIZE));
  return { rows };
};

export const applyManualGrouping = (
  layout: LayoutType,
  groupCount: number,
  students: string[]
): { layout: LayoutType; groups: string[][]; rowGroups: RowGroups; arcGroups: ArcGroups } => {
  const normalized = normalizeStudentList(students);

  if (layout === 'circular') {
    if (groupCount < 1 || groupCount > 6) {
      throw new Error('圆桌布局组数需在1-6之间');
    }
    if (normalized.length > groupCount * CIRCULAR_GROUP_SIZE) {
      throw new Error(`圆桌布局每组最多${CIRCULAR_GROUP_SIZE}人，当前无法分配`);
    }

    return {
      layout,
      groups: convertStudentsToCircular(normalized, groupCount),
      rowGroups: makeEmptyRowGroups(),
      arcGroups: makeEmptyArcGroups()
    };
  }

  if (layout === 'rows') {
    if (groupCount < 1 || groupCount > 6) {
      throw new Error('三横排组数需在1-6之间');
    }
    if (normalized.length > groupCount * ROW_GROUP_SIZE) {
      throw new Error(`三横排每组最多${ROW_GROUP_SIZE}人，当前无法分配`);
    }

    return {
      layout,
      groups: makeEmptyCircularGroups(),
      rowGroups: convertStudentsToRows(normalized, groupCount),
      arcGroups: makeEmptyArcGroups()
    };
  }

  if (groupCount < 1 || groupCount > 4) {
    throw new Error('两横排组数需在1-4之间');
  }
  if (normalized.length > groupCount * 9) {
    throw new Error('两横排每组最多9人，当前无法分配');
  }

  return {
    layout,
    groups: makeEmptyCircularGroups(),
    rowGroups: makeEmptyRowGroups(),
    arcGroups: convertStudentsToArc(normalized, groupCount)
  };
};

export const layoutMaxStudents = (layout: LayoutType): number => {
  if (layout === 'circular') return 36;
  if (layout === 'rows') return 36;
  return 36;
};
