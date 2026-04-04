import type { OCRSettings } from './types';

const OCR_SETTINGS_STORAGE_KEY = 'classSeatingOCRSettings';

const normalizeEndpoint = (value: string): string => {
  const trimmed = value.trim().replace(/\/$/, '');
  return trimmed || 'http://127.0.0.1:8787';
};

export const getDefaultOCREndpoint = (): string =>
  location.hostname === '127.0.0.1' || location.hostname === 'localhost'
    ? 'http://127.0.0.1:8787'
    : '';

export const makeDefaultOCRSettings = (): OCRSettings => ({
  engine: 'hybrid',
  allowLocalFallback: false,
  tencentEndpoint: getDefaultOCREndpoint(),
  tencentRegion: 'ap-guangzhou',
  tencentAction: 'Auto'
});

export const loadOCRSettings = (): OCRSettings => {
  const saved = localStorage.getItem(OCR_SETTINGS_STORAGE_KEY);
  if (!saved) {
    return makeDefaultOCRSettings();
  }

  try {
    const parsed = JSON.parse(saved) as Partial<OCRSettings>;
    const defaults = makeDefaultOCRSettings();
    return {
      engine: parsed.engine === 'local' || parsed.engine === 'tencent' || parsed.engine === 'hybrid' ? parsed.engine : defaults.engine,
      allowLocalFallback: typeof parsed.allowLocalFallback === 'boolean' ? parsed.allowLocalFallback : defaults.allowLocalFallback,
      tencentEndpoint: normalizeEndpoint(parsed.tencentEndpoint || defaults.tencentEndpoint),
      tencentRegion: (parsed.tencentRegion || defaults.tencentRegion).trim() || defaults.tencentRegion,
      tencentAction:
        parsed.tencentAction === 'ExtractDocMulti' ||
        parsed.tencentAction === 'GeneralAccurateOCR' ||
        parsed.tencentAction === 'GeneralBasicOCR' ||
        parsed.tencentAction === 'Auto'
          ? parsed.tencentAction
          : defaults.tencentAction
    };
  } catch {
    return makeDefaultOCRSettings();
  }
};

export const saveOCRSettings = (settings: OCRSettings): void => {
  const normalizedEndpoint = normalizeEndpoint(settings.tencentEndpoint);

  localStorage.setItem(
    OCR_SETTINGS_STORAGE_KEY,
    JSON.stringify({
      ...settings,
      tencentEndpoint: normalizedEndpoint,
      tencentRegion: settings.tencentRegion.trim() || 'ap-guangzhou'
    })
  );
};

const activeSettings = loadOCRSettings();
if (activeSettings.tencentEndpoint !== normalizeEndpoint(activeSettings.tencentEndpoint)) {
  saveOCRSettings(activeSettings);
}
