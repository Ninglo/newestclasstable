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

function mergeCookies(jar, headers) {
  const lines = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const line of lines) {
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

async function loginCNF(username, password) {
  const jar = {};

  // Step 1: GET login page for CSRF token
  const pageResp = await fetchWithJar(`${CNF_BASE_URL}/admin/auth/login`, { method: 'GET' }, jar);
  const pageHtml = await pageResp.text();
  const token = pageHtml.match(/_token:\s*"([^"]+)"/)?.[1]?.trim();
  if (!token) throw new Error('未能解析教务系统登录 token');

  // Step 2: POST login
  const body = new URLSearchParams({ username, password, _token: token, remember: 'false' });
  const loginResp = await fetchWithJar(`${CNF_BASE_URL}/admin/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: 'application/json, text/plain, */*',
    },
    body: body.toString(),
  }, jar);

  // Handle both 200 (JSON body) and 302 (redirect on success)
  if (loginResp.status >= 300 && loginResp.status < 400) {
    // Redirect means login succeeded (Laravel pattern)
    return jar;
  }

  const data = await loginResp.json().catch(() => ({}));
  if (String(data?.code) !== '1') {
    throw new Error(String(data?.msg || '账号或密码错误'));
  }
  return jar;
}

function parseMySquadHtml(html) {
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
        tutor: (teacherMatch?.[1] || '').replace(/<[^>]+>/g, '').trim(),
      });
    }
  }
  return classes;
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
  const squadId = String(parsed?.squadId || '').trim();
  const squadType = String(parsed?.squadType || 'offline').trim() || 'offline';

  if (!username || !password) return jsonResponse(400, { ok: false, error: '缺少教务账号或密码' });

  // ── listSquads: login then parse /admin/my_squad HTML ──
  if (action === 'listSquads') {
    try {
      const jar = await loginCNF(username, password);
      const myResp = await fetchWithJar(`${CNF_BASE_URL}/admin/my_squad`, {
        method: 'GET', headers: { Accept: 'text/html' },
      }, jar);
      if (myResp.status >= 300 && myResp.status < 400) {
        throw new Error('登录态失效，请重新登录');
      }
      const myHtml = await myResp.text();
      const squads = parseMySquadHtml(myHtml);
      return jsonResponse(200, { ok: true, squads, total: squads.length });
    } catch (e) {
      return jsonResponse(502, { ok: false, error: e instanceof Error ? e.message : '获取我的班级失败' });
    }
  }

  // ── fetchRoster: login then fetch student list for one squad ──
  if (action === 'fetchRoster') {
    if (!squadId || !/^\d+$/.test(squadId)) {
      return jsonResponse(400, { ok: false, error: '缺少有效的班级 ID' });
    }
    try {
      const jar = await loginCNF(username, password);

      const infoResp = await fetchWithJar(
        `${CNF_BASE_URL}/admin/squad_console/getSquadInfo?squad_id=${encodeURIComponent(squadId)}`,
        { method: 'GET', headers: { Accept: 'application/json' } }, jar
      );
      const infoData = await infoResp.json().catch(() => ({}));

      const listResp = await fetchWithJar(
        `${CNF_BASE_URL}/admin/squad/cop_mip/getStudentList?squad_id=${encodeURIComponent(squadId)}&squad_type=${encodeURIComponent(squadType)}`,
        { method: 'GET', headers: { Accept: 'application/json' } }, jar
      );
      const listData = await listResp.json().catch(() => ({}));
      if (!Array.isArray(listData?.data)) {
        throw new Error(String(listData?.msg || `学生名单获取失败: ${listResp.status}`));
      }

      const students = listData.data.map(item => {
        const en = String(item?.en_name || '').trim();
        const ch = String(item?.ch_name || '').trim();
        return {
          id: Number(item?.id) || 0,
          no: String(item?.no || '').trim(),
          enName: en,
          chName: ch,
          displayName: en || ch || String(item?.no || '').trim(),
        };
      });

      const squad = infoData?.data || {};
      return jsonResponse(200, {
        ok: true,
        squad: {
          id: Number(squad?.id) || Number(squadId),
          name: String(squad?.name || '').trim(),
          fullName: String(squad?.full_name || '').trim(),
          type: squadType,
        },
        students,
        total: students.length,
      });
    } catch (e) {
      return jsonResponse(502, { ok: false, error: e instanceof Error ? e.message : '获取名单失败' });
    }
  }

  return jsonResponse(400, { ok: false, error: 'action 必须为 listSquads 或 fetchRoster' });
}
