// 必须先用 wx-server-sdk 初始化云环境上下文，否则 @cloudbase/node-sdk 的 app.ai() 在模块加载阶段会同步抛错，
// 导致 exports.main 未挂载 → 运行时报 "handler not found"。与 getRecommendation 顶部保持一致。
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const tcb = require('@cloudbase/node-sdk');
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-1'; // 支持环境变量覆盖，便于环境迁移
const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();
const imageModelObj = ai.createImageModel('hunyuan-image');  // ⑦ 模块级单例，避免每次调用重建
const aiGateway = require('./utils/aiGateway');
// 阶段 3 读取统一：菜图 _id=norm_id（与分表系一致），D12 弱归一口径
let normLexName;
try { ({ normLexName } = require('./normLexName')); }
catch (e) { ({ normLexName } = require('../_shared/normLexName')); }

const IMAGE_MODEL_ID = 'HY-Image-3.0-Plus-4090-Tob-v1.0';

// 出图溢出已退役：hy3-preview 是文本模型、无法替代图片生成，且 env2 跨账号代理已移除，
// 故出图通道繁忙时直接返回 430，由前端退避重试（见下方 if(!slotId) 分支）。
// —— 出图全局并发限流（分布式信号量）——
// 混元 image 上游并发上限≈14（2026-08-16 探针实测：N=14 全成功、N=15 起触发 429 限流），规模上来后所有云函数实例同时打上游会集体 429 雪崩。
// 用 counters 集合（已存在）里的 N 个槽位文档做全局互斥：同一时刻最多 N 个请求在调上游，
// 其余立即返回 430 由前端退避重试（不在云端排队占实例，避免实例枯竭雪崩）。带超时回收防实例崩溃泄漏。
const SLOT_COL = 'counters';
const SLOT_PREFIX = 'img_slot_';
const SLOT_N = 10;           // 全局出图并发上限（混元 image 上游实测≈14，取 10 留余量削峰，低于上限避免 429 雪崩）
const SLOT_TIMEOUT = 60000;  // 单槽位最长占用(ms)，超时强制回收，防实例崩溃泄漏导致通道永久堵塞

async function ensureSlotDoc(db, id) {
  try {
    await db.collection(SLOT_COL).doc(id).get();
  } catch (e) {
    // 文档不存在 → 初始化（set 幂等覆盖，并发重复无害）
    await db.collection(SLOT_COL).doc(id).set({ data: { busy: false, ts: 0 } }).catch(() => {});
  }
}
async function acquireSlot(db, _) {
  for (let i = 0; i < SLOT_N; i++) {
    const id = SLOT_PREFIX + i;
    try {
      // 回收超时占用（防止实例崩溃未释放导致通道永久堵塞）
      await db.collection(SLOT_COL).where({ _id: id, busy: true, ts: _.lt(Date.now() - SLOT_TIMEOUT) }).update({ data: { busy: false } }).catch(() => {});
      // 原子抢占空闲槽位
      const r = await db.collection(SLOT_COL).where({ _id: id, busy: false }).update({ data: { busy: true, ts: Date.now() } });
      if (r && r.stats && r.stats.updated > 0) return id;
    } catch (e) { /* 忽略，尝试下一个 */ }
  }
  return null;
}
async function releaseSlot(db, id) {
  if (!id) return;
  await db.collection(SLOT_COL).doc(id).update({ data: { busy: false } }).catch(() => {});
}


// 汤羹识别：汤必须用碗/盅盛装，禁止杯装+冰块（与 env2 bypassGenImage 同款，确保两边判断一致）
function looksLikeSoup(name, dish) {
  if (dish && (dish.category === '汤羹' || dish.type === '汤' || dish.type === '汤羹')) return true;
  const nm = (name || '').replace(/\s/g, '');
  if (!nm) return false;
  if (/茶汤/.test(nm)) return false; // 茶汤本质为茶饮，非汤羹
  return /(汤|羹|煲|砂锅|锅仔|粥)$/.test(nm);
}

