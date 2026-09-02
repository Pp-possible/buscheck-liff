/**
 * app.js — BusCheck
 * bootstrap, router, api(), คิวออฟไลน์, กล้อง
 */

const CFG = window.BUSCHECK_CONFIG;

// ไอคอน SVG (อ้างอิง <symbol> ที่นิยามไว้ใน index.html) — ใช้แทน emoji ทั้งหมด
function ic(name, cls) {
  return '<svg class="icon' + (cls ? ' ' + cls : '') + '"><use href="#i-' + name + '"></use></svg>';
}

// ต้องประกาศก่อน boot() เรียกใช้ (renderHomeFromData_ อาจถูกเรียกจาก boot() ทันทีถ้ามีแคชอยู่แล้ว)
const TILE_ICONS = {
  scan: ic('camera'), vouchQr: ic('id-card'), myRounds: ic('list'), manageBus: ic('bus'), report: ic('bar-chart'),
  daySummary: ic('clipboard'), users: ic('user'), approvals: ic('clock'), notifications: ic('bell'), students: ic('graduation-cap')
};

const state = {
  sessionToken: null,
  persona: null,
  profile: null,
  permissions: [],
  buses: [],
  permVersion: 0,
  currentRoundId: null,
  busRounds: { BOARD: null, DROP: null },
  vouchTickets: [],
  vouchTicketIdx: 0,
  vouchTimer: null,
  regType: null,   // 'TEACHER' | 'STUDENT'
  teacherRegPassword: null,   // ผ่านหน้า S-00p แล้วเก็บไว้ส่งอีกทีตอน reg.submitTeacher จริง
  ticket: null,
  sponsor: null,
  html5Qr: null,
  html5QrVouch: null,
  scanHistory: {},  // clientEventId -> true, กันยิงซ้ำเร็วเกินไปจากกล้อง
  bootReady: false, // true เมื่อ auth.bootstrap ผ่านแล้วจริง (ก่อนหน้านี้หน้าจออาจวาดจากแคชไปก่อน)
  pendingRoute: null
};

// ---------------------------------------------------------------------------
// แคชหน้าจอ (stale-while-revalidate) — วาดจากของเก่าทันทีให้รู้สึกเหมือนเปิดแอพเกม
// แล้วค่อยยิงไปเซิร์ฟเวอร์เงียบ ๆ เพื่ออัปเดตทับ พร้อมปุ่มรีเฟรชให้กดยืนยันเอง
// ---------------------------------------------------------------------------

const CACHE_PREFIX = 'buscheck_cache_';

function cacheGet_(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function cacheSet_(key, data) {
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ data: data, cachedAt: Date.now() })); } catch (e) {}
}

function setSyncBadge_(elId, mode, ts) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.classList.remove('loading');
  if (mode === 'loading') { el.innerHTML = ic('refresh', 'btn-refresh-spin') + ' กำลังอัปเดต...'; el.classList.add('loading'); }
  else if (mode === 'cache') { el.innerHTML = ic('save') + ' ข้อมูลล่าสุดที่บันทึกไว้ — กำลังตรวจสอบใหม่'; }
  else if (mode === 'fresh') { el.innerHTML = ic('check-circle', 'icon-ok') + ' อัปเดตแล้ว ' + new Date(ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }); flashSynced_(elId); }
  else if (mode === 'error') { el.innerHTML = ic('alert-triangle', 'icon-error') + ' อัปเดตไม่สำเร็จ — แตะปุ่มรีเฟรชเพื่อลองใหม่'; }
}
function flashSynced_(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}
function spinRefreshBtn_(btnId, on) {
  const el = document.getElementById(btnId);
  if (el) el.classList.toggle('btn-refresh-spin', !!on);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function toast(msg, ms) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms || 2200);
}

function vibrate(pattern) { if (navigator.vibrate) navigator.vibrate(pattern); }

// กันกดปุ่มซ้ำระหว่างรอ API ตอบ (double-submit) — ปิดปุ่มไว้ระหว่างทำงาน คืนสภาพให้เสมอไม่ว่าสำเร็จ
// หรือพัง ปุ่มที่ปิดอยู่แล้วจะเห็นเป็นสีจาง ๆ ตาม .btn[disabled] ใน styles.css โดยอัตโนมัติ
function guardClick_(fn) {
  return async function (e) {
    const btn = e && e.currentTarget;
    if (btn) {
      if (btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';
      btn.disabled = true;
    }
    try { await fn(e); } finally {
      if (btn) { btn.disabled = false; delete btn.dataset.busy; }
    }
  };
}

function onClickGuarded_(id, fn) {
  document.getElementById(id).addEventListener('click', guardClick_(fn));
}

function beep(freq, duration) {
  try {
    const ctx = beep._ctx || (beep._ctx = new (window.AudioContext || window.webkitAudioContext)());
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq; osc.type = 'sine';
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration / 1000);
    osc.start(); osc.stop(ctx.currentTime + duration / 1000);
  } catch (e) { /* เสียงเป็นแค่ feedback เสริม ไม่ใช่ตัวบล็อกการทำงาน */ }
}

function feedbackSuccess() { beep(880, 120); vibrate(60); }
function feedbackTransfer() { beep(660, 160); vibrate([40, 40, 40]); }
function feedbackDuplicate() { beep(520, 100); vibrate([30, 30]); }
function feedbackError() { beep(220, 300); vibrate(300); }

const qrInstances_ = {};
function renderQr_(elId, text) {
  if (qrInstances_[elId]) {
    qrInstances_[elId].clear();
    qrInstances_[elId].makeCode(text);
  } else {
    document.getElementById(elId).innerHTML = '';
    qrInstances_[elId] = new QRCode(elId, { text: text, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
  }
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function thaiDateNow(date) {
  const d = date ? new Date(date) : new Date();
  const be = d.getFullYear() + 543;
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + be;
}

// scheduledAt = "YYYY-MM-DDTHH:mm" (ค่าจาก <input type=datetime-local> หรือจาก backend ตรง ๆ)
function formatThaiDateTime_(scheduledAt) {
  if (!scheduledAt || scheduledAt.indexOf('T') === -1) return '';
  const [datePart, timePart] = scheduledAt.split('T');
  const [y, m, dd] = datePart.split('-').map(Number);
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  return dd + ' ' + months[m - 1] + ' ' + (y + 543) + ' เวลา ' + timePart.slice(0, 5) + ' น.';
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === name));
  window.scrollTo(0, 0);
  if (name !== 'S-03' && state.html5Qr) stopScanCamera_();
  if (name !== 'S-00b' && state.html5QrVouch) stopVouchCamera_();
  if (name !== 'S-19' && state.vouchTimer) { clearInterval(state.vouchTimer); state.vouchTimer = null; }
}

document.addEventListener('click', (e) => {
  const back = e.target.closest('[data-back]');
  if (back) showScreen(back.dataset.back);
});

// ---------------------------------------------------------------------------
// api() — ทุก request เป็น POST, Content-Type: text/plain;charset=utf-8 (N10)
// ---------------------------------------------------------------------------

async function api(action, payload) {
  const body = { action: action, sessionToken: state.sessionToken, payload: payload || {} };
  let res;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000); // เชื่อมต่อค้าง (เช่น connection ตายเงียบใน webview) ต้องไม่แขวนถาวร
  try {
    res = await fetch(CFG.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: ac.signal
    });
  } catch (networkErr) {
    return { ok: false, data: null, error: { code: 'E_NETWORK', message: 'เชื่อมต่อไม่ได้ กรุณาตรวจสอบสัญญาณอินเทอร์เน็ต' } };
  } finally {
    clearTimeout(timer);
  }
  let json;
  try { json = await res.json(); } catch (e) {
    return { ok: false, data: null, error: { code: 'E_INTERNAL', message: 'เกิดข้อผิดพลาดของระบบ กรุณาลองใหม่' } };
  }
  if (typeof json.permVersion === 'number' && json.permVersion !== state.permVersion) {
    state.permVersion = json.permVersion;
    refreshProfileSilently_();
  }
  return json;
}

async function refreshProfileSilently_() {
  if (!state.sessionToken) return;
  const r = await api('me.profile', {});
  if (r.ok) {
    state.permissions = r.data.permissions;
    state.buses = r.data.buses;
  }
}

// ---------------------------------------------------------------------------
// คิวออฟไลน์ (6.9)
// ---------------------------------------------------------------------------

const QUEUE_KEY = 'buscheck_offline_queue';

function getQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch (e) { return []; } }
function setQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); updateOfflineBanner(); }

function enqueueScan(roundId, event) {
  const q = getQueue();
  if (q.length >= CFG.MAX_OFFLINE_QUEUE) { toast('คิวออฟไลน์เต็ม กรุณาหาสัญญาณอินเทอร์เน็ตด่วน'); return; }
  q.push({ roundId, event });
  setQueue(q);
}

function updateOfflineBanner() {
  const n = getQueue().length;
  ['offline-banner', 'offline-banner-2'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (n > 0) { el.innerHTML = ic('alert-triangle') + ' ยังไม่ส่ง ' + n + ' รายการ (ออฟไลน์)'; el.classList.add('show'); }
    else { el.classList.remove('show'); }
  });
}

async function flushQueue() {
  const q = getQueue();
  if (!q.length || !navigator.onLine) return;

  const byRound = {};
  q.forEach(item => { (byRound[item.roundId] = byRound[item.roundId] || []).push(item.event); });

  let duplicateCount = 0;
  const stillQueued = [];

  for (const roundId of Object.keys(byRound)) {
    const events = byRound[roundId].slice(0, CFG.MAX_OFFLINE_QUEUE);
    const r = await api('scan.submit', { roundId, events });
    if (!r.ok) { byRound[roundId].forEach(ev => stillQueued.push({ roundId, event: ev })); continue; }
    r.data.results.forEach(res => { if (res.result === 'DUPLICATE_IN_ROUND') duplicateCount++; });
    if (state.currentRoundId === roundId) renderScanCounts_(r.data.counts);
  }

  setQueue(stillQueued);
  if (duplicateCount > 0) toast(duplicateCount + ' รายการซ้ำกับที่มีคนเช็คไว้แล้ว');
}

setInterval(flushQueue, (CFG.OFFLINE_FLUSH_SEC || 5) * 1000);
window.addEventListener('online', flushQueue);
updateOfflineBanner();

// ---------------------------------------------------------------------------
// Bootstrap — จุดเริ่มต้นของแอพ
// ---------------------------------------------------------------------------

// รองรับลิงก์เจาะจงหน้า (?p=scan/vouch/bus) — ใช้กับปุ่ม Rich Menu ของบอทตอบกลับ (เฟส 3, 9.7)
// LIFF ตอน redirect ผ่านหน้า login อาจย้าย query string เดิมไปไว้ใน liff.state แทน จึงต้องเช็คทั้งสองที่
function deepLinkRoute_() {
  const ROUTE_MAP = { scan: 'S-02', vouch: 'S-19', bus: 'S-20' };
  let p = new URLSearchParams(location.search).get('p');
  if (!p && liff.state) p = new URLSearchParams(liff.state.replace(/^\?/, '')).get('p');
  return ROUTE_MAP[p] || null;
}

async function boot() {
  // เช็คลิงก์เจาะจงหน้า (?p=...) จาก URL ทันทีตั้งแต่ต้น ก่อน liff.init() เลย (อ่าน location.search
  // ได้โดยไม่ต้องรอ LIFF) เพื่อไม่ให้วาดหน้าแรกจาก cache ทับก่อน — ปุ่ม Rich Menu ที่ตั้งใจพาไปหน้า
  // เจาะจงจะได้ไม่ต้องเห็นหน้า home วาบขึ้นมาก่อนเด้งไปหน้าที่ต้องการ
  state.pendingRoute = deepLinkRoute_();

  // วาดหน้าแรกจากแคชทันที (ถ้าเคยเปิดสำเร็จมาก่อน) ก่อนรอ LIFF/เซิร์ฟเวอร์เลย — ข้ามขั้นนี้ถ้ามี
  // ลิงก์เจาะจงหน้าอยู่แล้ว เพราะปลายทางจริงไม่ใช่หน้าแรก ไม่ต้องวาดหน้าแรกให้เสียเวลา/วาบจอ
  const cachedHome = cacheGet_('home');
  if (cachedHome && cachedHome.data && !state.pendingRoute) {
    renderHomeFromData_(cachedHome.data);
    setSyncBadge_('s01-sync', 'cache', cachedHome.cachedAt);
    showScreen('S-01');
  }

  try {
    let idToken;
    try {
      await liff.init({ liffId: CFG.LIFF_ID });
      if (!liff.isLoggedIn()) { liff.login(); return; }
      idToken = liff.getIDToken();
      // liff.state มีค่าได้ก็ต่อเมื่อ liff.init() เสร็จแล้วเท่านั้น (LIFF ย้าย query string เดิมไปไว้ที่นี่
      // ตอน redirect ผ่านหน้า login) เช็คซ้ำอีกทีเผื่อรอบแรกจาก location.search เพียวๆ ยังไม่เจอ
      if (!state.pendingRoute) state.pendingRoute = deepLinkRoute_();
    } catch (e) {
      if (!cachedHome) toast('เปิดผ่าน LINE เท่านั้น กรุณาเปิดลิงก์นี้ในแอพ LINE');
      else { toast('เชื่อมต่อไม่ได้ กำลังแสดงข้อมูลล่าสุดที่บันทึกไว้'); setSyncBadge_('s01-sync', 'error'); }
      return;
    }
    if (!idToken) {
      if (!cachedHome) toast('ยืนยันตัวตนไม่สำเร็จ กรุณาเปิดแอพใหม่');
      return;
    }

    const r = await api('auth.bootstrap', { idToken: idToken });
    if (!r.ok) {
      if (r.error.code === 'E_PENDING_APPROVAL') { toast(r.error.message); return; }
      if (!cachedHome) toast(r.error.message || 'เข้าสู่ระบบไม่สำเร็จ');
      else { toast('เชื่อมต่อไม่ได้ กำลังแสดงข้อมูลล่าสุดที่บันทึกไว้'); setSyncBadge_('s01-sync', 'error'); }
      return;
    }

    state.permVersion = r.permVersion;

    if (!r.data.known) {
      renderGateModes_(r.data.gateModes);
      showScreen('S-00a');
      return;
    }

    applySession_(r.data);
    state.bootReady = true;

    if (state.persona === 'STUDENT') {
      showScreen('S-21');
      loadStudentHome_();
    } else if (state.pendingRoute) {
      // มีลิงก์เจาะจงหน้า — ไปหน้านั้นตรง ๆ เลย ไม่ต้องผ่านหน้าแรกให้เห็นวาบก่อน แต่ยังโหลดข้อมูล
      // หน้าแรกเงียบ ๆ อยู่เบื้องหลังไว้ด้วย (renderHome_ ไม่เรียก showScreen) กันหน้าแรกว่างเปล่า
      // ตอนกดย้อนกลับจากหน้าที่ลิงก์พาไป
      const route = state.pendingRoute;
      state.pendingRoute = null;
      navigateTile_(route);
      renderHome_({ silent: true });
    } else {
      showScreen('S-01');
      renderHome_({ silent: !!cachedHome });
    }
  } finally {
    window.__buscheckBootReady = true;
  }
}

