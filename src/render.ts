import { getCircularGroupCountFromGroups, getCircularSlotMap, getRowsGroupCountFromGroups, getRowsSlotMap } from './layouts';
import type { AppState, TimeModeData } from './types';

interface RenderHandlers {
  handleSeatChange: (groupIndex: number, seatIndex: number, value: string) => void;
  handleRowSeatChange: (rowIndex: number, side: 'left' | 'right', seatIndex: number, value: string) => void;
  handleArcSeatChange: (rowIndex: number, seatIndex: number, value: string) => void;
}

const asElement = <T extends Element>(selector: string): T => {
  const node = document.querySelector(selector);
  if (!node) {
    throw new Error(`Element not found: ${selector}`);
  }
  return node as T;
};

const makeInput = (value: string, fontSize: number, readonly: boolean): HTMLInputElement => {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.style.fontSize = `${fontSize}px`;
  if (readonly) {
    input.readOnly = true;
  }
  return input;
};

const maxNameLength = (names: string[], fallback = 1): number =>
  Math.max(...names.filter((name) => name).map((name) => name.length), fallback);

export const refreshSeating = (state: AppState, handlers: RenderHandlers): void => {
  const classroom = asElement<HTMLDivElement>('#classroom');
  classroom.innerHTML = '';

  if (state.currentLayout === 'circular') {
    classroom.className = 'classroom';
    refreshCircularSeating(state, handlers);
  } else if (state.currentLayout === 'rows') {
    classroom.className = 'classroom three-rows-layout';
    refreshRowSeating(state, handlers);
  } else {
    classroom.className = 'classroom arc-layout';
    refreshArcSeating(state, handlers);
  }
};

export const renderModePreview = (container: HTMLDivElement, modeData: TimeModeData): void => {
  container.innerHTML = '';

  if (modeData.layout === 'circular') {
    renderPreviewCircular(container, modeData.groups || []);
    return;
  }

  if (modeData.layout === 'rows') {
    renderPreviewRows(container, modeData.rowGroups);
    return;
  }

  renderPreviewArc(container, modeData.arcGroups);
};

const refreshCircularSeating = (state: AppState, handlers: RenderHandlers): void => {
  const classroom = asElement<HTMLDivElement>('#classroom');
  const activeGroupCount = getCircularGroupCountFromGroups(state.groups);
  const slotMap = getCircularSlotMap(activeGroupCount);

  for (let slotIndex = 0; slotIndex < 6; slotIndex += 1) {
    const logicalGroupIndex = slotMap[slotIndex];
    const table = document.createElement('div');

    if (logicalGroupIndex === null) {
      table.className = 'table table-empty';
      table.innerHTML = '<h3>空组</h3><div class="seats seats-empty"></div>';
      classroom.appendChild(table);
      continue;
    }

    const visualGroup = state.currentGroupOrder[logicalGroupIndex] || logicalGroupIndex + 1;
    table.className = `table group-${((visualGroup - 1) % 6) + 1}`;

    const title = document.createElement('h3');
    title.textContent = `Group ${visualGroup}`;
    table.appendChild(title);

    const seats = document.createElement('div');
    seats.className = 'seats';

    const maxLength = maxNameLength(state.groups[logicalGroupIndex], 1);
    const fontSize = Math.min(16, Math.max(10, Math.floor(140 / maxLength)));

    for (let seatIndex = 0; seatIndex < 6; seatIndex += 1) {
      const seat = document.createElement('div');
      seat.className = 'seat';
      const student = state.groups[logicalGroupIndex][seatIndex] || '';
      const input = makeInput(student, fontSize, !state.isEditMode);
      input.onchange = () => handlers.handleSeatChange(logicalGroupIndex, seatIndex, input.value);
      seat.appendChild(input);
      seats.appendChild(seat);
    }

    table.appendChild(seats);
    classroom.appendChild(table);
  }
};

