const HOST = 'ocr.tencentcloudapi.com';
const SERVICE = 'ocr';
const VERSION = '2018-11-19';
const AUTO_ACTIONS = ['ExtractDocMulti', 'GeneralAccurateOCR', 'GeneralBasicOCR'];
const SELF_TEST_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ3sAAAAASUVORK5CYII=';

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

  if (!SECRET_ID || !SECRET_KEY) return jsonResponse({ ok: false, error: 'TENCENT_SECRET_ID / TENCENT_SECRET_KEY 未配置。' });

  let body;
  try { body = await context.request.json(); } catch { body = {}; }

  const { action: reqAction, region: reqRegion } = body;
  const action = String(reqAction || 'Auto').trim();
  const region = String(reqRegion || DEFAULT_REGION).trim();
  const actions = action === 'Auto' ? AUTO_ACTIONS : [action, 'GeneralAccurateOCR', 'GeneralBasicOCR'];
  const uniqueActions = [...new Set(actions.filter(Boolean))];
  const failures = [];

  for (const currentAction of uniqueActions) {
    try {
      const payloadObj = currentAction === 'ExtractDocMulti'
        ? { ImageBase64: SELF_TEST_IMAGE_BASE64, ConfigId: 'General', ReturnFullText: true, EnableCoord: true, ItemNamesShowMode: false }
        : { ImageBase64: SELF_TEST_IMAGE_BASE64 };
      const payload = JSON.stringify(payloadObj);
      const timestamp = Math.floor(Date.now() / 1000);
      const authorization = await buildAuthorization({ payload, timestamp, secretId: SECRET_ID, secretKey: SECRET_KEY });
      const response = await fetch(`https://${HOST}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Host: HOST, Authorization: authorization, 'X-TC-Action': currentAction, 'X-TC-Version': VERSION, 'X-TC-Region': region, 'X-TC-Timestamp': String(timestamp) },
        body: payload,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const apiError = data?.Response?.Error;
      if (apiError) {
        if (/FailedOperation\.OcrFailed/i.test(apiError.Code)) {
          return jsonResponse({ ok: true, action: currentAction, source: `tencent:${currentAction}`, warning: '自检样例无可识别文字，已确认接口可调用。' });
        }
        throw new Error(`${apiError.Code}: ${apiError.Message}`);
      }
      return jsonResponse({ ok: true, action: currentAction, source: `tencent:${currentAction}` });
    } catch (error) {
      failures.push({ action: currentAction, message: error instanceof Error ? error.message : 'unknown' });
    }
  }

  return jsonResponse({ ok: false, error: failures[0]?.message || '自检失败', tried: failures });
}