function applySession_(data) {
  state.sessionToken = data.sessionToken;
  state.persona = data.persona;
  state.profile = data.profile;
  state.permissions = data.permissions || [];
}

function renderGateModes_(modes) {
  document.getElementById('btn-reg-teacher').style.display = modes.sponsorQr ? 'block' : 'none';
  document.getElementById('btn-reg-student').style.display = modes.sponsorQr ? 'block' : 'none';
}

document.getElementById('btn-logout').addEventListener('click', () => {
  state.sessionToken = null;
  try { liff.logout(); } catch (e) {}
  location.reload();
});

boot();

// ---------------------------------------------------------------------------
// S-00 — ลงทะเบียนด้วย QR ผู้รับรอง
// ---------------------------------------------------------------------------

// จำนวนขั้นตอนของแต่ละ regType ไม่เท่ากัน — ครูมีขั้น "รหัสผ่าน" (S-00p) แทรกก่อนสแกน QR ด้วย ส่วน
// นักเรียนไม่ต้องผ่านขั้นนี้เลย แถบบอกขั้นตอนจึงต้องคำนวณสด ๆ ตาม regType ทุกครั้งที่เปลี่ยนหน้า
const REG_STEPS_ = { TEACHER: ['S-00a', 'S-00p', 'S-00b', 'S-00c', 'S-00d'], STUDENT: ['S-00a', 'S-00b', 'S-00c', 'S-00d'] };
function renderStepBar_(elId, screenName, regType) {
  const el = document.getElementById(elId);
  if (!el) return;
  const steps = REG_STEPS_[regType] || REG_STEPS_.STUDENT;
  const activeIdx = Math.max(0, steps.indexOf(screenName));
  el.innerHTML = steps.map((s, i) => '<span class="seg' + (i < activeIdx ? ' done' : i === activeIdx ? ' active' : '') + '"></span>').join('');
}
renderStepBar_('s00a-steps', 'S-00a', 'STUDENT'); // regType ยังไม่ถูกเลือกตอนอยู่หน้านี้ — ใช้ค่าเริ่มต้นไปก่อน

document.getElementById('btn-reg-teacher').addEventListener('click', () => {
  state.regType = 'TEACHER';
  document.getElementById('reg-teacher-password').value = '';
  renderStepBar_('s00p-steps', 'S-00p', 'TEACHER');
  showScreen('S-00p');
});
document.getElementById('btn-reg-student').addEventListener('click', () => startVouchScan_('STUDENT'));

onClickGuarded_('btn-check-teacher-password', async () => {
  const password = document.getElementById('reg-teacher-password').value;
  if (!password) { toast('กรุณากรอกรหัสผ่าน'); return; }
  const r = await api('reg.checkTeacherPassword', { password: password });
  if (!r.ok) { toast(r.error.message); return; }
  state.teacherRegPassword = password;
  startVouchScan_('TEACHER');
});

function startVouchScan_(regType) {
  state.regType = regType;
  document.getElementById('s00b-back').dataset.back = regType === 'TEACHER' ? 'S-00p' : 'S-00a';
  document.getElementById('s00b-title').textContent = regType === 'TEACHER' ? 'ลงทะเบียนเป็นครู' : 'ลงทะเบียนเป็นนักเรียน';
  document.getElementById('s00b-instruction').textContent = regType === 'TEACHER'
    ? 'ให้ผู้ดูแลระบบสูงสุดเปิดหน้า "QR รับรองของฉัน" แล้วสแกนที่นี่'
    : 'ให้ครูเปิดหน้า "QR รับรองของฉัน" แล้วสแกนที่นี่';
  renderStepBar_('s00b-steps', 'S-00b', regType);
  showScreen('S-00b');
  startVouchCamera_();
}

function startVouchCamera_() {
  const el = document.getElementById('qr-reader-vouch');
  el.innerHTML = '';
  const qr = new Html5Qrcode('qr-reader-vouch');
  state.html5QrVouch = qr;
  qr.start({ facingMode: 'environment' }, { fps: 10, qrbox: 220 },
    (decodedText) => onVouchQrDecoded_(decodedText),
    () => {}
  ).catch(() => toast('เปิดกล้องไม่ได้ กรุณาอนุญาตการใช้กล้อง'));
}

function stopVouchCamera_() {
  if (state.html5QrVouch) { state.html5QrVouch.stop().catch(() => {}); state.html5QrVouch = null; }
}

let vouchScanLock = false;
async function onVouchQrDecoded_(rawQr) {
  if (vouchScanLock) return;
  vouchScanLock = true;
  stopVouchCamera_();

  let idToken;
  try { idToken = liff.getIDToken(); } catch (e) { idToken = null; }

  const r = await api('vouch.verify', { idToken: idToken, rawQr: rawQr, regType: state.regType });
  if (!r.ok) {
    feedbackError();
    toast(voutchErrorMessage_(r.error.code, r.error.message));
    vouchScanLock = false;
    startVouchCamera_();
    return;
  }

  feedbackSuccess();
  state.ticket = r.data.ticket;
  state.sponsor = r.data.sponsor;
  vouchScanLock = false;
  showVouchForm_(r.data);
}

function voutchErrorMessage_(code, fallback) {
  const map = {
    E_VOUCH_EXPIRED: 'QR หมดอายุแล้ว — ขอให้ผู้รับรองกดสร้างใหม่',
    E_VOUCH_LEVEL: fallback,
    E_WRONG_QR_FAMILY: 'นี่คือ QR ประจำตัวนักเรียน ไม่ใช่ QR ผู้รับรอง',
    E_VOUCH_USED: 'QR นี้ถูกใช้ไปแล้ว ขอให้ผู้รับรองสร้างใหม่',
    E_ALREADY_REGISTERED: 'บัญชี LINE นี้ลงทะเบียนไว้แล้ว'
  };
  return map[code] || fallback;
}

let s00cTimer = null;
function showVouchForm_(data) {
  document.getElementById('s00c-sponsor-name').textContent = data.sponsor.name;
  document.getElementById('s00c-sponsor-role').textContent = data.sponsor.role;

  const expiresAt = new Date(data.expiresAt).getTime();
  clearInterval(s00cTimer);
  s00cTimer = setInterval(() => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    const m = Math.floor(left / 60), s = left % 60;
    const badge = document.getElementById('s00c-countdown');
    badge.innerHTML = ic('clock') + ' กรอกให้เสร็จภายใน ' + m + ':' + String(s).padStart(2, '0') + ' นาที';
    badge.classList.toggle('warn', left <= 60 && left > 20);
    badge.classList.toggle('urgent', left <= 20);
    if (left <= 0) { clearInterval(s00cTimer); toast('หมดเวลากรอกฟอร์ม กรุณาสแกน QR ผู้รับรองใหม่'); showScreen('S-00a'); }
  }, 1000);

  document.getElementById('s00c-form-teacher').style.display = state.regType === 'TEACHER' ? 'block' : 'none';
  document.getElementById('s00c-form-student').style.display = state.regType === 'STUDENT' ? 'block' : 'none';

  renderStepBar_('s00c-steps', 'S-00c', state.regType);
  showScreen('S-00c');
}

onClickGuarded_('btn-submit-teacher', async () => {
  const fullName = document.getElementById('t-fullName').value.trim();
  const phone = document.getElementById('t-phone').value.trim();
  if (!fullName || !phone) { toast('กรุณากรอกชื่อและเบอร์โทรให้ครบ'); return; }

  const r = await api('reg.submitTeacher', {
    ticket: state.ticket, fullName: fullName, phone: phone,
    nickname: document.getElementById('t-nickname').value.trim(), password: state.teacherRegPassword
  });
  if (!r.ok) { toast(r.error.message); return; }
  applySession_(r.data);
  clearInterval(s00cTimer);
  document.getElementById('s00d-message').textContent = 'ลงทะเบียนสำเร็จ · สิทธิ์: ' + (r.data.user.role || 'ครูประจำรถ') + ' · รับรองโดย ' + state.sponsor.name;
  document.getElementById('s00d-qr-box').style.display = 'none';
  renderStepBar_('s00d-steps', 'S-00d', state.regType);
  showScreen('S-00d');
});

onClickGuarded_('btn-submit-student', async () => {
  const payload = {
    ticket: state.ticket,
    fullName: document.getElementById('s-fullName').value.trim(),
    nickname: document.getElementById('s-nickname').value.trim(),
    note: document.getElementById('s-note').value.trim(),
    phone: document.getElementById('s-phone').value.trim()
  };
  if (!payload.fullName || !payload.phone) {
    toast('กรุณากรอกข้อมูลให้ครบถ้วน'); return;
  }
  const r = await api('reg.submitStudent', payload);
  if (!r.ok) { toast(r.error.message); return; }
  applySession_({ sessionToken: r.data.sessionToken, persona: 'STUDENT', profile: r.data.student, permissions: [] });
  clearInterval(s00cTimer);
  document.getElementById('s00d-message').textContent = 'ลงทะเบียนสำเร็จ · ใช้ QR นี้ให้ครูสแกนตอนขึ้น-ลงรถ';
  document.getElementById('s00d-qr-box').style.display = 'block';
  renderQr_('s00d-qr-canvas', r.data.qrPayload);
  renderStepBar_('s00d-steps', 'S-00d', state.regType);
  showScreen('S-00d');
});

document.getElementById('btn-goto-home').addEventListener('click', () => {
  if (state.persona === 'STAFF') { showScreen('S-01'); renderHome_(); }
  else { showScreen('S-21'); loadStudentHome_(); }
});

// ---------------------------------------------------------------------------
// S-01 หน้าแรก
// ---------------------------------------------------------------------------

function renderHomeFromData_(data) {
  document.getElementById('s01-name').textContent = data.profile.nickname ? data.profile.name + ' (' + data.profile.nickname + ')' : data.profile.name;
  document.getElementById('s01-role').textContent = data.profile.role || '';
  document.getElementById('s01-sponsor').textContent = data.profile.registered_by_name
    ? 'เพิ่มโดย ' + data.profile.registered_by_name : '';
  document.getElementById('s01-avatar').innerHTML = data.profile.picture
    ? '<img src="' + data.profile.picture + '" alt="">'
    : '<svg class="icon"><use href="#i-user"/></svg>';

  const tilesWrap = document.getElementById('s01-tiles');
  tilesWrap.innerHTML = data.tiles.map(t => (
    '<div class="tile" data-tile="' + t.key + '" data-route="' + (t.route || '') + '">' +
    '<span class="icon-wrap">' + (TILE_ICONS[t.key] || ic('list')) + '</span>' +
    '<span class="label">' + t.label + '</span>' +
    (t.badge ? '<span class="badge">' + t.badge + '</span>' : '') +
    '</div>'
  )).join('');

  tilesWrap.querySelectorAll('.tile').forEach(el => {
    el.addEventListener('click', () => {
      const route = el.dataset.route;
      if (!state.bootReady) { state.pendingRoute = route; toast('กำลังเชื่อมต่อ รอสักครู่...'); return; }
      navigateTile_(route);
    });
  });
}

function navigateTile_(route) {
  if (route === 'S-02') { showScreen('S-02'); loadRounds_(); }
  else if (route === 'S-19') { showScreen('S-19'); startVouchQrLoop_(); }
  else if (route === 'S-20') { showScreen('S-20'); loadBuses_(); }
  else if (route === 'S-16') { showScreen('S-16'); initReportScreen_(); }
  else if (route === 'S-07') { showScreen('S-07'); initDaySummaryScreen_(); }
  else if (route === 'S-12') { showScreen('S-12'); loadUsersList_(); }
  else if (route === 'S-17') { showScreen('S-17'); loadApprovalsList_(); }
  else if (route === 'S-18') { showScreen('S-18'); loadStudentsList_(); }
  else if (route === 'S-13') { showScreen('S-13'); loadAlertsList_(); }
}

async function renderHome_(opts) {
  opts = opts || {};
  const cached = cacheGet_('home');
  if (cached && !opts.silent) {
    renderHomeFromData_(cached.data);
    setSyncBadge_('s01-sync', 'cache', cached.cachedAt);
  }
  setSyncBadge_('s01-sync', 'loading');
  spinRefreshBtn_('btn-refresh-home', true);

  const r = await api('me.home', {});
  spinRefreshBtn_('btn-refresh-home', false);
  if (!r.ok) {
    if (!cached) toast(r.error.message);
    setSyncBadge_('s01-sync', 'error');
    return;
  }

  cacheSet_('home', r.data);
  renderHomeFromData_(r.data);
  setSyncBadge_('s01-sync', 'fresh', Date.now());
}

document.getElementById('btn-refresh-home').addEventListener('click', () => renderHome_());

// ---------------------------------------------------------------------------
// S-02 เลือกรอบเช็ค
// ---------------------------------------------------------------------------

document.getElementById('btn-refresh-rounds').addEventListener('click', () => loadRounds_());

const ROUND_TYPE_LABELS_ = { BOARD: 'ขึ้นรถ', DROP: 'ลงรถ', HEADCOUNT: 'นับยอด', ACTIVITY: 'กิจกรรม' };

// จัดกลุ่มรอบที่ ชื่อรอบ+ประเภท+วันเวลา ตรงกันเป๊ะไว้การ์ดเดียวกัน (คนละคันรถ) — คีย์นี้คำนวณจากข้อมูล
// รอบที่มีอยู่แล้วล้วน ๆ ไม่ต้องมี field ใหม่ฝั่ง Firestore ถ้าแก้เวลา/ชื่อของคันใดคันหนึ่งภายหลัง
// จนไม่ตรงกับพี่น้องคันอื่นแล้ว ก็แค่หลุดไปอยู่การ์ดของตัวเอง ไม่ต้องจัดการอะไรเป็นพิเศษ
function groupRoundsForDisplay_(rounds) {
  const groups = {}; const order = [];
  rounds.forEach(r => {
    const key = r.round_name + '|' + r.round_type + '|' + r.scheduled_at;
    if (!groups[key]) { groups[key] = { key: key, round_name: r.round_name, round_type: r.round_type, scheduled_at: r.scheduled_at, rounds: [] }; order.push(key); }
    groups[key].rounds.push(r);
  });
  const list = order.map(k => groups[k]);
  list.sort((a, b) => String(b.scheduled_at || '').localeCompare(String(a.scheduled_at || ''))); // ใหม่ไปเก่า
  list.forEach(g => g.rounds.sort((a, b) => Number(a.seq) - Number(b.seq)));
  return list;
}

function aggregateGroupStatus_(group) {
  if (group.rounds.some(r => r.status === 'OPEN')) return 'OPEN';
  if (group.rounds.every(r => r.status === 'CLOSED')) return 'CLOSED';
  return 'PLANNED';
}

function attachSwipeHandlers_(list) {
  let startX = 0, currentX = 0;
  list.querySelectorAll('.swipeable').forEach(el => {
    el.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX;
      currentX = 0;
      el.style.transition = 'none';
    }, {passive: true});
    el.addEventListener('touchmove', e => {
      currentX = e.touches[0].clientX - startX;
      if (currentX > 0) currentX = 0; // only swipe left
      if (currentX < -100) currentX = -100; // max swipe
      el.style.transform = 'translateX(' + currentX + 'px)';
    }, {passive: true});
    el.addEventListener('touchend', e => {
      el.style.transition = 'transform 0.2s ease-out';
      if (currentX < -50) {
        el.style.transform = 'translateX(-80px)'; // snap open
      } else {
        el.style.transform = 'translateX(0)'; // snap close
      }
      currentX = 0;
    });
  });
}