// 饮品识别（与 env2 bypassGenImage.looksLikeDrink 同款逻辑，确保两边判断一致）
// 汤羹类一律先由 looksLikeSoup 抢走，不在此判定为饮品
function looksLikeDrink(name, dish) {
  if (dish && (dish.cuisine === '饮品' || dish.category === '饮品')) return true;
  if (looksLikeSoup(name, dish)) return false;
  const nm = (name || '').replace(/\s/g, '');
  if (!nm) return false;
  return /^(热|温|冰|鲜|五谷|原味|低糖)?(豆浆|豆奶|牛奶|酸奶|羊奶|椰奶|燕麦奶|花生奶|米汤|米浆|芝麻糊|核桃露|杏仁露|热可可|可可|奶茶|柠檬水|酸梅汤|可乐|雪碧|汽水|气泡水|矿泉水|纯净水|温开水|凉白开|开水|咖啡|拿铁|美式|红茶|绿茶|花茶|乌龙茶|蜂蜜水|姜茶|藕粉|奶昔|龟苓膏)$|奶茶|柠檬水|酸梅汤|可乐|雪碧|汽水|气泡|咖啡|拿铁|豆浆|牛奶|酸奶|豆奶|椰汁|椰奶|米汤|可可|芝麻糊|藕粉|奶昔|蜂蜜水|姜茶/.test(nm)
    || /(茶|咖啡|奶|汁|饮|水|露|糊|浆)$/.test(nm);
}

// 水果饮品识别：果汁/果茶/水果茶及含具体水果名的饮品类，必须突出具体水果品类
function looksLikeFruitDrink(name, dish) {
  const nm = (name || '').replace(/\s/g, '');
  if (!nm) return false;
  return /(橙|柚|莓|桃|梨|苹果|葡萄|芒果|西瓜|柠檬|百香果|荔枝|火龙果|猕猴桃|草莓|菠萝|木瓜|石榴|香蕉|杨桃|山楂|蓝莓|树莓|果茶|水果茶|果汁|鲜榨|果蔬)/.test(nm)
    || /(汁|茶)$/.test(nm) && /(果|莓|橙|桃|梨|葡萄|芒果|西瓜|柠檬|椰)/.test(nm);
}

// 冰饮识别：仅名称含「冰」或明确冷饮才允许画冰块；其余默认常温/热饮禁冰块
function looksLikeIcedDrink(name, dish) {
  const nm = (name || '').replace(/\s/g, '');
  if (!nm) return false;
  return /^(冰|冰镇|冰饮)/.test(nm)
    || /(冰咖啡|冰美式|冰拿铁|冰红茶|冰绿茶|冰乌龙|冰果汁|冰可乐|冰沙|冰镇.*饮)$/.test(nm);
}

// 纯茶识别（泡好的茶汤，非奶茶/果茶）：红/绿/花/乌龙/普洱/白茶/龙井等，强调「一杯茶汤」而非散装干茶叶
function looksLikePlainTea(name, dish) {
  const nm = (name || '').replace(/\s/g, '');
  if (!nm) return false;
  if (/奶|果|汁/.test(nm)) return false; // 奶茶/果茶/果汁不走纯茶分支
  return /茶/.test(nm);
}

// 清蒸做法识别：菜名含「蒸」即命中（与 env2 bypassGenImage 同款）。置于汤羹/饮品之后、普通菜之前。
function looksLikeSteam(name) {
  const nm = String(name || '').replace(/\s/g, '');
  return nm.indexOf('蒸') >= 0;
}

// 单道菜出图提示词（与 env2 bypassGenImage 同款结构化约束框架，确保两边风格与规则一致）
// 分支：汤羹 / 饮品（冰饮）/ 饮品（常温·热饮）/ 水果饮品 / 清蒸 / 普通菜
// 熟食硬约束（2026-09-06 用户反馈配图像活体）：正向描述置前（模型对否定词不敏感），匹配菜名含动物/蛋类即加
function hardFoodConstraints(name) {
  const out = [];
  if (/蛙|田鸡|龟|甲鱼|鳖|鸡|鸭|鹅|鸽|鹌鹑|鱼|鳝|泥鳅|虾|蟹|鱿|章鱼|兔|驴|牛|羊|猪|排骨|肉/.test(name)) {
    out.push('最重要：图中是烹饪完成的熟食菜肴，食材已去头去内脏斩成小块后装盘，是盘中的一道菜；严禁出现活体动物、任何动物头部、眼睛、嘴巴、皮毛、完整禽形');
  }
  if (/鸡|鸭|鹅|鸽|鹌鹑/.test(name)) out.push('禽类已斩件成均匀小块码放盘中，看不到头颈爪和完整禽形');
  if (/蛋|羹/.test(name)) out.push('蛋类已剥壳，呈现剥壳后白净完整的蛋体或蛋液制品（煎蛋/蒸蛋/卤蛋切面），严禁出现完整带壳生蛋');
  out.push('画面中只能出现这一道菜，严禁出现其他菜品、配菜拼盘、额外盘子里的食物');
  return out.join('，');
}

