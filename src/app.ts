import {
  addDays,
  dateKeyToMonthDay,
  formatTodayLabel,
  getChineseWeekday,
  getWeekNumber,
  monthDayToDateKey,
  parseDateFromClassTime
} from './calendar';
import { APP_NAME, APP_SLUG, BACKUP_FILE_PREFIX, readStorageValue, storageKeys, writeStorageValue } from './appMeta';
import {
  applyManualGrouping,
  collectStudentsFromArc,
  collectStudentsFromCircular,
  collectStudentsFromRows,
  convertStudentsToCircular,
  convertStudentsToRows,
  getCircularGroupCount,
  getCircularGroupCountFromGroups,
  getCircularSlotMap,
  getRowGroupCount,
  getRowsGroupCountFromGroups,
  getRowsSlotMap,
  layoutMaxStudents,
  normalizeStudentList,
  placeCentered,
  rotateCircularGroupOrderForWeek,
  rotateArcLayoutForWeek,
  rotateCircularLayoutForWeek,
  rotateRowsLayoutForWeek
} from './layouts';
import { recognizeClassFromImage, type OCRClassDraft } from './ocr';
import { getDefaultOCREndpoint, loadOCRSettings, saveOCRSettings } from './ocrSettings';
import { refreshSeating, renderModePreview } from './render';
import {
  createInitialState,
  makeClassShell,
  makeEmptyArcGroups,
  makeEmptyCircularGroups,
  makeEmptyLocationInfo,
  makeEmptyRowGroups
} from './state';
import {
  clearBatchUndoData,
  loadBatchUndoData,
  loadClassData,
  loadUserProfile,
  saveBatchUndoData,
  saveClassData,
  saveUserProfile
} from './storage';
import { cnfFetchRoster, cnfLoginAndListSquads, loadCnfCredentials, saveCnfCredentials } from './cnfSync';
import type { ArcGroups, ClassConfig, ClassData, ClassSnapshot, LayoutType, LocationInfo, OCRSettings, ThemeName, TimeMode } from './types';

interface OCRDraftView {
  id: string;
  fileName: string;
  source: string;
  errorMessage: string;
  className: string;
  layout: LayoutType;
  mode: TimeMode;
  overwrite: boolean;
  groupsText: string;
  detectedStudentCount: number;
  placedStudentCount: number;
  confidence: number;
  date: string;
  day: string;
  weekday: string;
  time: string;
  campus: string;
  floor: string;
  room: string;
  fullDate: string;
}

interface BackupPayload {
  app: {
    name: string;
    slug: string;
  };
  exportedAt: string;
  sourceOrigin: string;
  classData: ClassData;
  userProfile: {
    username: string;
    theme: string;
  };
  batchUndo: ClassData | null;
}

type ManualSeatRef =
  | { key: string; label: string; kind: 'circular'; groupIndex: number; seatIndex: number }
  | { key: string; label: string; kind: 'rows'; rowIndex: number; side: 'left' | 'right'; seatIndex: number }
  | { key: string; label: string; kind: 'arc'; rowIndex: number; seatIndex: number };

interface ManualTuneDraft {
  layout: LayoutType;
  groups: string[][];
  rowGroups: ReturnType<typeof makeEmptyRowGroups>;
  arcGroups: ArcGroups;
  groupCount: number;
  selectedSeatKey: string | null;
}

const state = createInitialState();
let ocrDrafts: OCRDraftView[] = [];
let ocrSettings: OCRSettings = loadOCRSettings();
let manualTuneDraft: ManualTuneDraft | null = null;
let isOcrRecognitionRunning = false;
let activeClassName = '';

const getLaunchClassName = (): string => {
  try {
    return new URLSearchParams(window.location.search).get('class')?.trim() || '';
  } catch {
    return '';
  }
};

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
};

const classSelect = (): HTMLSelectElement => byId<HTMLSelectElement>('classSelect');
const floatingClassSelect = (): HTMLSelectElement => byId<HTMLSelectElement>('floatingClassSelect');
const headerClassName = (): HTMLInputElement => byId<HTMLInputElement>('headerClassName');
const notes = (): HTMLDivElement => byId<HTMLDivElement>('notes');
const classroom = (): HTMLDivElement => byId<HTMLDivElement>('classroom');

const deepCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const showDialog = (id: string): void => {
  byId<HTMLDivElement>(id).style.display = 'block';
  byId<HTMLDivElement>('overlay').style.display = 'block';
};