// S-02/S-06: การ์ดสรุป "รอบเช็ค" หนึ่งใบต่อหนึ่ง (ชื่อรอบ+ประเภท+วันเวลา) — กดแล้วพาไปหน้า S-14
// ที่แสดงการ์ดรถแต่ละคันของรอบเช็คนั้น (แทนที่จะซ้อนการ์ดรถไว้ข้างในแบบเดิม)
function renderRoundsList_(rounds, opts) {
  opts = opts || {};
  const archivedList = !!opts.archived;
  const list = document.getElementById(opts.listElId || 's02-list');
  if (archivedList) state.archivedRoundsRaw = rounds; else state.activeRoundsRaw = rounds;

  if (!rounds.length) {
    list.innerHTML = '<div class="empty-state">' + (archivedList ? 'ยังไม่มีรอบที่เก็บไว้' : 'วันนี้ยังไม่มีรอบเช็ค') + '</div>';
    return;
  }

  state.roundsById = state.roundsById || {};
  rounds.forEach(r => { state.roundsById[r.round_id] = r; });

  const canManage = state.permissions && state.permissions.indexOf('round.open') !== -1;
  const groups = groupRoundsForDisplay_(rounds);

  list.innerHTML = groups.map(group => {
    const typeLabel = ROUND_TYPE_LABELS_[group.round_type] || group.round_type;
    const status = aggregateGroupStatus_(group);
    const statusClass = status === 'OPEN' ? 'open' : (status === 'CLOSED' ? 'closed' : '');
    const statusLabel = status === 'OPEN' ? 'เปิดอยู่' : status === 'CLOSED' ? 'ปิดแล้ว' : 'รอเปิด';
    const checked = group.rounds.reduce((s, r) => s + (r.checked || 0), 0);
    const expected = group.rounds.reduce((s, r) => s + (r.expected || 0), 0);

    // สลับ swipe: กลุ่มที่ยังไม่มีคันไหน OPEN/CLOSED เลย → ปัดลบทั้งกลุ่มได้เลย (ยังไม่มีข้อมูลเช็ค);
    // มีคันที่ OPEN หรือ CLOSED แล้วอย่างน้อยคันเดียว → ปัดเก็บทั้งกลุ่มเข้าประวัติแทน;
    // อยู่ในหน้าประวัติอยู่แล้ว → ปัดคืนทั้งกลุ่มกลับไปหน้ารอบเช็ควันนี้
    let swipeAction = null;
    if (canManage) {
      if (archivedList) swipeAction = { attr: 'data-restore-group', label: 'คืน', zoneClass: 'restore-zone', bgClass: 'archive-zone-bg' };
      else if (status === 'PLANNED') swipeAction = { attr: 'data-delete-group', label: 'ลบ', zoneClass: '', bgClass: '' };
      else swipeAction = { attr: 'data-archive-group', label: 'เก็บ', zoneClass: 'archive-zone', bgClass: 'archive-zone-bg' };
    }

    let html = '<div class="round-item ' + statusClass + (swipeAction ? ' ' + swipeAction.bgClass : '') + '" data-group="' + group.key + '">';
    if (swipeAction) {
      html += '<div class="round-item-actions ' + swipeAction.zoneClass + '" ' + swipeAction.attr + '="' + group.key + '">' + swipeAction.label + '</div>';
      html += '<div class="round-item-content swipeable" data-open-group="' + group.key + '">';
    } else {
      html += '<div class="round-item-content" data-open-group="' + group.key + '">';
    }

    html += '<div class="row1"><span class="status-badge">' + statusLabel + '</span> ' + formatThaiDateTime_(group.scheduled_at) + '</div>' +
      '<div class="progress">' + typeLabel + ' · ' + group.round_name + ' · ' + group.rounds.length + ' คัน · ' + checked + '/' + expected + ' คนแล้ว</div>' +
      (archivedList && canManage ? '<button class="btn btn-danger" style="margin-top:8px" data-delete-permanent-group="' + group.key + '">ลบถาวรทั้งกลุ่ม</button>' : '') +
      '<div class="drill-hint">ดูรายคันรถ →</div>' +
      '</div></div>';
    return html;
  }).join('');

  const afterChange = () => { if (archivedList) loadRoundHistory_({ silent: true }); else loadRounds_({ silent: true }); };

  list.querySelectorAll('[data-open-group]').forEach(el => el.addEventListener('click', () => {
    const group = groups.find(g => g.key === el.dataset.openGroup);
    if (group) navigateToSession_(group, archivedList);
  }));
  list.querySelectorAll('[data-delete-group]').forEach(btn => btn.addEventListener('click', guardClick_(async (e) => {
    if (!confirm('ยืนยันลบรอบเช็คทั้งกลุ่มนี้ (ทุกคันรถ)?')) return;
    const group = groups.find(g => g.key === e.currentTarget.dataset.deleteGroup);
    const results = await Promise.all(group.rounds.map(r => api('round.delete', { roundId: r.round_id })));
    toast(results.every(r => r.ok) ? 'ลบรอบสำเร็จ' : 'ลบไม่สำเร็จบางคัน');
    afterChange();
  })));
  list.querySelectorAll('[data-archive-group]').forEach(btn => btn.addEventListener('click', guardClick_(async (e) => {
    const group = groups.find(g => g.key === e.currentTarget.dataset.archiveGroup);
    const results = await Promise.all(group.rounds.map(r => api('round.archive', { roundId: r.round_id })));
    toast(results.every(r => r.ok) ? 'เก็บรอบเข้าประวัติแล้ว' : 'เก็บไม่สำเร็จบางคัน');
    afterChange();
  })));
  list.querySelectorAll('[data-delete-permanent-group]').forEach(btn => btn.addEventListener('click', guardClick_(async (e) => {
    e.stopPropagation(); // ปุ่มนี้อยู่ใน .round-item-content เดียวกับ data-open-group กันไม่ให้ bubble ไปเปิดหน้ารายละเอียดด้วย
    if (!confirm('ลบรอบเช็คทั้งกลุ่มนี้ถาวร (ทุกคันรถ)? ข้อมูลการเช็คจะหายไปด้วยและกู้คืนไม่ได้')) return;
    const group = groups.find(g => g.key === e.currentTarget.dataset.deletePermanentGroup);
    const results = await Promise.all(group.rounds.map(r => api('round.delete', { roundId: r.round_id })));
    toast(results.every(r => r.ok) ? 'ลบรอบถาวรแล้ว' : 'ลบไม่สำเร็จบางคัน');
    afterChange();
  })));
  list.querySelectorAll('[data-restore-group]').forEach(btn => btn.addEventListener('click', guardClick_(async (e) => {
    const group = groups.find(g => g.key === e.currentTarget.dataset.restoreGroup);
    const results = await Promise.all(group.rounds.map(r => api('round.restore', { roundId: r.round_id })));
    toast(results.every(r => r.ok) ? 'คืนรอบไปที่รอบเช็ควันนี้แล้ว' : 'คืนไม่สำเร็จบางคัน');
    afterChange();
  })));

  attachSwipeHandlers_(list);
}

// S-14: การ์ดรถแต่ละคันของ "รอบเช็ค" หนึ่งกลุ่มที่เลือกจาก S-02/S-06
function navigateToSession_(group, archived, backTo) {
  state.currentSession = { round_name: group.round_name, round_type: group.round_type, scheduled_at: group.scheduled_at, archived: !!archived };
  document.getElementById('s14-back').dataset.back = backTo || (archived ? 'S-06' : 'S-02');
  const typeLabel = ROUND_TYPE_LABELS_[group.round_type] || group.round_type;
  document.getElementById('s14-title').textContent = typeLabel + ' · ' + group.round_name;
  showScreen('S-14');
  renderSessionDetail_();
}

function renderSessionDetail_() {
  const s = state.currentSession;
  if (!s) return;
  const source = s.archived ? (state.archivedRoundsRaw || []) : (state.activeRoundsRaw || []);
  const rounds = source.filter(r => r.round_name === s.round_name && r.round_type === s.round_type && r.scheduled_at === s.scheduled_at);
  renderSessionBusCards_(rounds, { archived: s.archived });
}

function renderSessionBusCards_(rounds, opts) {
  opts = opts || {};
  const archivedList = !!opts.archived;
  const list = document.getElementById('s14-list');
  if (!rounds.length) {
    list.innerHTML = '<div class="empty-state">ไม่พบรอบเช็คนี้แล้ว อาจถูกย้ายหรือเปลี่ยนแปลงไป</div>';
    return;
  }

  state.roundsById = state.roundsById || {};
  rounds.forEach(r => { state.roundsById[r.round_id] = r; });

  const canManage = state.permissions && state.permissions.indexOf('round.open') !== -1;
  const canEdit = state.permissions && state.permissions.indexOf('round.edit') !== -1;
  const isSuperAdmin = !!(state.profile && state.profile.level === 100);

  list.innerHTML = rounds.map(round => {
    const statusClass = round.status === 'OPEN' ? 'open' : (round.status === 'CLOSED' ? 'closed' : '');
    const statusLabel = round.status === 'OPEN' ? 'เปิดอยู่' : round.status === 'CLOSED' ? 'ปิดแล้ว' : 'รอเปิด';
    const checkers = round.checkers.map(c => c.name).join(' + ') || 'ยังไม่มีใครเช็ค';
    const isPlanned = round.status === 'PLANNED';
    const isClosed = round.status === 'CLOSED';
    const busLabel = (state.busMap && state.busMap[round.scope_id]) || round.scope_id || '';

    // สลับ swipe: รอบใน "วันนี้" ที่ยัง PLANNED → ปัดลบได้เลย (ยังไม่มีข้อมูลเช็ค);
    // รอบที่ OPEN/CLOSED แล้ว → ปัดเก็บเข้าประวัติแทน (ย้อนกลับได้ ไม่ทำลายข้อมูล);
    // อยู่ในหน้าประวัติอยู่แล้ว → ปัดคืนกลับไปหน้ารอบเช็ควันนี้
    let swipeAction = null;
    if (canManage) {
      if (archivedList) swipeAction = { attr: 'data-restore', label: 'คืน', zoneClass: 'restore-zone', bgClass: 'archive-zone-bg' };
      else if (isPlanned) swipeAction = { attr: 'data-delete', label: 'ลบ', zoneClass: '', bgClass: '' };
      else swipeAction = { attr: 'data-archive', label: 'เก็บ', zoneClass: 'archive-zone', bgClass: 'archive-zone-bg' };
    }

    let html = '<div class="round-item ' + statusClass + (swipeAction ? ' ' + swipeAction.bgClass : '') + '" data-round="' + round.round_id + '" data-status="' + round.status + '">';
    if (swipeAction) {
      html += '<div class="round-item-actions ' + swipeAction.zoneClass + '" ' + swipeAction.attr + '="' + round.round_id + '">' + swipeAction.label + '</div>';
      html += '<div class="round-item-content swipeable">';
    } else {
      html += '<div class="round-item-content">';
    }

    html += '<div class="row1"><span class="status-badge">' + (busLabel || '—') + '</span> ' + round.checked + '/' + round.expected + ' ' + statusLabel + '</div>' +
      '<div class="progress">' + checkers + '</div>' +
      (isPlanned && !archivedList && isSuperAdmin ? '<button class="btn btn-secondary" style="margin-top:8px" data-open="' + round.round_id + '">เปิดรอบ</button>' : '') +
      (isPlanned && !archivedList && !isSuperAdmin ? '<button class="btn btn-secondary" style="margin-top:8px" data-wait-open="1">รอเปิด</button>' : '') +
      (round.status === 'OPEN' ? '<button class="btn btn-primary" style="margin-top:8px" data-enter="' + round.round_id + '">เช็คต่อ →</button>' : '') +
      (isClosed && canManage ? '<button class="btn btn-secondary" style="margin-top:8px" data-reopen="' + round.round_id + '">เปิดรอบอีกครั้ง</button>' : '') +
      ((isPlanned || round.status === 'OPEN') && canEdit ? '<button class="btn btn-secondary" style="margin-top:8px" data-edit="' + round.round_id + '">แก้ไข</button>' : '') +
      (canManage && !archivedList ? '<button class="btn btn-secondary" style="margin-top:8px" data-duplicate="' + round.round_id + '">ทำซ้ำ</button>' : '') +
      (canManage && archivedList ? '<button class="btn btn-danger" style="margin-top:8px" data-delete-permanent="' + round.round_id + '">ลบถาวร</button>' : '') +
      '</div></div>';
    return html;
  }).join('');

  const afterChange = async () => {
    if (archivedList) await loadRoundHistory_({ silent: true }); else await loadRounds_({ silent: true });
    renderSessionDetail_();
  };

  list.querySelectorAll('[data-open]').forEach(btn => btn.addEventListener('click', guardClick_(async (e) => {
    const roundId = e.currentTarget.dataset.open;
    const r = await api('round.open', { roundId });
    if (!r.ok) { toast(r.error.message); return; }
    toast('เปิดรอบแล้ว');
    await afterChange();
  })));
  list.querySelectorAll('[data-wait-open]').forEach(btn => btn.addEventListener('click', () => toast('รอ Super Admin เปิดรอบรถ')));
  list.querySelectorAll('[data-enter]').forEach(btn => btn.addEventListener('click', () => enterScanScreen_(btn.dataset.enter)));
  list.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => openCreateRoundDialog_(state.roundsById[btn.dataset.edit], false)));
  list.querySelectorAll('[data-duplicate]').forEach(btn => btn.addEventListener('click', () => openCreateRoundDialog_(state.roundsById[btn.dataset.duplicate], true)));
  list.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', guardClick_(async (e) => {
    if (!confirm('ยืนยันลบรอบเช็คนี้?')) return;
    const roundId = e.currentTarget.dataset.delete;
    const r = await api('round.delete', { roundId });
    if (!r.ok) { toast(r.error.message); return; }
    toast('ลบรอบสำเร็จ');
    await afterChange();
  })));
  list.querySelectorAll('[data-archive]').forEach(btn => btn.addEventListener('click', guardClick_(async (e) => {
    const roundId = e.currentTarget.dataset.archive;
    const r = await api('round.archive', { roundId });
    if (!r.ok) { toast(r.error.message); return; }
    toast('เก็บรอบเข้าประวัติแล้ว');
    await afterChange();
  })));
  list.querySelectorAll('[data-delete-permanent]').forEach(btn => btn.addEventListener('click', guardClick_(async (e) => {
    if (!confirm('ลบรอบนี้ถาวร? ข้อมูลการเช็คของรอบนี้จะหายไปด้วยและกู้คืนไม่ได้')) return;
    const roundId = e.currentTarget.dataset.deletePermanent;
    const r = await api('round.delete', { roundId });
    if (!r.ok) { toast(r.error.message); return; }
    toast('ลบรอบถาวรแล้ว');
    await afterChange();
  })));
  list.querySelectorAll('[data-restore]').forEach(btn => btn.addEventListener('click', guardClick_(async (e) => {
    const roundId = e.currentTarget.dataset.restore;
    const r = await api('round.restore', { roundId });
    if (!r.ok) { toast(r.error.message); return; }
    toast('คืนรอบไปที่รอบเช็ควันนี้แล้ว');
    await afterChange();
  })));
  list.querySelectorAll('[data-reopen]').forEach(btn => btn.addEventListener('click', guardClick_(async (e) => {
    const roundId = e.currentTarget.dataset.reopen;
    const r = await api('round.reopen', { roundId });
    if (!r.ok) { toast(r.error.message); return; }
    toast('เปิดรอบอีกครั้งแล้ว');
    await afterChange();
  })));

  attachSwipeHandlers_(list);
}

