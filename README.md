# Sheet ↔ Lark/Feishu Base Sync (v4) — OAuth User + Background Sync (No Service Account)

> ใช้ได้เฉพาะโดเมน `@shd-technology.co.th`  
> UI เป็นไฟล์เดียว: `public/index.html` (รวม CSS/JS ในไฟล์เดียว)

## Why v4
ระบบ v3 มีปัญหา access token หมดอายุเร็วและต้องใส่ token ไว้ใน Cron URL ทำให้ดูแลยากและเสี่ยง (ในคู่มือเดิมระบุเรื่อง token expiry และ cron URL ไว้ชัดเจน)  
v4 เปลี่ยนเป็น **Google OAuth Authorization Code + Refresh Token (offline)** โดยยังเป็น “OAuth user ล้วน ๆ” (ไม่ใช้ service account)  
Cron เรียก `/api/sync` ได้ตลอด **โดยไม่ต้องแนบ token ใน URL** เพราะ server แลก refresh_token เป็น access_token ให้เอง

## Features
- ✅ Login แบบ pop-up และบังคับ `hd=shd-technology.co.th`
- ✅ เลือก “ฝั่งหลัก” (Master):
  - Lark → Sheet
  - Sheet → Lark
- ✅ เก็บ “Sync Pairs” ลง Google History Sheet (Pairs tab) เพื่อให้ cron ทำงานต่อได้แม้ปิดเว็บ
- ✅ เก็บ “History log” ทุกครั้งที่ sync (History tab)
- ✅ รักษาลำดับแถว (Row ordering) ตาม `created_time` ของ Lark records เมื่อ Lark เป็นฝั่งหลัก

## IMPORTANT LIMITATIONS (เรื่องข้อมูลมหาศาล)
Google Sheets API / Lark API ไม่สามารถ sync “หลายล้านล้านแถว” แบบ real-time ใน 1 request ได้จริงบน serverless
ดังนั้น v4 ใช้แนวทาง:
- ✅ เหมาะกับระดับ **หลักพัน–หลักแสน** แถว (ขึ้นกับแผน Vercel, ความกว้างคอลัมน์, และ latency)
- ✅ รองรับ **chunk write/read** และจำกัด `MAX_ROWS_PER_SYNC`
- ✅ ถ้าต้องการระดับ “ใหญ่มาก” แนะนำ: แยกเป็นหลาย pairs ตามช่วงวันที่ / partition หรือทำ incremental ด้วย key + updated_at (ต่อยอดได้)

## Setup

### 1) สร้าง Google OAuth Client
Google Cloud Console → APIs & Services → Credentials  
สร้าง **OAuth client (Web application)**

**Authorized JavaScript origins**
- `https://<your-vercel-domain>`

**Authorized redirect URIs**
- `https://<your-vercel-domain>/api/auth/google/callback`

เปิดใช้ APIs:
- Google Sheets API

### 2) สร้าง Lark/Feishu App
Feishu/Lark Developer Console (open.feishu.cn หรือ open.larksuite.com):
- App ID / App Secret
- เปิดสิทธิ์ Bitable (read/write) ให้ app เข้าถึง base/table ที่จะ sync

### 3) ตั้งค่า Environment Variables บน Vercel
ใส่ใน Project → Settings → Environment Variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` (ต้องตรงกับ callback)
- `ALLOWED_DOMAIN` (ค่าเริ่มต้น `shd-technology.co.th`)
- `LARK_APP_ID`
- `LARK_APP_SECRET`
- `LARK_OPEN_API_BASE` (default `https://open.feishu.cn` for Feishu; set `https://open.larksuite.com` if using Lark)
- `HISTORY_SHEET_ID` = `1ZhiRnz1IAkfwLGoOTgF8CUZshHZ-ll5NqdR1nWvcIcE`
- `HISTORY_TAB` = `History`
- `PAIRS_TAB` = `Pairs`
- `SYNC_SECRET` = สุ่มยาว ๆ (ใช้เข้ารหัส refresh token)
- `MAX_ROWS_PER_SYNC` (default 5000)

### 4) เตรียม History Sheet
ในสเปรดชีต History ให้มี 2 แท็บ:

**History tab** แถว 1 เป็น header:
`Timestamp | Sheet URL | Lark URL | Direction | User | Row Count | Status | Error`

**Pairs tab** แถว 1 เป็น header:
`CreatedAt | SheetURL | SheetId | LarkURL | BaseId | TableId | Direction | User | RefreshEnc | Active | LastSyncAt | Notes`

> แนะนำให้ share History Sheet ให้เฉพาะทีมที่เกี่ยวข้อง (มีข้อมูล pair config)

## Usage
1) เปิดเว็บ → กด “Login with Google (SHD)”
2) วางลิงก์ Google Sheet และ Lark Base
3) เลือก “ฝั่งหลัก” (Master)
4) กด “Save Pair” (เพื่อให้ cron sync ต่อ)
5) กด “Sync Now” เพื่อทดสอบทันที
6) ตั้ง Cron เรียก:
   - `GET https://<your-vercel-domain>/api/sync`

## Cron
แนะนำ cron-job.org / UptimeRobot / หรือ Vercel Cron (Pro)
ตั้งถี่ตามที่ต้องการ เช่น ทุก 5–30 นาที

## Security Notes
- refresh token ถูกเข้ารหัสก่อนเก็บลง History Sheet (ด้วย `SYNC_SECRET`)
- ระบบตรวจ id_token และบังคับ domain ก่อนรับ refresh token
- ไม่ embed token ใน URL แล้ว

