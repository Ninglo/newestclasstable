import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_SECRET_FILE = join(__dirname, 'ocr-credentials.local.json');

const loadLocalSecrets = () => {
  if (!existsSync(LOCAL_SECRET_FILE)) {
    return { secretId: '', secretKey: '', region: '' };
  }

  try {
    const raw = readFileSync(LOCAL_SECRET_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      secretId: String(parsed?.secretId || '').trim(),
      secretKey: String(parsed?.secretKey || '').trim(),
      region: String(parsed?.region || '').trim()
    };
  } catch {
    return { secretId: '', secretKey: '', region: '' };
  }
};

const localSecrets = loadLocalSecrets();

const PORT = Number.parseInt(process.env.TENCENT_OCR_PROXY_PORT || '8787', 10);
const SECRET_ID = (process.env.TENCENT_SECRET_ID || localSecrets.secretId || '').trim();
const SECRET_KEY = (process.env.TENCENT_SECRET_KEY || localSecrets.secretKey || '').trim();
const DEFAULT_REGION = (process.env.TENCENT_REGION || localSecrets.region || 'ap-guangzhou').trim();
const DEFAULT_ACTION = (process.env.TENCENT_DEFAULT_ACTION || 'GeneralAccurateOCR').trim();
const VERSION = '2018-11-19';
const HOST = 'ocr.tencentcloudapi.com';
const SERVICE = 'ocr';
const AUTO_ACTIONS = ['ExtractDocMulti', 'GeneralAccurateOCR', 'GeneralBasicOCR'];
const SELF_TEST_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ3sAAAAASUVORK5CYII=';
const CNF_BASE_URL = 'https://cnfadmin.cnfschool.net';

const json = (statusCode, payload) => {
  const body = JSON.stringify(payload);
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST,GET,OPTIONS'
    },
    body
  };
};

const send = (res, response) => {
  res.writeHead(response.statusCode, response.headers);
  res.end(response.body);
};

const getSetCookieLines = (response) => {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }

  const raw = response.headers.get('set-cookie');
  if (!raw) {
    return [];
  }

  return raw
    .split(/,(?=\s*[^;,=\s]+=[^;,]*)/g)
    .map((line) => line.trim())
    .filter(Boolean);
};

const mergeCookiesFromResponse = (cookieJar, response) => {
  const lines = getSetCookieLines(response);
  lines.forEach((line) => {
    const cookiePair = line.split(';', 1)[0] || '';
    const separatorIndex = cookiePair.indexOf('=');
    if (separatorIndex <= 0) {
      return;
    }
    const name = cookiePair.slice(0, separatorIndex).trim();
    const value = cookiePair.slice(separatorIndex + 1).trim();
    if (!name) {
      return;
    }
    cookieJar[name] = value;
  });
};

const cookieHeaderFromJar = (cookieJar) =>
  Object.entries(cookieJar)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');

const fetchWithCookieJar = async (url, options, cookieJar) => {
  const headers = new Headers(options?.headers || {});
  const cookieHeader = cookieHeaderFromJar(cookieJar);
  if (cookieHeader) {
    headers.set('Cookie', cookieHeader);
  }

  const response = await fetch(url, {
    ...options,
    headers,
    redirect: 'manual'
  });

  mergeCookiesFromResponse(cookieJar, response);
  return response;
};