const hideDialog = (id: string): void => {
  byId<HTMLDivElement>(id).style.display = 'none';
  byId<HTMLDivElement>('overlay').style.display = 'none';
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const saveProfile = (): void => {
  saveUserProfile(state.userProfile);
};

const persist = (): void => {
  saveClassData(state.classData);
};

const applyTheme = (theme: ThemeName): void => {
  document.body.classList.remove(
    'theme-paper',
    'theme-classic',
    'theme-mint',
    'theme-rose',
    'theme-apricot',
    'theme-golden',
    'theme-plum'
  );
  document.body.classList.add(`theme-${theme}`);
  byId<HTMLSelectElement>('themeSelect').value = theme;
};

const getClassTheme = (className: string): ThemeName => state.classData[className]?.theme || state.userProfile.theme || 'paper';

const syncEditorThemeSelect = (theme: ThemeName): void => {
  byId<HTMLSelectElement>('editorThemeSelect').value = theme;
};

const ensureUsername = (): void => {
  const currentName = state.userProfile.username.trim();
  if (currentName) {
    return;
  }

  const input = window.prompt('请输入用户名', 'Teacher');
  const username = input?.trim() || 'Teacher';
  state.userProfile.username = username;
  saveProfile();
};

const updateWelcome = (): void => {
  const week = getWeekNumber();
  byId<HTMLSpanElement>('homeWeekNum').textContent = String(week);
  byId<HTMLHeadingElement>('welcomeText').textContent = `${APP_NAME} · ${state.userProfile.username}`;
  byId<HTMLParagraphElement>('todayText').textContent = `今天是 ${formatTodayLabel()}，第${week}周，${getChineseWeekday()}`;
  byId<HTMLInputElement>('usernameInput').value = state.userProfile.username;
};

const setUsageGuideVisible = (visible: boolean): void => {
  byId<HTMLDivElement>('homeView')
    .querySelector<HTMLElement>('.usage-guide')
    ?.classList.toggle('hidden', !visible);
  byId<HTMLButtonElement>('usageGuideToggleBtn').textContent = visible ? '隐藏使用说明' : '查看使用说明';
  writeStorageValue(storageKeys.usageGuideDismissed, visible ? '0' : '1');
};

const initializeUsageGuide = (): void => {
  setUsageGuideVisible(readStorageValue(storageKeys.usageGuideDismissed) !== '1');
};

const toggleUsageGuide = (): void => {
  const guide = byId<HTMLDivElement>('homeView').querySelector<HTMLElement>('.usage-guide');
  setUsageGuideVisible(guide?.classList.contains('hidden') ?? false);
};

const countStudentsInMode = (mode: ClassConfig[TimeMode]): number => {
  if (mode.layout === 'circular') {
    return collectStudentsFromCircular(mode.groups || []).length;
  }
  if (mode.layout === 'rows') {
    return collectStudentsFromRows(mode.rowGroups || makeEmptyRowGroups()).length;
  }
  return collectStudentsFromArc(mode.arcGroups || makeEmptyArcGroups()).length;
};

const updateSyncModeButton = (): void => {
  const button = byId<HTMLButtonElement>('syncOtherModeBtn');
  const className = classSelect().value.trim();
  const targetMode: TimeMode = state.currentTimeMode === 'weekday' ? 'weekend' : 'weekday';
  const targetLabel = targetMode === 'weekday' ? '周中' : '周末';

  if (!className || !state.classData[className]) {
    button.textContent = `同步到${targetLabel}`;
    button.disabled = true;
    return;
  }

  const currentMode = state.classData[className][state.currentTimeMode];
  const currentCount = countStudentsInMode(currentMode);

  button.textContent = `同步到${targetLabel}`;
  button.disabled = currentCount === 0;
  button.title = currentCount === 0 ? '当前时段还没有可同步的名单。' : `将当前学生名单和座位顺序同步到${targetLabel}。`;
};

const layoutLabel = (layout: LayoutType): string => {
  if (layout === 'rows') return '三横排';
  if (layout === 'arc') return '两横排';
  return '圆桌';
};

const modeLabel = (mode: TimeMode): string => (mode === 'weekday' ? '周中' : '周末');

const syncClassPickerValues = (className: string): void => {
  classSelect().value = className;
  floatingClassSelect().value = className;
};

const updateEditorFloatingContext = (): void => {
  const floating = byId<HTMLDivElement>('editorFloatingContext');
  const meta = byId<HTMLSpanElement>('floatingClassMeta');
  const className = activeClassName.trim();

  floating.classList.toggle('hidden', state.currentView !== 'editor');
  if (state.currentView !== 'editor') {
    return;
  }

  syncClassPickerValues(className);
  meta.textContent = className
    ? `${modeLabel(state.currentTimeMode)} · ${layoutLabel(state.currentLayout)}`
    : '未选择班级';
};

const formatModeMeta = (mode: ClassConfig[TimeMode]): string => {
  const info = sanitizeLocationInfo(mode.locationInfo);
  const parts = [info.weekday, info.time, info.campus, info.room].filter(Boolean);
  return parts.join(' · ') || '未设置';
};

const renderClassOverview = (): void => {
  const container = byId<HTMLDivElement>('homeClassList');
  const classNames = Object.keys(state.classData).sort();

  if (classNames.length === 0) {
    container.innerHTML = '<div class="class-card empty">暂无班级，请点击“新建班级座位表”</div>';
    updateBatchUndoButton();
    updateSyncModeButton();
    return;
  }

  const cards = classNames
    .map((className) => {
      const config = state.classData[className];
      const weekdayCount = countStudentsInMode(config.weekday);
      const weekendCount = countStudentsInMode(config.weekend);
      return `
        <article class="class-card" data-open-class="${escapeHtml(className)}">
          <div class="class-card-header">
            <strong>${escapeHtml(className)}</strong>
            <span>${weekdayCount + weekendCount} 人次</span>
          </div>
          <div class="class-card-meta">
            <span class="mode-chip">周中</span>
            <span>${escapeHtml(layoutLabel(config.weekday.layout))}</span>
            <span>${weekdayCount} 人</span>
          </div>
          <div class="class-card-detail">${escapeHtml(formatModeMeta(config.weekday))}</div>
          <div class="class-card-meta">
            <span class="mode-chip weekend">周末</span>
            <span>${escapeHtml(layoutLabel(config.weekend.layout))}</span>
            <span>${weekendCount} 人</span>
          </div>
          <div class="class-card-detail">${escapeHtml(formatModeMeta(config.weekend))}</div>
          <button>进入编辑</button>
        </article>
      `;
    })
    .join('');

  container.innerHTML = cards;
  updateBatchUndoButton();
  updateSyncModeButton();
};

const applyLaunchClass = (): void => {
  const launchClass = getLaunchClassName();
  if (!launchClass) {
    return;
  }

  if (state.classData[launchClass]) {
    openClassInEditor(launchClass);
    return;
  }

  headerClassName().value = launchClass;
  const homeClassList = byId<HTMLDivElement>('homeClassList');
  const hint = document.createElement('div');
  hint.className = 'class-card empty';
  hint.textContent = `已从 Amber 打开班级 ${launchClass}，当前座位表里还没有这班的数据。可直接新建或导入。`;
  homeClassList.prepend(hint);
};

const updateBatchUndoButton = (): void => {
  const button = byId<HTMLButtonElement>('undoWeekBtn');
  button.disabled = !loadBatchUndoData();
};

const setCurrentView = (view: 'home' | 'editor'): void => {
  state.currentView = view;
  const home = byId<HTMLDivElement>('homeView');
  const editor = byId<HTMLDivElement>('editorView');

  if (view === 'home') {
    home.classList.remove('hidden');
    editor.classList.add('hidden');
    updateWelcome();
    renderClassOverview();
    updateEditorFloatingContext();
    return;
  }

  home.classList.add('hidden');
  editor.classList.remove('hidden');
  updateEditorFloatingContext();
};

const updateClassSelect = (): void => {
  const classNames = Object.keys(state.classData).sort();
  const populate = (select: HTMLSelectElement): void => {
    select.innerHTML = '<option value="">选择班级...</option>';
    classNames.forEach((className) => {
      const option = document.createElement('option');
      option.value = className;
      option.textContent = className;
      select.appendChild(option);
    });
  };

  populate(classSelect());
  populate(floatingClassSelect());
  updateEditorFloatingContext();
};

const sanitizeLocationInfo = (location: Partial<LocationInfo> | undefined): LocationInfo => {
  const merged: LocationInfo = {
    ...makeEmptyLocationInfo(),
    ...location
  };

  if (!merged.fullDate) {
    merged.fullDate = monthDayToDateKey(merged.date, merged.day) || '';
  }

  return merged;
};

const sanitizeModeData = (mode: ClassConfig[TimeMode]): ClassConfig[TimeMode] => {
  const locationInfo = sanitizeLocationInfo(mode.locationInfo || {});

  if (mode.layout === 'circular') {
    const base = makeEmptyCircularGroups();
    (mode.groups || []).slice(0, 6).forEach((group, idx) => {
      base[idx] = normalizeStudentList(group).slice(0, 6).concat(Array(6).fill('')).slice(0, 6);
    });
    const defaultOrder = [1, 2, 3, 4, 5, 6];
    const groupOrder = (mode.groupOrder || defaultOrder).slice(0, 6).concat(defaultOrder).slice(0, 6);

    return {
      layout: 'circular',
      groups: base,
      groupOrder,
      rowGroups: null,
      arcGroups: null,
      currentArrangement: mode.currentArrangement || 0,
      locationInfo
    };
  }

  if (mode.layout === 'rows') {
    const base = makeEmptyRowGroups();
    const rows = mode.rowGroups?.rows || [];
    for (let index = 0; index < 3; index += 1) {
      base.rows[index].left = normalizeStudentList(rows[index]?.left || []).slice(0, 6).concat(Array(6).fill('')).slice(0, 6);
      base.rows[index].right = normalizeStudentList(rows[index]?.right || []).slice(0, 6).concat(Array(6).fill('')).slice(0, 6);
    }

    return {
      layout: 'rows',
      groups: null,
      groupOrder: null,
      rowGroups: base,
      arcGroups: null,
      currentArrangement: mode.currentArrangement || 0,
      locationInfo
    };
  }

  const arc = makeEmptyArcGroups();
  const source = mode.arcGroups?.rows || ((mode.groups?.length === 2 && mode.groups[0].length === 18) ? (mode.groups as string[][]) : []);
  source.slice(0, 2).forEach((row, idx) => {
    arc.rows[idx] = normalizeStudentList(row).slice(0, 18).concat(Array(18).fill('')).slice(0, 18);
  });

  return {
    layout: 'arc',
    groups: null,
    groupOrder: null,
    rowGroups: null,
    arcGroups: arc,
    currentArrangement: mode.currentArrangement || 0,
    locationInfo
  };
};

const sanitizeClassSnapshot = (snapshot: Partial<ClassSnapshot> | undefined): ClassSnapshot => {
  const shell: ClassConfig = makeClassShell('circular', state.userProfile.theme);
  return {
    theme: snapshot?.theme || state.userProfile.theme || 'paper',
    weekday: sanitizeModeData(snapshot?.weekday || shell.weekday),
    weekend: sanitizeModeData(snapshot?.weekend || shell.weekend)
  };
};

const snapshotFromConfig = (config: ClassConfig): ClassSnapshot => ({
  theme: config.theme,
  weekday: deepCopy(config.weekday),
  weekend: deepCopy(config.weekend)
});

const sanitizeClassDataMap = (loaded: ClassData): ClassData => {
  const sanitized: Record<string, ClassConfig> = {};

  Object.entries(loaded).forEach(([className, config]) => {
    const shell: ClassConfig = makeClassShell('circular', state.userProfile.theme);
    const snapshot = sanitizeClassSnapshot(config);
    shell.theme = snapshot.theme;
    shell.weekday = snapshot.weekday;
    shell.weekend = snapshot.weekend;
    shell.previousWeek = config.previousWeek ? sanitizeClassSnapshot(config.previousWeek) : null;
    shell.cnf = config.cnf || null;
    sanitized[className] = shell;
  });

  return sanitized;
};

const sanitizeImportedTheme = (theme: string | undefined): ThemeName => {
  if (theme === 'classic'
    || theme === 'mint'
    || theme === 'rose'
    || theme === 'apricot'
    || theme === 'golden'
    || theme === 'plum'
    || theme === 'paper') {
    return theme;
  }
  return 'paper';
};

const buildBackupPayload = (): BackupPayload => ({
  app: {
    name: APP_NAME,
    slug: APP_SLUG
  },
  exportedAt: new Date().toISOString(),
  sourceOrigin: window.location.origin,
  classData: deepCopy(state.classData),
  userProfile: {
    username: state.userProfile.username,
    theme: state.userProfile.theme
  },
  batchUndo: deepCopy(loadBatchUndoData())
});

const exportDataBackup = (): void => {
  const payload = buildBackupPayload();
  const stamp = payload.exportedAt.slice(0, 19).replace(/[:T]/g, '-');
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${BACKUP_FILE_PREFIX}-${stamp}.json`;
  link.click();
  URL.revokeObjectURL(url);
};

const applyImportedBackup = (payload: Partial<BackupPayload>): void => {
  state.userProfile = {
    username: typeof payload.userProfile?.username === 'string' ? payload.userProfile.username.trim() : '',
    theme: sanitizeImportedTheme(payload.userProfile?.theme)
  };
  saveProfile();
  applyTheme(state.userProfile.theme);
  updateWelcome();

  state.classData = sanitizeClassDataMap(
    payload.classData && typeof payload.classData === 'object'
      ? payload.classData as ClassData
      : {}
  );
  persist();

  if (payload.batchUndo && typeof payload.batchUndo === 'object') {
    saveBatchUndoData(sanitizeClassDataMap(payload.batchUndo as ClassData));
  } else {
    clearBatchUndoData();
  }

  activeClassName = '';
  syncClassPickerValues('');
  updateClassSelect();
  renderClassOverview();
  setCurrentView('home');
};

const importBackupFile = async (event: Event): Promise<void> => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    return;
  }

  try {
    const payload = JSON.parse(await file.text()) as Partial<BackupPayload>;
    applyImportedBackup(payload);
    window.alert('备份导入成功，当前页面已切回主页。');
  } catch {
    window.alert('备份文件读取失败，请确认选择的是导出的 JSON 备份。');
  } finally {
    input.value = '';
  }
};

const triggerImportBackup = (): void => {
  byId<HTMLInputElement>('backupImportInput').click();
};

const loadSavedData = (): void => {
  const loaded = loadClassData();

  state.classData = sanitizeClassDataMap(loaded);
  activeClassName = '';
  updateClassSelect();
};

const getLocationInfo = (): LocationInfo => {
  const date = byId<HTMLInputElement>('date').value.trim();
  const day = byId<HTMLInputElement>('day').value.trim();
  const cachedFullDate = byId<HTMLInputElement>('date').dataset.fullDate || '';
  const fullDate = monthDayToDateKey(date, day) || cachedFullDate;

  return {
    date,
    day,
    weekday: byId<HTMLSelectElement>('weekday').value,
    time: byId<HTMLInputElement>('time').value,
    campus: byId<HTMLSelectElement>('campus').value,
    floor: byId<HTMLInputElement>('floor').value,
    room: byId<HTMLInputElement>('room').value,
    notes: notes().innerHTML,
    fullDate
  };
};

const setLocationInfo = (info: Partial<LocationInfo> | undefined): void => {
  const merged = sanitizeLocationInfo(info);
  byId<HTMLInputElement>('date').value = merged.date;
  byId<HTMLInputElement>('date').dataset.fullDate = merged.fullDate;
  byId<HTMLInputElement>('day').value = merged.day;
  byId<HTMLSelectElement>('weekday').value = merged.weekday;
  byId<HTMLInputElement>('time').value = merged.time;
  byId<HTMLSelectElement>('campus').value = merged.campus;
  byId<HTMLInputElement>('floor').value = merged.floor;
  byId<HTMLInputElement>('room').value = merged.room;
  notes().innerHTML = merged.notes;
};

const captureCurrentModeData = (): ClassConfig[TimeMode] => ({
  layout: state.currentLayout,
  groups: state.currentLayout === 'circular' ? JSON.parse(JSON.stringify(state.groups)) : null,
  groupOrder: state.currentLayout === 'circular' ? [...state.currentGroupOrder] : null,
  rowGroups: state.currentLayout === 'rows' ? JSON.parse(JSON.stringify(state.rowGroups)) : null,
  arcGroups: state.currentLayout === 'arc' ? JSON.parse(JSON.stringify(state.arcGroups)) : null,
  currentArrangement: state.currentArrangement,
  locationInfo: getLocationInfo()
});

const ensureClassShell = (className: string): void => {
  if (!state.classData[className]) {
    state.classData[className] = makeClassShell(state.currentLayout, state.userProfile.theme);
  }
};

const saveCurrentClassMode = (): void => {
  const className = activeClassName.trim();
  if (!className) {
    return;
  }

  ensureClassShell(className);
  state.classData[className][state.currentTimeMode] = captureCurrentModeData();
  state.classData[className].theme = getClassTheme(className);
  persist();
};

const resetLayoutData = (): void => {
  state.groups = makeEmptyCircularGroups();
  state.currentGroupOrder = [1, 2, 3, 4, 5, 6];
  state.rowGroups = makeEmptyRowGroups();
  state.arcGroups = makeEmptyArcGroups();
};

const setLayoutClass = (layout: LayoutType): void => {
  const target = classroom();
  target.className = 'classroom';
  if (layout === 'rows') {
    target.classList.add('three-rows-layout');
  } else if (layout === 'arc') {
    target.classList.add('arc-layout');
  }
};

const refresh = (): void => {
  refreshSeating(state, {
    handleSeatChange: (groupIndex, seatIndex, value) => {
      if (state.isEditMode) {
        state.groups[groupIndex][seatIndex] = value;
      }
    },
    handleRowSeatChange: (rowIndex, side, seatIndex, value) => {
      if (state.isEditMode) {
        state.rowGroups.rows[rowIndex][side][seatIndex] = value;
      }
    },
    handleArcSeatChange: (rowIndex, seatIndex, value) => {
      if (state.isEditMode) {
        state.arcGroups.rows[rowIndex][seatIndex] = value;
      }
    }
  });
};

const loadClass = (): void => {
  const className = classSelect().value;
  const data = state.classData[className]?.[state.currentTimeMode];

  if (!className || !data) {
    activeClassName = className || '';
    state.currentLayout = 'circular';
    resetLayoutData();
    state.currentArrangement = 0;
    setLocationInfo(makeEmptyLocationInfo());
    headerClassName().value = className || '';
    syncEditorThemeSelect(state.userProfile.theme);
    applyTheme(state.userProfile.theme);
    setLayoutClass(state.currentLayout);
    refresh();
    updateSyncModeButton();
    updateEditorFloatingContext();
    return;
  }

  activeClassName = className;
  state.currentLayout = data.layout || 'circular';
  state.currentArrangement = data.currentArrangement || 0;

  if (state.currentLayout === 'circular') {
    state.groups = JSON.parse(JSON.stringify(data.groups || makeEmptyCircularGroups()));
    state.currentGroupOrder = [...(data.groupOrder || [1, 2, 3, 4, 5, 6])];
    state.rowGroups = makeEmptyRowGroups();
    state.arcGroups = makeEmptyArcGroups();
  } else if (state.currentLayout === 'rows') {
    state.rowGroups = JSON.parse(JSON.stringify(data.rowGroups || makeEmptyRowGroups()));
    state.groups = makeEmptyCircularGroups();
    state.currentGroupOrder = [1, 2, 3, 4, 5, 6];
    state.arcGroups = makeEmptyArcGroups();
  } else {
    state.arcGroups = JSON.parse(JSON.stringify(data.arcGroups || makeEmptyArcGroups()));
    state.groups = makeEmptyCircularGroups();
    state.currentGroupOrder = [1, 2, 3, 4, 5, 6];
    state.rowGroups = makeEmptyRowGroups();
  }

  setLocationInfo(data.locationInfo);
  headerClassName().value = className;
  const classTheme = getClassTheme(className);
  syncEditorThemeSelect(classTheme);
  applyTheme(classTheme);
  setLayoutClass(state.currentLayout);
  refresh();
  updateSyncModeButton();
  updateEditorFloatingContext();
};

const applyTimeModeUi = (mode: TimeMode): void => {
  state.currentTimeMode = mode;
  byId<HTMLButtonElement>('weekdayBtn').className = 'active';
  byId<HTMLButtonElement>('weekendBtn').className = '';
  if (mode === 'weekend') {
    byId<HTMLButtonElement>('weekdayBtn').className = '';
    byId<HTMLButtonElement>('weekendBtn').className = 'active';
  }
  updateEditorFloatingContext();
};

const hasOpenEditorDialog = (): boolean =>
  Array.from(document.querySelectorAll<HTMLElement>('.dialog')).some((dialog) => dialog.style.display === 'block');

const closeEditorTransientUi = (): void => {
  document.querySelectorAll<HTMLElement>('.dialog').forEach((dialog) => {
    dialog.style.display = 'none';
  });
  byId<HTMLDivElement>('overlay').style.display = 'none';
  manualTuneDraft = null;
};

const switchEditorClass = (nextClassName: string, options?: { resetMode?: boolean; preserveDialogs?: boolean }): void => {
  const targetClassName = nextClassName.trim();
  const currentClassName = activeClassName.trim();

  if (!targetClassName) {
    syncClassPickerValues(currentClassName);
    return;
  }

  if (targetClassName === currentClassName && state.currentView === 'editor') {
    syncClassPickerValues(targetClassName);
    updateEditorFloatingContext();
    return;
  }

  if (isOcrRecognitionRunning) {
    window.alert('图片识别进行中，请等待当前识别完成后再切换班级。');
    syncClassPickerValues(currentClassName);
    return;
  }

  if (!options?.preserveDialogs && hasOpenEditorDialog()) {
    const shouldContinue = window.confirm('当前有功能弹窗处于打开状态。切换班级会先关闭弹窗，并放弃这些弹窗里未确认的临时修改，是否继续？');
    if (!shouldContinue) {
      syncClassPickerValues(currentClassName);
      return;
    }
    closeEditorTransientUi();
  }

  if (state.currentView === 'editor' && currentClassName) {
    saveCurrentClassMode();
  }

  if (options?.resetMode) {
    applyTimeModeUi('weekday');
  }

  syncClassPickerValues(targetClassName);
  loadClass();
  setCurrentView('editor');
};

const openClassInEditor = (className: string): void => {
  switchEditorClass(className, { resetMode: true, preserveDialogs: true });
};

const goHome = (): void => {
  saveCurrentClassMode();
  applyTheme(state.userProfile.theme);
  setCurrentView('home');
};

const toggleTime = (mode: TimeMode): void => {
  saveCurrentClassMode();
  applyTimeModeUi(mode);
  loadClass();
};

const copyCurrentToOtherMode = (): void => {
  const className = classSelect().value.trim();
  if (!className) {
    alert('请先选择班级。');
    return;
  }

  ensureClassShell(className);
  saveCurrentClassMode();

  const targetMode: TimeMode = state.currentTimeMode === 'weekday' ? 'weekend' : 'weekday';
  const targetLabel = targetMode === 'weekday' ? '周中' : '周末';
  const currentModeData = state.classData[className][state.currentTimeMode];
  const targetModeData = state.classData[className][targetMode];

  if (countStudentsInMode(currentModeData) === 0) {
    alert('当前时段还没有可复制的名单。');
    return;
  }

  const shouldSync = window.confirm(`是否同步所有学生及座位顺序到${targetLabel}？\n\n这会覆盖${targetLabel}当前的座位布局与学生顺序，但保留${targetLabel}原本的日期、时间、校区和备注信息。`);
  if (!shouldSync) {
    return;
  }

  state.classData[className][targetMode] = {
    layout: currentModeData.layout,
    groups: currentModeData.layout === 'circular' ? deepCopy(currentModeData.groups) : null,
    groupOrder: currentModeData.layout === 'circular' ? [...(currentModeData.groupOrder || [1, 2, 3, 4, 5, 6])] : null,
    rowGroups: currentModeData.layout === 'rows' ? deepCopy(currentModeData.rowGroups) : null,
    arcGroups: currentModeData.layout === 'arc' ? deepCopy(currentModeData.arcGroups) : null,
    currentArrangement: currentModeData.currentArrangement,
    locationInfo: deepCopy(targetModeData.locationInfo || makeEmptyLocationInfo())
  };

  persist();
  updateSyncModeButton();
  alert(`已把当前学生名单和座位顺序同步到${targetLabel}。`);
};

const showSaveDialog = (): void => {
  byId<HTMLInputElement>('saveClassName').value = headerClassName().value;
  showDialog('saveDialog');
};

const hideSaveDialog = (): void => {
  hideDialog('saveDialog');
};

const saveClass = (): void => {
  const className = byId<HTMLInputElement>('saveClassName').value.trim();
  if (!className) {
    alert('请输入班级名称');
    return;
  }

  ensureClassShell(className);
  state.classData[className][state.currentTimeMode] = captureCurrentModeData();

  persist();
  updateClassSelect();
  syncClassPickerValues(className);
  activeClassName = className;
  headerClassName().value = className;
  hideSaveDialog();
  renderClassOverview();
  updateEditorFloatingContext();
};

const deleteCurrentClass = (): void => {
  const className = classSelect().value;
  if (!className) {
    return;
  }

  if (!confirm(`确定要删除 ${className} 的所有配置吗？`)) {
    return;
  }

  delete state.classData[className];
  persist();
  updateClassSelect();
  renderClassOverview();

  headerClassName().value = '';
  activeClassName = '';
  syncClassPickerValues('');
  state.currentLayout = 'circular';
  resetLayoutData();
  state.currentArrangement = 0;
  syncEditorThemeSelect(state.userProfile.theme);
  applyTheme(state.userProfile.theme);
  setLocationInfo(makeEmptyLocationInfo());
  refresh();
  updateEditorFloatingContext();
};

const renameCurrentClass = (): void => {
  const oldName = classSelect().value.trim();
  if (!oldName) {
    alert('请先选择班级。');
    return;
  }

  saveCurrentClassMode();
  const input = window.prompt('输入新的班号', oldName);
  const newName = input?.trim();
  if (!newName || newName === oldName) {
    return;
  }

  if (state.classData[newName]) {
    alert('这个班号已经存在了，请换一个名称。');
    return;
  }

  state.classData[newName] = state.classData[oldName];
  delete state.classData[oldName];
  persist();
  updateClassSelect();
  renderClassOverview();
  syncClassPickerValues(newName);
  activeClassName = newName;
  headerClassName().value = newName;
  loadClass();
};

const syncDateField = (): void => {
  const info = getLocationInfo();
  byId<HTMLInputElement>('date').dataset.fullDate = info.fullDate;
};

const showImportDialog = (): void => {
  byId<HTMLTextAreaElement>('studentNames').value = '';
  byId<HTMLDivElement>('errorMsg').textContent = '';
  byId<HTMLDivElement>('errorMsg').className = '';
  showDialog('importDialog');
};

const hideImportDialog = (): void => {
  hideDialog('importDialog');
};

const showError = (message: string): void => {
  const errorMsg = byId<HTMLDivElement>('errorMsg');
  errorMsg.textContent = message;
  errorMsg.className = 'error';
};

const showSuccess = (message: string): void => {
  const errorMsg = byId<HTMLDivElement>('errorMsg');
  errorMsg.textContent = message;
  errorMsg.className = 'success';
  setTimeout(() => {
    errorMsg.textContent = '';
    errorMsg.className = '';
  }, 2500);
};

const ensureClassForImportSave = (): string | null => {
  const selected = classSelect().value.trim();
  if (selected) {
    activeClassName = selected;
    return selected;
  }

  const proposed = headerClassName().value.trim() || `Class${Object.keys(state.classData).length + 1}`;
  const input = window.prompt('请输入班级名称以保存导入结果', proposed);
  const className = input?.trim();
  if (!className) {
    return null;
  }

  ensureClassShell(className);
  updateClassSelect();
  syncClassPickerValues(className);
  activeClassName = className;
  headerClassName().value = className;
  return className;
};

const saveAndRefresh = (message: string): void => {
  if (state.currentView === 'home') {
    setCurrentView('editor');
  }

  refresh();
  hideImportDialog();

  const className = ensureClassForImportSave();
  if (!className) {
    alert('已导入到当前画布，但你取消了保存，数据不会持久化。');
    return;
  }

  saveCurrentClassMode();
  showSuccess(message);
};

const importCircularLayout = (students: string[]): void => {
  const normalized = normalizeStudentList(students);
  if (normalized.length === 0) {
    showError('请至少输入1名学生');
    return;
  }
  if (normalized.length > 36) {
    showError(`圆桌布局最多36人，当前${normalized.length}人`);
    return;
  }

  state.currentLayout = 'circular';
  state.groups = convertStudentsToCircular(normalized);
  state.currentGroupOrder = [1, 2, 3, 4, 5, 6];
  state.rowGroups = makeEmptyRowGroups();
  state.arcGroups = makeEmptyArcGroups();
  state.currentArrangement = 0;
  setLayoutClass('circular');

  const groupCount = getCircularGroupCount(normalized.length);
  saveAndRefresh(`成功导入${normalized.length}人，分为${groupCount}组`);
};

const importRowsLayout = (students: string[]): void => {
  const normalized = normalizeStudentList(students);
  if (normalized.length === 0) {
    showError('请至少输入1名学生');
    return;
  }
  if (normalized.length > 36) {
    showError(`三横排布局最多36人，当前${normalized.length}人`);
    return;
  }

  state.currentLayout = 'rows';
  state.rowGroups = convertStudentsToRows(normalized);
  state.groups = makeEmptyCircularGroups();
  state.currentGroupOrder = [1, 2, 3, 4, 5, 6];
  state.arcGroups = makeEmptyArcGroups();
  state.currentArrangement = 0;
  setLayoutClass('rows');

  const groupCount = getRowGroupCount(normalized.length);
  saveAndRefresh(`成功导入${normalized.length}人，分为${groupCount}组`);
};

const importArcLayout = (input: string): void => {
  const lines = input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let first: string[] = [];
  let second: string[] = [];

  const splitNames = (text: string): string[] =>
    text
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean);

  const firstLine = lines[0] || '';
  const secondLine = lines[1] || '';

  if (firstLine.startsWith('第一排')) {
    first = splitNames(firstLine.substring(firstLine.indexOf(':') + 1));
  } else if (firstLine) {
    first = splitNames(firstLine);
  }

  if (secondLine.startsWith('第二排')) {
    second = splitNames(secondLine.substring(secondLine.indexOf(':') + 1));
  } else if (secondLine) {
    second = splitNames(secondLine);
  }

  const total = first.length + second.length;
  if (total === 0) {
    showError('请至少输入1名学生');
    return;
  }
  if (total > 36) {
    showError(`两横排布局最多36人，当前${total}人`);
    return;
  }

  state.currentLayout = 'arc';
  state.groups = makeEmptyCircularGroups();
  state.currentGroupOrder = [1, 2, 3, 4, 5, 6];
  state.rowGroups = makeEmptyRowGroups();
  state.arcGroups = makeEmptyArcGroups();
  placeCentered(state.arcGroups.rows[0], first);
  placeCentered(state.arcGroups.rows[1], second);
  state.currentArrangement = 0;
  setLayoutClass('arc');

  saveAndRefresh(`成功导入两横排布局，共${total}人`);
};

const importStudents = (): void => {
  const input = byId<HTMLTextAreaElement>('studentNames').value;
  const students = input
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean);

  if (byId<HTMLInputElement>('circularLayout').checked) {
    importCircularLayout(students);
    return;
  }

  if (byId<HTMLInputElement>('rowsLayout').checked) {
    importRowsLayout(students);
    return;
  }

  importArcLayout(input);
};

const rotateLocationByWeek = (info: LocationInfo): LocationInfo => {
  const next = { ...info };
  const currentKey = next.fullDate || monthDayToDateKey(next.date, next.day) || parseDateFromClassTime(next.time) || '';

  if (!currentKey) {
    return next;
  }

  const nextKey = addDays(currentKey, 7);
  if (!nextKey) {
    return next;
  }

  const converted = dateKeyToMonthDay(nextKey);
  next.fullDate = nextKey;
  if (converted) {
    next.date = converted.month;
    next.day = converted.day;
    if (!next.weekday) {
      next.weekday = converted.weekday;
    }
  }

  return next;
};

const rotateSingleClassMode = (mode: ClassConfig[TimeMode], rotateDate: boolean): ClassConfig[TimeMode] => {
  const nextLocationInfo = rotateDate
    ? rotateLocationByWeek(sanitizeLocationInfo(mode.locationInfo))
    : sanitizeLocationInfo(mode.locationInfo);

  if (mode.layout === 'circular') {
    const activeCount = getCircularGroupCountFromGroups(mode.groups || makeEmptyCircularGroups());
    return {
      ...mode,
      groups: rotateCircularLayoutForWeek(mode.groups || makeEmptyCircularGroups()),
      groupOrder: rotateCircularGroupOrderForWeek(mode.groupOrder || [1, 2, 3, 4, 5, 6], activeCount),
      currentArrangement: (mode.currentArrangement + 1) % 200,
      locationInfo: nextLocationInfo
    };
  }

  if (mode.layout === 'rows') {
    return {
      ...mode,
      rowGroups: rotateRowsLayoutForWeek(mode.rowGroups || makeEmptyRowGroups()),
      groupOrder: null,
      currentArrangement: (mode.currentArrangement + 1) % 200,
      locationInfo: nextLocationInfo
    };
  }

  return {
    ...mode,
    arcGroups: rotateArcLayoutForWeek(mode.arcGroups || makeEmptyArcGroups()),
    groupOrder: null,
    currentArrangement: (mode.currentArrangement + 1) % 200,
    locationInfo: nextLocationInfo
  };
};

const generateSeating = (): void => {
  if (state.isEditMode) {
    refresh();
    return;
  }

  if (state.currentLayout === 'circular') {
    const activeCount = getCircularGroupCountFromGroups(state.groups);
    state.groups = rotateCircularLayoutForWeek(state.groups);
    state.currentGroupOrder = rotateCircularGroupOrderForWeek(state.currentGroupOrder, activeCount);
  } else if (state.currentLayout === 'rows') {
    state.rowGroups = rotateRowsLayoutForWeek(state.rowGroups);
  } else {
    state.arcGroups = rotateArcLayoutForWeek(state.arcGroups);
  }

  state.currentArrangement = (state.currentArrangement + 1) % 200;
  refresh();
  saveCurrentClassMode();
};

const generateWeeklySeating = (): void => {
  saveBatchUndoData(deepCopy(state.classData));
  Object.keys(state.classData).forEach((className) => {
    const current = state.classData[className];
    state.classData[className] = {
      theme: current.theme,
      previousWeek: snapshotFromConfig(current),
      weekday: rotateSingleClassMode(current.weekday, true),
      weekend: rotateSingleClassMode(current.weekend, true),
      cnf: current.cnf || null
    };
  });

  persist();
  updateWelcome();
  renderClassOverview();

  if (state.currentView === 'editor' && classSelect().value) {
    loadClass();
  }

  alert('已生成新一周座位表，所有班级已完成轮转并保存。');
};

const undoWeeklySeating = (): void => {
  const snapshot = loadBatchUndoData();
  if (!snapshot) {
    alert('当前没有可撤回的周轮转记录。');
    return;
  }

  state.classData = sanitizeClassDataMap(snapshot);
  clearBatchUndoData();
  persist();
  updateClassSelect();
  renderClassOverview();

  if (state.currentView === 'editor' && classSelect().value) {
    loadClass();
  }

  alert('已撤回上次主页周轮转。');
};

const currentStudentList = (): string[] => {
  if (state.currentLayout === 'circular') {
    return collectStudentsFromCircular(state.groups);
  }
  if (state.currentLayout === 'rows') {
    return collectStudentsFromRows(state.rowGroups);
  }
  return collectStudentsFromArc(state.arcGroups);
};

const sortStudentNames = (students: string[]): string[] =>
  [...normalizeStudentList(students)].sort((left, right) =>
    left.localeCompare(right, 'en', { sensitivity: 'base', numeric: true })
  );

const showPreviousWeekDialog = (): void => {
  const className = classSelect().value.trim();
  if (!className) {
    alert('请先选择班级。');
    return;
  }

  const previousWeek = state.classData[className]?.previousWeek;
  if (!previousWeek) {
    alert('这个班级还没有上一周记录。');
    return;
  }

  const modeLabel = state.currentTimeMode === 'weekday' ? '周中' : '周末';
  const previewContainer = byId<HTMLDivElement>('previousWeekPreview');
  const summary = byId<HTMLParagraphElement>('previousWeekSummary');
  previewContainer.className = `previous-week-preview ${previousWeek[state.currentTimeMode].layout === 'rows' ? 'three-rows-layout' : previousWeek[state.currentTimeMode].layout === 'arc' ? 'arc-layout' : 'classroom'}`;
  summary.textContent = `${className} · ${modeLabel} · 预览上一周座位。恢复后会把当前版本保留为新的“上周”记录。`;
  renderModePreview(previewContainer, previousWeek[state.currentTimeMode]);
  showDialog('previousWeekDialog');
};

const hidePreviousWeekDialog = (): void => {
  hideDialog('previousWeekDialog');
};

const restorePreviousWeek = (): void => {
  const className = classSelect().value.trim();
  if (!className) {
    return;
  }

  const current = state.classData[className];
  const previousWeek = current?.previousWeek;
  if (!current || !previousWeek) {
    alert('没有可恢复的上一周记录。');
    return;
  }

  const currentSnapshot = snapshotFromConfig(current);
  state.classData[className] = {
    ...sanitizeClassSnapshot(previousWeek),
    previousWeek: currentSnapshot,
    cnf: current.cnf || null
  };
  persist();
  loadClass();
  renderClassOverview();
  hidePreviousWeekDialog();
  alert('已恢复为上周版本。');
};

const showRosterDialog = (): void => {
  const className = classSelect().value.trim();
  if (!className) {
    alert('请先选择班级。');
    return;
  }

  const students = sortStudentNames(currentStudentList());
  const summary = byId<HTMLParagraphElement>('rosterSummary');
  const rosterList = byId<HTMLDivElement>('rosterList');
  const modeLabel = state.currentTimeMode === 'weekday' ? '周中' : '周末';

  summary.textContent = `${className} · ${modeLabel} · 当前总人数 ${students.length} 人`;
  rosterList.innerHTML = students.length
    ? students.map((student, index) => `<div class="roster-item"><span>${index + 1}.</span><strong>${escapeHtml(student)}</strong><button type="button" class="roster-delete-btn" data-delete-student="${escapeHtml(student)}" title="删除该学生">&times;</button></div>`).join('')
    : '<div class="muted">当前没有学生名单。</div>';
  showDialog('rosterDialog');
};

const removeStudentFromSeats = (name: string): void => {
  const className = classSelect().value.trim();
  if (!className || !state.classData[className]) {
    return;
  }
  const mode = state.classData[className][state.currentTimeMode];
  if (!mode) {
    return;
  }

  if (mode.groups) {
    for (const group of mode.groups) {
      for (let i = 0; i < group.length; i++) {
        if (group[i] === name) {
          group[i] = '';
        }
      }
    }
    state.groups = deepCopy(mode.groups);
  }
  if (mode.rowGroups) {
    for (const row of mode.rowGroups.rows) {
      for (let i = 0; i < row.left.length; i++) {
        if (row.left[i] === name) {
          row.left[i] = '';
        }
      }
      for (let i = 0; i < row.right.length; i++) {
        if (row.right[i] === name) {
          row.right[i] = '';
        }
      }
    }
    state.rowGroups = deepCopy(mode.rowGroups);
  }
  if (mode.arcGroups) {
    for (const row of mode.arcGroups.rows) {
      for (let i = 0; i < row.length; i++) {
        if (row[i] === name) {
          row[i] = '';
        }
      }
    }
    state.arcGroups = deepCopy(mode.arcGroups);
  }
  persist();
  renderClassOverview();
  showRosterDialog();
};

const hideRosterDialog = (): void => {
  hideDialog('rosterDialog');
};

const toggleEditMode = (): void => {
  state.isEditMode = !state.isEditMode;
  const button = document.querySelector<HTMLButtonElement>('.edit-mode button');
  if (button) {
    button.textContent = state.isEditMode ? '退出编辑' : '编辑模式';
    button.style.background = state.isEditMode ? '#f44336' : '#2196F3';
  }
  refresh();
};

const toggleLayout = (): void => {
  const currentStudents =
    state.currentLayout === 'circular'
      ? collectStudentsFromCircular(state.groups)
      : state.currentLayout === 'rows'
        ? collectStudentsFromRows(state.rowGroups)
        : collectStudentsFromArc(state.arcGroups);

  const nextLayout: LayoutType =
    state.currentLayout === 'circular'
      ? 'rows'
      : state.currentLayout === 'rows'
        ? 'arc'
        : 'circular';

  if (currentStudents.length > layoutMaxStudents(nextLayout)) {
    alert(`当前人数超出${nextLayout}布局上限`);
    return;
  }

  state.currentLayout = nextLayout;
  state.currentArrangement = 0;

  if (nextLayout === 'circular') {
    state.groups = convertStudentsToCircular(currentStudents);
    state.currentGroupOrder = [1, 2, 3, 4, 5, 6];
    state.rowGroups = makeEmptyRowGroups();
    state.arcGroups = makeEmptyArcGroups();
  } else if (nextLayout === 'rows') {
    state.rowGroups = convertStudentsToRows(currentStudents);
    state.groups = makeEmptyCircularGroups();
    state.currentGroupOrder = [1, 2, 3, 4, 5, 6];
    state.arcGroups = makeEmptyArcGroups();
  } else {
    const splitIndex = Math.ceil(currentStudents.length / 2);
    state.arcGroups = makeEmptyArcGroups();
    placeCentered(state.arcGroups.rows[0], currentStudents.slice(0, splitIndex));
    placeCentered(state.arcGroups.rows[1], currentStudents.slice(splitIndex, splitIndex + 18));
    state.groups = makeEmptyCircularGroups();
    state.currentGroupOrder = [1, 2, 3, 4, 5, 6];
    state.rowGroups = makeEmptyRowGroups();
  }

  setLayoutClass(nextLayout);
  refresh();
  saveCurrentClassMode();
  updateEditorFloatingContext();
};

const updateLayoutDescription = (): void => {
  const layoutDesc = byId<HTMLDivElement>('layoutDescription');
  if (byId<HTMLInputElement>('circularLayout').checked) {
    layoutDesc.innerHTML = `
      <ul style="font-size: 14px; color: #666; margin: 10px 0;">
        <li>圆桌：31-36人=6组，25-30人=5组，19-24人=4组，1-18人=3组</li>
        <li>每组最多6人，自动跳过空组轮转</li>
      </ul>
    `;
    return;
  }

  if (byId<HTMLInputElement>('rowsLayout').checked) {
    layoutDesc.innerHTML = `
      <ul style="font-size: 14px; color: #666; margin: 10px 0;">
        <li>三横排：31-36人=6组，25-30人=5组，1-24人=4组</li>
        <li>轮转按组号+2，跳过空组</li>
      </ul>
    `;
    return;
  }

  layoutDesc.innerHTML = `
    <ul style="font-size: 14px; color: #666; margin: 10px 0;">
      <li>两横排布局：前排与后排，每排最多18人</li>
      <li>支持按“第一排 / 第二排”直接导入</li>
    </ul>
  `;
};

const showCreateClassDialog = (): void => {
  showDialog('createClassDialog');
};

const hideCreateClassDialog = (): void => {
  hideDialog('createClassDialog');
};

const groupsToText = (layout: LayoutType, groups: string[][]): string => {
  if (layout === 'arc') {
    const first = groups[0]?.filter(Boolean).join(', ') || '';
    const second = groups[1]?.filter(Boolean).join(', ') || '';
    return `第一排: ${first}\n第二排: ${second}`;
  }

  const lines: string[] = [];
  groups.forEach((group, index) => {
    const normalized = [...group, ...Array(Math.max(0, 6 - group.length)).fill('')].slice(0, 6);
    if (normalized.some(Boolean)) {
      const firstRow = normalized.slice(0, 2).map((name) => name || '_').join(', ');
      const secondRow = normalized.slice(2, 4).map((name) => name || '_').join(', ');
      const thirdRow = normalized.slice(4, 6).map((name) => name || '_').join(', ');
      lines.push(`Group ${index + 1}: ${firstRow} | ${secondRow} | ${thirdRow}`);
    }
  });
  return lines.join('\n');
};

const parseGroupsText = (layout: LayoutType, text: string): string[][] => {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (layout === 'arc') {
    const rows = [Array(18).fill(''), Array(18).fill('')] as ArcGroups['rows'];
    const parseLine = (line: string): string[] =>
      line
        .split(/[,，]/)
        .map((name) => name.trim())
        .filter(Boolean)
        .slice(0, 18);

    let first: string[] = [];
    let second: string[] = [];
    if (lines[0]?.startsWith('第一排')) {
      first = parseLine(lines[0].substring(lines[0].indexOf(':') + 1));
      second = parseLine((lines[1] || '').substring((lines[1] || '').indexOf(':') + 1));
    } else {
      first = parseLine(lines[0] || '');
      second = parseLine(lines[1] || '');
    }

    placeCentered(rows[0], first);
    placeCentered(rows[1], second);
    return rows;
  }

  const groups = Array.from({ length: 6 }, () => [] as string[]);
  lines.forEach((line, lineIndex) => {
    const match = line.match(/Group\s*(\d+)\s*:/i);
    if (match) {
      const groupIndex = Math.max(0, Math.min(5, Number.parseInt(match[1], 10) - 1));
      const body = line.substring(line.indexOf(':') + 1).trim();
      if (body.includes('|')) {
        const seats = body
          .split('|')
          .flatMap((row) =>
            row
              .split(/[,，]/)
              .map((name) => name.trim())
              .map((name) => (name === '_' ? '' : name))
          )
          .slice(0, 6);
        groups[groupIndex] = [...seats, ...Array(Math.max(0, 6 - seats.length)).fill('')].slice(0, 6);
        return;
      }

      groups[groupIndex] = line
        .substring(line.indexOf(':') + 1)
        .split(/[,，]/)
        .map((name) => name.trim())
        .filter(Boolean)
        .slice(0, 6);
      return;
    }

    if (lineIndex < 6) {
      groups[lineIndex] = line
        .split(/[,，]/)
        .map((name) => name.trim())
        .filter(Boolean)
        .slice(0, 6);
    }
  });

  return groups;
};

const toDraft = (result: OCRClassDraft): OCRDraftView => {
  const draftClassName = result.className || result.fileName.replace(/\.[^.]+$/, '').slice(0, 12);

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    fileName: result.fileName,
    source: result.source || 'unknown',
    errorMessage: '',
    className: draftClassName,
    layout: result.layout,
    mode: 'weekday',
    overwrite: true,
    groupsText: groupsToText(result.layout, result.groups),
    detectedStudentCount: result.detectedStudentCount,
    placedStudentCount: result.placedStudentCount,
    confidence: result.confidence,
    date: result.info.date,
    day: result.info.day,
    weekday: result.info.weekday,
    time: result.info.time,
    campus: result.info.campus,
    floor: result.info.floor,
    room: result.info.room,
    fullDate: result.info.fullDate
  };
};

const renderOcrReview = (): void => {
  const container = byId<HTMLDivElement>('ocrReviewList');
  if (ocrDrafts.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = ocrDrafts
    .map((draft) => {
      const mismatch = Math.abs(draft.detectedStudentCount - draft.placedStudentCount);
      const warning =
        mismatch > 0
          ? `<div class="error">识别人数(${draft.detectedStudentCount}) 与落座人数(${draft.placedStudentCount}) 不一致，请核对。</div>`
          : `<div class="success">识别人数与落座人数一致：${draft.placedStudentCount}</div>`;
      const errorLine = draft.errorMessage
        ? `<div class="error">失败原因：${escapeHtml(draft.errorMessage)}</div>`
        : '';

      return `
        <div class="ocr-card" data-id="${escapeHtml(draft.id)}">
          <h3>${escapeHtml(draft.fileName)}</h3>
          <div class="ocr-source">识别来源：${escapeHtml(draft.source)}</div>
          ${errorLine}
          <div class="ocr-card-grid">
            <label>班级名<input data-field="className" value="${escapeHtml(draft.className)}" /></label>
            <label>模式
              <select data-field="mode">
                <option value="weekday" ${draft.mode === 'weekday' ? 'selected' : ''}>周中</option>
                <option value="weekend" ${draft.mode === 'weekend' ? 'selected' : ''}>周末</option>
              </select>
            </label>
            <label>布局
              <select data-field="layout">
                <option value="circular" ${draft.layout === 'circular' ? 'selected' : ''}>圆桌</option>
                <option value="rows" ${draft.layout === 'rows' ? 'selected' : ''}>三横排</option>
              </select>
            </label>
            <label>覆盖同名班级
              <select data-field="overwrite">
                <option value="true" ${draft.overwrite ? 'selected' : ''}>覆盖</option>
                <option value="false" ${!draft.overwrite ? 'selected' : ''}>新建</option>
              </select>
            </label>
            <label>月<input data-field="date" value="${escapeHtml(draft.date)}" /></label>
            <label>日<input data-field="day" value="${escapeHtml(draft.day)}" /></label>
            <label>星期<input data-field="weekday" value="${escapeHtml(draft.weekday)}" /></label>
            <label>时间<input data-field="time" value="${escapeHtml(draft.time)}" /></label>
            <label>校区<input data-field="campus" value="${escapeHtml(draft.campus)}" /></label>
            <label>楼层<input data-field="floor" value="${escapeHtml(draft.floor)}" /></label>
            <label>教室<input data-field="room" value="${escapeHtml(draft.room)}" /></label>
          </div>
          ${warning}
          <label>座位文本（可修改）
            <textarea data-field="groupsText">${escapeHtml(draft.groupsText)}</textarea>
          </label>
        </div>
      `;
    })
    .join('');
};

const updateOcrProviderFields = (): void => {
  const engine = byId<HTMLSelectElement>('ocrEngine').value;
  const config = byId<HTMLDivElement>('ocrCloudConfig');
  config.classList.toggle('hidden', engine === 'local');
};

const setOcrEngineStatus = (message: string, type: 'error' | 'success' | 'muted' = 'muted'): void => {
  const status = byId<HTMLDivElement>('ocrEngineStatus');
  status.classList.remove('error', 'success', 'muted');
  status.classList.add(type);
  status.textContent = message;
};

const syncOcrSettingsToForm = (): void => {
  byId<HTMLSelectElement>('ocrEngine').value = ocrSettings.engine;
  byId<HTMLInputElement>('allowLocalFallback').checked = ocrSettings.allowLocalFallback;
  byId<HTMLInputElement>('tencentEndpoint').value = ocrSettings.tencentEndpoint;
  byId<HTMLInputElement>('tencentRegion').value = ocrSettings.tencentRegion;
  byId<HTMLSelectElement>('tencentAction').value = ocrSettings.tencentAction;
  updateOcrProviderFields();
};

const readOcrSettingsFromForm = (): OCRSettings => {
  const engine = byId<HTMLSelectElement>('ocrEngine').value as OCRSettings['engine'];
  const settings: OCRSettings = {
    engine: engine === 'local' || engine === 'tencent' || engine === 'hybrid' ? engine : 'hybrid',
    allowLocalFallback: byId<HTMLInputElement>('allowLocalFallback').checked,
    tencentEndpoint: byId<HTMLInputElement>('tencentEndpoint').value.trim().replace(/\/$/, '') || getDefaultOCREndpoint(),
    tencentRegion: byId<HTMLInputElement>('tencentRegion').value.trim() || 'ap-guangzhou',
    tencentAction: byId<HTMLSelectElement>('tencentAction').value as OCRSettings['tencentAction']
  };

  if (
    settings.tencentAction !== 'Auto' &&
    settings.tencentAction !== 'ExtractDocMulti' &&
    settings.tencentAction !== 'GeneralAccurateOCR' &&
    settings.tencentAction !== 'GeneralBasicOCR'
  ) {
    settings.tencentAction = 'Auto';
  }

  ocrSettings = settings;
  saveOCRSettings(settings);
  return settings;
};

const checkOCRChannel = async (): Promise<void> => {
  const settings = readOcrSettingsFromForm();

  if (settings.engine === 'local') {
    setOcrEngineStatus('当前为仅本地OCR模式，不会请求腾讯接口。', 'success');
    return;
  }

  setOcrEngineStatus('检测中...');
  try {
    const endpoint = settings.tencentEndpoint.replace(/\/$/, '');
    const healthResp = await fetch(`${endpoint}/api/health`);

    const health = await healthResp.json().catch(() => ({} as Record<string, unknown>));
    if (!healthResp.ok) {
      throw new Error('代理返回异常状态码');
    }

    const secretConfigured = health?.secretConfigured === true;
    const autoActions = 'ExtractDocMulti -> GeneralAccurateOCR -> GeneralBasicOCR';
    const serviceName = String(health?.service || 'tencent-ocr-proxy');
    const fallbackText = settings.allowLocalFallback ? '开启' : '关闭';
    const latestSource = ocrDrafts.length > 0 ? `；最近识别来源：${ocrDrafts[0].source}` : '';

    if (!secretConfigured) {
      setOcrEngineStatus('腾讯代理在线，但未检测到密钥配置（或代理未读取到环境变量）。', 'error');
      return;
    }

    const selfTestResp = await fetch(`${endpoint}/api/self-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: settings.tencentAction,
        region: settings.tencentRegion
      })
    });
    const selfTest = await selfTestResp.json().catch(() => ({} as Record<string, unknown>));
    if (!selfTestResp.ok) {
      throw new Error('OCR自检请求失败');
    }

    if (selfTest?.ok === true) {
      const action = String(selfTest?.action || 'unknown');
      const warning = selfTest?.warning ? `；说明：${String(selfTest.warning)}` : '';
      setOcrEngineStatus(
        `${serviceName} 在线，权限正常。自检命中：${action}${warning}；自动策略：${autoActions}；本地回退：${fallbackText}${latestSource}`,
        'success'
      );
      return;
    }

    const testError = String(selfTest?.error || '权限或接口不可用');
    const triedActions = Array.isArray(selfTest?.tried)
      ? selfTest.tried
          .map((item: unknown) => String((item as { action?: string }).action || '').trim())
          .filter(Boolean)
          .join(' -> ')
      : '';
    setOcrEngineStatus(
      `${serviceName} 在线但自检失败：${testError}${triedActions ? `；尝试接口：${triedActions}` : ''}；自动策略：${autoActions}；本地回退：${fallbackText}${latestSource}`,
      'error'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '检测失败';
    setOcrEngineStatus(`检测失败：${message}`, 'error');
  }
};

