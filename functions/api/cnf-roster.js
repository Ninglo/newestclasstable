const CNF_BASE_URL = 'https://cnfadmin.cnfschool.net';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Content-Type': 'application/json',
};

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: corsHeaders });
}

function getSetCookieLines(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.get('set-cookie');
  if (!raw) return [];
  return raw.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g).map(l => l.trim()).filter(Boolean);
}

function mergeCookies(jar, headers) {
  for (const line of getSetCookieLines(headers)) {
    const pair = line.split(';', 1)[0] || '';
    const sep = pair.indexOf('=');
    if (sep <= 0) continue;
    const name = pair.slice(0, sep).trim();
    const value = pair.slice(sep + 1).trim();
    if (name) jar[name] = value;
  }
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([n, v]) => `${n}=${v}`).join('; ');
}

async function fetchWithJar(url, options, jar) {
  const headers = new Headers(options?.headers || {});
  const ch = cookieHeader(jar);
  if (ch) headers.set('Cookie', ch);
  const resp = await fetch(url, { ...options, headers, redirect: 'manual' });
  mergeCookies(jar, resp.headers);
  return resp;
}

function extractLoginToken(html) {
  const m = html.match(/_token:\s*"([^"]+)"/);
  return m?.[1]?.trim() || '';
}

async function loginCNF(username, password) {
  const jar = {};
  const pageResp = await fetchWithJar(`${CNF_BASE_URL}/admin/auth/login`, { method: 'GET' }, jar);
  if (!pageResp.ok) throw new Error(`教务登录页请求失败: ${pageResp.status}`);
  const html = await pageResp.text();
  const token = extractLoginToken(html);
  if (!token) throw new Error('未能解析教务系统登录 token');

  const body = new URLSearchParams({ username, password, _token: token, remember: 'false' });
  const loginResp = await fetchWithJar(`${CNF_BASE_URL}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json, text/plain, */*' },
    body: body.toString(),
  }, jar);

  const data = await loginResp.json().catch(() => ({}));
  if (!loginResp.ok) throw new Error(`教务登录失败: HTTP ${loginResp.status}`);
  if (String(data?.code) !== '1') throw new Error(String(data?.msg || '账号或密码错误'));
  return jar;
}

async function fetchRoster(username, password, squadId, squadType) {
  const jar = await loginCNF(username, password);
  const st = squadType || 'offline';

  const infoResp = await fetchWithJar(
    `${CNF_BASE_URL}/admin/squad_console/getSquadInfo?squad_id=${encodeURIComponent(squadId)}`,
    { method: 'GET', headers: { Accept: 'application/json, text/plain, */*' } }, jar
  );
  const infoData = await infoResp.json().catch(() => ({}));
  if (!infoResp.ok || Number(infoData?.code) !== 1) {
    throw new Error(String(infoData?.msg || `班级信息获取失败: ${infoResp.status}`));
  }

  const listResp = await fetchWithJar(
    `${CNF_BASE_URL}/admin/squad/cop_mip/getStudentList?squad_id=${encodeURIComponent(squadId)}&squad_type=${encodeURIComponent(st)}`,
    { method: 'GET', headers: { Accept: 'application/json, text/plain, */*' } }, jar
  );
  const listData = await listResp.json().catch(() => ({}));
  if (!listResp.ok || Number(listData?.code) !== 1 || !Array.isArray(listData?.data)) {
    throw new Error(String(listData?.msg || `学生名单获取失败: ${listResp.status}`));
  }

  const students = listData.data.map(item => {
    const en = String(item?.en_name || '').trim();
    const ch = String(item?.ch_name || '').trim();
    return { id: Number(item?.id) || 0, no: String(item?.no || '').trim(), enName: en, chName: ch, displayName: en || ch || String(item?.no || '').trim() };
  });

  const squad = infoData?.data || {};
  return {
    squad: { id: Number(squad?.id) || Number(squadId), name: String(squad?.name || '').trim(), fullName: String(squad?.full_name || '').trim(), type: st },
    students,
  };
}

function parseClassInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return { squadId: '', squadType: '' };
  if (/^\d+$/.test(raw)) return { squadId: raw, squadType: '' };
  try {
    const u = new URL(raw);
    return { squadId: String(u.searchParams.get('id') || '').trim(), squadType: String(u.searchParams.get('type') || '').trim() };
  } catch { return { squadId: '', squadType: '' }; }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (context.request.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method not allowed' });
  }

  let parsed;
  try { parsed = await context.request.json(); } catch { return jsonResponse(400, { ok: false, error: '请求体不是合法 JSON' }); }

  const action = String(parsed?.action || '').trim();
  const username = String(parsed?.username || '').trim();
  const password = String(parsed?.password || '');
  const classInfo = parseClassInput(parsed?.classUrl || '');
  const squadId = String(parsed?.squadId || classInfo.squadId || '').trim();
  const squadType = String(parsed?.squadType || classInfo.squadType || 'offline').trim() || 'offline';

  if (!username || !password) return jsonResponse(400, { ok: false, error: '缺少教务账号或密码' });

  if (action === 'login') {
    try {
      await loginCNF(username, password);
      return jsonResponse(200, { ok: true, message: '登录成功' });
    } catch (e) {
      return jsonResponse(401, { ok: false, error: e instanceof Error ? e.message : '登录失败' });
    }
  }

  if (action !== 'fetchRoster') return jsonResponse(400, { ok: false, error: 'action 必须为 login 或 fetchRoster' });
  if (!squadId || !/^\d+$/.test(squadId)) return jsonResponse(400, { ok: false, error: '缺少有效的班级 ID（squad_id）' });

  try {
    const result = await fetchRoster(username, password, squadId, squadType);
    return jsonResponse(200, { ok: true, squad: result.squad, students: result.students, total: result.students.length });
  } catch (e) {
    return jsonResponse(502, { ok: false, error: e instanceof Error ? e.message : '获取名单失败' });
  }
}