async function ensureBusMap_() {
  if (state.busMap) return;
  const r = await api('me.buses', {});
  state.busMap = {};
  if (r.ok) (r.data || []).forEach(b => { state.busMap[b.bus_id] = b.bus_name || b.bus_code; });
}

async function loadRounds_(opts) {
  opts = opts || {};
  const list = document.getElementById('s02-list');
  const cached = cacheGet_('rounds');
  if (cached && !opts.silent) {
    await ensureBusMap_();
    renderRoundsList_(cached.data);
    setSyncBadge_('s02-sync', 'cache', cached.cachedAt);
  } else if (!cached) {
    list.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  }
  setSyncBadge_('s02-sync', 'loading');
  spinRefreshBtn_('btn-refresh-rounds', true);

  const [r] = await Promise.all([api('round.today', {}), ensureBusMap_()]);
  spinRefreshBtn_('btn-refresh-rounds', false);
  if (!r.ok) {
    if (!cached) list.innerHTML = '<div class="empty-state">' + r.error.message + '</div>';
    setSyncBadge_('s02-sync', 'error');
    return;
  }

  cacheSet_('rounds', r.data);
  renderRoundsList_(r.data);
  setSyncBadge_('s02-sync', 'fresh', Date.now());
}

async function loadRoundHistory_(opts) {
  opts = opts || {};
  const list = document.getElementById('s06-list');
  const cached = cacheGet_('roundsArchived');
  if (cached && !opts.silent) {
    await ensureBusMap_();
    renderRoundsList_(cached.data, { archived: true, listElId: 's06-list' });
    setSyncBadge_('s06-sync', 'cache', cached.cachedAt);
  } else if (!cached) {
    list.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  }
  setSyncBadge_('s06-sync', 'loading');
  spinRefreshBtn_('btn-refresh-round-history', true);

  const [r] = await Promise.all([api('round.today', { archived: true }), ensureBusMap_()]);
  spinRefreshBtn_('btn-refresh-round-history', false);
  if (!r.ok) {
    if (!cached) list.innerHTML = '<div class="empty-state">' + r.error.message + '</div>';
    setSyncBadge_('s06-sync', 'error');
    return;
  }

  cacheSet_('roundsArchived', r.data);
  renderRoundsList_(r.data, { archived: true, listElId: 's06-list' });
  setSyncBadge_('s06-sync', 'fresh', Date.now());
}

document.getElementById('btn-goto-round-history').addEventListener('click', () => { showScreen('S-06'); loadRoundHistory_(); });
document.getElementById('btn-refresh-round-history').addEventListener('click', () => loadRoundHistory_());

// ---------------------------------------------------------------------------
// S-16 รายงาน: ใครเช็คใคร (มุมรายนักเรียน / รายครู)
// ---------------------------------------------------------------------------

document.getElementById('s16-tabs').querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => {
  document.querySelectorAll('#s16-tabs .chip').forEach(c => c.classList.remove('selected'));
  chip.classList.add('selected');
  const tab = chip.dataset.tab;
  document.getElementById('s16-student-panel').style.display = tab === 'student' ? 'block' : 'none';
  document.getElementById('s16-checker-panel').style.display = tab === 'checker' ? 'block' : 'none';
}));

function initReportScreen_() {
  document.getElementById('s16-tabs').querySelectorAll('.chip').forEach(c => c.classList.toggle('selected', c.dataset.tab === 'student'));
  document.getElementById('s16-student-panel').style.display = 'block';
  document.getElementById('s16-checker-panel').style.display = 'none';

  state.s16StudentId = null;
  document.getElementById('s16-student-search').value = '';
  document.getElementById('s16-student-results').innerHTML = '';
  document.getElementById('s16-student-timeline').innerHTML = '';
  document.getElementById('s16-student-date').value = new Date().toISOString().slice(0, 10);

  const to = new Date();
  const from = new Date(to.getTime() - 6 * 86400000);
  document.getElementById('s16-checker-to').value = to.toISOString().slice(0, 10);
  document.getElementById('s16-checker-from').value = from.toISOString().slice(0, 10);
  document.getElementById('s16-checker-result').innerHTML = '';
  loadCheckerPicker_();
}

let s16SearchDebounce = null;
document.getElementById('s16-student-search').addEventListener('input', (e) => {
  clearTimeout(s16SearchDebounce);
  const q = e.target.value.trim();
  const resultsEl = document.getElementById('s16-student-results');
  if (!q) { resultsEl.innerHTML = ''; return; }
  s16SearchDebounce = setTimeout(async () => {
    const r = await api('student.searchAll', { q: q });
    if (!r.ok) return;
    resultsEl.innerHTML = r.data.map(s =>
      '<div class="roster-row" data-pick="' + s.student_id + '" data-name="' + (s.nickname || s.name) + '"><div><div class="name">' + (s.nickname || s.name) + '</div>' +
      '<div class="meta">' + s.name + ' · ' + s.class + '</div></div></div>'
    ).join('') || '<div class="empty-state">ไม่พบรายชื่อ</div>';
    resultsEl.querySelectorAll('[data-pick]').forEach(row => row.addEventListener('click', () => {
      document.getElementById('s16-student-search').value = row.dataset.name;
      resultsEl.innerHTML = '';
      loadStudentTimeline_(row.dataset.pick);
    }));
  }, 300);
});

document.getElementById('s16-student-date').addEventListener('change', () => {
  if (state.s16StudentId) loadStudentTimeline_(state.s16StudentId);
});

async function loadStudentTimeline_(studentId) {
  state.s16StudentId = studentId;
  const date = document.getElementById('s16-student-date').value;
  const wrap = document.getElementById('s16-student-timeline');
  wrap.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  const r = await api('round.byStudent', { studentId: studentId, date: date });
  if (!r.ok) { wrap.innerHTML = '<div class="empty-state">' + r.error.message + '</div>'; return; }
  if (!r.data.timeline.length) { wrap.innerHTML = '<div class="empty-state">วันนั้นยังไม่มีการเช็คเลย</div>'; return; }
  wrap.innerHTML = r.data.timeline.map(t => (
    '<div class="roster-row"><div><div class="name">รอบ ' + t.seq + ' ' + t.round_name + '</div>' +
    '<div class="meta">' + new Date(t.checked_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) + ' · ' + (t.checked_by_name || '—') +
    (t.duplicate_attempts > 0 ? ' · เช็คซ้ำ ' + t.duplicate_attempts + ' ครั้ง' : '') + '</div></div></div>'
  )).join('');
}

async function loadCheckerPicker_() {
  const sel = document.getElementById('s16-checker-user');
  sel.innerHTML = '<option value="' + state.profile.user_id + '">ตัวเอง (' + state.profile.name + ')</option>';
  if (state.permissions.indexOf('user.view') !== -1) {
    const r = await api('user.list', {});
    if (r.ok) {
      r.data.filter(u => u.user_id !== state.profile.user_id).forEach(u => {
        sel.innerHTML += '<option value="' + u.user_id + '">' + u.display_name + ' (' + u.role_name + ')</option>';
      });
    }
  }
}

onClickGuarded_('btn-s16-checker-run', async () => {
  const userId = document.getElementById('s16-checker-user').value;
  const from = document.getElementById('s16-checker-from').value;
  const to = document.getElementById('s16-checker-to').value;
  const wrap = document.getElementById('s16-checker-result');
  if (!userId) { toast('กรุณาเลือกครู/เจ้าหน้าที่'); return; }
  wrap.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  const r = await api('round.byChecker', { userId: userId, from: from, to: to });
  if (!r.ok) { wrap.innerHTML = '<div class="empty-state">' + r.error.message + '</div>'; return; }
  const d = r.data;
  wrap.innerHTML = '<div class="card" style="margin:12px 0;">' +
    '<div class="card-title">สรุปผลงาน ' + d.from + ' – ' + d.to + '</div>' +
    '<div class="progress">รอบที่รับผิดชอบ ' + d.roundsResponsible + ' รอบ · เช็ค ' + d.studentsChecked + ' คน</div>' +
    '<div class="progress">เช็คซ้ำที่ถูกปฏิเสธ ' + d.duplicatesRejected + ' ครั้ง</div>' +
    (d.incompleteRounds > 0
      ? '<div style="color:var(--color-duplicate-text);font-weight:600;margin-top:4px;">' + ic('alert-triangle', 'icon-amber') + ' รอบที่ปิดไม่ครบ ' + d.incompleteRounds + ' รอบ</div>'
      : '') +
    '</div>';
});

// ---------------------------------------------------------------------------
// S-07 สรุปยอดวัน + หน้ากระทบยอด "ใครหาย เพราะอะไร"
// ---------------------------------------------------------------------------

// จับคู่ reason_code → day_status เป้าหมายตาม Reasons.applies_to (ดู schema.js REASON_DEFAULTS) —
// ไม่มี action ให้ดึงชีทนี้ผ่าน API จึงต้องจับคู่ตรงนี้ให้ตรงกับค่าที่ seed ไว้จริง
const REASON_STATUS_MAP_ = {
  SICK: 'ABSENT', LEAVE: 'ABSENT', PARENT_PICKUP: 'EXCUSED', OTHER_BUS_CONFIRMED: 'UNRESOLVED',
  PICKED_UP_AT_SCHOOL: 'EXCUSED', SCAN_MISSED: 'UNRESOLVED', STILL_SEARCHING: 'UNRESOLVED'
};
const REASON_LABELS_ = {
  SICK: 'ป่วย', LEAVE: 'ลากิจ', PARENT_PICKUP: 'ผู้ปกครองรับเอง', OTHER_BUS_CONFIRMED: 'ยืนยันแล้วว่าขึ้นรถคันอื่น',
  PICKED_UP_AT_SCHOOL: 'ผู้ปกครองมารับที่โรงเรียน', SCAN_MISSED: 'ขึ้น-ลงจริงแต่ลืมสแกน', STILL_SEARCHING: 'ยังตามหาอยู่'
};

document.getElementById('btn-refresh-daysummary').addEventListener('click', () => loadDaySummary_());

function initDaySummaryScreen_() {
  loadDaySummary_();
}

// สถานะรวมของ "รอบเช็ค" หนึ่งกลุ่ม (ทุกคันรถของชื่อรอบ+ประเภท+เวลาเดียวกัน) แสดงเป็น badge เดียว —
// ไม่มีแนวคิดเช้า/บ่ายเข้ามาเกี่ยวข้องเลย ยึดตามเวลาจริงที่ตั้งไว้ (scheduled_at) ของแต่ละรอบเท่านั้น
function sessionStatusMeta_(status) {
  if (status === 'CLOSED') return { label: 'เสร็จแล้ว', cls: 'badge-closed', icon: ic('check-circle') };
  if (status === 'OPEN') return { label: 'กำลังดำเนินการ', cls: 'badge-open', icon: ic('refresh') };
  return { label: 'รอเปิด', cls: 'badge-none', icon: ic('clock') };
}

// การ์ด dashboard ของ "รอบเช็ค" หนึ่งกลุ่ม — โชว์ทั้งตัวเลขจริง (checked/expected) และ progress bar
// เสมอคู่กัน (ไม่ใช้สีสื่อสถานะเพียงอย่างเดียว) กดแล้วเจาะดูรายคันรถได้ที่หน้าเดียวกับ S-02/S-14
function renderSessionDashboardCard_(group) {
  const typeLabel = ROUND_TYPE_LABELS_[group.round_type] || group.round_type;
  const status = aggregateGroupStatus_(group);
  const meta = sessionStatusMeta_(status);
  const checked = group.rounds.reduce((s, r) => s + (r.checked || 0), 0);
  const expected = group.rounds.reduce((s, r) => s + (r.expected || 0), 0);
  const pct = expected ? Math.round((checked / expected) * 100) : 0;
  return '<div class="round-item"><div class="round-item-content" data-open-group="' + group.key + '">' +
    '<div class="row1"><span class="status-badge ' + meta.cls + '">' + meta.icon + ' ' + meta.label + '</span> ' + formatThaiDateTime_(group.scheduled_at) + '</div>' +
    '<div class="progress">' + typeLabel + ' · ' + group.round_name + ' · ' + group.rounds.length + ' คัน</div>' +
    '<div class="progress-bar" style="margin:6px 0 4px;"><div class="progress-bar-fill" style="width:' + pct + '%"></div></div>' +
    '<div class="progress">' + checked + '/' + expected + ' คน (' + pct + '%)</div>' +
    '<div class="drill-hint">ดูรายคันรถ →</div>' +
    '</div></div>';
}

// dashboard หลักของหน้านี้ — เอารอบของ "ทั้งวัน" (เช้า+บ่ายรวมกัน จาก backend สองก้อน) มาจัดกลุ่มเป็น
// รอบเช็คแล้วเรียงตามเวลาจริงจากรอบแรกไปหลัง (อ่านเป็นลำดับเหตุการณ์ของวันนี้ ไม่ใช่ "ล่าสุดก่อน" แบบ S-02)
function renderSessionDashboard_(amRounds, pmRounds) {
  const rounds = (amRounds || []).concat(pmRounds || []);
  if (!rounds.length) return '<div class="empty-state">วันนี้ยังไม่มีรอบเช็ค</div>';
  state.roundsById = state.roundsById || {};
  rounds.forEach(r => { state.roundsById[r.round_id] = r; });
  state.activeRoundsRaw = rounds;

  const groups = groupRoundsForDisplay_(rounds).slice()
    .sort((a, b) => String(a.scheduled_at || '').localeCompare(String(b.scheduled_at || '')));
  return groups.map(renderSessionDashboardCard_).join('');
}

function wireSessionDashboardCards_() {
  document.querySelectorAll('#s07-summary [data-open-group]').forEach(el => el.addEventListener('click', () => {
    const groups = groupRoundsForDisplay_(state.activeRoundsRaw || []);
    const group = groups.find(g => g.key === el.dataset.openGroup);
    if (group) navigateToSession_(group, false, 'S-07');
  }));
}

async function loadDaySummary_() {
  const wrap = document.getElementById('s07-summary');
  wrap.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  document.getElementById('s07-reconcile').innerHTML = '';
  setSyncBadge_('s07-sync', 'loading');
  const [amR, pmR] = await Promise.all([
    api('day.summary', { direction: 'AM' }), api('day.summary', { direction: 'PM' }), ensureBusMap_()
  ]);
  if (!amR.ok || !pmR.ok) {
    wrap.innerHTML = '<div class="empty-state">' + ((!amR.ok && amR.error.message) || (!pmR.ok && pmR.error.message)) + '</div>';
    setSyncBadge_('s07-sync', 'error');
    return;
  }
  setSyncBadge_('s07-sync', 'fresh', Date.now());
  renderDaySummary_(amR.data, pmR.data);
}

