const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

export async function onRequest(context) {
  return new Response(JSON.stringify({
    ok: true,
    service: 'tencent-ocr-proxy',
    secretConfigured: Boolean(context.env.TENCENT_SECRET_ID && context.env.TENCENT_SECRET_KEY),
    secretSource: context.env.TENCENT_SECRET_ID ? 'env' : 'none',
  }), { headers: corsHeaders });
}
