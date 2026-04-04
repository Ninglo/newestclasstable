export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: 'tencent-ocr-proxy',
    secretConfigured: Boolean(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY),
    secretSource: process.env.TENCENT_SECRET_ID ? 'env' : 'none',
  });
}