function buildImagePrompt(name, dish) {
  const dishName = name && name.length ? name : '美食';
  const neg = '禁止生成文字、Logo、水印、二维码；禁止插画、简笔画、卡通、3D 渲染风格；禁止出现人手或多只餐具；禁止杂乱背景与过度饱和滤镜；禁止在热饮、汤羹、热食中出现冰块；禁止用笼统纯色液体替代具体水果，水果饮品必须呈现真实水果实体；严禁出现活体动物、动物头颅、眼睛、嘴巴、舌头，蛙/龟/甲鱼/禽类/鱼类等食材必须呈现为去头去内脏的熟食成品菜肴（盘中餐，绝非活的生物）；蛋类必须去壳呈现（煎蛋/剥壳水煮蛋/蛋液），严禁出现完整带壳生蛋';
  if (looksLikeSoup(name, dish)) {
    return [
      dishName + '，盛在浅口汤碗或陶瓷汤盅中、完整单碗摆盘，碗下垫纯色盘或木质/亚麻桌面、无杂物',
      '写实摄影风格，高清美食照片，专业食物摄影质感，汤体色泽清透真实、食材纹理清晰',
      '45 度俯拍或微俯视角，浅景深特写，主体居中占画面约 70%，清晰呈现汤面油花、食材与升腾热气，背景大面积留白干净简约',
      '自然侧光柔光，画面明暗对比柔和，高光突出汤面油润与热气感，氛围温暖有食欲',
      '汤品必须用碗/盅盛装，严禁用玻璃杯或马克杯装盛，严禁添加冰块',
      neg
    ].join('，');
  }
  if (looksLikeDrink(name, dish)) {
    if (looksLikeFruitDrink(name, dish)) {
      const fruitDesc = looksLikeIcedDrink(name, dish)
        ? '盛在通透玻璃杯中，杯中可见真实果肉块、杯沿点缀新鲜水果切片，可加冰块'
        : '盛在素雅玻璃杯或陶瓷杯中，杯中可见真实果肉块、杯沿点缀新鲜水果切片，严禁添加冰块';
      return [
        dishName + '，' + fruitDesc + '，完整单杯摆盘，杯下垫纯色杯垫或木质/亚麻桌面、无杂物',
        '写实摄影风格，高清美食照片，专业饮品摄影质感',
        '平视或微俯视角，浅景深特写，主体居中占画面约 70%，画面以该水果品类的真实实体（整果/切片/果肉）为视觉主体，清晰呈现水果的真实色泽、纹理与新鲜质感，背景大面积留白干净简约',
        '自然柔光，画面明暗对比柔和，高光突出水果鲜活色泽与杯壁水珠/热气感，氛围清爽有食欲',
        '必须以具体水果品类为主体，禁止笼统一杯有色液体、禁止用色素感纯色替代真实水果',
        neg
      ].join('，');
    }
    if (looksLikePlainTea(name, dish)) {
      return [
        dishName + '，一杯泡好的热茶汤：盛在通透玻璃茶杯或素雅陶瓷茶盏中，杯中盛满澄澈茶汤、可见舒展的茶叶或杯畔点缀几片真实茶叶，杯下垫纯色茶托或木质桌面、无杂物',
        '写实摄影风格，高清美食照片，专业茶饮摄影质感，茶汤色泽清亮真实（绿茶清浅、红茶琥珀、花茶微黄），杯壁可见袅袅热气',
        '平视或微俯视角，浅景深特写，主体居中占画面约 70%，清晰呈现茶汤通透质感与杯中茶叶，背景大面积留白干净简约',
        '自然柔光，画面明暗对比柔和，高光突出茶汤温润色泽与杯壁热气感，氛围清雅有食欲',
        '必须呈现一杯可饮的泡好茶汤，禁止将干茶叶散落在盘面画成茶叶堆、禁止画成空杯或茶叶原料',
        neg
      ].join('，');
    }
    if (looksLikeIcedDrink(name, dish)) {
      return [
        dishName + '，盛在通透玻璃杯或素雅陶瓷杯中、完整单杯摆盘，杯下垫纯色杯垫或木质/亚麻桌面、无杂物',
        '写实摄影风格，高清美食照片，专业饮品摄影质感，液体色泽清透真实、食材纹理清晰',
        '平视或微俯视角，浅景深特写，主体居中占画面约 70%，清晰呈现液面、冰块、果肉或杯壁水珠等真实细节，背景大面积留白干净简约',
        '自然柔光，画面明暗对比柔和，高光突出饮品清透色泽与杯壁水珠感，氛围清爽有食欲',
        neg
      ].join('，');
    }
    return [
      dishName + '，盛在素雅陶瓷杯、玻璃杯或保温杯中、完整单杯摆盘，杯下垫纯色杯垫或木质/亚麻桌面、无杂物',
      '写实摄影风格，高清美食照片，专业饮品摄影质感，液体色泽真实、食材纹理清晰',
      '平视或微俯视角，浅景深特写，主体居中占画面约 70%，清晰呈现液面、果肉、杯壁水珠或升腾热气等真实细节，背景大面积留白干净简约',
      '自然柔光，画面明暗对比柔和，高光突出饮品色泽与杯壁水珠/热气感，氛围温润清爽有食欲',
      '热饮与常温饮品严禁添加冰块，可呈现杯壁水珠或袅袅热气',
      neg
    ].join('，');
  }
  if (looksLikeSteam(name)) {
    return [
      dishName + '，清蒸做法的成熟成品，单盘完整摆盘：盛在浅色白瓷盘或垫有荷叶/蒸垫的蒸盘中，桌面纯色无杂物',
      '写实摄影风格，高清美食照片，专业食物摄影质感，表面透出轻微水汽与油亮、肉质细嫩湿润、色泽自然真实（无重酱色、无干炸金黄、无红油辣椒堆叠）',
      '45 度俯拍或微俯视角，浅景深特写，主体居中占画面约 75%，背景大面积留白干净简约',
      '自然柔光，画面明暗对比柔和，氛围清爽本味、有食欲',
      '必须是清蒸/白蒸的成熟菜成品相，禁止出现红烧、油炸、爆炒、干锅、麻辣等其它做法的观感',
      neg
    ].join('，');
  }
  return [
    dishName + '，盛在浅色陶瓷盘中、完整单份摆盘，桌面为纯色木质或亚麻质感、无杂物',
    '写实摄影风格，高清美食照片，专业食物摄影质感，食材纹理清晰、色泽真实饱满',
    '45 度俯拍视角，浅景深特写，主体居中占画面约 70%，背景大面积留白干净简约',
    '自然侧光柔光，画面明暗对比柔和，高光突出食物表面油润与热气感，氛围温暖有食欲',
    neg
  ].join('，');
}