const refreshRowSeating = (state: AppState, handlers: RenderHandlers): void => {
  const classroom = asElement<HTMLDivElement>('#classroom');
  const activeGroupCount = getRowsGroupCountFromGroups(state.rowGroups);
  const slotMap = getRowsSlotMap(activeGroupCount);

  const rows = [
    { leftSlot: 0, rightSlot: 1 },
    { leftSlot: 2, rightSlot: 3 },
    { leftSlot: 4, rightSlot: 5 }
  ];

  rows.forEach((rowMeta, rowIndex) => {
    const rowElement = document.createElement('div');
    rowElement.className = 'row';

    const leftGroupIndex = slotMap[rowMeta.leftSlot];
    const rightGroupIndex = slotMap[rowMeta.rightSlot];

    const leftData = state.rowGroups.rows[rowIndex].left;
    const rightData = state.rowGroups.rows[rowIndex].right;

    const isSingleCenter = rowIndex === 2 && leftGroupIndex !== null && rightGroupIndex === null;
    if (isSingleCenter) {
      rowElement.classList.add('single-center');
    }

    const buildGroup = (position: 'left' | 'right'): HTMLDivElement => {
      const group = document.createElement('div');
      group.className = position === 'left' ? 'group-left' : 'group-right';

      const currentGroupIndex = position === 'left' ? leftGroupIndex : rightGroupIndex;
      const currentData = position === 'left' ? leftData : rightData;
      const sideKey = position;

      const title = document.createElement('h3');
      title.textContent = currentGroupIndex === null ? '空组' : `Group ${currentGroupIndex + 1}`;
      group.appendChild(title);

      const seats = document.createElement('div');
      seats.className = 'seats-row';

      const maxLength = maxNameLength(currentData, 1);
      const fontSize = Math.min(16, Math.max(10, Math.floor(140 / maxLength)));

      currentData.forEach((student, seatIndex) => {
        if (!student) {
          return;
        }

        const seat = document.createElement('div');
        seat.className = 'seat';
        const input = makeInput(student, fontSize, !state.isEditMode || currentGroupIndex === null);
        input.onchange = () => handlers.handleRowSeatChange(rowIndex, sideKey, seatIndex, input.value);
        seat.appendChild(input);
        seats.appendChild(seat);
      });

      group.appendChild(seats);
      return group;
    };

    const leftGroup = buildGroup('left');
    const rightGroup = buildGroup('right');

    if (isSingleCenter) {
      leftGroup.classList.add('group-center');
      rowElement.appendChild(leftGroup);
    } else {
      rowElement.appendChild(leftGroup);
      rowElement.appendChild(rightGroup);
    }

    classroom.appendChild(rowElement);
  });
};

const refreshArcSeating = (state: AppState, handlers: RenderHandlers): void => {
  const classroom = asElement<HTMLDivElement>('#classroom');

  state.arcGroups.rows.forEach((row, rowIndex) => {
    const rowElement = document.createElement('div');
    rowElement.className = 'arc-row';

    const title = document.createElement('h3');
    title.className = 'two-row-title';
    title.textContent = rowIndex === 0 ? '前排' : '后排';
    rowElement.appendChild(title);

    const seats = document.createElement('div');
    seats.className = 'arc-seats';

    const maxLength = maxNameLength(row, 1);
    const fontSize = Math.min(16, Math.max(12, Math.floor(140 / maxLength)));

    for (let i = 0; i < row.length; i += 1) {
      const student = row[i] || '';
      const seat = document.createElement('div');
      seat.className = 'seat arc-seat';

      const input = makeInput(student, fontSize, !state.isEditMode);
      input.onchange = () => handlers.handleArcSeatChange(rowIndex, i, input.value);

      seat.appendChild(input);
      seats.appendChild(seat);
    }

    rowElement.appendChild(seats);
    classroom.appendChild(rowElement);
  });
};

const renderPreviewCircular = (container: HTMLDivElement, groups: string[][]): void => {
  const activeGroupCount = getCircularGroupCountFromGroups(groups);
  const slotMap = getCircularSlotMap(activeGroupCount);

  for (let slotIndex = 0; slotIndex < 6; slotIndex += 1) {
    const logicalGroupIndex = slotMap[slotIndex];
    const table = document.createElement('div');

    if (logicalGroupIndex === null) {
      table.className = 'table table-empty';
      table.innerHTML = '<h3>空组</h3><div class="seats seats-empty"></div>';
      container.appendChild(table);
      continue;
    }

    table.className = `table group-${(logicalGroupIndex % 6) + 1}`;
    const title = document.createElement('h3');
    title.textContent = `Group ${logicalGroupIndex + 1}`;
    table.appendChild(title);

    const seats = document.createElement('div');
    seats.className = 'seats';
    const maxLength = maxNameLength(groups[logicalGroupIndex] || [], 1);
    const fontSize = Math.min(16, Math.max(10, Math.floor(140 / maxLength)));

    for (let seatIndex = 0; seatIndex < 6; seatIndex += 1) {
      const seat = document.createElement('div');
      seat.className = 'seat';
      seat.appendChild(makeInput(groups[logicalGroupIndex]?.[seatIndex] || '', fontSize, true));
      seats.appendChild(seat);
    }

    table.appendChild(seats);
    container.appendChild(table);
  }
};