const parseMySquadHtml = (html) => {
  const classes = [];
  const rowPattern = /<tr\s*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowPattern.exec(html)) !== null) {
    const content = match[1];
    const idMatch = content.match(/data-id="(\d+)"/);
    const linkMatch = content.match(/squad_console\?type=(\w+)&id=(\d+)/);
    const nameMatch = content.match(/column-name[^>]*>\s*(?:<a[^>]*>)?\s*([^<]+)/);
    const sectionMatch = content.match(/column-section[^>]*>\s*([\s\S]*?)\s*<\/td>/);
    const groupMatch = content.match(/column-group[^>]*>\s*([\s\S]*?)\s*<\/td>/);
    const teacherMatch = content.match(/column-class_teacher[^>]*>\s*([\s\S]*?)\s*<\/td>/);
    if (idMatch && nameMatch) {
      classes.push({
        id: Number(idMatch[1]),
        type: linkMatch?.[1] || 'offline',
        name: nameMatch[1].trim(),
        section: (sectionMatch?.[1] || '').replace(/<[^>]+>/g, '').trim(),
        group: (groupMatch?.[1] || '').replace(/<[^>]+>/g, '').trim(),
        tutor: (teacherMatch?.[1] || '').replace(/<[^>]+>/g, '').trim()
      });
    }
  }
  return classes;
};

const extractLoginToken = (html) => {
  const tokenMatch = html.match(/_token:\s*"([^"]+)"/);
  return tokenMatch?.[1]?.trim() || '';
};

const parseCNFClassInfo = (input) => {
  const raw = String(input || '').trim();
  if (!raw) {
    return { squadId: '', squadType: '' };
  }

  if (/^\d+$/.test(raw)) {
    return { squadId: raw, squadType: '' };
  }

  try {
    const parsed = new URL(raw);
    return {
      squadId: String(parsed.searchParams.get('id') || '').trim(),
      squadType: String(parsed.searchParams.get('type') || '').trim()
    };
  } catch {
    return { squadId: '', squadType: '' };
  }
};

const loginCNF = async ({ username, password }) => {
  const cookieJar = {};

  const loginPageResp = await fetchWithCookieJar(`${CNF_BASE_URL}/admin/auth/login`, { method: 'GET' }, cookieJar);
  if (!loginPageResp.ok) {
    throw new Error(`教务登录页请求失败: ${loginPageResp.status}`);
  }

  const loginHtml = await loginPageResp.text();
  const loginToken = extractLoginToken(loginHtml);
  if (!loginToken) {
    throw new Error('未能解析教务系统登录 token');
  }

  const loginPayload = new URLSearchParams({
    username,
    password,
    _token: loginToken,
    remember: 'false'
  });

  const loginResp = await fetchWithCookieJar(
    `${CNF_BASE_URL}/admin/auth/login`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json, text/plain, */*'
      },
      body: loginPayload.toString()
    },
    cookieJar
  );

  const loginData = await loginResp.json().catch(() => ({}));
  if (!loginResp.ok) {
    throw new Error(`教务登录失败: HTTP ${loginResp.status}`);
  }
  if (String(loginData?.code || '') !== '1') {
    throw new Error(String(loginData?.msg || '账号或密码错误'));
  }

  return cookieJar;
};

const fetchCNFRoster = async ({ username, password, squadId, squadType }) => {
  const cookieJar = await loginCNF({ username, password });
  const normalizedSquadType = String(squadType || '').trim() || 'offline';

  const squadInfoResp = await fetchWithCookieJar(
    `${CNF_BASE_URL}/admin/squad_console/getSquadInfo?${new URLSearchParams({ squad_id: squadId }).toString()}`,
    { method: 'GET', headers: { Accept: 'application/json, text/plain, */*' } },
    cookieJar
  );
  const squadInfoData = await squadInfoResp.json().catch(() => ({}));
  if (!squadInfoResp.ok || Number(squadInfoData?.code) !== 1) {
    throw new Error(String(squadInfoData?.msg || `班级信息获取失败: HTTP ${squadInfoResp.status}`));
  }

  const studentResp = await fetchWithCookieJar(
    `${CNF_BASE_URL}/admin/squad/cop_mip/getStudentList?${new URLSearchParams({
      squad_id: squadId,
      squad_type: normalizedSquadType
    }).toString()}`,
    { method: 'GET', headers: { Accept: 'application/json, text/plain, */*' } },
    cookieJar
  );
  const studentData = await studentResp.json().catch(() => ({}));
  if (!studentResp.ok || Number(studentData?.code) !== 1 || !Array.isArray(studentData?.data)) {
    throw new Error(String(studentData?.msg || `学生名单获取失败: HTTP ${studentResp.status}`));
  }

  const students = studentData.data.map((item) => {
    const enName = String(item?.en_name || '').trim();
    const chName = String(item?.ch_name || '').trim();
    return {
      id: Number(item?.id) || 0,
      no: String(item?.no || '').trim(),
      enName,
      chName,
      displayName: enName || chName || String(item?.no || '').trim()
    };
  });

  const squad = squadInfoData?.data || {};
  return {
    squad: {
      id: Number(squad?.id) || Number(squadId) || 0,
      name: String(squad?.name || '').trim(),
      fullName: String(squad?.full_name || '').trim(),
      type: normalizedSquadType
    },
    students
  };
};

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const hmac = (key, msg, encoding) => createHmac('sha256', key).update(msg, 'utf8').digest(encoding);