// 下载图片字节（支持 https/http，跟随重定向），带 socket 级超时
function httpsGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const req = mod.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGetBuffer(res.headers.location));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('download timeout')); });
  });
}

// 菜品图片复用键：仅用菜名（出图 prompt 不含菜系，同名必同图），保证「同一道菜」跨用户/跨次复用同一文件。
function imageKey(name) {
  return (name || '').trim();
}
// 下载并持久化到云存储（避免 24h 临时 URL 失效），成功返回 fileID；失败返回 null（绝不回吐临时 URL）。
// 下载+上传整体带重试，吸收瞬时抖动；全部失败后返回 null，由主流程降级为 code:500。
async function persistImage(key, url, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const buf = await httpsGetBuffer(url);
      // 文件名用 key 的 md5 hex（纯 ASCII），避免中文/特殊字符进入云存储 fileID ——
      // 微信 <image> 对含中文的 cloud:// fileID 解析不稳，会当成本地相对路径拼到页面目录导致 500。
      // md5 仍保证同菜同图去重（相同菜名→相同 hex→相同 fileID）。
      const safe = crypto.createHash('md5').update(key).digest('hex');
      // 路径带时间戳：重生成时新图走新路径，避免同名覆盖后 CDN/临时 URL 缓存旧图（2026-09-06 用户实测图片重生成无变化）
      const cloudPath = 'recommend-images/' + safe + '-' + Date.now() + '.png';
      const up = await app.uploadFile({ cloudPath, fileContent: buf });
      return up.fileID;
    } catch (e) {
      lastErr = e;
      console.error('[getDishImage] persistImage 失败(第' + (i + 1) + '次)', e);
    }
  }
  console.error('[getDishImage] persistImage 最终失败', lastErr);
  return null;
}