const showImageImportDialog = (): void => {
  hideCreateClassDialog();
  syncOcrSettingsToForm();
  setOcrEngineStatus('点击“检测OCR通道”可验证当前是否走腾讯AI接口。');
  byId<HTMLDivElement>('ocrProgress').textContent = '';
  byId<HTMLInputElement>('imageFiles').value = '';
  ocrDrafts = [];
  renderOcrReview();
  showDialog('imageImportDialog');
};

const hideImageImportDialog = (): void => {
  hideDialog('imageImportDialog');
};

const startImageRecognition = async (): Promise<void> => {
  const files = Array.from(byId<HTMLInputElement>('imageFiles').files || []);
  const progress = byId<HTMLDivElement>('ocrProgress');
  const settings = readOcrSettingsFromForm();

  if (files.length === 0) {
    progress.textContent = '请先选择至少一张图片。';
    return;
  }

  ocrDrafts = [];
  renderOcrReview();
  isOcrRecognitionRunning = true;

  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      progress.textContent = `正在识别 ${index + 1}/${files.length}: ${file.name}（${settings.engine}）`;

      try {
        const result = await recognizeClassFromImage(file, settings);
        ocrDrafts.push(toDraft(result));
        renderOcrReview();
      } catch (error) {
        const message = error instanceof Error ? error.message : '识别失败';
        ocrDrafts.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          fileName: file.name,
          source: `failed:${settings.engine}`,
          errorMessage: message,
          className: file.name.replace(/\.[^.]+$/, ''),
          layout: 'circular',
          mode: 'weekday',
          overwrite: true,
          groupsText: '',
          detectedStudentCount: 0,
          placedStudentCount: 0,
          confidence: 0,
          date: '',
          day: '',
          weekday: '',
          time: '',
          campus: '',
          floor: '',
          room: '',
          fullDate: ''
        });
        progress.textContent = `图片 ${file.name} 识别失败：${message}`;
        renderOcrReview();
      }
    }

    progress.textContent = `识别完成，共 ${ocrDrafts.length} 条，可修改后确认导入。`;
  } finally {
    isOcrRecognitionRunning = false;
  }
};

