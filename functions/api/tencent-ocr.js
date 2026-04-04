const HOST = 'ocr.tencentcloudapi.com';
const SERVICE = 'ocr';
const VERSION = '2018-11-19';
const AUTO_ACTIONS = ['ExtractDocMulti', 'GeneralAccurateOCR', 'GeneralBasicOCR'];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Content-Type': 'application/json',
};

const enc = new TextEncoder();

function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function hmacSign(key, msg) {
  const keyData = typeof key === 'string' ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

async function hmacSignHex(key, msg) {
  const keyData = typeof key === 'string' ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

async function buildAuthorization({ payload, timestamp, secretId, secretKey }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const signedHeaders = 'content-type;host';
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${HOST}\n`;
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, await sha256Hex(payload)].join('\n');
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, await sha256Hex(canonicalRequest)].join('\n');
  const secretDate = await hmacSign(`TC3${secretKey}`, date);
  const secretService = await hmacSign(secretDate, SERVICE);
  const secretSigning = await hmacSign(secretService, 'tc3_request');
  const signature = await hmacSignHex(secretSigning, stringToSign);
  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

const parsePolygon = (polygon) => {
  if (!Array.isArray(polygon) || polygon.length === 0) return null;
  const points = polygon.map(p => ({ x: Number(p?.X), y: Number(p?.Y) })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (points.length === 0) return null;
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

const parseQuad = (coord) => {
  if (!coord) return null;
  const points = [coord.LeftTop, coord.RightTop, coord.RightBottom, coord.LeftBottom]
    .map(p => ({ x: Number(p?.X), y: Number(p?.Y) })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (points.length === 0) return null;
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

const parseItemPolygon = (ip) => {
  if (!ip) return null;
  const x = Number(ip.X), y = Number(ip.Y), w = Number(ip.Width), h = Number(ip.Height);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  return { x0: x, y0: y, x1: x + w, y1: y + h };
};

const splitTextTokens = (text) =>
  String(text || '').split(/[,\s，。;；:：、|｜/\\]+/).map(s => s.trim()).filter(Boolean);

const normalizeTextDetection = (d) => {
  const text = String(d?.DetectedText || '').trim();
  if (!text) return null;
  const polygon = parsePolygon(d?.Polygon) || parseItemPolygon(d?.ItemPolygon);
  const confidence = Number.isFinite(Number(d?.Confidence)) ? Number(d.Confidence) : 0;
  return { text, confidence, x0: polygon?.x0 ?? 0, y0: polygon?.y0 ?? 0, x1: polygon?.x1 ?? 0, y1: polygon?.y1 ?? 0 };
};

const normalizeWords = (textDetections) => {
  const words = [];
  for (const d of textDetections || []) {
    const nd = normalizeTextDetection(d);
    if (nd) words.push(nd);
    if (!Array.isArray(d?.Words)) continue;
    for (const w of d.Words) {
      const text = String(w?.Character || w?.DetectedText || '').trim();
      if (!text) continue;
      const polygon = parsePolygon(w?.Polygon) || parseItemPolygon(w?.ItemPolygon);
      const confidence = Number.isFinite(Number(w?.Confidence)) ? Number(w.Confidence) : nd?.confidence || 0;
      words.push({ text, confidence, x0: polygon?.x0 ?? nd?.x0 ?? 0, y0: polygon?.y0 ?? nd?.y0 ?? 0, x1: polygon?.x1 ?? nd?.x1 ?? 0, y1: polygon?.y1 ?? nd?.y1 ?? 0 });
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
      try { const info = item?.AdvancedInfo ? JSON.parse(item.AdvancedInfo) : null; const c = Number(info?.Confidence ?? info?.confidence ?? 0); return Number.isFinite(c) ? c : 0; } catch { return 0; }
    })();
    if (tokenTexts.length === 0 && text) tokenTexts.push(text);
    for (const token of tokenTexts) {
      words.push({ text: token, confidence: confidenceFromAdvancedInfo, x0: polygon?.x0 ?? 0, y0: polygon?.y0 ?? 0, x1: polygon?.x1 ?? 0, y1: polygon?.y1 ?? 0 });
    }
    if (Array.isArray(item?.WordCoord)) {
      for (const w of item.WordCoord) {
        const wt = String(w?.DetectedText || '').trim();
        if (!wt) continue;
        const wp = parseQuad(w?.Coord) || polygon;
        words.push({ text: wt, confidence: confidenceFromAdvancedInfo, x0: wp?.x0 ?? 0, y0: wp?.y0 ?? 0, x1: wp?.x1 ?? 0, y1: wp?.y1 ?? 0 });
      }
    }
  }
  return words;
};

const buildPayload = (action, imageBase64) => {
  if (action === 'ExtractDocMulti') return { ImageBase64: imageBase64, ConfigId: 'General', ReturnFullText: true, EnableCoord: true, ItemNamesShowMode: false };
  return { ImageBase64: imageBase64 };
};

async function callTencentAPI({ action, region, imageBase64, secretId, secretKey }) {
  const payload = JSON.stringify(buildPayload(action, imageBase64));
  const timestamp = Math.floor(Date.now() / 1000);
  const authorization = await buildAuthorization({ payload, timestamp, secretId, secretKey });
  const response = await fetch(`https://${HOST}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Host: HOST, Authorization: authorization, 'X-TC-Action': action, 'X-TC-Version': VERSION, 'X-TC-Region': region, 'X-TC-Timestamp': String(timestamp) },
    body: payload,
  });
  if (!response.ok) throw new Error(`腾讯 OCR 请求失败: ${response.status}`);
  const data = await response.json();
  const apiError = data?.Response?.Error;
  if (apiError) throw new Error(`${apiError.Code}: ${apiError.Message}`);
  const textDetections = data?.Response?.TextDetections || [];
  const wordList = data?.Response?.WordList || [];
  const words = textDetections.length > 0 ? normalizeWords(textDetections) : normalizeWordList(wordList);
  const rawText = (textDetections.length > 0 ? textDetections : wordList).map(i => String(i?.DetectedText || '').trim()).filter(Boolean).join('\n');
  return { provider: 'tencent', action, requestId: data?.Response?.RequestId || '', rawText, words };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders });
}

