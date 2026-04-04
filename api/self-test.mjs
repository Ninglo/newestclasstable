import { createHash, createHmac } from 'node:crypto';

const HOST = 'ocr.tencentcloudapi.com';
const SERVICE = 'ocr';
const VERSION = '2018-11-19';
const AUTO_ACTIONS = ['ExtractDocMulti', 'GeneralAccurateOCR', 'GeneralBasicOCR'];
const SELF_TEST_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQ3sAAAAASUVORK5CYII=';

const SECRET_ID = (process.env.TENCENT_SECRET_ID || '').trim();
const SECRET_KEY = (process.env.TENCENT_SECRET_KEY || '').trim();
const DEFAULT_REGION = (process.env.TENCENT_REGION || 'ap-guangzhou').trim();

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const hmac = (key, msg, encoding) => createHmac('sha256', key).update(msg, 'utf8').digest(encoding);

const buildAuthorization = ({ payload, timestamp, secretId, secretKey }) => {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const signedHeaders = 'content-type;host';
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${HOST}\n`;
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256(payload)].join('\n');
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, sha256(canonicalRequest)].join('\n');
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign, 'hex');
  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).setHeader('Access-Control-Allow-Origin', '*').setHeader('Access-Control-Allow-Headers', 'Content-Type').setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS').end();

  if (!SECRET_ID || !SECRET_KEY) return res.status(200).json({ ok: false, error: 'TENCENT_SECRET_ID / TENCENT_SECRET_KEY 未配置。' });

  const { action: reqAction, region: reqRegion } = req.body || {};
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
      const authorization = buildAuthorization({ payload, timestamp, secretId: SECRET_ID, secretKey: SECRET_KEY });
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
          return res.status(200).json({ ok: true, action: currentAction, source: `tencent:${currentAction}`, warning: '自检样例无可识别文字，已确认接口可调用。' });
        }
        throw new Error(`${apiError.Code}: ${apiError.Message}`);
      }
      return res.status(200).json({ ok: true, action: currentAction, source: `tencent:${currentAction}` });
    } catch (error) {
      failures.push({ action: currentAction, message: error instanceof Error ? error.message : 'unknown' });
    }
  }

  return res.status(200).json({ ok: false, error: failures[0]?.message || '自检失败', tried: failures });
}