const draftToModeData = (draft: OCRDraftView): ClassConfig[TimeMode] => {
  const info: LocationInfo = {
    ...makeEmptyLocationInfo(),
    date: draft.date,
    day: draft.day,
    weekday: draft.weekday,
    time: draft.time,
    campus: draft.campus,
    floor: draft.floor,
    room: draft.room,
    fullDate: draft.fullDate || monthDayToDateKey(draft.date, draft.day) || ''
  };

  if (draft.layout === 'circular') {
    const parsedGroups = parseGroupsText('circular', draft.groupsText);
    const groups = makeEmptyCircularGroups();
    parsedGroups.slice(0, 6).forEach((group, index) => {
      groups[index] = normalizeStudentList(group).slice(0, 6).concat(Array(6).fill('')).slice(0, 6);
    });

    return {
      layout: 'circular',
      groups,
      groupOrder: [1, 2, 3, 4, 5, 6],
      rowGroups: null,
      arcGroups: null,
      currentArrangement: 0,
      locationInfo: info
    };
  }

  if (draft.layout === 'rows') {
    const parsedGroups = parseGroupsText('rows', draft.groupsText);
    const slotMap = getRowsSlotMap(parsedGroups.filter((group) => group.length > 0).length || 4);
    const slotGroups = Array.from({ length: 6 }, () => Array(6).fill(''));

    slotMap.forEach((logicalIndex, slotIndex) => {
      if (logicalIndex === null) {
        return;
      }
      slotGroups[slotIndex] = normalizeStudentList(parsedGroups[logicalIndex] || []).slice(0, 6).concat(Array(6).fill('')).slice(0, 6);
    });

    return {
      layout: 'rows',
      groups: null,
      groupOrder: null,
      rowGroups: {
        rows: [
          { left: slotGroups[0], right: slotGroups[1] },
          { left: slotGroups[2], right: slotGroups[3] },
          { left: slotGroups[4], right: slotGroups[5] }
        ]
      },
      arcGroups: null,
      currentArrangement: 0,
      locationInfo: info
    };
  }

  const rows = parseGroupsText('arc', draft.groupsText);
  return {
    layout: 'arc',
    groups: null,
    groupOrder: null,
    rowGroups: null,
    arcGroups: { rows: [rows[0], rows[1]] },
    currentArrangement: 0,
    locationInfo: info
  };
};

