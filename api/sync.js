import {
  json, mustEnv, getConfig,
  parseGoogleSheetId, parseLarkBase,
  decryptText, refreshAccessToken,
  sheetsGetValues, sheetsClear, sheetsUpdate, sheetsAppend,
  larkListAllRecords, larkBatchDeleteAll, larkCreateRecordsSequential
} from "./_util.js";

function normalizeCell(v){
  if(v === null || v === undefined) return "";
  if(typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function guessA1EndCol(headers){
  const n = Math.max(headers.length, 1);
  let col = "";
  let x = n;
  while(x>0){
    const r = (x-1)%26;
    col = String.fromCharCode(65+r) + col;
    x = Math.floor((x-1)/26);
  }
  return col;
}

async function logHistory({ accessToken, cfg, sheetUrl, larkUrl, direction, user, rowCount, status, error }){
  const row = [
    new Date().toISOString(),
    sheetUrl || "",
    larkUrl || "",
    direction || "",
    user || "system",
    rowCount || 0,
    status || "Success",
    error || ""
  ];
  await sheetsAppend({ accessToken, spreadsheetId: cfg.historySheetId, range: `${cfg.historyTab}!A:H`, values: row });
}

async function readPairsFromHistory({ refreshToken }){
  const cfg = getConfig();
  const accessToken = await refreshAccessToken(refreshToken);
  const rows = await sheetsGetValues({ accessToken, spreadsheetId: cfg.historySheetId, range: `${cfg.pairsTab}!A1:L20000` });
  if(rows.length <= 1) return [];
  const data = rows.slice(1);
  return data.map((r, i) => ({
    rowId: i + 2,
    createdAt: r[0] || "",
    sheetUrl: r[1] || "",
    sheetId: r[2] || "",
    larkUrl: r[3] || "",
    baseId: r[4] || "",
    tableId: r[5] || "",
    direction: r[6] || "lark-to-sheet",
    user: r[7] || "",
    refreshEnc: r[8] || "",
    active: (String(r[9]||"TRUE").toUpperCase() !== "FALSE"),
    lastSyncAt: r[10] || "",
    notes: r[11] || ""
  })).filter(x => x.active && x.sheetId && x.baseId && x.tableId && x.refreshEnc);
}

async function updateLastSync({ accessToken, cfg, rowId }){
  const range = `${cfg.pairsTab}!K${rowId}:K${rowId}`; // LastSyncAt column K
  await sheetsUpdate({ accessToken, spreadsheetId: cfg.historySheetId, range, values: [[new Date().toISOString()]] });
}

async function syncLarkToSheet({ accessToken, cfg, sheetId, baseId, tableId }){
  // header from sheet row1
  const header = await sheetsGetValues({ accessToken, spreadsheetId: sheetId, range: `A1:1` });
  const headers = header?.[0] || [];
  if(headers.length === 0) throw new Error("Sheet has no header row (row 1 must contain headers)");

  // fetch from lark
  const items = await larkListAllRecords({ baseId, tableId });
  const max = cfg.maxRowsPerSync;
  const limited = items.slice(0, max);

  // map to rows in header order
  const rows = limited.map(it => {
    const fields = it.fields || {};
    return headers.map(h => normalizeCell(fields[h]));
  });

  const endCol = guessA1EndCol(headers);
  // Clear existing data below header up to max rows
  await sheetsClear({ accessToken, spreadsheetId: sheetId, range: `A2:${endCol}` });

  // Write in chunks
  const chunkSize = 1000;
  for(let i=0;i<rows.length;i+=chunkSize){
    const chunk = rows.slice(i, i+chunkSize);
    const startRow = 2 + i;
    const range = `A${startRow}:${endCol}${startRow + chunk.length - 1}`;
    await sheetsUpdate({ accessToken, spreadsheetId: sheetId, range, values: chunk });
  }

  return { rowCount: rows.length, truncated: items.length > rows.length };
}

async function syncSheetToLark({ accessToken, cfg, sheetId, baseId, tableId }){
  // read header + data (limited)
  const header = await sheetsGetValues({ accessToken, spreadsheetId: sheetId, range: `A1:1` });
  const headers = header?.[0] || [];
  if(headers.length === 0) throw new Error("Sheet has no header row (row 1 must contain headers)");

  // read up to MAX_ROWS_PER_SYNC from sheet
  const endCol = guessA1EndCol(headers);
  const maxRows = cfg.maxRowsPerSync;
  const range = `A2:${endCol}${maxRows+1}`;
  const values = await sheetsGetValues({ accessToken, spreadsheetId: sheetId, range });
  const records = values.map(row => {
    const obj = {};
    headers.forEach((h, idx) => obj[h] = row[idx] ?? "");
    return obj;
  });

  // overwrite destination: delete all existing then create sequentially to preserve order
  await larkBatchDeleteAll({ baseId, tableId });
  await larkCreateRecordsSequential({ baseId, tableId, records });

  return { rowCount: records.length, truncated: false };
}

export default async function handler(req, res){
  const cfg = getConfig();
  try{
    if(req.method === "GET"){
      // background cron mode: must provide a refreshToken? We don't want that.
      // So we read pairs from HISTORY_SHEET using a system refresh token stored in env? But user said OAuth user only.
      // Therefore cron needs at least one refresh token to read encrypted refresh tokens.
      // We support cron by using SYNC_OWNER_REFRESH_TOKEN env (a normal OAuth user refresh token).
      const ownerRefresh = process.env.SYNC_OWNER_REFRESH_TOKEN;
      if(!ownerRefresh){
        json(res, 400, { ok:false, error:"Missing SYNC_OWNER_REFRESH_TOKEN env. Cron mode needs an owner refresh token to read pairs." });
        return;
      }
      const pairs = await readPairsFromHistory({ refreshToken: ownerRefresh });
      const secret = mustEnv("SYNC_SECRET");
      const results = [];
      for(const p of pairs){
        const pairRefresh = decryptText(p.refreshEnc, secret);
        const accessToken = await refreshAccessToken(pairRefresh);
        try{
          const r = await runOne({ accessToken, cfg, pair: { ...p, refreshToken: pairRefresh, userEmail: p.user || "cron" } });
          results.push({ pair: p.sheetUrl, status:"success", ...r });
          await updateLastSync({ accessToken, cfg, rowId: p.rowId });
          await logHistory({ accessToken, cfg, sheetUrl:p.sheetUrl, larkUrl:p.larkUrl, direction:p.direction, user:p.user||"cron", rowCount:r.rowCount, status:"Success", error:"" });
        }catch(e){
          results.push({ pair: p.sheetUrl, status:"error", error: e.message });
          await logHistory({ accessToken, cfg, sheetUrl:p.sheetUrl, larkUrl:p.larkUrl, direction:p.direction, user:p.user||"cron", rowCount:0, status:"Error", error:e.message });
        }
      }
      json(res, 200, { ok:true, mode:"cron", processed: results.length, results });
      return;
    }

    if(req.method === "POST"){
      const body = req.body || {};
      const pairs = body.pairs || [];
      if(!Array.isArray(pairs) || pairs.length === 0) throw new Error("Missing pairs[]");

      const results = [];
      for(const input of pairs){
        const refreshToken = input.refreshToken || "";
        if(!refreshToken) throw new Error("Missing refreshToken in pair");
        const accessToken = await refreshAccessToken(refreshToken);

        try{
          const r = await runOne({ accessToken, cfg, pair: input });
          results.push({ status:"success", rowCount: r.rowCount, truncated: r.truncated || false });
          // log history to global history sheet as the same access token (user must have edit access)
          await logHistory({
            accessToken,
            cfg,
            sheetUrl: input.sheetUrl,
            larkUrl: input.larkUrl,
            direction: input.direction,
            user: input.userEmail || input.user || "manual",
            rowCount: r.rowCount,
            status: "Success",
            error: ""
          });
          // if rowId present, update last sync
          if(input.rowId) await updateLastSync({ accessToken, cfg, rowId: parseInt(input.rowId,10) });
        }catch(e){
          results.push({ status:"error", error: e.message });
          await logHistory({
            accessToken,
            cfg,
            sheetUrl: input.sheetUrl,
            larkUrl: input.larkUrl,
            direction: input.direction,
            user: input.userEmail || input.user || "manual",
            rowCount: 0,
            status: "Error",
            error: e.message
          });
        }
      }

      json(res, 200, { ok:true, processed: results.length, results });
      return;
    }

    json(res, 405, { ok:false, error:"Method not allowed" });
  }catch(e){
    json(res, 500, { ok:false, error: e.message });
  }
}

async function runOne({ accessToken, cfg, pair }){
  const sheetUrl = pair.sheetUrl;
  const larkUrl = pair.larkUrl;
  const direction = pair.direction === "sheet-to-lark" ? "sheet-to-lark" : "lark-to-sheet";

  const sheetId = pair.sheetId || parseGoogleSheetId(sheetUrl);
  if(!sheetId) throw new Error("Invalid Google Sheet URL");
  const parsed = parseLarkBase(larkUrl);
  const baseId = pair.baseId || parsed.baseId;
  const tableId = pair.tableId || parsed.tableId;
  if(!baseId || !tableId) throw new Error("Invalid Lark Base URL (need /base/<baseId>?table=<tableId>)");

  if(direction === "lark-to-sheet"){
    return await syncLarkToSheet({ accessToken, cfg, sheetId, baseId, tableId });
  }else{
    return await syncSheetToLark({ accessToken, cfg, sheetId, baseId, tableId });
  }
}