// สถานะปิดยอดของวันนี้ "ก้อนเดียว" ไม่แยกเช้า/บ่ายให้ผู้ใช้ต้องเลือก — ข้างในยังเรียก day.close/
// day.unaccounted แยกช่วงตามที่ backend ต้องการ (โครงสร้างข้อมูลเดิมยังอิง AM/PM อยู่จริง) แต่รวมผล
// เป็นคำตอบเดียวว่า "ปิดได้หรือยัง" ให้ผู้ใช้ไม่ต้องรับรู้เรื่องช่วงเวลาเลย
function renderCloseStatus_(am, pm) {
  const canClose = state.permissions.indexOf('day.close') !== -1;
  const directions = [am, pm].filter(d => d.totals.expected > 0 || d.status === 'CLOSED');
  if (!directions.length) return '';

  if (directions.every(d => d.status === 'CLOSED')) {
    return '<div class="card" style="margin:12px 16px;"><div class="row1" style="font-weight:700;">' + ic('check-circle', 'icon-ok') + ' ปิดยอดวันนี้ครบแล้ว</div></div>';
  }

  const pending = directions.filter(d => d.status !== 'CLOSED');
  const totalUnaccounted = pending.reduce((s, d) => s + d.totals.unaccounted, 0);
  if (totalUnaccounted > 0) {
    return '<div class="card" style="margin:12px 16px;border-color:var(--color-error);">' +
      '<div style="color:var(--color-error);font-weight:700;">' + ic('alert-octagon') + ' ยังปิดยอดไม่ได้ — เหลือ ' + totalUnaccounted + ' คน</div>' +
      '<button class="btn btn-secondary btn-block" style="margin-top:10px;" id="btn-day-view-missing">ดูว่าใครหาย →</button>' +
      '</div>';
  }
  if (canClose) {
    return '<div class="card" style="margin:12px 16px;">' +
      '<div class="row1" style="font-weight:700;">' + ic('check-circle', 'icon-ok') + ' ยอดครบแล้ว พร้อมปิดยอด</div>' +
      '<button class="btn btn-primary btn-block" style="margin-top:8px;" id="btn-day-close">ปิดยอดวันนี้</button>' +
      '</div>';
  }
  return '<div class="empty-state">ยอดครบแล้ว รอผู้ดูแลกดปิดยอด</div>';
}

function renderDaySummary_(am, pm) {
  document.getElementById('s07-summary').innerHTML =
    renderSessionDashboard_(am.rounds, pm.rounds) +
    renderCloseStatus_(am, pm);

  wireSessionDashboardCards_();

  const closeBtn = document.getElementById('btn-day-close');
  if (closeBtn) closeBtn.addEventListener('click', guardClick_(async () => {
    const pending = [am, pm].filter(d => d.status !== 'CLOSED' && d.canClose);
    const results = await Promise.all(pending.map(d => api('day.close', { direction: d.direction })));
    const failed = results.find(r => !r.ok);
    toast(failed ? failed.error.message : 'ปิดยอดวันนี้แล้ว');
    loadDaySummary_();
  }));
  const missingBtn = document.getElementById('btn-day-view-missing');
  if (missingBtn) missingBtn.addEventListener('click', () => loadReconcile_());
}

async function loadReconcile_() {
  const wrap = document.getElementById('s07-reconcile');
  wrap.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  const date = new Date().toISOString().slice(0, 10);
  const [amR, pmR] = await Promise.all([
    api('day.unaccounted', { date: date, direction: 'AM' }),
    api('day.unaccounted', { date: date, direction: 'PM' })
  ]);
  if (!amR.ok && !pmR.ok) { wrap.innerHTML = '<div class="empty-state">' + amR.error.message + '</div>'; return; }
  const items = (amR.ok ? amR.data.items.map(it => Object.assign({}, it, { direction: 'AM' })) : [])
    .concat(pmR.ok ? pmR.data.items.map(it => Object.assign({}, it, { direction: 'PM' })) : []);
  renderReconcile_(items, date);
}

// รายชื่อคนค้างของทั้งวันรวมเป็นลิสต์เดียว (ไม่แยกการ์ดเช้า/บ่าย) — แต่ละคนยังจำ direction ของตัวเอง
// ไว้ใน dataset เพื่อส่งกลับไปกับ day.resolve ให้ถูกช่วง โดยผู้ใช้ไม่ต้องเลือกเองว่าเป็นช่วงไหน
function renderReconcile_(items, date) {
  const wrap = document.getElementById('s07-reconcile');
  if (!items.length) { wrap.innerHTML = '<div class="empty-state">ไม่มีใครค้างแล้ว</div>'; return; }
  const canResolve = state.permissions.indexOf('day.resolve') !== -1;

  wrap.innerHTML = '<div style="padding:0 16px;font-weight:700;margin:10px 0;">เหลือ ' + items.length + ' คนที่ยังไม่ลงตัว</div>' +
    items.map(it => (
      '<div class="card" style="margin:10px 16px;' + (it.severity === 'CRITICAL' ? 'border-color:var(--color-error);' : '') + '">' +
      '<div style="font-weight:700;">' + (it.severity === 'CRITICAL' ? ic('alert-octagon', 'icon-error') : ic('alert-triangle', 'icon-amber')) + ' ' + it.name + ' · ' + it.class + '</div>' +
      '<div class="progress">' + it.hint + '</div>' +
      (it.planned_bus && it.planned_bus.teacher ? '<div class="progress">ครูประจำรถ: ' + it.planned_bus.teacher + (it.planned_bus.teacher_phone ? ' · <a href="tel:' + it.planned_bus.teacher_phone + '">' + it.planned_bus.teacher_phone + '</a>' : '') + '</div>' : '') +
      (it.guardian && it.guardian.name ? '<div class="progress">ผู้ปกครอง: ' + it.guardian.name + (it.guardian.phone ? ' · <a href="tel:' + it.guardian.phone + '">' + it.guardian.phone + '</a>' : '') + '</div>' : '') +
      (canResolve
        ? '<div class="chip-group" style="margin-top:8px;">' +
        it.suggestedReasons.filter(rc => REASON_STATUS_MAP_[rc]).map(rc =>
          '<div class="chip" data-resolve="' + it.student_id + '" data-reason="' + rc + '" data-status="' + REASON_STATUS_MAP_[rc] + '" data-direction="' + it.direction + '">' + (REASON_LABELS_[rc] || rc) + '</div>'
        ).join('') +
        '</div>'
        : '') +
      '</div>'
    )).join('');

  wrap.querySelectorAll('[data-resolve]').forEach(chip => chip.addEventListener('click', guardClick_(async (e) => {
    const studentId = e.currentTarget.dataset.resolve;
    const reasonCode = e.currentTarget.dataset.reason;
    const status = e.currentTarget.dataset.status;
    const direction = e.currentTarget.dataset.direction;
    const r = await api('day.resolve', { date: date, direction: direction, items: [{ studentId: studentId, status: status, reasonCode: reasonCode }] });
    if (!r.ok) { toast(r.error.message); return; }
    toast('บันทึกแล้ว');
    loadReconcile_();
    loadDaySummary_();
  })));
}

// ---------------------------------------------------------------------------
// S-12 จัดการผู้ใช้และสิทธิ์
// ---------------------------------------------------------------------------

document.getElementById('btn-refresh-users').addEventListener('click', () => loadUsersList_());
document.getElementById('s12-search').addEventListener('input', debounce_(() => loadUsersList_(), 300));
document.getElementById('s12-tabs').querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => {
  document.querySelectorAll('#s12-tabs .chip').forEach(c => c.classList.remove('selected'));
  chip.classList.add('selected');
  loadUsersList_();
}));

function debounce_(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function loadUsersList_() {
  const list = document.getElementById('s12-list');
  list.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  setSyncBadge_('s12-sync', 'loading');
  const status = document.querySelector('#s12-tabs .chip.selected').dataset.status;
  const q = document.getElementById('s12-search').value.trim();
  const [usersR, rolesR] = await Promise.all([
    api('user.list', { status: status || undefined, q: q || undefined }),
    ensureRolesLoaded_()
  ]);
  if (!usersR.ok) { list.innerHTML = '<div class="empty-state">' + usersR.error.message + '</div>'; setSyncBadge_('s12-sync', 'error'); return; }
  setSyncBadge_('s12-sync', 'fresh', Date.now());
  renderUsersList_(usersR.data);
}

async function ensureRolesLoaded_() {
  if (state.rolesList) return state.rolesList;
  const r = await api('role.list', {});
  state.rolesList = r.ok ? r.data : [];
  return state.rolesList;
}

function renderUsersList_(users) {
  const list = document.getElementById('s12-list');
  if (!users.length) { list.innerHTML = '<div class="empty-state">ไม่พบผู้ใช้</div>'; return; }
  const myLevel = state.profile.level || 0;
  // เลือกได้เฉพาะ role ที่ level ต่ำกว่าตัวเองเคร่งครัด ยกเว้น SUPER_ADMIN (level 100) ตั้งอีกคนเป็น
  // SUPER_ADMIN ได้ —ตรงกับกฎ P1 ฝั่ง server ใน admin.js (server เช็คซ้ำอีกชั้นเสมอ)
  const grantable = (state.rolesList || []).filter(r => r.level < myLevel || (myLevel === 100 && r.role_code === 'SUPER_ADMIN'));

  list.innerHTML = users.map(u => (
    '<div class="roster-row" data-user="' + u.user_id + '" style="flex-direction:column;align-items:stretch;gap:6px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;">' +
    '<div><div class="name">' + u.display_name + (u.nickname ? ' (' + u.nickname + ')' : '') + '</div><div class="meta">เข้าใช้ล่าสุด ' + (u.last_login_at ? new Date(u.last_login_at).toLocaleString('th-TH') : 'ยังไม่เคย') + '</div></div>' +
    '<span class="status-badge" style="background:' + (u.status === 'ACTIVE' ? 'var(--color-board-badge)' : u.status === 'SUSPENDED' ? 'var(--color-error-badge)' : 'var(--color-absent-badge)') + '">' + u.status + '</span>' +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center;">' +
    '<select class="s12-role-select" data-user="' + u.user_id + '" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);">' +
    grantable.map(r => '<option value="' + r.role_code + '"' + (r.role_code === u.role_code ? ' selected' : '') + '>' + r.role_name_th + '</option>').join('') +
    (grantable.some(r => r.role_code === u.role_code) ? '' : '<option value="' + u.role_code + '" selected disabled>' + u.role_name + ' (ปัจจุบัน)</option>') +
    '</select>' +
    '<button class="btn btn-secondary" style="min-height:36px;padding:6px 10px;font-size:13px;" data-toggle-status="' + u.user_id + '" data-current-status="' + u.status + '">' + (u.status === 'SUSPENDED' ? 'เปิดใช้งาน' : 'ระงับ') + '</button>' +
    '</div>' +
    '</div>'
  )).join('');

  list.querySelectorAll('.s12-role-select').forEach(sel => {
    sel.dataset.prevValue = sel.value;
    sel.addEventListener('change', guardClick_(async (e) => {
      // เก็บ reference ของ <select> ไว้เองตั้งแต่ต้น — e.currentTarget จะเป็น null หลัง await
      // เพราะ browser เคลียร์ค่านี้ทิ้งทันทีที่ event dispatch จบรอบ (ก่อนโค้ดหลัง await จะรันต่อ)
      const target = e.currentTarget;
      const userId = target.dataset.user;
      const roleCode = target.value;
      const user = users.find(u => u.user_id === userId);
      let confirmName;
      if (roleCode === 'SUPER_ADMIN') {
        confirmName = prompt('ยืนยันการตั้งเป็นผู้ดูแลระบบสูงสุด — พิมพ์ชื่อ "' + user.display_name + '" ให้ตรงกัน');
        if (confirmName !== user.display_name) { toast('ชื่อไม่ตรงกัน ยกเลิกการเปลี่ยนสิทธิ์'); target.value = target.dataset.prevValue; return; }
      }
      const r = await api('user.setRole', { userId: userId, roleCode: roleCode, confirmName: confirmName });
      if (!r.ok) { toast(r.error.message); target.value = target.dataset.prevValue; return; }
      target.dataset.prevValue = roleCode;
      toast('เปลี่ยนสิทธิ์ ' + user.display_name + ' เป็น ' + r.data.user.role_name + ' แล้ว');
    }));
  });

  list.querySelectorAll('[data-toggle-status]').forEach(btn => btn.addEventListener('click', guardClick_(async (e) => {
    const userId = e.currentTarget.dataset.toggleStatus;
    const currentlySuspended = e.currentTarget.dataset.currentStatus === 'SUSPENDED';
    if (!currentlySuspended && !confirm('ระงับผู้ใช้คนนี้?')) return;
    const r = await api(currentlySuspended ? 'user.activate' : 'user.suspend', { userId: userId });
    if (!r.ok) { toast(r.error.message); return; }
    toast(currentlySuspended ? 'เปิดใช้งานแล้ว' : 'ระงับแล้ว');
    loadUsersList_();
  })));
}

// ---------------------------------------------------------------------------
// S-18 จัดการนักเรียน — ระงับ/เปิดใช้งานย้อนกลับได้เสมอ (student.setActive แค่เปลี่ยน status ไปมา
// ระหว่าง ACTIVE/INACTIVE ไม่เคยลบข้อมูลนักเรียนทิ้งจริง — ก่อนหน้านี้ไม่มีหน้าจอให้กดคืนสถานะเลย
// พอกด "ระงับ" (ผ่าน vouch.revoke ตอนเพิ่งลงทะเบียน) ไปแล้วเลยดูเหมือนต้องลงทะเบียนใหม่ทั้งที่จริง ๆ
// กู้คืนได้แค่ไม่มีปุ่มให้กด)
// ---------------------------------------------------------------------------

document.getElementById('btn-refresh-students').addEventListener('click', () => loadStudentsList_());
document.getElementById('s18-search').addEventListener('input', debounce_(() => loadStudentsList_(), 300));
document.getElementById('s18-tabs').querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => {
  document.querySelectorAll('#s18-tabs .chip').forEach(c => c.classList.remove('selected'));
  chip.classList.add('selected');
  loadStudentsList_();
}));

async function loadStudentsList_() {
  const list = document.getElementById('s18-list');
  list.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  setSyncBadge_('s18-sync', 'loading');
  const status = document.querySelector('#s18-tabs .chip.selected').dataset.status;
  const q = document.getElementById('s18-search').value.trim();
  const r = await api('student.list', { status: status || undefined, q: q || undefined });
  if (!r.ok) { list.innerHTML = '<div class="empty-state">' + r.error.message + '</div>'; setSyncBadge_('s18-sync', 'error'); return; }
  setSyncBadge_('s18-sync', 'fresh', Date.now());
  renderStudentsList_(r.data);
}