const ensureNewName = (baseName: string): string => {
  if (!state.classData[baseName]) {
    return baseName;
  }

  let index = 1;
  while (state.classData[`${baseName}_${index}`]) {
    index += 1;
  }

  return `${baseName}_${index}`;
};

const confirmImageImport = (): void => {
  if (ocrDrafts.length === 0) {
    alert('没有可导入的识别结果');
    return;
  }

  ocrDrafts.forEach((draft) => {
    const classNameRaw = draft.className.trim() || draft.fileName.replace(/\.[^.]+$/, '');
    const className = draft.overwrite ? classNameRaw : ensureNewName(classNameRaw);

    ensureClassShell(className);
    state.classData[className][draft.mode] = draftToModeData(draft);
  });

  persist();
  updateClassSelect();
  renderClassOverview();
  hideImageImportDialog();
  alert(`已导入 ${ocrDrafts.length} 条图片识别结果。`);
};

const currentGroupCountForLayout = (): number =>
  state.currentLayout === 'circular'
    ? Math.max(1, getCircularGroupCountFromGroups(state.groups))
    : state.currentLayout === 'rows'
      ? Math.max(1, getRowsGroupCountFromGroups(state.rowGroups))
      : 4;

const collectManualDraftStudents = (draft: ManualTuneDraft): string[] =>
  draft.layout === 'circular'
    ? collectStudentsFromCircular(draft.groups)
    : draft.layout === 'rows'
      ? collectStudentsFromRows(draft.rowGroups)
      : collectStudentsFromArc(draft.arcGroups);

const buildManualSeatSections = (draft: ManualTuneDraft): Array<{ title: string; seats: ManualSeatRef[] }> => {
  if (draft.layout === 'circular') {
    return draft.groups.map((group, groupIndex) => ({
      title: `第${groupIndex + 1}组`,
      seats: group.map((_, seatIndex) => ({
        key: `c-${groupIndex}-${seatIndex}`,
        label: `座位 ${seatIndex + 1}`,
        kind: 'circular',
        groupIndex,
        seatIndex
      }))
    }));
  }

  if (draft.layout === 'rows') {
    const labels = [
      ['第一排左', '第一排右'],
      ['第二排左', '第二排右'],
      ['第三排左', '第三排右']
    ] as const;

    return draft.rowGroups.rows.flatMap((row, rowIndex) => ([
      {
        title: labels[rowIndex][0],
        seats: row.left.map((_, seatIndex) => ({
          key: `r-${rowIndex}-left-${seatIndex}`,
          label: `位置 ${seatIndex + 1}`,
          kind: 'rows' as const,
          rowIndex,
          side: 'left' as const,
          seatIndex
        }))
      },
      {
        title: labels[rowIndex][1],
        seats: row.right.map((_, seatIndex) => ({
          key: `r-${rowIndex}-right-${seatIndex}`,
          label: `位置 ${seatIndex + 1}`,
          kind: 'rows' as const,
          rowIndex,
          side: 'right' as const,
          seatIndex
        }))
      }
    ]));
  }

  return draft.arcGroups.rows.map((row, rowIndex) => ({
    title: rowIndex === 0 ? '第一排' : '第二排',
    seats: row.map((_, seatIndex) => ({
      key: `a-${rowIndex}-${seatIndex}`,
      label: `位置 ${seatIndex + 1}`,
      kind: 'arc',
      rowIndex,
      seatIndex
    }))
  }));
};

