# Cron setup (v4)

## Goal
ให้ระบบซิงค์ “ต่อเนื่อง” แม้ user ปิดหน้าเว็บแล้ว

## วิธีที่แนะนำ
### A) cron-job.org (ฟรี)
1) สร้าง cronjob ใหม่
2) URL: `https://<your-vercel-domain>/api/sync`
3) Method: GET
4) Schedule: ทุก 5–30 นาที (ตามความเหมาะสม)

> v4 จะไม่ embed token ใน URL แล้ว

## สิ่งที่ต้องตั้งค่าเพิ่มใน Vercel (สำคัญ)
Cron mode ต้องอ่าน Pairs tab และถอดรหัส refresh token ที่บันทึกไว้  
ดังนั้นต้องใส่ env ตัวนี้:

- `SYNC_OWNER_REFRESH_TOKEN`

ค่าเป็น **Google OAuth refresh token ของ “เจ้าของระบบ” 1 คน** (ยังเป็น OAuth user ล้วน ๆ ไม่ใช่ service account)

### วิธีเอา SYNC_OWNER_REFRESH_TOKEN
1) login ผ่านหน้าเว็บครั้งแรก (ระบบจะได้ refresh token)
2) เปิด DevTools → Application → LocalStorage → `google_refresh_token`
3) Copy ค่านั้นไปใส่ใน Vercel env `SYNC_OWNER_REFRESH_TOKEN`

> เจ้าของระบบต้องมีสิทธิ์ “แก้ไข” History Sheet และ Sheets ที่จะ sync