function renderStudentsList_(students) {
  const list = document.getElementById('s18-list');
  if (!students.length) { list.innerHTML = '<div class="empty-state">ไม่พบนักเรียน</div>'; return; }

  list.innerHTML = students.map(s => (
    '<div class="roster-row" style="flex-direction:column;align-items:stretch;gap:6px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;">' +
    '<div><div class="name">' + s.name + (s.nickname ? ' (' + s.nickname + ')' : '') + '</div>' +
    '<div class="meta">' + [s.student_code, s.class].filter(Boolean).join(' · ') + '</div></div>' +
    '<span class="status-badge ' + (s.status === 'ACTIVE' ? 'badge-open' : 'badge-none') + '">' + (s.status === 'ACTIVE' ? 'ใช้งานอยู่' : 'ระงับ') + '</span>' +
    '</div>' +
    '<button class="btn btn-secondary" style="min-height:36px;padding:6px 10px;font-size:13px;" data-toggle-student="' + s.student_id + '" data-current-status="' + s.status + '">' +
    (s.status === 'ACTIVE' ? 'ระงับ' : 'เปิดใช้งานอีกครั้ง') + '</button>' +
    '</div>'
  )).join('');

  list.querySelectorAll('[data-toggle-student]').forEach(btn => btn.addEventListener('click', guardClick_(async (e) => {
    const studentId = e.currentTarget.dataset.toggleStudent;
    const currentlyActive = e.currentTarget.dataset.currentStatus === 'ACTIVE';
    if (currentlyActive && !confirm('ระงับบัญชีนักเรียนคนนี้?')) return;
    const r = await api('student.setActive', { studentId: studentId, active: !currentlyActive });
    if (!r.ok) { toast(r.error.message); return; }
    toast(currentlyActive ? 'ระงับแล้ว' : 'เปิดใช้งานอีกครั้งแล้ว');
    loadStudentsList_();
  })));
}

// ---------------------------------------------------------------------------
// S-17 กล่องรออนุมัติ
// ---------------------------------------------------------------------------

document.getElementById('btn-refresh-approvals').addEventListener('click', () => loadApprovalsList_());

async function loadApprovalsList_() {
  const list = document.getElementById('s17-list');
  list.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  setSyncBadge_('s17-sync', 'loading');
  const [regsR] = await Promise.all([api('reg.list', { status: 'PENDING' }), ensureRolesLoaded_()]);
  if (!regsR.ok) { list.innerHTML = '<div class="empty-state">' + regsR.error.message + '</div>'; setSyncBadge_('s17-sync', 'error'); return; }
  setSyncBadge_('s17-sync', 'fresh', Date.now());
  renderApprovalsList_(regsR.data);
}

function renderApprovalsList_(regs) {
  const list = document.getElementById('s17-list');
  if (!regs.length) { list.innerHTML = '<div class="empty-state">ไม่มีคำขอรออนุมัติ</div>'; return; }
  const myLevel = state.profile.level || 0;
  const grantable = (state.rolesList || []).filter(r => r.level < myLevel);

  list.innerHTML = regs.map(r => {
    const isTeacher = r.reg_type === 'TEACHER';
    return '<div class="card" style="margin:10px 16px;" data-reg="' + r.reg_id + '">' +
      '<div class="card-title">' + (isTeacher ? ic('briefcase') : ic('graduation-cap')) + ' ' + r.full_name + (r.nickname ? ' (' + r.nickname + ')' : '') + '</div>' +
      '<div class="meta">' + (isTeacher ? (r.phone || '') : (r.class_level || '') + ' ' + (r.room || '')) + '</div>' +
      '<div class="meta">ยื่นเมื่อ ' + new Date(r.submitted_at).toLocaleString('th-TH') + '</div>' +
      (isTeacher
        ? '<div class="field" style="margin:8px 0 0;"><label>สิทธิ์ที่จะให้</label><select class="s17-role-select">' +
        grantable.map(rr => '<option value="' + rr.role_code + '">' + rr.role_name_th + '</option>').join('') + '</select></div>'
        : '') +
      '<div class="dialog-actions" style="margin-top:10px;">' +
      '<button class="btn btn-secondary" data-reject="' + r.reg_id + '">ไม่อนุมัติ</button>' +
      '<button class="btn btn-primary" data-approve="' + r.reg_id + '" data-type="' + r.reg_type + '">อนุมัติ</button>' +
      '</div></div>';
  }).join('');

  list.querySelectorAll('[data-approve]').forEach(btn => btn.addEventListener('click', guardClick_(async (e) => {
    const regId = e.currentTarget.dataset.approve;
    const type = e.currentTarget.dataset.type;
    const card = e.currentTarget.closest('.card');
    let r;
    if (type === 'TEACHER') {
      const roleCode = card.querySelector('.s17-role-select').value;
      if (!roleCode) { toast('กรุณาเลือกสิทธิ์'); return; }
      r = await api('reg.approveTeacher', { regId: regId, roleCode: roleCode });
    } else {
      r = await api('reg.approveStudent', { regId: regId });
    }
    if (!r.ok) { toast(r.error.message); return; }
    toast('อนุมัติแล้ว');
    loadApprovalsList_();
  })));

  list.querySelectorAll('[data-reject]').forEach(btn => btn.addEventListener('click', guardClick_(async (e) => {
    const reason = prompt('เหตุผลที่ไม่อนุมัติ');
    if (!reason) return;
    const r = await api('reg.reject', { regId: e.currentTarget.dataset.reject, reason: reason });
    if (!r.ok) { toast(r.error.message); return; }
    toast('ไม่อนุมัติแล้ว');
    loadApprovalsList_();
  })));
}

// ---------------------------------------------------------------------------
// S-13 ศูนย์แจ้งเตือน
// ---------------------------------------------------------------------------

document.getElementById('btn-refresh-alerts').addEventListener('click', () => loadAlertsList_());
document.getElementById('s13-tabs').querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => {
  document.querySelectorAll('#s13-tabs .chip').forEach(c => c.classList.remove('selected'));
  chip.classList.add('selected');
  loadAlertsList_();
}));

const ALERT_LEVEL_ICON_ = { CRITICAL: ic('alert-octagon', 'icon-error'), WARN: ic('alert-triangle', 'icon-amber'), INFO: ic('bell', 'icon-muted') };

async function loadAlertsList_() {
  const list = document.getElementById('s13-list');
  list.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  setSyncBadge_('s13-sync', 'loading');
  const status = document.querySelector('#s13-tabs .chip.selected').dataset.status;
  const r = await api('alert.list', { status: status || undefined });
  if (!r.ok) { list.innerHTML = '<div class="empty-state">' + r.error.message + '</div>'; setSyncBadge_('s13-sync', 'error'); return; }
  setSyncBadge_('s13-sync', 'fresh', Date.now());
  renderAlertsList_(r.data);
}

function renderAlertsList_(alerts) {
  const list = document.getElementById('s13-list');
  if (!alerts.length) { list.innerHTML = '<div class="empty-state">ไม่มีการแจ้งเตือน</div>'; return; }
  const canAck = state.permissions.indexOf('alert.ack') !== -1;

  list.innerHTML = alerts.map(a => (
    '<div class="card" style="margin:10px 16px;">' +
    '<div style="font-weight:700;">' + (ALERT_LEVEL_ICON_[a.level] || '') + ' ' + a.title + '</div>' +
    '<div class="progress">' + a.message + '</div>' +
    '<div class="meta">' + new Date(a.created_at).toLocaleString('th-TH') + '</div>' +
    (a.status === 'OPEN' && canAck
      ? '<button class="btn btn-secondary" style="margin-top:8px;" data-ack="' + a.alert_id + '">รับทราบ</button>'
      : a.status !== 'OPEN' ? '<div class="meta" style="margin-top:4px;">' + (a.status === 'ACKED' ? 'รับทราบแล้ว' : 'จบแล้ว') + '</div>' : '') +
    '</div>'
  )).join('');

  list.querySelectorAll('[data-ack]').forEach(btn => btn.addEventListener('click', guardClick_(async (e) => {
    const r = await api('alert.ack', { alertIds: [e.currentTarget.dataset.ack] });
    if (!r.ok) { toast(r.error.message); return; }
    toast('รับทราบแล้ว');
    loadAlertsList_();
  })));
}

document.getElementById('btn-new-round').addEventListener('click', () => openCreateRoundDialog_());
document.getElementById('dlg-create-round-cancel').addEventListener('click', () => {
  document.getElementById('dlg-create-round').classList.remove('show');
});
document.getElementById('dlg-create-round-back').addEventListener('click', () => showCreateRoundStep_(1));

function nowForDatetimeLocal_() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); // ตัด offset ออกก่อน toISOString ให้ได้เวลาท้องถิ่นตรง ๆ
  return d.toISOString().slice(0, 16);
}

// สลับขั้นตอนของ dialog สร้างรอบ — โหมดแก้ไขมีขั้นตอนเดียว (ไม่มีขั้นที่ 2 เพราะแก้ได้แค่คันเดียวที่มีอยู่แล้ว)
// โหมดสร้างใหม่/ทำซ้ำ ขั้นที่ 1 = ชื่อ/ประเภท/เวลา ขั้นที่ 2 = เลือกรถ (เลือกได้หลายคัน สร้างพร้อมกันทีเดียว)
function showCreateRoundStep_(step) {
  state.crStep = step;
  document.getElementById('cr-step1').style.display = step === 1 ? 'block' : 'none';
  document.getElementById('cr-step2').style.display = step === 2 ? 'block' : 'none';
  document.getElementById('dlg-create-round-cancel').style.display = step === 1 ? 'inline-flex' : 'none';
  document.getElementById('dlg-create-round-back').style.display = step === 2 ? 'inline-flex' : 'none';
  const submitBtn = document.getElementById('dlg-create-round-submit');
  submitBtn.textContent = state.crMode === 'edit' ? 'บันทึก' : (step === 1 ? 'ถัดไป' : 'สร้างรอบ');
}

// existingRound: ไม่ใส่ = สร้างใหม่, ใส่ + duplicate=false = แก้ไขรอบเดิม, ใส่ + duplicate=true = ทำซ้ำเป็นรอบใหม่
async function openCreateRoundDialog_(existingRound, duplicate) {
  const isEdit = !!(existingRound && !duplicate);
  state.crMode = isEdit ? 'edit' : 'create';

  document.getElementById('dlg-create-round-title').textContent = isEdit ? 'แก้ไขรอบเช็ค' : 'สร้างรอบเช็คใหม่';
  document.getElementById('cr-round-id').value = isEdit ? existingRound.round_id : '';
  document.getElementById('cr-name').value = existingRound ? existingRound.round_name : '';
  document.getElementById('cr-type').value = existingRound ? existingRound.round_type : 'BOARD';
  document.getElementById('cr-type').disabled = isEdit; // แก้ประเภทรอบเดิมไม่ได้ (round.update ไม่รองรับ) — ทำซ้ำเป็นรอบใหม่แทนถ้าอยากเปลี่ยน
  document.getElementById('cr-scheduled-at').value = (existingRound && existingRound.scheduled_at) ? existingRound.scheduled_at.slice(0, 16) : nowForDatetimeLocal_();
  document.getElementById('cr-require-all').checked = existingRound ? existingRound.require_all : true;
  document.getElementById('cr-edit-bus-field').style.display = isEdit ? 'block' : 'none';
  document.getElementById('dlg-create-round').classList.add('show');
  showCreateRoundStep_(1);

  const busSelEdit = document.getElementById('cr-bus');
  const busMulti = document.getElementById('cr-bus-multi');
  busSelEdit.innerHTML = '<option value="">กำลังโหลด...</option>';
  busMulti.innerHTML = '<div class="empty-state" style="padding:10px;">กำลังโหลด...</div>';

  const r = await api('me.buses', {});
  if (!r.ok) { toast('โหลดรายการรถไม่ได้: ' + r.error.message); busSelEdit.innerHTML = '<option value="">(โหลดไม่สำเร็จ)</option>'; return; }
  const buses = r.data || [];
  state.busMap = state.busMap || {};
  buses.forEach(b => { state.busMap[b.bus_id] = b.bus_name || b.bus_code; });

  if (isEdit) {
    busSelEdit.innerHTML = buses.map(b => '<option value="' + b.bus_id + '">' + b.bus_code + (b.bus_name && b.bus_name !== b.bus_code ? ' · ' + b.bus_name : '') + '</option>').join('') || '<option value="">(ไม่มีรถในขอบเขตของคุณ)</option>';
    if (buses.some(b => b.bus_id === existingRound.scope_id)) busSelEdit.value = existingRound.scope_id;
  } else {
    busMulti.innerHTML = buses.map(b =>
      '<div class="chip' + (duplicate && existingRound.scope_id === b.bus_id ? ' selected' : '') + '" data-bus="' + b.bus_id + '">' +
      b.bus_code + (b.bus_name && b.bus_name !== b.bus_code ? ' · ' + b.bus_name : '') + '</div>'
    ).join('') || '<div class="empty-state">ไม่มีรถในขอบเขตของคุณ</div>';
    busMulti.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => c.classList.toggle('selected')));
  }
}

// เตือนถ้ามีรอบชื่อ+ประเภท+เวลาเดียวกันอยู่แล้ว กันตั้งรอบซ้ำเวลาเดียวกันหลายครั้งโดยไม่ตั้งใจ — เป็นแค่คำเตือน
// ไม่บล็อกเด็ดขาด เผื่อบางครั้งตั้งใจสร้างซ้ำจริง ๆ (เช่น เที่ยวเสริม) ให้ยืนยันอีกทีก่อนเท่านั้น
function warnIfDuplicateRoundTime_(scheduledAt, roundType, roundName) {
  const existing = Object.values(state.roundsById || {}).some(r =>
    r.scheduled_at === scheduledAt && r.round_type === roundType && r.round_name === roundName
  );
  if (!existing) return true;
  return confirm('มีรอบ "' + roundName + '" เวลานี้อยู่แล้ว ต้องการสร้างซ้ำอีกหรือไม่?');
}

onClickGuarded_('dlg-create-round-submit', async () => {
  const roundName = document.getElementById('cr-name').value.trim();
  const scheduledAt = document.getElementById('cr-scheduled-at').value;
  const roundId = document.getElementById('cr-round-id').value;
  if (!roundName) { toast('กรุณาระบุชื่อรอบ'); return; }
  if (!scheduledAt) { toast('กรุณาระบุวันที่และเวลาตรวจยอด'); return; }

  if (roundId) {
    // โหมดแก้ไข — ขั้นตอนเดียว
    const busId = document.getElementById('cr-bus').value;
    if (!busId) { toast('กรุณาเลือกรถ'); return; }
    const r = await api('round.update', {
      roundId: roundId, roundName: roundName, scopeId: busId, scheduledAt: scheduledAt,
      requireAll: document.getElementById('cr-require-all').checked
    });
    if (!r.ok) { toast(r.error.message); return; }
    document.getElementById('dlg-create-round').classList.remove('show');
    toast('บันทึกการแก้ไขแล้ว');
    loadRounds_({ silent: true });
    return;
  }

  if (state.crStep === 1) {
    if (!warnIfDuplicateRoundTime_(scheduledAt, document.getElementById('cr-type').value, roundName)) return;
    showCreateRoundStep_(2);
    return;
  }

  const busIds = Array.from(document.querySelectorAll('#cr-bus-multi .chip.selected')).map(c => c.dataset.bus);
  if (!busIds.length) { toast('กรุณาเลือกรถอย่างน้อย 1 คัน'); return; }

  const roundType = document.getElementById('cr-type').value;
  const requireAll = document.getElementById('cr-require-all').checked;
  let created = 0; const failed = [];
  for (const busId of busIds) {
    // eslint-disable-next-line no-await-in-loop
    const r = await api('round.create', { scheduledAt: scheduledAt, scopeType: 'BUS', scopeId: busId, roundName: roundName, roundType: roundType, requireAll: requireAll });
    if (r.ok) created++; else failed.push((state.busMap[busId] || busId) + ': ' + r.error.message);
  }

  document.getElementById('dlg-create-round').classList.remove('show');
  document.getElementById('cr-name').value = '';
  if (failed.length) toast('สร้างสำเร็จ ' + created + ' คัน — ผิดพลาด: ' + failed.join(', '));
  else toast('สร้างรอบให้ ' + created + ' คันแล้ว');
  loadRounds_({ silent: true });
});

