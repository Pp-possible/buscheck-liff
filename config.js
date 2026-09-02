// config.js — ไฟล์เดียวที่แก้ตอน deploy (17.13)
// backend คือ Firebase Cloud Function (functions/) ไม่ใช่ Google Apps Script แล้ว —
// เหลือชื่อ key ว่า GAS_URL ไว้ (ไม่เปลี่ยนชื่อ เพื่อไม่ต้องแตะ app.js) แต่ค่าคือ URL ของ Cloud Function
window.BUSCHECK_CONFIG = {
  LIFF_ID: '2011340916-jNIJUaEi',
  GAS_URL: 'https://asia-southeast1-bus-chechin.cloudfunctions.net/api',
  POLL_ROSTER_SEC: 10,
  POLL_DASHBOARD_SEC: 20,
  OFFLINE_FLUSH_SEC: 5,
  MAX_OFFLINE_QUEUE: 500
};