const getManualSeatValue = (draft: ManualTuneDraft, seat: ManualSeatRef): string => {
  if (seat.kind === 'circular') {
    return draft.groups[seat.groupIndex]?.[seat.seatIndex] || '';
  }
  if (seat.kind === 'rows') {
    return draft.rowGroups.rows[seat.rowIndex]?.[seat.side]?.[seat.seatIndex] || '';
  }
  return draft.arcGroups.rows[seat.rowIndex]?.[seat.seatIndex] || '';
};

const setManualSeatValue = (draft: ManualTuneDraft, seat: ManualSeatRef, value: string): void => {
  if (seat.kind === 'circular') {
    draft.groups[seat.groupIndex][seat.seatIndex] = value;
    return;
  }
  if (seat.kind === 'rows') {
    draft.rowGroups.rows[seat.rowIndex][seat.side][seat.seatIndex] = value;
    return;
  }
  draft.arcGroups.rows[seat.rowIndex][seat.seatIndex] = value;
};

const findManualSeat = (draft: ManualTuneDraft, key: string): ManualSeatRef | null => {
  for (const section of buildManualSeatSections(draft)) {
    const hit = section.seats.find((seat) => seat.key === key);
    if (hit) {
      return hit;
    }
  }
  return null;
};

const manualSeatSummary = (seat: ManualSeatRef): string => {
  if (seat.kind === 'circular') {
    return `第${seat.groupIndex + 1}组 · 位置${seat.seatIndex + 1}`;
  }
  if (seat.kind === 'rows') {
    return `第${seat.rowIndex + 1}排${seat.side === 'left' ? '左' : '右'}侧 · 位置${seat.seatIndex + 1}`;
  }
  return `${seat.rowIndex === 0 ? '前排' : '后排'} · 位置${seat.seatIndex + 1}`;
};

const updateManualTuneStatus = (): void => {
  const status = byId<HTMLDivElement>('manualTuneStatus');
  if (!manualTuneDraft?.selectedSeatKey) {
    status.textContent = '换位模式：先点一个座位，再点另一个座位完成交换。';
    status.classList.remove('is-selected');
    return;
  }

  const seat = findManualSeat(manualTuneDraft, manualTuneDraft.selectedSeatKey);
  status.textContent = seat
    ? `已选中 ${manualSeatSummary(seat)}，现在再点一个目标座位完成互换。`
    : '换位模式：先点一个座位，再点另一个座位完成交换。';
  status.classList.toggle('is-selected', Boolean(seat));
};

const renderManualTuneEditor = (): void => {
  const container = byId<HTMLDivElement>('manualSeatEditor');
  if (!manualTuneDraft) {
    container.innerHTML = '';
    return;
  }
  const draft = manualTuneDraft;

  const renderSeat = (seat: ManualSeatRef, label: string): string => `
    <div class="seat manual-seat${draft.selectedSeatKey === seat.key ? ' selected' : ''}" data-seat-key="${seat.key}">
      <span class="manual-seat-label">${escapeHtml(label)}</span>
      <button type="button" class="manual-seat-clear" data-clear-key="${seat.key}" title="清空此座位">&times;</button>
      <input data-seat-input="${seat.key}" value="${escapeHtml(getManualSeatValue(draft, seat))}" />
    </div>
  `;

  if (draft.layout === 'circular') {
    const activeGroupCount = getCircularGroupCountFromGroups(draft.groups);
    const slotMap = getCircularSlotMap(activeGroupCount);
    container.innerHTML = `
      <div class="manual-layout classroom">
        ${Array.from({ length: 6 }, (_, slotIndex) => {
          const logicalGroupIndex = slotMap[slotIndex];
          if (logicalGroupIndex === null) {
            return `
              <div class="table table-empty manual-table-empty">
                <h3>空组</h3>
                <div class="seats seats-empty"></div>
              </div>
            `;
          }
          return `
            <div class="table group-${(logicalGroupIndex % 6) + 1}">
              <h3>Group ${logicalGroupIndex + 1}</h3>
              <div class="seats">
                ${draft.groups[logicalGroupIndex].map((_, seatIndex) => renderSeat({
                  key: `c-${logicalGroupIndex}-${seatIndex}`,
                  label: `位置 ${seatIndex + 1}`,
                  kind: 'circular',
                  groupIndex: logicalGroupIndex,
                  seatIndex
                }, `${seatIndex + 1}`)).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
    updateManualTuneStatus();
    return;
  }

  if (draft.layout === 'rows') {
    const activeGroupCount = getRowsGroupCountFromGroups(draft.rowGroups);
    const slotMap = getRowsSlotMap(activeGroupCount);
    const rows = [
      { leftSlot: 0, rightSlot: 1 },
      { leftSlot: 2, rightSlot: 3 },
      { leftSlot: 4, rightSlot: 5 }
    ];

    container.innerHTML = `
      <div class="manual-layout classroom three-rows-layout">
        ${rows.map((rowMeta, rowIndex) => {
          const leftGroupIndex = slotMap[rowMeta.leftSlot];
          const rightGroupIndex = slotMap[rowMeta.rightSlot];
          const isSingleCenter = rowIndex === 2 && leftGroupIndex !== null && rightGroupIndex === null;
          const renderGroup = (side: 'left' | 'right', title: string, groupIndex: number | null) => {
            const seats = draft.rowGroups.rows[rowIndex][side];
            if (groupIndex === null) {
              return `<div class="${side === 'left' ? 'group-left' : 'group-right'} manual-group-empty"><h3>空组</h3><div class="seats-row"></div></div>`;
            }
            return `
              <div class="${side === 'left' ? 'group-left' : 'group-right'}${isSingleCenter && side === 'left' ? ' group-center' : ''}">
                <h3>${escapeHtml(title)}</h3>
                <div class="seats-row">
                  ${seats.map((_, seatIndex) => renderSeat({
                    key: `r-${rowIndex}-${side}-${seatIndex}`,
                    label: `位置 ${seatIndex + 1}`,
                    kind: 'rows',
                    rowIndex,
                    side,
                    seatIndex
                  }, `${seatIndex + 1}`)).join('')}
                </div>
              </div>
            `;
          };
          return `
            <div class="row${isSingleCenter ? ' single-center' : ''}">
              ${renderGroup('left', leftGroupIndex === null ? '空组' : `Group ${leftGroupIndex + 1}`, leftGroupIndex)}
              ${isSingleCenter ? '' : renderGroup('right', rightGroupIndex === null ? '空组' : `Group ${rightGroupIndex + 1}`, rightGroupIndex)}
            </div>
          `;
        }).join('')}
      </div>
    `;
    updateManualTuneStatus();
    return;
  }

  container.innerHTML = `
    <div class="manual-layout classroom arc-layout">
      ${draft.arcGroups.rows.map((row, rowIndex) => `
        <div class="arc-row">
          <h3 class="two-row-title">${rowIndex === 0 ? '前排' : '后排'}</h3>
          <div class="arc-seats">
            ${row.map((_, seatIndex) => renderSeat({
              key: `a-${rowIndex}-${seatIndex}`,
              label: `位置 ${seatIndex + 1}`,
              kind: 'arc',
              rowIndex,
              seatIndex
            }, `${seatIndex + 1}`)).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
  updateManualTuneStatus();
};

const showManualTuneDialog = (): void => {
  manualTuneDraft = {
    layout: state.currentLayout,
    groups: deepCopy(state.groups),
    rowGroups: deepCopy(state.rowGroups),
    arcGroups: deepCopy(state.arcGroups),
    groupCount: currentGroupCountForLayout(),
    selectedSeatKey: null
  };

  byId<HTMLInputElement>('manualGroupCount').value = String(manualTuneDraft.groupCount);
  byId<HTMLInputElement>('manualNewStudent').value = '';
  byId<HTMLDivElement>('manualTuneError').textContent = '';
  renderManualTuneEditor();
  showDialog('manualTuneDialog');
};

const hideManualTuneDialog = (): void => {
  manualTuneDraft = null;
  hideDialog('manualTuneDialog');
};

const applyManualGroupCount = (): void => {
  if (!manualTuneDraft) {
    return;
  }

  const groupCount = Number.parseInt(byId<HTMLInputElement>('manualGroupCount').value, 10);
  const students = collectManualDraftStudents(manualTuneDraft);

  try {
    const result = applyManualGrouping(manualTuneDraft.layout, groupCount, students);
    manualTuneDraft.groups = result.groups;
    manualTuneDraft.rowGroups = result.rowGroups;
    manualTuneDraft.arcGroups = result.arcGroups;
    manualTuneDraft.groupCount = groupCount;
    manualTuneDraft.selectedSeatKey = null;
    byId<HTMLDivElement>('manualTuneError').textContent = '';
    renderManualTuneEditor();
  } catch (error) {
    byId<HTMLDivElement>('manualTuneError').textContent = error instanceof Error ? error.message : '重排失败';
  }
};

const addManualTuneStudent = (): void => {
  if (!manualTuneDraft) {
    return;
  }

  const input = byId<HTMLInputElement>('manualNewStudent');
  const name = input.value.trim();
  if (!name) {
    byId<HTMLDivElement>('manualTuneError').textContent = '请先输入新学生名字。';
    return;
  }

  const target = buildManualSeatSections(manualTuneDraft)
    .flatMap((section) => section.seats)
    .find((seat) => !getManualSeatValue(manualTuneDraft!, seat).trim());

  if (!target) {
    byId<HTMLDivElement>('manualTuneError').textContent = '当前没有空位，请先调组数或清空一个座位。';
    return;
  }

  setManualSeatValue(manualTuneDraft, target, name);
  input.value = '';
  byId<HTMLDivElement>('manualTuneError').textContent = '';
  renderManualTuneEditor();
};

const shuffleManualTuneSeats = (): void => {
  if (!manualTuneDraft) {
    return;
  }

  const allSeats = buildManualSeatSections(manualTuneDraft).flatMap((s) => s.seats);
  const occupiedSeats = allSeats.filter((seat) => getManualSeatValue(manualTuneDraft!, seat).trim());

  if (occupiedSeats.length <= 1) {
    return;
  }

  const names = occupiedSeats.map((seat) => getManualSeatValue(manualTuneDraft!, seat));

  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }

  occupiedSeats.forEach((seat, index) => {
    setManualSeatValue(manualTuneDraft!, seat, names[index]);
  });

  manualTuneDraft.selectedSeatKey = null;
  renderManualTuneEditor();
};

const applyManualTune = (): void => {
  if (!manualTuneDraft) {
    return;
  }

  state.groups = deepCopy(manualTuneDraft.groups);
  state.rowGroups = deepCopy(manualTuneDraft.rowGroups);
  state.arcGroups = deepCopy(manualTuneDraft.arcGroups);
  state.currentArrangement = 0;
  refresh();
  saveCurrentClassMode();
  hideManualTuneDialog();
};

// ── CNF Sync (教务导入) ──────────────────────────────────

let cnfSyncBusy = false;

const setCnfStatus = (text: string, cls: 'cnf-ok' | 'cnf-err' | 'cnf-busy' | '' = ''): void => {
  const el = byId<HTMLDivElement>('cnfSyncStatus');
  el.textContent = text;
  el.className = `cnf-sync-status ${cls}`.trim();
};

const showCnfSyncDialog = (): void => {
  const creds = loadCnfCredentials();
  byId<HTMLInputElement>('cnfUsername').value = creds.username;
  byId<HTMLInputElement>('cnfPassword').value = creds.password;
  byId<HTMLDivElement>('cnfSquadPickerWrap').style.display = 'none';
  byId<HTMLButtonElement>('cnfFetchBtn').disabled = true;
  setCnfStatus('');
  showDialog('cnfSyncDialog');
};

const hideCnfSyncDialog = (): void => {
  hideDialog('cnfSyncDialog');
};

const getCnfFormCreds = () => ({
  username: byId<HTMLInputElement>('cnfUsername').value.trim(),
  password: byId<HTMLInputElement>('cnfPassword').value
});

const cnfLoginAction = async (): Promise<void> => {
  if (cnfSyncBusy) return;
  const creds = getCnfFormCreds();
  if (!creds.username || !creds.password) {
    setCnfStatus('请填写账号和密码', 'cnf-err');
    return;
  }
  cnfSyncBusy = true;
  setCnfStatus('正在登录并加载班级列表...', 'cnf-busy');
  try {
    const squads = await cnfLoginAndListSquads(creds);
    saveCnfCredentials(creds);

    const select = byId<HTMLSelectElement>('cnfSquadSelect');
    select.innerHTML = '';
    if (squads.length === 0) {
      select.innerHTML = '<option value="">暂无班级</option>';
    } else {
      select.innerHTML = '<option value="">-- 选择班级 --</option>';
      for (const s of squads) {
        const opt = document.createElement('option');
        opt.value = String(s.id);
        opt.dataset.type = s.type || 'offline';
        opt.textContent = `${s.name}（${s.group || s.section}）`;
        select.appendChild(opt);
      }
    }

    // Pre-select if current class has a cnf binding
    const currentCnf = activeClassName ? state.classData[activeClassName]?.cnf : null;
    if (currentCnf?.squadId) {
      select.value = currentCnf.squadId;
    }

    byId<HTMLDivElement>('cnfSquadPickerWrap').style.display = '';
    byId<HTMLButtonElement>('cnfFetchBtn').disabled = false;
    setCnfStatus(`已加载 ${squads.length} 个班级，选一个然后点"抓取名单"`, 'cnf-ok');
  } catch (err) {
    setCnfStatus(err instanceof Error ? err.message : '登录失败', 'cnf-err');
  } finally {
    cnfSyncBusy = false;
  }
};

const cnfFetchAction = async (): Promise<void> => {
  if (cnfSyncBusy) return;
  const creds = getCnfFormCreds();
  const select = byId<HTMLSelectElement>('cnfSquadSelect');
  const squadId = select.value;
  if (!squadId) {
    setCnfStatus('请先选择一个班级', 'cnf-err');
    return;
  }
  const selectedOption = select.options[select.selectedIndex];
  const squadType = selectedOption?.dataset.type || 'offline';

  cnfSyncBusy = true;
  setCnfStatus('正在抓取学生名单...', 'cnf-busy');
  hideCnfSyncDialog();

  try {
    const result = await cnfFetchRoster(creds, squadId, squadType);
    saveCnfCredentials(creds);

    const names = result.students.map((s) => s.displayName).filter(Boolean);
    if (names.length === 0) {
      setCnfStatus('该班级暂无学生', 'cnf-err');
      showDialog('cnfSyncDialog');
      return;
    }

    const squadName = result.squad.name || result.squad.fullName || `班级${squadId}`;
    let targetClassName = activeClassName || squadName;

    if (!activeClassName) {
      const shell = makeClassShell('circular', state.userProfile.theme);
      state.classData[squadName] = shell;
      targetClassName = squadName;
    }

    const config = state.classData[targetClassName];
    if (config) {
      config.cnf = {
        squadId,
        squadType: squadType as 'offline' | 'online',
        sessionToken: '',
        loginUsername: creds.username,
        lastSyncedAt: new Date().toISOString()
      };

      const maxSlots = layoutMaxStudents('circular');
      const sliced = names.slice(0, maxSlots);
      const groups = convertStudentsToCircular(sliced);
      config.weekday.layout = 'circular';
      config.weekday.groups = groups;
      config.weekday.groupOrder = [1, 2, 3, 4, 5, 6];

      saveClassData(state.classData);

      classSelect().value = targetClassName;
      loadClass();
      renderClassOverview();
      refresh();
    }

    const errorMsg = byId<HTMLDivElement>('errorMsg');
    errorMsg.textContent = `已从教务系统导入 ${names.length} 名学生（${squadName}）`;
    errorMsg.className = 'success';
    setTimeout(() => { errorMsg.textContent = ''; errorMsg.className = ''; }, 3000);
  } catch (err) {
    setCnfStatus(err instanceof Error ? err.message : '抓取失败', 'cnf-err');
    showDialog('cnfSyncDialog');
  } finally {
    cnfSyncBusy = false;
  }
};

// ── Batch Import ──────────────────────────────────────────

const showBatchImportDialog = (): void => {
  byId<HTMLTextAreaElement>('batchImportData').value = '';
  byId<HTMLDivElement>('batchImportError').textContent = '';
  showDialog('batchImportDialog');
};

const hideBatchImportDialog = (): void => {
  hideDialog('batchImportDialog');
};

const parseBatchLayout = (text: string): LayoutType => {
  if (text.includes('三排') || text.includes('横排')) return 'rows';
  if (text.includes('弧') || text.includes('两排')) return 'arc';
  return 'circular';
};

const processBatchImport = (): void => {
  const input = byId<HTMLTextAreaElement>('batchImportData').value;
  const chunks = input.split('!').map((item) => item.trim()).filter(Boolean);
  let successCount = 0;
  const errors: string[] = [];

  chunks.forEach((chunk) => {
    try {
      const lines = chunk.split('\n').map((line) => line.trim()).filter(Boolean);
      const nameLine = lines.find((line) => line.startsWith('班级名称:'));
      const className = nameLine?.split(':')[1]?.trim();
      if (!className) {
        throw new Error('缺少班级名称');
      }

      ensureClassShell(className);

      let activeMode: TimeMode = 'weekday';
      let activeLayout: LayoutType = 'circular';
      let groupText: string[] = [];

      const flush = (): void => {
        if (groupText.length === 0) {
          return;
        }

        const modeData = state.classData[className][activeMode];
        const text = groupText.join('\n');

        if (activeLayout === 'circular') {
          const groups = parseGroupsText('circular', text);
          modeData.layout = 'circular';
          modeData.groups = makeEmptyCircularGroups();
          groups.forEach((group, idx) => {
            if (idx < 6) {
              modeData.groups![idx] = normalizeStudentList(group).slice(0, 6).concat(Array(6).fill('')).slice(0, 6);
            }
          });
          modeData.rowGroups = null;
          modeData.arcGroups = null;
        } else if (activeLayout === 'rows') {
          const groups = parseGroupsText('rows', text);
          const rowGroups = convertStudentsToRows(groups.flat());
          modeData.layout = 'rows';
          modeData.groups = null;
          modeData.rowGroups = rowGroups;
          modeData.arcGroups = null;
        } else {
          const rows = parseGroupsText('arc', text);
          modeData.layout = 'arc';
          modeData.groups = null;
          modeData.rowGroups = null;
          modeData.arcGroups = { rows: [rows[0], rows[1]] };
        }

        groupText = [];
      };

      lines.forEach((line) => {
        if (line.startsWith('周中布局:')) {
          flush();
          activeMode = 'weekday';
          activeLayout = parseBatchLayout(line);
          return;
        }

        if (line.startsWith('周末布局:')) {
          flush();
          activeMode = 'weekend';
          activeLayout = parseBatchLayout(line);
          return;
        }

        if (line.startsWith('月:')) {
          state.classData[className][activeMode].locationInfo.date = line.split(':')[1]?.trim() || '';
          return;
        }

        if (line.startsWith('日:')) {
          state.classData[className][activeMode].locationInfo.day = line.split(':')[1]?.trim() || '';
          return;
        }

        if (line.startsWith('星期:')) {
          state.classData[className][activeMode].locationInfo.weekday = line.split(':')[1]?.trim() || '';
          return;
        }

        if (line.startsWith('时间:')) {
          state.classData[className][activeMode].locationInfo.time = line.slice(line.indexOf(':') + 1).trim();
          return;
        }

        if (line.startsWith('校区:')) {
          state.classData[className][activeMode].locationInfo.campus = line.split(':')[1]?.trim() || '';
          return;
        }

        if (line.startsWith('楼层:')) {
          state.classData[className][activeMode].locationInfo.floor = line.split(':')[1]?.trim() || '';
          return;
        }

        if (line.startsWith('教室:')) {
          state.classData[className][activeMode].locationInfo.room = line.split(':')[1]?.trim() || '';
          return;
        }

        if (line.startsWith('Group') || line.startsWith('第一排') || line.startsWith('第二排')) {
          groupText.push(line);
        }
      });

      flush();

      (['weekday', 'weekend'] as TimeMode[]).forEach((mode) => {
        const info = state.classData[className][mode].locationInfo;
        info.fullDate = monthDayToDateKey(info.date, info.day) || '';
      });

      successCount += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : '解析失败');
    }
  });

  persist();
  updateClassSelect();
  renderClassOverview();

  const errorBox = byId<HTMLDivElement>('batchImportError');
  if (errors.length > 0) {
    errorBox.className = 'error';
    errorBox.innerHTML = `成功 ${successCount} 个，失败 ${errors.length} 个：<br>${errors.map((msg) => `• ${escapeHtml(msg)}`).join('<br>')}`;
  } else {
    errorBox.className = 'success';
    errorBox.textContent = `成功导入 ${successCount} 个班级。`;
    setTimeout(hideBatchImportDialog, 1300);
  }
};