// 入口：输入 { name, cuisine, force? }，输出 { code, data:{ imageUrl } }
// 构建指纹（2026-08-17 出图 prompt 结构化约束优化）
// BUILD_TAG: 2026-09-09.img-force-regen（+force=1 强制重生成：图片标记页"出问题图"重生成用，绕过现存 env1 fileID 复用直接出新图覆盖）
// 历史：2026-09-07.img-steam-single（+清蒸专属分支：成熟成品/白瓷蒸盘/轻微水汽/禁红烧油炸爆炒干锅麻辣观感；head/egg/独幅沿用 img-no-live3；与 env2 bypassGenImage steam-single-dish 口径一致）
//       2026-09-06.img-no-live3（禽类斩件/蛋类剥壳正向描述/单品单盘禁配菜；…；禁活体/动物头/眼嘴，蛙龟甲鱼禽鱼去头熟食形态，蛋类去壳）
const BUILD_TAG = '2026-09-09.img-force-regen';
console.log('[build] getDishImage BUILD_TAG=' + BUILD_TAG);

exports.main = async (event, context) => {
  console.log('[build] getDishImage BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  try {
    context.callbackWaitsForEmptyEventLoop = false;
    const name = (event && event.name) || '';
    const cuisine = (event && event.cuisine) || '';
    const force = !!(event && event.force);   // 2026-09-09：出问题图重生成（force）不读缓存直接出新图
    if (!name) return { code: 400, msg: '缺少菜名' };

    const db = cloud.database();
    const key = imageKey(name);
    const nid = normLexName(name); // 库 _id=norm_id（读/写统一口径）

    // 2026-09-02：fileID 有效性校验——必须是「纯 ASCII + 属于当前环境」才可复用。
    // 历史/跨环境写入的 env2 fileID（cloud://your-env2-bucket.*）在当前环境前端无法加载，
    // 以及含中文的 fileID（微信 <image> 解析 500），一律视为失效 → 走重新生成并覆盖。
    const currentEnv = cloud.DYNAMIC_CURRENT_ENV || process.env.TCB_ENV || '';
    const isValidFileID = (url) => {
      if (typeof url !== 'string' || !url) return false;
      if (!/^[\x00-\x7F]*$/.test(url)) return false;
      if (!url.startsWith('cloud://')) return false;
      if (!currentEnv || !url.startsWith('cloud://' + currentEnv + '.')) return false;
      return true;
    };
    // 图片复用：直接按 _id 命中 dish_image_v2（_id=norm_id，O(1)）；force 时跳过复用直接重生成
    if (!force) {
      try {
        const hit = await db.collection('dish_image_v2').doc(nid).get();
        if (hit && hit.data && isValidFileID(hit.data.imageUrl)) {
          return { code: 200, data: { imageUrl: hit.data.imageUrl, reused: true } };
        }
        // 命中但 fileID 无效（跨环境/中文）：删除该失效记录，走重新生成覆盖
        if (hit && hit.data && hit.data.imageUrl && hit.data._id) {
          await db.collection('dish_image_v2').doc(hit.data._id).remove().catch(() => {});
          console.log('[getDishImage] 删除失效图记录 nid=' + nid + ' url=' + String(hit.data.imageUrl).slice(0, 60));
        }
      } catch (e) { /* 未命中（含文档不存在）不影响出图，继续生成 */ }
    }

    // 未复用：AI 新生成（混元 image 上游并发≈1，做全局信号量限流，避免规模上来后集体 429 雪崩）
    const _ = db.command;
    // 初始化槽位文档（按需，set 幂等）
    for (let i = 0; i < SLOT_N; i++) await ensureSlotDoc(db, SLOT_PREFIX + i);
    const slotId = await acquireSlot(db, _);
    if (!slotId) {
      // 出图通道繁忙：hy3-preview 是文本模型无法替代图片生成，且 env2 跨账号代理已退役；
      // 直接返回 430，由前端退避重试（不在云端排队占实例，避免实例枯竭雪崩）。
      return { code: 430, msg: '出图通道繁忙，请稍后重试' };
    }
    try {
      // 混元主出图通道（带重试），包成闭包供网关调用。
      // 网关 callUnifiedImage 读 sys_config/ai_custom_image：enabled=false（缺省）→ 走混元；
      // enabled=true 且 baseUrl/model 齐全 → 走 OpenAI 兼容图像端点（/images/generations）兜底/替换。
      const callHunyuanImage = async (prompt) => {
        let img = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            img = await imageModelObj.generateImage({
              model: IMAGE_MODEL_ID,
              prompt: prompt,
              // 前端菜图仅显示 140rpx（约 ≤210 物理像素），1024x1024 严重过剩。
              // 混元 hunyuan-image 的 size 约束：宽高须 768–1280 且 64 倍数，最小即 768。
              // 768x768 像素量降约 44%、PNG 体积近半 → 下载/存储更省、生图链路更快（推理耗时非线性的，但整体更轻）。
              size: '768x768',
              revise: { value: false }
            });
            break;
          } catch (e) {
            console.error('[getDishImage] generateImage 失败(第' + (attempt + 1) + '次)：', e && e.message);
            if (attempt < 2) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          }
        }
        if (!img || !img.data || !img.data[0] || !img.data[0].url) throw new Error('混元出图返回结构异常');
        return { url: img.data[0].url };
      };
      const r = await aiGateway.callUnifiedImage([hardFoodConstraints(name), buildImagePrompt(name, {}), '画面构图变体编号' + (Date.now() % 1000000)].filter(Boolean).join('，'), db, { callHunyuanImage });
      const img = { data: [{ url: r.url }] };
      if (img && img.data && img.data[0] && img.data[0].url) {
        const imageUrl = await persistImage(key, img.data[0].url);
        // 持久化成功才返回图片；失败则降级为 500，绝不把 24h 临时 URL 写进历史库
        if (imageUrl) {
          // 落库去重键，后续任何人/任何次出同菜直接命中，不再调 AI。
          // 策略：库里已有该菜图（env2 审核真值/历史图）→ 保留不覆盖，仅返回已有图；
          //       库里没有才 set 写入（source:'ai-gen'），实现渐进复用且不降级覆盖真值。
          const exDoc = await db.collection('dish_image_v2').doc(nid).get().catch(() => null);
          if (!force && exDoc && exDoc.data && typeof exDoc.data.imageUrl === 'string' && exDoc.data.imageUrl) {
            console.log('[getDishImage] 图已存在(保留真值) nid=' + nid);
            return { code: 200, data: { imageUrl: exDoc.data.imageUrl, reused: true } };
          }
          try {
            // _id 由 doc(nid) 决定，data 里不能再带 _id（-501007 不能更新_id的值 → 此前缓存从未写入）
            await db.collection('dish_image_v2').doc(nid).set({
              data: { name, cuisine: cuisine || '', imageUrl, source: 'ai-gen', createdAt: Date.now() }
            });
          } catch (e) {
            // 落库失败必须浮出：静默吞掉会让图片缓存永久失效、每次出图都重新生成（2026-09-06 排查结论）
            console.error('[getDishImage] 落库失败 nid=' + nid + '：', e && e.message);
          }
          return { code: 200, data: { imageUrl } };
        }
        return { code: 500, msg: '图片存储失败' };
      }
      console.error('[getDishImage] 出图返回结构异常：', JSON.stringify(img));
      return { code: 500, msg: '出图失败' };
    } finally {
      await releaseSlot(db, slotId);
    }
  } catch (e) {
    console.error('[getDishImage] 异常：', e);
    return { code: 500, msg: (e && e.message) || '出图异常' };
  }
};