export async function onRequestPost(context) {
  const SECRET_ID = (context.env.TENCENT_SECRET_ID || '').trim();
  const SECRET_KEY = (context.env.TENCENT_SECRET_KEY || '').trim();
  const DEFAULT_REGION = (context.env.TENCENT_REGION || 'ap-guangzhou').trim();
  const DEFAULT_ACTION = (context.env.TENCENT_DEFAULT_ACTION || 'GeneralAccurateOCR').trim();

  if (!SECRET_ID || !SECRET_KEY) return jsonResponse({ error: 'TENCENT_SECRET_ID / TENCENT_SECRET_KEY 未配置。' }, 500);

  let body;
  try { body = await context.request.json(); } catch { return jsonResponse({ error: '请求体 JSON 解析失败' }, 400); }

  const { imageBase64, action: reqAction, region: reqRegion } = body || {};
  if (!imageBase64) return jsonResponse({ error: '缺少 imageBase64' }, 400);

  const action = String(reqAction || DEFAULT_ACTION || 'GeneralAccurateOCR').trim();
  const region = String(reqRegion || DEFAULT_REGION || 'ap-guangzhou').trim();
  const actions = action === 'Auto' ? AUTO_ACTIONS : [action, 'GeneralAccurateOCR', 'GeneralBasicOCR'];
  const uniqueActions = [...new Set(actions.filter(Boolean))];

  let lastError = null;
  for (const currentAction of uniqueActions) {
    try {
      const result = await callTencentAPI({ action: currentAction, region, imageBase64, secretId: SECRET_ID, secretKey: SECRET_KEY });
      return jsonResponse(result);
    } catch (error) {
      lastError = error;
    }
  }

  return jsonResponse({ error: lastError instanceof Error ? lastError.message : '腾讯 OCR 调用失败' }, 502);
}