// ---------------------------------------------------------------------------
// S-03 หน้าสแกน
// ---------------------------------------------------------------------------

async function enterScanScreen_(roundId) {
  state.currentRoundId = roundId;
  const r = await api('round.get', { roundId: roundId });
  if (!r.ok) { toast(r.error.message); return; }
  const round = r.data;

  document.getElementById('s03-round-name').textContent = round.round_name + ' (รอบ ' + round.seq + ')';
  document.getElementById('s03-round-sub').textContent = thaiDateNow() + ' · ผู้เช็ค: ' + round.checkers.map(c => c.name).join(', ');
  renderScanCounts_({ expected: round.expected, checked: round.checked });
  document.getElementById('s03-feed').innerHTML = '';

  const isBoard = round.round_type === 'BOARD';
  document.getElementById('s03-mode-board').classList.toggle('active', isBoard);
  document.getElementById('s03-mode-drop').classList.toggle('active', !isBoard);

  showScreen('S-03');
  startScanCamera_();
}

function renderScanCounts_(counts) {
  const queued = getQueue().filter(q => q.roundId === state.currentRoundId).length;
  document.getElementById('s03-count-onboard').textContent = counts.checked != null ? counts.checked : (counts.expected - (counts.remaining || 0));
  document.getElementById('s03-count-checked').textContent = counts.checked;
  document.getElementById('s03-count-remaining').textContent = Math.max(0, (counts.expected || 0) - (counts.checked || 0));
  if (queued > 0) document.getElementById('s03-count-checked').textContent += ' (+' + queued + ' รอส่ง)';
}

function startScanCamera_() {
  const el = document.getElementById('qr-reader');
  el.innerHTML = '';
  const qr = new Html5Qrcode('qr-reader');
  state.html5Qr = qr;
  qr.start({ facingMode: 'environment' }, { fps: 10, qrbox: 240 },
    (decodedText) => onScanDecoded_(decodedText),
    () => {}
  ).catch(() => toast('เปิดกล้องไม่ได้ กรุณาอนุญาตการใช้กล้อง'));
}

function stopScanCamera_() {
  if (state.html5Qr) { state.html5Qr.stop().catch(() => {}); state.html5Qr = null; }
}

let scanLock = false;
async function onScanDecoded_(rawQr) {
  if (scanLock) return;
  scanLock = true;
  await submitScanEvent_(rawQr, 'QR');
  setTimeout(() => { scanLock = false; }, 800); // สแกนต่อเนื่องอัตโนมัติใน 0.8 วินาที
}

async function submitScanEvent_(raw, method, extra) {
  const clientEventId = uuid();
  const event = Object.assign({ clientEventId: clientEventId, raw: raw, method: method, scannedAt: new Date().toISOString() }, extra || {});

  if (!navigator.onLine) {
    enqueueScan(state.currentRoundId, event);
    addFeedItem_({ result: 'QUEUED', message: 'บันทึกไว้แล้ว (รอส่งเมื่อมีสัญญาณ)', student: null });
    return;
  }

  const r = await api('scan.submit', { roundId: state.currentRoundId, events: [event] });
  if (!r.ok) {
    feedbackError();
    toast(r.error.message);
    return;
  }
  const result = r.data.results[0];
  renderScanCounts_(r.data.counts);
  handleScanResult_(result, event);
}

function handleScanResult_(result, originalEvent) {
  switch (result.result) {
    case 'OK':
    case 'MOVED_FROM_OTHER_BUS':
      feedbackSuccess();
      if (result.result === 'MOVED_FROM_OTHER_BUS') feedbackTransfer();
      addFeedItem_(result);
      break;
    case 'NEEDS_CONFIRM':
      showTransferDialog_(result, originalEvent);
      break;
    case 'DUPLICATE_IN_ROUND':
      feedbackDuplicate();
      showDuplicateDialog_(result, originalEvent);
      break;
    case 'ROUND_NOT_OPEN':
    case 'NOT_ASSIGNED':
    case 'UNKNOWN_QR':
    case 'REVOKED_CARD':
    case 'E_WRONG_QR_FAMILY':
    case 'REJECTED_TIME':
      feedbackError();
      addFeedItem_(result);
      break;
    default:
      addFeedItem_(result);
  }
}

function addFeedItem_(result) {
  const feed = document.getElementById('s03-feed');
  const cls = result.result === 'OK' ? 'ok' : result.result === 'MOVED_FROM_OTHER_BUS' ? 'transfer' :
    result.result === 'DUPLICATE_IN_ROUND' ? 'duplicate' : 'error';
  const icon = cls === 'ok' ? ic('check-circle', 'icon-ok') : cls === 'transfer' ? ic('transfer') : cls === 'duplicate' ? ic('alert-triangle', 'icon-amber') : ic('x-circle', 'icon-error');
  const name = result.student ? (result.student.nickname || result.student.name) + ' (' + result.student.name + ')' : '';
  const sub = result.student ? result.student.class : '';
  const div = document.createElement('div');
  div.className = 'scan-feed-item ' + cls;
  div.innerHTML = '<span class="feed-icon">' + icon + '</span>' +
    '<div><div class="name">' + (name || result.message) + '</div>' +
    '<div class="sub">' + (name ? (sub + ' · ' + (result.message || '')) : '') + '</div>' +
    (result.student && result.student.medical_note ? '<div class="medical">' + ic('alert-triangle', 'icon-amber') + ' ' + result.student.medical_note + '</div>' : '') +
    '</div>';
  feed.insertBefore(div, feed.firstChild);
}

// ---- Dialog: ยืนยันย้ายรถ / เปิดสถานะใหม่ ----
let pendingTransfer = null;
function showTransferDialog_(result, originalEvent) {
  pendingTransfer = { result, originalEvent };
  document.getElementById('dlg-transfer-title').textContent = 'ยืนยันย้ายรถ?';
  document.getElementById('dlg-transfer-body').textContent = result.message;
  document.getElementById('dlg-confirm-transfer').classList.add('show');
}
document.getElementById('dlg-transfer-cancel').addEventListener('click', () => {
  document.getElementById('dlg-confirm-transfer').classList.remove('show');
  pendingTransfer = null;
});
onClickGuarded_('dlg-transfer-confirm', async () => {
  document.getElementById('dlg-confirm-transfer').classList.remove('show');
  if (!pendingTransfer) return;
  await submitScanEvent_(pendingTransfer.originalEvent.raw, pendingTransfer.originalEvent.method, { confirmTransfer: true });
  pendingTransfer = null;
});

// ---- Dialog: เช็คซ้ำ ----
let pendingDuplicate = null;
function showDuplicateDialog_(result, originalEvent) {
  pendingDuplicate = { result, originalEvent };
  document.getElementById('dlg-duplicate-body').innerHTML =
    (result.student ? '<strong>' + (result.student.nickname || result.student.name) + '</strong> · ' + result.student.name + '<br>' : '') +
    'เช็คโดย ' + result.existingCheck.checked_by_name + '<br>เมื่อ ' + new Date(result.existingCheck.checked_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) +
    ' (' + result.existingCheck.minutesAgo + ' นาทีที่แล้ว)';
  document.getElementById('dlg-duplicate-override').style.display = result.canOverride ? 'inline-flex' : 'none';
  document.getElementById('dlg-duplicate').classList.add('show');
}
document.getElementById('dlg-duplicate-ack').addEventListener('click', () => {
  document.getElementById('dlg-duplicate').classList.remove('show');
  pendingDuplicate = null;
});
onClickGuarded_('dlg-duplicate-override', async () => {
  document.getElementById('dlg-duplicate').classList.remove('show');
  if (!pendingDuplicate) return;
  const reason = prompt('ระบุเหตุผลที่เช็คทับ (เช่น เช็คผิดคน / ผลเดิมผิด)') || 'อื่น ๆ';
  await submitScanEvent_(pendingDuplicate.originalEvent.raw, pendingDuplicate.originalEvent.method, { confirmOverride: true, overrideReason: reason });
  pendingDuplicate = null;
});

// ---- ค้นหาชื่อ (บัตรหาย/QR เสีย) ----
let searchDebounce = null;
document.getElementById('s03-search').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const q = e.target.value.trim();
  const resultsEl = document.getElementById('s03-search-results');
  if (!q) { resultsEl.innerHTML = ''; return; }
  searchDebounce = setTimeout(async () => {
    const r = await api('student.searchAll', { q: q });
    if (!r.ok) return;
    resultsEl.innerHTML = r.data.map(s =>
      '<div class="roster-row" data-add="' + s.student_id + '"><div><div class="name">' + (s.nickname || s.name) + '</div>' +
      '<div class="meta">' + s.name + ' · ' + s.class + '</div></div></div>'
    ).join('') || '<div class="empty-state">ไม่พบรายชื่อ</div>';
    resultsEl.querySelectorAll('[data-add]').forEach(row => row.addEventListener('click', () => addStudentToRound_(row.dataset.add)));
  }, 300);
});

async function addStudentToRound_(studentId) {
  const r = await api('trip.addStudent', { roundId: state.currentRoundId, studentId: studentId, clientEventId: uuid() });
  document.getElementById('s03-search').value = '';
  document.getElementById('s03-search-results').innerHTML = '';
  if (!r.ok) { toast(r.error.message); return; }
  renderScanCounts_(r.data.counts);
  if (r.data.scanResult) handleScanResult_(r.data.scanResult, {});
}

document.getElementById('s03-mode-board').addEventListener('click', () => switchScanMode_('BOARD'));
document.getElementById('s03-mode-drop').addEventListener('click', () => switchScanMode_('DROP'));

async function switchScanMode_(type) {
  const r = await api('round.today', {});
  if (!r.ok) return;
  const round = r.data.find(x => x.round_id === state.currentRoundId);
  if (!round) return;
  const target = r.data.find(x => x.scope_id === round.scope_id && x.round_type === type && x.status === 'OPEN');
  if (!target) { toast('ยังไม่มีรอบประเภทนี้เปิดอยู่'); return; }
  enterScanScreen_(target.round_id);
}

document.getElementById('btn-goto-s04').addEventListener('click', () => { showScreen('S-04'); loadRoster_(); });
document.getElementById('btn-goto-s05').addEventListener('click', () => { showScreen('S-05'); loadCloseScreen_(); });

// ---------------------------------------------------------------------------
// S-04 รายชื่อ
// ---------------------------------------------------------------------------

let rosterCache = [];
let rosterTab = 'all';

async function loadRoster_() {
  const cacheKey = 'roster_' + state.currentRoundId;
  const cached = cacheGet_(cacheKey);
  if (cached) {
    rosterCache = cached.data;
    renderRosterList_();
    setSyncBadge_('s04-sync', 'cache', cached.cachedAt);
  } else {
    document.getElementById('s04-list').innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  }
  setSyncBadge_('s04-sync', 'loading');
  spinRefreshBtn_('btn-refresh-roster', true);

  const r = await api('round.checks', { roundId: state.currentRoundId });
  spinRefreshBtn_('btn-refresh-roster', false);
  if (!r.ok) {
    if (!cached) toast(r.error.message);
    setSyncBadge_('s04-sync', 'error');
    return;
  }

  cacheSet_(cacheKey, r.data.items);
  rosterCache = r.data.items;
  renderRosterList_();
  setSyncBadge_('s04-sync', 'fresh', Date.now());
}

document.querySelectorAll('#s04-tabs .chip').forEach(chip => chip.addEventListener('click', () => {
  document.querySelectorAll('#s04-tabs .chip').forEach(c => c.classList.remove('selected'));
  chip.classList.add('selected');
  rosterTab = chip.dataset.tab;
  renderRosterList_();
}));
document.getElementById('s04-search').addEventListener('input', renderRosterList_);
document.getElementById('btn-refresh-roster').addEventListener('click', loadRoster_);

function renderRosterList_() {
  const q = document.getElementById('s04-search').value.trim().toLowerCase();
  let items = rosterCache;
  if (rosterTab === 'pending') items = items.filter(i => !i.result);
  else if (rosterTab === 'onboard' || rosterTab === 'completed' || rosterTab === 'absent') {
    // ต้องอิงจาก DayRoster.day_status จริง — round.checks คืนแค่ผลรายรอบ จึงกรองแบบหยาบจาก result ที่มี
    items = items.filter(i => i.result === 'PRESENT');
  }
  if (q) items = items.filter(i => i.name.toLowerCase().indexOf(q) !== -1);

  const list = document.getElementById('s04-list');
  list.innerHTML = items.map(i => (
    '<div class="roster-row"><div><div class="name">' + i.name + '</div>' +
    '<div class="meta">' + (i.checked_by_name ? 'เช็คโดย ' + i.checked_by_name + ' · ' + (i.checked_at || '') : (i.hint || 'ยังไม่ถูกเช็ค')) + '</div></div>' +
    '<span class="status-pill">' + (i.result || 'รอ') + '</span></div>'
  )).join('') || '<div class="empty-state">ไม่มีรายชื่อ</div>';
}

// ---------------------------------------------------------------------------
// S-05 ปิดรอบ / ปิดเที่ยวรถ
// ---------------------------------------------------------------------------

function renderCloseSummary_(round) {
  document.getElementById('s05-round-summary').textContent = round.checked + '/' + round.expected + ' คน · เช็คซ้ำ ' + round.duplicateAttempts + ' ครั้ง';
}

async function loadCloseScreen_() {
  const cacheKey = 'close_' + state.currentRoundId;
  const cached = cacheGet_(cacheKey);
  if (cached) {
    renderCloseSummary_(cached.data);
    setSyncBadge_('s05-sync', 'cache', cached.cachedAt);
  }
  setSyncBadge_('s05-sync', 'loading');
  spinRefreshBtn_('btn-refresh-close', true);

  const rr = await api('round.get', { roundId: state.currentRoundId });
  spinRefreshBtn_('btn-refresh-close', false);
  if (!rr.ok) {
    if (!cached) toast(rr.error.message);
    setSyncBadge_('s05-sync', 'error');
    return;
  }

  cacheSet_(cacheKey, rr.data);
  renderCloseSummary_(rr.data);
  setSyncBadge_('s05-sync', 'fresh', Date.now());
}

document.getElementById('btn-refresh-close').addEventListener('click', loadCloseScreen_);

onClickGuarded_('btn-close-round', async () => {
  const r = await api('round.close', { roundId: state.currentRoundId });
  if (!r.ok) {
    if (r.error.code === 'E_ROUND_INCOMPLETE' && r.error.details) {
      showManageBlockersUI_(r.error.details.blockers);
      return;
    }
    toast(r.error.message);
    return;
  }
  toast('ปิดรอบแล้ว');
  showScreen('S-02'); loadRounds_();
});