const setTextAlign = (align: 'left' | 'center' | 'right'): void => {
  document.execCommand(`justify${align.charAt(0).toUpperCase()}${align.slice(1)}`, false);
  updateAlignButtons();
};

const setVerticalAlign = (align: 'top' | 'middle' | 'bottom'): void => {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) {
    return;
  }

  const range = selection.getRangeAt(0);
  const selected = range.commonAncestorContainer;

  if (selected.nodeType === 3) {
    const span = document.createElement('span');
    span.style.verticalAlign = align;
    range.surroundContents(span);
  } else if (selected.nodeType === 1) {
    (selected as HTMLElement).style.verticalAlign = align;
  }

  updateAlignButtons();
};

const updateAlignButtons = (): void => {
  const buttons = document.querySelectorAll<HTMLButtonElement>('.text-align-group button');
  buttons.forEach((button) => button.classList.remove('active'));

  const alignment = document.queryCommandState('justifyLeft')
    ? 'left'
    : document.queryCommandState('justifyCenter')
      ? 'center'
      : document.queryCommandState('justifyRight')
        ? 'right'
        : '';

  if (!alignment) {
    return;
  }

  const activeButton = document.querySelector<HTMLButtonElement>(`[onclick*=\"setTextAlign('${alignment}')\"]`);
  if (activeButton) {
    activeButton.classList.add('active');
  }
};

const updateTime = (): void => {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const input = byId<HTMLInputElement>('time');
  if (!input.value) {
    input.value = `${hours}:${minutes}`;
  }
};

const bindNotes = (): void => {
  const panel = byId<HTMLDivElement>('editorView').querySelector<HTMLElement>('.right-section');
  const notesSection = byId<HTMLDivElement>('editorView').querySelector<HTMLElement>('.notes-section');
  const widthHandle = byId<HTMLDivElement>('notesWidthHandle');
  const heightHandle = byId<HTMLDivElement>('notesHeightHandle');
  const toolbarToggle = byId<HTMLButtonElement>('notesToolbarToggle');

  if (panel && notesSection) {
    const savedWidth = readStorageValue(storageKeys.notesPanelWidth);
    if (savedWidth) {
      panel.style.width = `${Math.max(280, Math.min(520, Number(savedWidth) || 360))}px`;
    }
    const savedHeight = readStorageValue(storageKeys.notesSectionHeight);
    if (savedHeight) {
      notesSection.style.height = `${Math.max(520, Number(savedHeight) || 520)}px`;
    }

    const applyToolbarState = (collapsed: boolean): void => {
      notesSection.classList.toggle('toolbar-collapsed', collapsed);
      toolbarToggle.textContent = collapsed ? '显示设置' : '隐藏设置';
      writeStorageValue(storageKeys.notesToolbarCollapsed, collapsed ? '1' : '0');
    };

    applyToolbarState(readStorageValue(storageKeys.notesToolbarCollapsed) !== '0');
    toolbarToggle.addEventListener('click', () => {
      applyToolbarState(!notesSection.classList.contains('toolbar-collapsed'));
    });

    const persistWidth = (): void => {
      writeStorageValue(storageKeys.notesPanelWidth, String(panel.getBoundingClientRect().width));
    };
    const persistHeight = (): void => {
      writeStorageValue(storageKeys.notesSectionHeight, String(notesSection.getBoundingClientRect().height));
    };

    panel.addEventListener('mouseup', persistWidth);
    panel.addEventListener('touchend', persistWidth);
    notesSection.addEventListener('mouseup', persistHeight);
    notesSection.addEventListener('touchend', persistHeight);

    widthHandle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = panel.getBoundingClientRect().width;

      const onMove = (moveEvent: PointerEvent): void => {
        const nextWidth = Math.max(280, Math.min(560, startWidth + (moveEvent.clientX - startX)));
        panel.style.width = `${nextWidth}px`;
        persistWidth();
      };

      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        persistWidth();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
    });

    heightHandle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = notesSection.getBoundingClientRect().height;

      const onMove = (moveEvent: PointerEvent): void => {
        const nextHeight = Math.max(440, Math.min(window.innerHeight - 80, startHeight + (moveEvent.clientY - startY)));
        notesSection.style.height = `${nextHeight}px`;
        persistHeight();
      };

      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        persistHeight();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
    });

    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(() => {
        persistWidth();
        persistHeight();
      });
      observer.observe(panel);
      observer.observe(notesSection);
    }
  }

  byId<HTMLSelectElement>('noteFontSize').addEventListener('change', (event) => {
    document.execCommand('fontSize', false, '7');
    const fonts = document.getElementsByTagName('font');
    const target = event.target as HTMLSelectElement;

    for (let idx = 0; idx < fonts.length; idx += 1) {
      if (fonts[idx].size === '7') {
        fonts[idx].removeAttribute('size');
        fonts[idx].style.fontSize = `${target.value}px`;
      }
    }
  });

  byId<HTMLInputElement>('noteColor').addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement;
    document.execCommand('foreColor', false, target.value);
  });

  notes().addEventListener('paste', (event) => {
    event.preventDefault();
    const clipboard = (event as ClipboardEvent).clipboardData;
    if (!clipboard) {
      return;
    }

    for (const item of clipboard.items) {
      if (item.type.startsWith('image')) {
        const file = item.getAsFile();
        if (!file) {
          continue;
        }

        const reader = new FileReader();
        reader.onload = (loadEvent) => {
          const img = document.createElement('img');
          img.src = String(loadEvent.target?.result || '');
          img.style.maxWidth = '100%';
          img.style.height = 'auto';
          img.style.border = '1px solid #ddd';
          img.style.margin = '10px auto';
          img.style.display = 'block';
          notes().appendChild(img);
        };
        reader.readAsDataURL(file);
        continue;
      }

      if (item.type === 'text/plain') {
        item.getAsString((text) => {
          document.execCommand('insertText', false, text);
        });
      }
    }
  });
};

