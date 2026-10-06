// 临时探针：测单用户 TEXT_CONC=N 路并发出文（经 withTextSlot 闸门打 hy3 主池）的真实表现。
// 目的：回答"前端 TEXT_CONC 能调多大"——统计不同并发下的成功率/槽满率/上游429率/耗时。
// ⚠️ 测完即删（临时函数，勿进生产）。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const tcb = require('@cloudbase/node-sdk');
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-1';
const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();
const textModel = ai.createModel('cloudbase');
const TXT_MODEL = 'hy3';

class SlotBusyError extends Error {
  constructor(m) { super(m); this.name = 'SlotBusyError'; }
}

const TXT_SLOT_COL = 'counters';
const TXT_SLOT_PREFIX = 'txt_slot_';
const TXT_SLOT_N = 10;
const TXT_SLOT_TIMEOUT = 60000;
const SLOT_ACQUIRE_DB_ERROR = '__db_err__';
let txtSlotsReady = false;
async function ensureTxtSlotDoc(id) {
  try { await db.collection(TXT_SLOT_COL).doc(id).get(); }
  catch (e) { await db.collection(TXT_SLOT_COL).doc(id).set({ data: { busy: false, ts: 0 } }).catch(() => {}); }
}
async function acquireTxtSlot() {
  for (let i = 0; i < TXT_SLOT_N; i++) {
    const id = TXT_SLOT_PREFIX + i;
    try {
      await db.collection(TXT_SLOT_COL).where({ _id: id, busy: true, ts: _.lt(Date.now() - TXT_SLOT_TIMEOUT) }).update({ data: { busy: false } }).catch(() => {});
      const r = await db.collection(TXT_SLOT_COL).where({ _id: id, busy: false }).update({ data: { busy: true, ts: Date.now() } });
      if (r && r.stats && r.stats.updated > 0) return id;
    } catch (e) {
      return SLOT_ACQUIRE_DB_ERROR;
    }
  }
  return null;
}
async function releaseTxtSlot(id) {
  if (!id || id === SLOT_ACQUIRE_DB_ERROR) return;
  await db.collection(TXT_SLOT_COL).doc(id).update({ data: { busy: false } }).catch(() => {});
}
async function withTextSlot(fn) {
  if (!txtSlotsReady) {
    for (let i = 0; i < TXT_SLOT_N; i++) await ensureTxtSlotDoc(TXT_SLOT_PREFIX + i);
    txtSlotsReady = true;
  }
  const slotId = await acquireTxtSlot();
  if (slotId === null) throw new SlotBusyError('text channel busy');
  try { return await fn(); }
  finally { await releaseTxtSlot(slotId); }
}

const PROMPT = [{ role: 'user', content: '用10个字以内说一道家常菜的名字。只回名字。' }];

async function oneCall() {
  const t0 = Date.now();
  try {
    await withTextSlot(() => textModel.generateText({ model: TXT_MODEL, messages: PROMPT, temperature: 0.7, topP: 0.9 }));
    return { ok: true, busy: false, upstream429: false, ms: Date.now() - t0 };
  } catch (e) {
    const msg = String(e && e.message || '');
    const isBusy = e instanceof SlotBusyError;
    const is429 = /429/i.test(msg);
    return { ok: false, busy: isBusy, upstream429: is429, ms: Date.now() - t0, err: msg.slice(0, 80) };
  }
}

exports.main = async (event) => {
  const conc = Math.max(1, Math.min(20, parseInt(event && event.conc) || 2));
  const runs = Math.max(1, Math.min(5, parseInt(event && event.runs) || 3));
  const groups = [];
  for (let r = 0; r < runs; r++) {
    const results = await Promise.all(Array.from({ length: conc }, () => oneCall()));
    const ok = results.filter(x => x.ok).length;
    const busy = results.filter(x => x.busy).length;
    const u429 = results.filter(x => x.upstream429).length;
    const avgMs = Math.round(results.reduce((s, x) => s + x.ms, 0) / results.length);
    const maxMs = Math.max(...results.map(x => x.ms));
    groups.push({ run: r, conc, ok, busy, upstream429: u429, avgMs, maxMs });
  }
  return { conc, runs, groups, slotN: TXT_SLOT_N };
};