const renderPreviewRows = (container: HTMLDivElement, rowGroups: TimeModeData['rowGroups']): void => {
  if (!rowGroups) {
    return;
  }

  const activeGroupCount = getRowsGroupCountFromGroups(rowGroups);
  const slotMap = getRowsSlotMap(activeGroupCount);
  const rows = [
    { leftSlot: 0, rightSlot: 1 },
    { leftSlot: 2, rightSlot: 3 },
    { leftSlot: 4, rightSlot: 5 }
  ];

  rows.forEach((rowMeta, rowIndex) => {
    const rowElement = document.createElement('div');
    rowElement.className = 'row';
    const leftGroupIndex = slotMap[rowMeta.leftSlot];
    const rightGroupIndex = slotMap[rowMeta.rightSlot];
    const leftData = rowGroups.rows[rowIndex].left;
    const rightData = rowGroups.rows[rowIndex].right;
    const isSingleCenter = rowIndex === 2 && leftGroupIndex !== null && rightGroupIndex === null;

    if (isSingleCenter) {
      rowElement.classList.add('single-center');
    }

    const buildGroup = (position: 'left' | 'right'): HTMLDivElement => {
      const group = document.createElement('div');
      group.className = position === 'left' ? 'group-left' : 'group-right';
      const currentGroupIndex = position === 'left' ? leftGroupIndex : rightGroupIndex;
      const currentData = position === 'left' ? leftData : rightData;
      const title = document.createElement('h3');
      title.textContent = currentGroupIndex === null ? '空组' : `Group ${currentGroupIndex + 1}`;
      group.appendChild(title);

      const seats = document.createElement('div');
      seats.className = 'seats-row';
      const maxLength = maxNameLength(currentData, 1);
      const fontSize = Math.min(16, Math.max(10, Math.floor(140 / maxLength)));

      currentData.forEach((student) => {
        if (!student) {
          return;
        }
        const seat = document.createElement('div');
        seat.className = 'seat';
        seat.appendChild(makeInput(student, fontSize, true));
        seats.appendChild(seat);
      });

      group.appendChild(seats);
      return group;
    };

    const leftGroup = buildGroup('left');
    const rightGroup = buildGroup('right');
    if (isSingleCenter) {
      leftGroup.classList.add('group-center');
      rowElement.appendChild(leftGroup);
    } else {
      rowElement.appendChild(leftGroup);
      rowElement.appendChild(rightGroup);
    }

    container.appendChild(rowElement);
  });
};

const renderPreviewArc = (container: HTMLDivElement, arcGroups: TimeModeData['arcGroups']): void => {
  if (!arcGroups) {
    return;
  }

  arcGroups.rows.forEach((row, rowIndex) => {
    const rowElement = document.createElement('div');
    rowElement.className = 'arc-row';

    const title = document.createElement('h3');
    title.className = 'two-row-title';
    title.textContent = rowIndex === 0 ? '前排' : '后排';
    rowElement.appendChild(title);

    const seats = document.createElement('div');
    seats.className = 'arc-seats';
    const maxLength = maxNameLength(row, 1);
    const fontSize = Math.min(16, Math.max(12, Math.floor(140 / maxLength)));

    for (let index = 0; index < row.length; index += 1) {
      const seat = document.createElement('div');
      seat.className = 'seat arc-seat';
      seat.appendChild(makeInput(row[index] || '', fontSize, true));
      seats.appendChild(seat);
    }

    rowElement.appendChild(seats);
    container.appendChild(rowElement);
  });
};