const buildAuthorization = ({ payload, timestamp, secretId, secretKey }) => {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const signedHeaders = 'content-type;host';
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${HOST}\n`;
  const hashedPayload = sha256(payload);

  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    hashedPayload
  ].join('\n');

  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    sha256(canonicalRequest)
  ].join('\n');

  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign, 'hex');

  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
};

const parsePolygon = (polygon) => {
  if (!Array.isArray(polygon) || polygon.length === 0) return null;
  const points = polygon
    .map((point) => ({
      x: Number(point?.X),
      y: Number(point?.Y)
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

  if (points.length === 0) return null;

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys)
  };
};

const parseQuad = (coord) => {
  if (!coord) return null;
  const points = [coord.LeftTop, coord.RightTop, coord.RightBottom, coord.LeftBottom]
    .map((point) => ({
      x: Number(point?.X),
      y: Number(point?.Y)
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

  if (points.length === 0) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys)
  };
};

const parseItemPolygon = (itemPolygon) => {
  if (!itemPolygon) return null;
  const x = Number(itemPolygon?.X);
  const y = Number(itemPolygon?.Y);
  const width = Number(itemPolygon?.Width);
  const height = Number(itemPolygon?.Height);
  if (![x, y, width, height].every(Number.isFinite)) return null;

  return {
    x0: x,
    y0: y,
    x1: x + width,
    y1: y + height
  };
};

const splitTextTokens = (text) =>
  String(text || '')
    .split(/[,\s，。;；:：、|｜/\\]+/)
    .map((item) => item.trim())
    .filter(Boolean);

const normalizeTextDetection = (detection) => {
  const text = String(detection?.DetectedText || '').trim();
  if (!text) return null;

  const polygon = parsePolygon(detection?.Polygon) || parseItemPolygon(detection?.ItemPolygon);
  const confidence = Number.isFinite(Number(detection?.Confidence)) ? Number(detection.Confidence) : 0;

  return {
    text,
    confidence,
    x0: polygon?.x0 ?? 0,
    y0: polygon?.y0 ?? 0,
    x1: polygon?.x1 ?? 0,
    y1: polygon?.y1 ?? 0
  };
};

const normalizeWords = (textDetections) => {
  const words = [];

  for (const detection of textDetections || []) {
    const normalizedDetection = normalizeTextDetection(detection);
    if (normalizedDetection) {
      words.push(normalizedDetection);
    }

    if (!Array.isArray(detection?.Words)) continue;

    for (const word of detection.Words) {
      const text = String(word?.Character || word?.DetectedText || '').trim();
      if (!text) continue;

      const polygon = parsePolygon(word?.Polygon) || parseItemPolygon(word?.ItemPolygon);
      const confidence = Number.isFinite(Number(word?.Confidence)) ? Number(word.Confidence) : normalizedDetection?.confidence || 0;

      words.push({
        text,
        confidence,
        x0: polygon?.x0 ?? normalizedDetection?.x0 ?? 0,
        y0: polygon?.y0 ?? normalizedDetection?.y0 ?? 0,
        x1: polygon?.x1 ?? normalizedDetection?.x1 ?? 0,
        y1: polygon?.y1 ?? normalizedDetection?.y1 ?? 0
      });
    }
  }

  return words;
};

const normalizeWordList = (wordList) => {
  const words = [];

  for (const item of wordList || []) {
    const text = String(item?.DetectedText || '').trim();
    const polygon = parseQuad(item?.Coord);
    const tokenTexts = splitTextTokens(text);
    const confidenceFromAdvancedInfo = (() => {
      try {
        const info = item?.AdvancedInfo ? JSON.parse(item.AdvancedInfo) : null;
        const conf = Number(info?.Confidence ?? info?.confidence ?? 0);
        return Number.isFinite(conf) ? conf : 0;
      } catch {
        return 0;
      }
    })();

    if (tokenTexts.length === 0 && text) {
      tokenTexts.push(text);
    }

    for (const token of tokenTexts) {
      words.push({
        text: token,
        confidence: confidenceFromAdvancedInfo,
        x0: polygon?.x0 ?? 0,
        y0: polygon?.y0 ?? 0,
        x1: polygon?.x1 ?? 0,
        y1: polygon?.y1 ?? 0
      });
    }

    if (Array.isArray(item?.WordCoord)) {
      for (const word of item.WordCoord) {
        const wordText = String(word?.DetectedText || '').trim();
        if (!wordText) continue;
        const wordPolygon = parseQuad(word?.Coord) || polygon;
        words.push({
          text: wordText,
          confidence: confidenceFromAdvancedInfo,
          x0: wordPolygon?.x0 ?? 0,
          y0: wordPolygon?.y0 ?? 0,
          x1: wordPolygon?.x1 ?? 0,
          y1: wordPolygon?.y1 ?? 0
        });
      }
    }
  }

  return words;
};

const buildPayload = (action, imageBase64) => {
  if (action === 'ExtractDocMulti') {
    return {
      ImageBase64: imageBase64,
      ConfigId: 'General',
      ReturnFullText: true,
      EnableCoord: true,
      ItemNamesShowMode: false
    };
  }
  if (action === 'GeneralAccurateOCR' || action === 'GeneralBasicOCR') {
    return {
      ImageBase64: imageBase64
    };
  }

  return {
    ImageBase64: imageBase64
  };
};

const callTencentAPI = async ({ action, region, imageBase64 }) => {
  const payloadObject = buildPayload(action, imageBase64);

  const payload = JSON.stringify(payloadObject);
  const timestamp = Math.floor(Date.now() / 1000);
  const authorization = buildAuthorization({
    payload,
    timestamp,
    secretId: SECRET_ID,
    secretKey: SECRET_KEY
  });

  const response = await fetch(`https://${HOST}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Host: HOST,
      Authorization: authorization,
      'X-TC-Action': action,
      'X-TC-Version': VERSION,
      'X-TC-Region': region,
      'X-TC-Timestamp': String(timestamp)
    },
    body: payload
  });

  if (!response.ok) {
    throw new Error(`腾讯 OCR 请求失败: ${response.status}`);
  }

  const data = await response.json();
  const apiError = data?.Response?.Error;
  if (apiError) {
    throw new Error(`${apiError.Code}: ${apiError.Message}`);
  }

  const textDetections = data?.Response?.TextDetections || [];
  const wordList = data?.Response?.WordList || [];
  const words = textDetections.length > 0 ? normalizeWords(textDetections) : normalizeWordList(wordList);
  const rawText = textDetections.length > 0
    ? textDetections
      .map((item) => String(item?.DetectedText || '').trim())
      .filter(Boolean)
      .join('\n')
    : wordList
      .map((item) => String(item?.DetectedText || '').trim())
      .filter(Boolean)
      .join('\n');

  return {
    provider: 'tencent',
    action,
    requestId: data?.Response?.RequestId || '',
    rawText,
    words
  };
};