function showManageBlockersUI_(blockers) {
  const wrap = document.getElementById('s05-round-card');
  const existing = wrap.querySelector('.blocker-list'); if (existing) existing.remove();
  const div = document.createElement('div');
  div.className = 'blocker-list';
  div.innerHTML = '<p style="color:var(--color-error);font-weight:700;">' + ic('alert-octagon') + ' ปิดรอบไม่ได้ — ยังมี ' + blockers.length + ' คนที่ยังไม่ระบุสถานะ</p>' +
    blockers.map(b => (
      '<div class="roster-row"><div class="name">' + b.name + '</div></div>' +
      '<div class="chip-group" style="margin:0 0 10px;">' +
      '<div class="chip" data-manage="ABSENT" data-student="' + b.student_id + '">ขาด</div>' +
      '<div class="chip" data-manage="EXCUSED" data-student="' + b.student_id + '">ผู้ปกครองรับเอง</div>' +
      '<div class="chip" data-manage="UNRESOLVED" data-student="' + b.student_id + '">ยังไม่ทราบ</div></div>'
    )).join('');
  wrap.appendChild(div);
  div.querySelectorAll('[data-manage]').forEach(chip => chip.addEventListener('click', guardClick_(async () => {
    const status = chip.dataset.manage;
    const reasonCode = status === 'ABSENT' ? 'NO_SHOW' : status === 'EXCUSED' ? 'PARENT_PICKUP' : 'STILL_SEARCHING';
    const r = await api('student.setStatus', {
      date: new Date().toISOString().slice(0, 10), direction: 'AM', studentId: chip.dataset.student,
      status: status, reasonCode: reasonCode, clientEventId: uuid()
    });
    if (r.ok) { chip.closest('.roster-row').nextSibling ? null : null; chip.parentElement.previousElementSibling.remove(); chip.parentElement.remove(); toast('บันทึกแล้ว'); }
    else toast(r.error.message);
  })));
}

onClickGuarded_('btn-close-trip', async () => {
  const rr = await api('round.get', { roundId: state.currentRoundId });
  if (!rr.ok) return;
  const r = await api('trip.close', { tripId: rr.data.trip_id });
  if (!r.ok) { toast(r.error.message); return; }
  toast('ปิดเที่ยวรถแล้ว');
  showScreen('S-01'); renderHome_();
});

// ---------------------------------------------------------------------------
// S-19 QR รับรองของฉัน
// ---------------------------------------------------------------------------

async function startVouchQrLoop_() {
  await refreshVouchTokens_();
  renderVouchesList_();
  if (state.vouchTimer) clearInterval(state.vouchTimer);
  state.vouchTimer = setInterval(tickVouchQr_, 1000);
  tickVouchQr_();
}

async function refreshVouchTokens_() {
  const r = await api('vouch.getMyQr', {});
  if (!r.ok) { toast(r.error.message); return; }
  state.vouchTickets = r.data.tokens;
  state.vouchTicketIdx = 0;
  const scope = 'ครู ' + (r.data.canVouch.teacher ? ic('check-circle', 'icon-ok') : ic('x-circle', 'icon-error')) +
    ' · นักเรียน ' + (r.data.canVouch.student ? ic('check-circle', 'icon-ok') : ic('x-circle', 'icon-error'));
  document.getElementById('s19-scope').innerHTML = 'QR นี้รับรองได้: ' + scope;
  document.getElementById('s19-usedtoday').textContent = 'วันนี้รับรองไปแล้ว ' + r.data.usedToday + ' คน' + (r.data.dailyLimit ? ' / ' + r.data.dailyLimit : ' (ไม่จำกัด)');
}

function tickVouchQr_() {
  if (!state.vouchTickets.length) return;
  const now = Date.now();
  let idx = state.vouchTicketIdx;
  while (idx < state.vouchTickets.length - 1 && new Date(state.vouchTickets[idx].validTo).getTime() < now) idx++;
  state.vouchTicketIdx = idx;
  const tokenObj = state.vouchTickets[idx];
  const left = Math.max(0, Math.round((new Date(tokenObj.validTo).getTime() - now) / 1000));
  document.getElementById('s19-countdown').innerHTML = ic('refresh') + ' เปลี่ยนใหม่ใน ' + left + ' วินาที';
  renderQr_('s19-qr-canvas', tokenObj.payload);

  if (idx >= state.vouchTickets.length - 2 && left < 60) refreshVouchTokens_();
}

document.getElementById('btn-vouch-new').addEventListener('click', refreshVouchTokens_);
onClickGuarded_('btn-vouch-revoke-all', async () => {
  if (!confirm('ยกเลิก QR ทั้งชุดที่ออกไปแล้ว?')) return;
  const r = await api('vouch.revokeAllTokens', {});
  if (r.ok) { toast('ยกเลิกแล้ว'); refreshVouchTokens_(); } else toast(r.error.message);
});

async function renderVouchesList_() {
  const r = await api('vouch.myVouches', {});
  if (!r.ok) return;
  const list = document.getElementById('s19-vouches-list');
  list.innerHTML = r.data.map(v => (
    '<div class="roster-row"><div><div class="name">' + v.full_name + ' (' + (v.reg_type === 'TEACHER' ? 'ครู' : 'นักเรียน') + ')</div>' +
    '<div class="meta">' + (v.submitted_at || '') + (v.revoked ? ' · ระงับแล้ว' : '') + '</div></div>' +
    (v.canRevoke ? '<button class="btn btn-danger" data-revoke="' + v.reg_id + '" style="min-height:36px;padding:6px 12px;">ไม่ใช่ฉัน</button>' : '') +
    '</div>'
  )).join('') || '<div class="empty-state">ยังไม่มีรายการ</div>';

  list.querySelectorAll('[data-revoke]').forEach(btn => btn.addEventListener('click', guardClick_(async () => {
    if (!confirm('ยืนยันระงับบัญชีนี้?')) return;
    const rr = await api('vouch.revoke', { regId: btn.dataset.revoke, reason: 'ไม่ใช่ฉัน' });
    if (rr.ok) { toast('ระงับบัญชีแล้ว'); renderVouchesList_(); } else toast(rr.error.message);
  })));
}

// ---------------------------------------------------------------------------
// S-20 จัดการรถ
// ---------------------------------------------------------------------------

function renderBusList_(buses) {
  const list = document.getElementById('s20-list');
  if (!buses.length) { list.innerHTML = '<div class="empty-state">ยังไม่มีรถในระบบ</div>'; return; }
  list.innerHTML = buses.map(b => (
    '<div class="roster-row" style="opacity:' + (b.is_active ? '1' : '0.45') + '">' +
    '<div style="flex:1">' +
    '<div class="name">' + ic('bus') + ' รถ ' + b.bus_code + (b.bus_name && b.bus_name !== b.bus_code ? ' · ' + b.bus_name : '') + '</div>' +
    '<div class="meta">' +
    (b.plate_no ? 'ทะเบียน ' + b.plate_no + ' · ' : '') +
    'จุ ' + (b.capacity || '—') + ' คน' +
    ' · นักเรียน ' + b.student_count + ' คน' +
    (b.is_active ? '' : ' · ปิดใช้งาน') +
    '</div>' +
    (b.note ? '<div class="meta" style="color:var(--text-muted)">' + b.note + '</div>' : '') +
    '</div>' +
    '<div style="display:flex;gap:6px;flex-shrink:0">' +
    '<button class="btn btn-secondary" style="min-height:36px;padding:6px 10px;" data-bus-edit="' + b.bus_id + '" aria-label="แก้ไขรถ ' + b.bus_code + '" title="แก้ไข">' + ic('pencil') + '</button>' +
    '<button class="btn ' + (b.is_active ? 'btn-danger' : 'btn-secondary') + '" style="min-height:36px;padding:6px 10px;font-size:13px;" data-bus-toggle="' + b.bus_id + '" data-bus-active="' + b.is_active + '">' + (b.is_active ? 'ปิด' : 'เปิด') + '</button>' +
    '</div>' +
    '</div>'
  )).join('');

  list.querySelectorAll('[data-bus-edit]').forEach(btn => btn.addEventListener('click', () => {
    const bus = buses.find(b => b.bus_id === btn.dataset.busEdit);
    if (bus) openBusDialog_(bus);
  }));

  list.querySelectorAll('[data-bus-toggle]').forEach(btn => btn.addEventListener('click', guardClick_(async () => {
    const busId = btn.dataset.busToggle;
    const currently = btn.dataset.busActive === 'true';
    const bus = buses.find(b => b.bus_id === busId);
    const busLabel = bus ? 'รถ ' + bus.bus_code : busId;
    if (currently && !confirm('ปิดใช้งาน ' + busLabel + '?\nรถที่ปิดจะไม่แสดงในรายการเลือกรถสำหรับรอบเช็คใหม่')) return;
    const r = await api('bus.setActive', { busId, active: !currently });
    if (r.ok) { toast(currently ? 'ปิดใช้งานแล้ว' : 'เปิดใช้งานแล้ว'); loadBuses_({ silent: true }); }
    else toast(r.error.message);
  })));
}

async function loadBuses_(opts) {
  opts = opts || {};
  const cached = cacheGet_('buses');
  if (cached && !opts.silent) {
    renderBusList_(cached.data);
    setSyncBadge_('s20-sync', 'cache', cached.cachedAt);
  }
  setSyncBadge_('s20-sync', 'loading');
  spinRefreshBtn_('btn-refresh-buses', true);

  const r = await api('bus.list', {});
  spinRefreshBtn_('btn-refresh-buses', false);
  if (!r.ok) {
    if (!cached) document.getElementById('s20-list').innerHTML = '<div class="empty-state">' + r.error.message + '</div>';
    setSyncBadge_('s20-sync', 'error');
    return;
  }

  cacheSet_('buses', r.data);
  renderBusList_(r.data);
  setSyncBadge_('s20-sync', 'fresh', Date.now());
}

function openBusDialog_(bus) {
  const isEdit = !!bus;
  document.getElementById('dlg-bus-title').textContent = isEdit ? 'แก้ไขรถ ' + bus.bus_code : 'เพิ่มรถใหม่';
  document.getElementById('be-bus-id').value = isEdit ? bus.bus_id : '';
  document.getElementById('be-code').value = isEdit ? bus.bus_code : '';
  document.getElementById('be-name').value = isEdit ? (bus.bus_name && bus.bus_name !== bus.bus_code ? bus.bus_name : '') : '';
  document.getElementById('be-plate').value = isEdit ? (bus.plate_no || '') : '';
  document.getElementById('be-cap').value = isEdit ? (bus.capacity || '') : '';
  document.getElementById('be-note').value = isEdit ? (bus.note || '') : '';
  document.getElementById('be-order').value = isEdit ? (bus.sort_order != null ? bus.sort_order : '') : '';
  document.getElementById('dlg-bus-edit').classList.add('show');
}

document.getElementById('btn-add-bus').addEventListener('click', () => openBusDialog_(null));
document.getElementById('btn-refresh-buses').addEventListener('click', () => loadBuses_());
document.getElementById('dlg-bus-cancel').addEventListener('click', () => document.getElementById('dlg-bus-edit').classList.remove('show'));

onClickGuarded_('dlg-bus-save', async () => {
  const busCode = document.getElementById('be-code').value.trim();
  if (!busCode) { toast('กรุณาระบุหมายเลข/ชื่อรถ'); return; }
  const busId = document.getElementById('be-bus-id').value;
  const payload = {
    busCode,
    busName: document.getElementById('be-name').value.trim(),
    plateNo: document.getElementById('be-plate').value.trim(),
    capacity: document.getElementById('be-cap').value,
    note: document.getElementById('be-note').value.trim(),
    sortOrder: document.getElementById('be-order').value
  };
  if (busId) payload.busId = busId;

  const r = await api('bus.upsert', payload);
  if (!r.ok) { toast(r.error.message); return; }
  document.getElementById('dlg-bus-edit').classList.remove('show');
  toast(busId ? 'บันทึกแล้ว' : 'เพิ่มรถสำเร็จ');
  loadBuses_({ silent: true });
});

// ---------------------------------------------------------------------------
// S-21/S-24 โหมดนักเรียน (persona = STUDENT) — เฟส 4, 8.5
// ---------------------------------------------------------------------------

async function loadStudentHome_(opts) {
  opts = opts || {};
  setSyncBadge_('s21-sync', 'loading');
  const r = await api('student.myHome', {});
  if (!r.ok) { toast(r.error.message); setSyncBadge_('s21-sync', 'error'); return; }

  const d = r.data;
  document.getElementById('s21-name').textContent = d.profile.nickname ? d.profile.name + ' (' + d.profile.nickname + ')' : d.profile.name;
  document.getElementById('s21-class').textContent = [d.profile.class, d.bus ? d.bus.bus_name : ''].filter(Boolean).join(' · ');
  document.getElementById('s21-sponsor').textContent = d.profile.registered_by_name ? 'เพิ่มโดย ' + d.profile.registered_by_name : '';
  document.getElementById('s21-avatar').innerHTML = d.profile.picture
    ? '<img src="' + d.profile.picture + '" alt="">'
    : '<svg class="icon"><use href="#i-user"/></svg>';

  const qrCard = document.getElementById('s21-qr-card');
  if (d.qrPayload) { qrCard.style.display = 'block'; renderQr_('s21-qr-canvas', d.qrPayload); }
  else qrCard.style.display = 'none';

  setSyncBadge_('s21-sync', 'fresh', Date.now());
}

document.getElementById('btn-refresh-student-home').addEventListener('click', () => loadStudentHome_());
document.getElementById('s21-tile-history').addEventListener('click', () => { showScreen('S-24'); loadStudentHistory_(); });

function renderStudentHistoryItem_(h) {
  const typeLabel = ROUND_TYPE_LABELS_[h.round_type] || h.round_type;
  const timeText = h.checked_at ? new Date(h.checked_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '';
  return '<div class="round-item"><div class="round-item-content">' +
    '<div class="row1">' + thaiDateNow(h.checked_at) + ' · ' + timeText + ' น.</div>' +
    '<div class="progress">' + [typeLabel, h.round_name].filter(Boolean).join(' · ') + '</div>' +
    '<div class="progress">' + [h.bus_name, h.checked_by_name ? 'สแกนโดย ' + h.checked_by_name : ''].filter(Boolean).join(' · ') + '</div>' +
    (h.transferred_from_bus_name ? '<div class="warn">' + ic('transfer') + ' ย้ายรถ: ' + h.transferred_from_bus_name + ' → ' + (h.bus_name || '—') + '</div>' : '') +
    '</div></div>';
}

async function loadStudentHistory_() {
  const list = document.getElementById('s24-list');
  list.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  const r = await api('student.myHistory', {});
  if (!r.ok) { list.innerHTML = '<div class="empty-state">' + r.error.message + '</div>'; return; }
  if (!r.data.length) { list.innerHTML = '<div class="empty-state">ยังไม่มีประวัติการเดินทาง</div>'; return; }
  list.innerHTML = r.data.map(renderStudentHistoryItem_).join('');
}