const bindOcrReviewEvents = (): void => {
  byId<HTMLDivElement>('ocrReviewList').addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const field = target.dataset.field;
    const card = target.closest<HTMLElement>('.ocr-card');
    const id = card?.dataset.id;

    if (!field || !id) {
      return;
    }

    const draft = ocrDrafts.find((item) => item.id === id);
    if (!draft) {
      return;
    }

    if (field === 'overwrite') {
      draft.overwrite = target.value === 'true';
      return;
    }

    if (field === 'layout') {
      draft.layout = target.value as LayoutType;
      return;
    }

    if (field === 'mode') {
      draft.mode = target.value as TimeMode;
      return;
    }

    switch (field) {
      case 'className':
        draft.className = target.value;
        break;
      case 'groupsText':
        draft.groupsText = target.value;
        break;
      case 'date':
        draft.date = target.value;
        break;
      case 'day':
        draft.day = target.value;
        break;
      case 'weekday':
        draft.weekday = target.value;
        break;
      case 'time':
        draft.time = target.value;
        break;
      case 'campus':
        draft.campus = target.value;
        break;
      case 'floor':
        draft.floor = target.value;
        break;
      case 'room':
        draft.room = target.value;
        break;
      default:
        break;
    }
  });
};

const bindHomeEvents = (): void => {
  const saveUsername = (): void => {
    const username = byId<HTMLInputElement>('usernameInput').value.trim();
    if (!username) {
      return;
    }
    state.userProfile.username = username;
    saveProfile();
    updateWelcome();
  };

  byId<HTMLButtonElement>('saveUsernameBtn').addEventListener('click', saveUsername);
  byId<HTMLInputElement>('usernameInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      saveUsername();
    }
  });

  byId<HTMLSelectElement>('themeSelect').addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value as ThemeName;
    state.userProfile.theme = value;
    saveProfile();
    if (state.currentView === 'home') {
      applyTheme(value);
    }
  });

  byId<HTMLDivElement>('homeClassList').addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>('[data-open-class]');
    if (!card) {
      return;
    }

    const className = card.dataset.openClass;
    if (!className) {
      return;
    }

    openClassInEditor(className);
  });
};

const bindCoreEvents = (): void => {
  const editorView = byId<HTMLDivElement>('editorView');
  const editorToolsToggle = byId<HTMLButtonElement>('editorToolsToggle');
  const applyEditorToolsState = (collapsed: boolean): void => {
    editorView.classList.toggle('editor-tools-collapsed', collapsed);
    editorToolsToggle.textContent = collapsed ? '显示工具' : '隐藏工具';
    writeStorageValue(storageKeys.editorToolsCollapsed, collapsed ? '1' : '0');
  };

  applyEditorToolsState(readStorageValue(storageKeys.editorToolsCollapsed) === '1');
  editorToolsToggle.addEventListener('click', () => {
    applyEditorToolsState(!editorView.classList.contains('editor-tools-collapsed'));
  });

  byId<HTMLInputElement>('date').addEventListener('change', syncDateField);
  byId<HTMLInputElement>('day').addEventListener('change', syncDateField);
  byId<HTMLDivElement>('manualSeatEditor').addEventListener('click', (event) => {
    if (!manualTuneDraft) {
      return;
    }

    const target = event.target as HTMLElement;

    const clearBtn = target.closest<HTMLElement>('[data-clear-key]');
    if (clearBtn) {
      event.preventDefault();
      event.stopPropagation();
      const clearKey = clearBtn.dataset.clearKey;
      if (clearKey) {
        const seat = findManualSeat(manualTuneDraft, clearKey);
        if (seat) {
          setManualSeatValue(manualTuneDraft, seat, '');
          manualTuneDraft.selectedSeatKey = null;
          renderManualTuneEditor();
        }
      }
      return;
    }

    const row = target.closest<HTMLElement>('[data-seat-key]');
    const key = row?.dataset.seatKey;
    if (!key) {
      return;
    }

    // In swap mode (a seat is already selected), clicking any part of another seat
    // triggers the swap — even if the click lands on the input element.
    // Outside swap mode, clicking input also selects the seat (prevents input focus so
    // the whole cell is a usable click target, not just the tiny label area).
    if (!manualTuneDraft.selectedSeatKey && target.closest('input')) {
      event.preventDefault();
      manualTuneDraft.selectedSeatKey = key;
      renderManualTuneEditor();
      return;
    }

    if (!manualTuneDraft.selectedSeatKey || manualTuneDraft.selectedSeatKey === key) {
      manualTuneDraft.selectedSeatKey = manualTuneDraft.selectedSeatKey === key ? null : key;
      renderManualTuneEditor();
      return;
    }

    // Prevent the click from also focusing the input after swap
    event.preventDefault();

    const firstSeat = findManualSeat(manualTuneDraft, manualTuneDraft.selectedSeatKey);
    const secondSeat = findManualSeat(manualTuneDraft, key);
    if (!firstSeat || !secondSeat) {
      manualTuneDraft.selectedSeatKey = null;
      renderManualTuneEditor();
      return;
    }

    const firstValue = getManualSeatValue(manualTuneDraft, firstSeat);
    const secondValue = getManualSeatValue(manualTuneDraft, secondSeat);
    setManualSeatValue(manualTuneDraft, firstSeat, secondValue);
    setManualSeatValue(manualTuneDraft, secondSeat, firstValue);
    manualTuneDraft.selectedSeatKey = null;
    byId<HTMLDivElement>('manualTuneError').textContent = '';
    renderManualTuneEditor();
  });
  byId<HTMLDivElement>('manualSeatEditor').addEventListener('input', (event) => {
    if (!manualTuneDraft) {
      return;
    }

    const target = event.target as HTMLInputElement;
    const key = target.dataset.seatInput;
    if (!key) {
      return;
    }

    const seat = findManualSeat(manualTuneDraft, key);
    if (!seat) {
      return;
    }

    setManualSeatValue(manualTuneDraft, seat, target.value);
  });
  byId<HTMLDivElement>('rosterList').addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const btn = target.closest<HTMLElement>('[data-delete-student]');
    if (!btn) {
      return;
    }
    const studentName = btn.dataset.deleteStudent;
    if (studentName && confirm(`确定要删除「${studentName}」吗？`)) {
      removeStudentFromSeats(studentName);
    }
  });
  byId<HTMLSelectElement>('editorThemeSelect').addEventListener('change', (event) => {
    const className = classSelect().value.trim();
    if (!className) {
      return;
    }

    ensureClassShell(className);
    const value = (event.target as HTMLSelectElement).value as ThemeName;
    state.classData[className].theme = value;
    applyTheme(value);
    persist();
    renderClassOverview();
  });
  classSelect().addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    switchEditorClass(target.value);
  });
  floatingClassSelect().addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    switchEditorClass(target.value);
  });

  byId<HTMLInputElement>('circularLayout').addEventListener('change', updateLayoutDescription);
  byId<HTMLInputElement>('rowsLayout').addEventListener('change', updateLayoutDescription);
  byId<HTMLInputElement>('arcLayout').addEventListener('change', updateLayoutDescription);
  byId<HTMLInputElement>('backupImportInput').addEventListener('change', (event) => {
    void importBackupFile(event);
  });
  byId<HTMLSelectElement>('ocrEngine').addEventListener('change', () => {
    updateOcrProviderFields();
    readOcrSettingsFromForm();
  });
  byId<HTMLInputElement>('allowLocalFallback').addEventListener('change', () => {
    readOcrSettingsFromForm();
  });
  byId<HTMLInputElement>('tencentEndpoint').addEventListener('change', () => {
    readOcrSettingsFromForm();
  });
  byId<HTMLInputElement>('tencentRegion').addEventListener('change', () => {
    readOcrSettingsFromForm();
  });
  byId<HTMLSelectElement>('tencentAction').addEventListener('change', () => {
    readOcrSettingsFromForm();
  });
};

interface AppWindow extends Window {
  loadClass: () => void;
  toggleTime: (mode: TimeMode) => void;
  showSaveDialog: () => void;
  hideSaveDialog: () => void;
  saveClass: () => void;
  renameCurrentClass: () => void;
  deleteCurrentClass: () => void;
  showImportDialog: () => void;
  hideImportDialog: () => void;
  importStudents: () => void;
  generateSeating: () => void;
  toggleEditMode: () => void;
  setTextAlign: (align: 'left' | 'center' | 'right') => void;
  setVerticalAlign: (align: 'top' | 'middle' | 'bottom') => void;
  showBatchImportDialog: () => void;
  hideBatchImportDialog: () => void;
  processBatchImport: () => void;
  toggleLayout: () => void;
  goHome: () => void;
  generateWeeklySeating: () => void;
  undoWeeklySeating: () => void;
  showCreateClassDialog: () => void;
  hideCreateClassDialog: () => void;
  showImageImportDialog: () => void;
  hideImageImportDialog: () => void;
  startImageRecognition: () => Promise<void>;
  checkOCRChannel: () => Promise<void>;
  confirmImageImport: () => void;
  showManualTuneDialog: () => void;
  hideManualTuneDialog: () => void;
  applyManualGroupCount: () => void;
  addManualTuneStudent: () => void;
  shuffleManualTuneSeats: () => void;
  applyManualTune: () => void;
  copyCurrentToOtherMode: () => void;
  showPreviousWeekDialog: () => void;
  hidePreviousWeekDialog: () => void;
  restorePreviousWeek: () => void;
  showRosterDialog: () => void;
  hideRosterDialog: () => void;
  exportDataBackup: () => void;
  triggerImportBackup: () => void;
  toggleUsageGuide: () => void;
  showCnfSyncDialog: () => void;
  hideCnfSyncDialog: () => void;
  cnfLoginAction: () => Promise<void>;
  cnfFetchAction: () => Promise<void>;
}

const exposeToWindow = (): void => {
  const w = window as unknown as AppWindow;
  w.loadClass = loadClass;
  w.toggleTime = toggleTime;
  w.showSaveDialog = showSaveDialog;
  w.hideSaveDialog = hideSaveDialog;
  w.saveClass = saveClass;
  w.renameCurrentClass = renameCurrentClass;
  w.deleteCurrentClass = deleteCurrentClass;
  w.showImportDialog = showImportDialog;
  w.hideImportDialog = hideImportDialog;
  w.importStudents = importStudents;
  w.generateSeating = generateSeating;
  w.toggleEditMode = toggleEditMode;
  w.setTextAlign = setTextAlign;
  w.setVerticalAlign = setVerticalAlign;
  w.showBatchImportDialog = showBatchImportDialog;
  w.hideBatchImportDialog = hideBatchImportDialog;
  w.processBatchImport = processBatchImport;
  w.toggleLayout = toggleLayout;
  w.goHome = goHome;
  w.generateWeeklySeating = generateWeeklySeating;
  w.undoWeeklySeating = undoWeeklySeating;
  w.showCreateClassDialog = showCreateClassDialog;
  w.hideCreateClassDialog = hideCreateClassDialog;
  w.showImageImportDialog = showImageImportDialog;
  w.hideImageImportDialog = hideImageImportDialog;
  w.startImageRecognition = startImageRecognition;
  w.checkOCRChannel = checkOCRChannel;
  w.confirmImageImport = confirmImageImport;
  w.showManualTuneDialog = showManualTuneDialog;
  w.hideManualTuneDialog = hideManualTuneDialog;
  w.applyManualGroupCount = applyManualGroupCount;
  w.addManualTuneStudent = addManualTuneStudent;
  w.shuffleManualTuneSeats = shuffleManualTuneSeats;
  w.applyManualTune = applyManualTune;
  w.copyCurrentToOtherMode = copyCurrentToOtherMode;
  w.showPreviousWeekDialog = showPreviousWeekDialog;
  w.hidePreviousWeekDialog = hidePreviousWeekDialog;
  w.restorePreviousWeek = restorePreviousWeek;
  w.showRosterDialog = showRosterDialog;
  w.hideRosterDialog = hideRosterDialog;
  w.exportDataBackup = exportDataBackup;
  w.triggerImportBackup = triggerImportBackup;
  w.toggleUsageGuide = toggleUsageGuide;
  w.showCnfSyncDialog = showCnfSyncDialog;
  w.hideCnfSyncDialog = hideCnfSyncDialog;
  w.cnfLoginAction = cnfLoginAction;
  w.cnfFetchAction = cnfFetchAction;
};

const loadProfile = (): void => {
  state.userProfile = loadUserProfile();
  ensureUsername();
  applyTheme(state.userProfile.theme);
  updateWelcome();
};

export const initApp = (): void => {
  exposeToWindow();
  loadProfile();
  loadSavedData();
  bindCoreEvents();
  bindNotes();
  bindOcrReviewEvents();
  bindHomeEvents();
  initializeUsageGuide();
  updateLayoutDescription();
  updateTime();
  setInterval(updateTime, 60000);
  refresh();
  renderClassOverview();
  setCurrentView('home');
  applyLaunchClass();

  // When embedded in an iframe inside a legacy host shell, the outer container
  // already provides a back button. Hide Super Amber's own "返回主页" to avoid
  // two competing back actions confusing the teacher.
  if (window.self !== window.top) {
    const backHomeBtn = document.querySelector<HTMLElement>('.back-home');
    if (backHomeBtn) {
      backHomeBtn.style.display = 'none';
    }
  }
};
