import crypto from "crypto";
import axios from "axios";

const LARK_OPEN_API_BASE = process.env.LARK_OPEN_API_BASE || "https://open.feishu.cn";

export function json(res, status, obj){
  res.statusCode = status;
  res.setHeader("content-type","application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

export function mustEnv(name){
  const v = process.env[name];
  if(!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export function getConfig(){
  return {
    allowedDomain: process.env.ALLOWED_DOMAIN || "shd-technology.co.th",
    historySheetId: process.env.HISTORY_SHEET_ID || "",
    historyTab: process.env.HISTORY_TAB || "History",
    pairsTab: process.env.PAIRS_TAB || "Pairs",
    maxRowsPerSync: parseInt(process.env.MAX_ROWS_PER_SYNC || "5000", 10),
  };
}

export function originFromReq(req){
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host  = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0];
  return `${proto}://${host}`;
}

// ===== Crypto helpers (AES-256-GCM) =====
export function encryptText(plain, secret){
  const key = crypto.createHash("sha256").update(secret).digest(); // 32 bytes
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

export function decryptText(encB64Url, secret){
  const raw = Buffer.from(encB64Url, "base64url");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const key = crypto.createHash("sha256").update(secret).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  return plain.toString("utf8");
}

// ===== URL parsing =====
export function parseGoogleSheetId(url){
  const m = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : "";
}

export function parseLarkBase(url){
  const u = String(url);
  // common patterns:
  // https://xxx.larksuite.com/base/<baseId>?table=<tableId>
  // https://xxx.feishu.cn/base/<baseId>?table=<tableId>
  const base = (u.match(/\/base\/([a-zA-Z0-9]+)/) || [])[1] || "";
  const table = (u.match(/[?&]table=([a-zA-Z0-9]+)/) || [])[1] || "";
  // Some links use app_token under /base/<app_token>
  return { baseId: base, tableId: table };
}

// ===== Google OAuth token exchange =====
export async function exchangeCodeForTokens({ code, redirectUri }){
  const clientId = mustEnv("GOOGLE_CLIENT_ID");
  const clientSecret = mustEnv("GOOGLE_CLIENT_SECRET");
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const r = await axios.post("https://oauth2.googleapis.com/token", body.toString(), {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    timeout: 20000,
  });
  return r.data;
}

export async function refreshAccessToken(refreshToken){
  const clientId = mustEnv("GOOGLE_CLIENT_ID");
  const clientSecret = mustEnv("GOOGLE_CLIENT_SECRET");
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  const r = await axios.post("https://oauth2.googleapis.com/token", body.toString(), {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    timeout: 20000,
  });
  return r.data.access_token;
}

export async function verifyIdToken(idToken){
  const r = await axios.get("https://oauth2.googleapis.com/tokeninfo", {
    params: { id_token: idToken },
    timeout: 15000,
  });
  return r.data; // includes email, hd, aud, exp, etc.
}

// ===== Google Sheets API =====
export async function sheetsGetValues({ accessToken, spreadsheetId, range }){
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const r = await axios.get(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    timeout: 30000,
  });
  return r.data.values || [];
}

export async function sheetsClear({ accessToken, spreadsheetId, range }){
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:clear`;
  const r = await axios.post(url, {}, {
    headers: { authorization: `Bearer ${accessToken}` },
    timeout: 30000,
  });
  return r.data;
}

export async function sheetsUpdate({ accessToken, spreadsheetId, range, values }){
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const r = await axios.put(url, { majorDimension:"ROWS", values }, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    params: { valueInputOption: "USER_ENTERED" },
    timeout: 45000,
  });
  return r.data;
}

export async function sheetsAppend({ accessToken, spreadsheetId, range, values }){
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append`;
  const r = await axios.post(url, { majorDimension:"ROWS", values:[values] }, {
    headers: { authorization: `Bearer ${accessToken}` },
    params: { valueInputOption:"USER_ENTERED", insertDataOption:"INSERT_ROWS" },
    timeout: 30000,
  });
  return r.data;
}

// ===== Lark/Feishu API (Bitable) =====
// API base is configurable via LARK_OPEN_API_BASE (Feishu: https://open.feishu.cn, Lark: https://open.larksuite.com)

let cachedTenant = { token:"", exp:0 };

export async function getTenantAccessToken(){
  const now = Date.now();
  if(cachedTenant.token && now < cachedTenant.exp - 60_000) return cachedTenant.token;

  const appId = mustEnv("LARK_APP_ID");
  const appSecret = mustEnv("LARK_APP_SECRET");
  const r = await axios.post("${LARK_OPEN_API_BASE}/open-apis/auth/v3/tenant_access_token/internal", {
    app_id: appId,
    app_secret: appSecret
  }, { timeout: 20000 });
  if(!r.data?.tenant_access_token) throw new Error("Lark token missing");
  cachedTenant.token = r.data.tenant_access_token;
  cachedTenant.exp = now + (r.data.expire || 3600) * 1000;
  return cachedTenant.token;
}

export async function larkListAllRecords({ baseId, tableId }){
  const token = await getTenantAccessToken();
  let pageToken = "";
  const out = [];
  for(let i=0;i<200;i++){
    const r = await axios.get(`${LARK_OPEN_API_BASE}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records`, {
      headers: { authorization: `Bearer ${token}` },
      params: { page_size: 500, page_token: pageToken || undefined },
      timeout: 30000,
    });
    const items = r.data?.data?.items || [];
    out.push(...items);
    pageToken = r.data?.data?.page_token || "";
    if(!pageToken) break;
  }
  // sort by created_time ascending to preserve row ordering expectation
  out.sort((a,b) => (a.created_time||0) - (b.created_time||0));
  return out;
}

export async function larkBatchDeleteAll({ baseId, tableId }){
  const token = await getTenantAccessToken();
  const items = await larkListAllRecords({ baseId, tableId });
  const ids = items.map(x => x.record_id).filter(Boolean);
  // There is a batch delete endpoint in some versions, but not always enabled.
  // We'll delete in chunks to be safe.
  for(let i=0;i<ids.length;i++){
    const rid = ids[i];
    await axios.delete(`${LARK_OPEN_API_BASE}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records/${rid}`, {
      headers: { authorization: `Bearer ${token}` },
      timeout: 30000,
    });
    // tiny delay to avoid rate spikes
    if(i % 20 === 0) await new Promise(r => setTimeout(r, 120));
  }
  return { deleted: ids.length };
}

export async function larkCreateRecordsSequential({ baseId, tableId, records }){
  const token = await getTenantAccessToken();
  const url = `${LARK_OPEN_API_BASE}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records`;
  let created = 0;
  for(let i=0;i<records.length;i++){
    await axios.post(url, { fields: records[i] }, {
      headers: { authorization: `Bearer ${token}` },
      timeout: 30000,
    });
    created += 1;
    if(i % 20 === 0) await new Promise(r => setTimeout(r, 120));
  }
  return { created };
}