const handleTencentOCR = async (req, res, bodyText) => {
  if (!SECRET_ID || !SECRET_KEY) {
    send(
      res,
      json(500, {
        error: 'TENCENT_SECRET_ID / TENCENT_SECRET_KEY 未配置。'
      })
    );
    return;
  }

  let parsed = {};
  try {
    parsed = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    send(res, json(400, { error: '请求体不是合法 JSON' }));
    return;
  }

  const imageBase64 = String(parsed?.imageBase64 || '').trim();
  const action = String(parsed?.action || DEFAULT_ACTION || 'GeneralAccurateOCR').trim();
  const region = String(parsed?.region || DEFAULT_REGION || 'ap-guangzhou').trim();

  if (!imageBase64) {
    send(res, json(400, { error: '缺少 imageBase64' }));
    return;
  }

  const actions = action === 'Auto' ? AUTO_ACTIONS : [action, 'GeneralAccurateOCR', 'GeneralBasicOCR'];
  const uniqueActions = [...new Set(actions.filter(Boolean))];

  let lastError = null;
  for (const currentAction of uniqueActions) {
    try {
      const result = await callTencentAPI({
        action: currentAction,
        region,
        imageBase64
      });

      console.log(`[Tencent OCR Proxy] success action=${currentAction}`);
      send(res, json(200, result));
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : 'unknown';
      console.warn(`[Tencent OCR Proxy] failed action=${currentAction} message=${message}`);
    }
  }

  const message = lastError instanceof Error ? lastError.message : '腾讯 OCR 调用失败';
  send(res, json(502, { error: message }));
};

