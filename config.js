// config.js — ไฟล์เดียวที่แก้ตอน deploy (17.13)
// ลำดับ deploy: deploy Apps Script ก่อน -> ได้ GAS_URL -> ใส่ที่นี่ -> อัปโหลดหน้าเว็บ
// -> เอา URL หน้าเว็บไปใส่เป็น Endpoint ของ LIFF -> ได้ LIFF_ID -> ใส่ที่นี่ -> อัปโหลดอีกครั้ง
window.BUSCHECK_CONFIG = {
  LIFF_ID: '2011340916-jNIJUaEi',
  GAS_URL: 'https://asia-southeast1-bus-chechin.cloudfunctions.net/api',
  POLL_ROSTER_SEC: 10,
  POLL_DASHBOARD_SEC: 20,
  OFFLINE_FLUSH_SEC: 5,
  MAX_OFFLINE_QUEUE: 500
};