const handleSelfTest = async (res, bodyText) => {
  if (!SECRET_ID || !SECRET_KEY) {
    send(res, json(200, { ok: false, error: 'TENCENT_SECRET_ID / TENCENT_SECRET_KEY 未配置。' }));
    return;
  }

  let parsed = {};
  try {
    parsed = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    parsed = {};
  }

  const action = String(parsed?.action || 'Auto').trim();
  const region = String(parsed?.region || DEFAULT_REGION || 'ap-guangzhou').trim();
  const actions = action === 'Auto' ? AUTO_ACTIONS : [action, 'GeneralAccurateOCR', 'GeneralBasicOCR'];
  const uniqueActions = [...new Set(actions.filter(Boolean))];
  const failures = [];

  for (const currentAction of uniqueActions) {
    try {
      const result = await callTencentAPI({
        action: currentAction,
        region,
        imageBase64: SELF_TEST_IMAGE_BASE64
      });
      send(
        res,
        json(200, {
          ok: true,
          action: result.action,
          source: `tencent:${result.action}`
        })
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      if (/FailedOperation\.OcrFailed/i.test(message)) {
        send(
          res,
          json(200, {
            ok: true,
            action: currentAction,
            source: `tencent:${currentAction}`,
            warning: '自检样例无可识别文字，已确认接口可调用。'
          })
        );
        return;
      }
      failures.push({ action: currentAction, message });
    }
  }

  send(
    res,
    json(200, {
      ok: false,
      error: failures[0]?.message || '自检失败，未命中可用OCR接口',
      tried: failures
    })
  );
};

const handleCNFRoster = async (res, bodyText) => {
  let parsed = {};
  try {
    parsed = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    send(res, json(400, { ok: false, error: '请求体不是合法 JSON' }));
    return;
  }

  const action = String(parsed?.action || '').trim();
  const username = String(parsed?.username || '').trim();
  const password = String(parsed?.password || '');
  const classUrl = String(parsed?.classUrl || '').trim();
  const classInfoFromUrl = parseCNFClassInfo(classUrl);
  const squadId = String(parsed?.squadId || classInfoFromUrl.squadId || '').trim();
  const squadType = String(parsed?.squadType || classInfoFromUrl.squadType || 'offline').trim() || 'offline';

  if (!username || !password) {
    send(res, json(400, { ok: false, error: '缺少教务账号或密码' }));
    return;
  }

  if (action === 'login') {
    try {
      await loginCNF({ username, password });
      send(res, json(200, { ok: true, message: '登录成功' }));
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : '登录失败';
      send(res, json(401, { ok: false, error: message }));
      return;
    }
  }

  if (action === 'listSquads') {
    try {
      const cookieJar = await loginCNF({ username, password });
      const mySquadResp = await fetchWithCookieJar(
        `${CNF_BASE_URL}/admin/my_squad`,
        { method: 'GET', headers: { Accept: 'text/html' } },
        cookieJar
      );
      if (mySquadResp.status >= 300 && mySquadResp.status < 400) {
        throw new Error('登录态已失效，请重新登录');
      }
      const mySquadHtml = await mySquadResp.text();
      const squads = parseMySquadHtml(mySquadHtml);
      send(res, json(200, { ok: true, squads, total: squads.length }));
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : '获取我的班级失败';
      send(res, json(502, { ok: false, error: message }));
      return;
    }
  }

  if (action !== 'fetchRoster') {
    send(res, json(400, { ok: false, error: 'action 必须为 login、listSquads 或 fetchRoster' }));
    return;
  }

  if (!squadId || !/^\d+$/.test(squadId)) {
    send(res, json(400, { ok: false, error: '缺少有效的班级 ID（squad_id）' }));
    return;
  }

  try {
    const result = await fetchCNFRoster({ username, password, squadId, squadType });
    send(
      res,
      json(200, {
        ok: true,
        squad: result.squad,
        students: result.students,
        total: result.students.length
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '获取名单失败';
    send(res, json(502, { ok: false, error: message }));
  }
};

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    send(res, json(200, { ok: true }));
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    send(
      res,
      json(200, {
        ok: true,
        service: 'tencent-ocr-proxy',
        secretConfigured: Boolean(SECRET_ID && SECRET_KEY),
        secretSource: process.env.TENCENT_SECRET_ID ? 'env' : existsSync(LOCAL_SECRET_FILE) ? 'local-file' : 'none'
      })
    );
    return;
  }

  if (req.method === 'GET' && req.url === '/api/capabilities') {
    send(
      res,
      json(200, {
        ok: true,
        service: 'tencent-ocr-proxy',
        secretConfigured: Boolean(SECRET_ID && SECRET_KEY),
        secretSource: process.env.TENCENT_SECRET_ID ? 'env' : existsSync(LOCAL_SECRET_FILE) ? 'local-file' : 'none',
        secretFile: LOCAL_SECRET_FILE,
        host: HOST,
        version: VERSION,
        defaultAction: DEFAULT_ACTION,
        autoActions: AUTO_ACTIONS
      })
    );
    return;
  }

  if (req.method === 'POST' && req.url === '/api/self-test') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      handleSelfTest(res, bodyText).catch((error) => {
        const message = error instanceof Error ? error.message : '未知错误';
        send(res, json(500, { ok: false, error: message }));
      });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/cnf-roster') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      handleCNFRoster(res, bodyText).catch((error) => {
        const message = error instanceof Error ? error.message : '未知错误';
        send(res, json(500, { ok: false, error: message }));
      });
    });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/api/tencent-ocr') {
    send(res, json(404, { error: 'Not Found' }));
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const bodyText = Buffer.concat(chunks).toString('utf8');
    handleTencentOCR(req, res, bodyText).catch((error) => {
      const message = error instanceof Error ? error.message : '未知错误';
      send(res, json(500, { error: message }));
    });
  });
});

server.listen(PORT, () => {
  console.log(`[Tencent OCR Proxy] listening on http://127.0.0.1:${PORT}`);
});
