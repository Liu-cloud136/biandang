// ============================================================================
// bypassGenImage · env2 补图（阶段2，方案 §2 任务2）
// BUILD_TAG: 2026-08-21.bypass-genimage-v2
//
// 职责：
//   - 扫 env2 本地 dish_mirror（env1 菜库镜像同步到 env2）中缺 imageUrl 的菜；
//   - hy3 混元生图（hunyuan-image）生成图片；
//   - 写 env2 本地 dish_mirror.imageUrl（env1 零改动）；环境2 图产物待 env1 COS 回写点接入后
//     经共享实例 new cloud.Cloud({resourceAppid:'wx0000000000000000', resourceEnv:'your-env-id-1'})
//      → env1 COS（方案 A「getDishImage 430 分支投递点」触发时启用，当前不建跨账号写 COS）。
//
// 当前实现（B' 本地模式）：
//   - 增量扫 env2 本地 dish_mirror 缺图（cursor 分页），每菜 hy3 生成 768px 正图
//   - 图片字节写 COS（当前环境）→ fileID 回填 dish_mirror.imageUrl（仅本地）
//   - 失败静默记 bypass_log
// ============================================================================

const BUILD_TAG = '2026-09-07.custom-prompt-v5';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const tcb = require('@cloudbase/node-sdk');
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-2';
const app = tcb.init({ env: TCB_ENV, timeout: 120000 });
const ai = app.ai();
const imageModelObj = ai.createImageModel('hunyuan-image');  // ⑦ 模块级单例

const IMAGE_MODEL = 'HY-Image-3.0-Plus-4090-Tob-v1.0';

// 并发控制：混元 image 上游限流严（时间窗口级 429），取 2 道并发生图 + 长退避
const BATCH = 20;    // 每批最多扫 20 道菜
const CONCURRENCY = 4; // 本地并发槽（limiter 已控速率，此处仅控制同时 in-flight 数）2026-08-29 1707 道补图提速 2→4
const RETRIES = 3;   // 生图重试（含 429 退避）
const MAX_MS = 170000; // 循环补齐总时长上限（留 10s 余量给 180s 超时）
const { RateLimiter } = require('./rateLimiter');
// 自适应速率控制器（图）：初始 2、上限 4、60s 窗硬上限 20、429 退避 5/10/15s
const limiter = new RateLimiter({ rateInit: 2, rateMax: 4, rateMin: 0.5, burst: 4, windowCap: 20, successK: 10, backoffBase: 5000, backoffMax: 15000 });

exports.main = async (event) => {
  console.log('[build] bypassGenImage BUILD_TAG=' + BUILD_TAG);
  const { task, cursor, limit, dishName, notes, prompt } = event || {};

  if (task === 'health') {
    return { ok: true, build: BUILD_TAG, mode: 'gen-image', env: TCB_ENV };
  }

  // 全局生成开关：默认停用（GEN_DISABLED 未显式置 'false' 即停），彻底停止生成/补齐
  if (process.env.GEN_DISABLED !== 'false') {
    console.log('[bypassGenImage] GEN_DISABLED 已开启，跳过执行');
    return { ok: false, disabled: true, reason: 'gen_disabled' };
  }

  // 单菜补图（dishRegenPoll 驳回重生成专用，env2 本地调用）
  // 不依赖 dish_mirror 是否已有该菜：菜名即源，直接生图，生完后 upsert 回 dish_mirror
  if (dishName) {
    try {
      const imageResult = await genImage(dishName, { name: dishName, notes: notes || '', prompt: prompt || '' });
      if (!imageResult || !imageResult.fileID) {
        return { ok: false, err: 'genimage_empty', dishName };
      }
      // upsert：已有则先清旧 imageUrl（_.remove 彻底移除，避免残留旧 fileID），再写新图
      const exist = await db.collection('dish_mirror').where({ name: dishName }).limit(1).get();
      const doc = exist && exist.data && exist.data[0];
      if (doc && doc._id) {
        await db.collection('dish_mirror').doc(doc._id).update({
          data: { imageUrl: _.remove() },
        });
        await db.collection('dish_mirror').doc(doc._id).update({
          data: { imageUrl: imageResult.fileID, imageUpdatedAt: Date.now() },
        });
      } else {
        await db.collection('dish_mirror').add({
          data: { name: dishName, imageUrl: imageResult.fileID, source: 'regenerate', genAt: Date.now(), imageUpdatedAt: Date.now() },
        });
      }
      console.log('[bypassGenImage] 单菜补图成功 name=' + dishName);
      return { ok: true, dishName, fileID: imageResult.fileID };
    } catch (e) {
      console.warn('[bypassGenImage] 单菜补图失败 name=' + dishName + '：', e && e.message);
      return { ok: false, err: (e && e.message) || 'regenerate_failed', dishName };
    }
  }

  try {
    const startedAt = Date.now();
    let totalComputed = 0;
    let lastId = cursor && cursor.lastId;
    let rounds = 0;

    // 循环补齐：一次调用扫完所有缺 imageUrl 的菜（受 180s 超时约束）
    while (true) {
      const batchSize = Math.min(Number(limit) || BATCH, BATCH);
      const cond = { imageUrl: _.or(_.exists(false), _.eq('')) };
      if (lastId) cond._id = _.gt(lastId);
      let q = db.collection('dish_mirror').where(cond).orderBy('_id', 'asc').limit(batchSize);
      const list = (await q.get()).data || [];

      if (!list.length) break;

      let computed = 0;
      // 多槽并发：每 CONCURRENCY 道菜并发生图，学 env1 getDishImage 多槽模式
      for (let i = 0; i < list.length; i += CONCURRENCY) {
        const batch = list.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(batch.map(d => processOneDish(d)));
        for (let j = 0; j < settled.length; j++) {
          const r = settled[j];
          const d = batch[j];
          const name = d.name || d.dishName;
          if (r.status === 'fulfilled' && r.value && r.value.ok) {
            computed++;
            lastId = d._id;
          } else {
            const err = r.status === 'rejected' ? r.reason : (r.value && r.value.err);
            console.warn('[bypassGenImage] 补图失败 name=' + name + '：', err && err.message);
            await logTask('bypassGenImage', null, 'fail', 'dish [' + name + '] ' + (err && err.message || 'unknown'));
          }
        }
      }

      totalComputed += computed;
      rounds++;
      if (Date.now() - startedAt > MAX_MS || list.length < batchSize) break;
    }

    await logTask('rateLimiter', null, 'info', limiter.monitorMsg()).catch(() => {});
    return { ok: true, computed: totalComputed, rounds, hasMore: false, lastId };
  } catch (e) {
    console.error('[bypassGenImage] 扫描异常：', e && e.message);
    return { ok: false, err: (e && e.message) || 'scan_failed' };
  }
};

// 单道菜处理：生图 → 回写 → 自评
async function processOneDish(d) {
  await limiter.acquire(); // 自适应速率节流（按公共池实时余量）
  const name = d.name || d.dishName;
  if (!name) return { ok: false, err: { message: '空菜名' } };
  try {
    const imageResult = await genImage(name, d);
    if (imageResult && imageResult.fileID) {
      await db.collection('dish_mirror').doc(d._id).update({
        data: { imageUrl: imageResult.fileID, imageUpdatedAt: Date.now() },
      });
      console.log('[bypassGenImage] 补图成功 name=' + name);
      await selfEvaluateIfReady(d._id, name);
      limiter.onSuccess();
      return { ok: true };
    }
    limiter.onLimit(); // 生图返回空等非 429 失败也保守降速
    return { ok: false, err: { message: 'genimage_empty' } };
  } catch (e) {
    if (/429|限流|rate\s*limit|too many/i.test((e && e.message) || '')) {
      limiter.onLimit(); // 限流类错误 → 自适应降速
    }
    return { ok: false, err: e };
  }
}

// 生图（hy3 文本不可生图，准确模型=混元生图）→ 下载 → 传当前环境 COS（fileID）
// 含 429 限流退避重试（image 上游限速严，瞬时并发会 429，指数退避后重试）
async function genImage(name, dish) {
  const prompt = buildImagePrompt(name, dish);
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const resp = await imageModelObj.generateImage({
        model: IMAGE_MODEL,
        prompt,
        size: '768x768',
        revise: { value: false },
      });
      const url = resp && resp.data && resp.data[0] && resp.data[0].url;
      if (!url) throw new Error('生图返回空');
      const fileID = await uploadImage(name, url);
      if (!fileID) throw new Error('上传COS失败');
      return { fileID };
    } catch (e) {
      lastErr = e;
      const is429 = /429/.test((e && e.message) || '');
      if (is429 && attempt < RETRIES) {
        const wait = 5000 * (attempt + 1); // 5s, 10s, 15s 指数退避（image 限流为时间窗口级）
        console.warn('[bypassGenImage] 生图 429 退避 ' + wait + 'ms name=' + name);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// md5 文件名 + 上传当前环境 COS（与 getDishImage uploadFile 同规则，纯 ASCII fileID）
async function uploadImage(key, url, retries = 2) {
  const crypto = require('crypto');
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const buf = await httpsGetBuffer(url);
      // §10 产物体检：图 < 10KB 视为损坏/占位图，不回写
      if (buf.length < 10240) throw new Error('image_too_small:' + buf.length);
      const safe = crypto.createHash('md5').update(key).digest('hex');
      const cloudPath = 'recommend-images/' + safe + '.png';
      const up = await app.uploadFile({ cloudPath, fileContent: buf });
      return up.fileID;
    } catch (e) {
      if (attempt < retries) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      else throw e;
    }
  }
  return null;
}

// HTTPS GET → Buffer（生图返回 URL 下载）
function httpsGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = require('url').parse(url).protocol === 'https:' ? require('https') : require('http');
    lib.get(url, (res) => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// 汤羹识别：汤必须用碗/盅盛装，禁止杯装+冰块（与饮品区分）
function looksLikeSoup(name, dish) {
  if (dish && (dish.category === '汤羹' || dish.type === '汤' || dish.type === '汤羹')) return true;
  const nm = (name || '').replace(/\s/g, '');
  if (!nm) return false;
  // 茶汤（如龙井茶汤）本质为茶饮，名含「汤」但非汤羹，排除出汤类
  if (/茶汤/.test(nm)) return false;
  // 汤类：名称含「汤/羹/粥/煲/锅」且非明确饮品词（酸梅汤/米汤属饮品，已在 looksLikeDrink 优先判）
  return /(汤|羹|煲|砂锅|锅仔|粥)$/.test(nm);
}

// 清蒸做法识别：菜名含「蒸」（清蒸/蒸鱼/蒜蓉粉丝蒸虾/粉蒸肉…）或 dish.cookingMethod 带「蒸」。
// 置于汤羹/饮品之后、普通菜之前，避免「蒸汤」等极端情况误入。2026-09-07 修清蒸单菜图（出现一堆其他菜/做法不像清蒸）
function looksLikeSteam(name, dish) {
  const nm = String(name || '').replace(/\s/g, '');
  const cm = String(((dish && dish.cookingMethod) || (dish && dish.profile && dish.profile.cookingMethod)) || '');
  return nm.indexOf('蒸') >= 0 || cm.indexOf('蒸') >= 0;
}

// 饮品识别（与 env1 getRecommendation.looksLikeDrink 同款逻辑，确保两边判断一致）
// 注意：汤羹类（名含汤/羹/粥/煲/锅）一律先由 looksLikeSoup 抢走，不在此判定为饮品
function looksLikeDrink(name, dish) {
  if (dish && (dish.cuisine === '饮品' || dish.category === '饮品')) return true;
  if (looksLikeSoup(name, dish)) return false; // 汤羹类不算杯装饮品
  const nm = (name || '').replace(/\s/g, '');
  if (!nm) return false;
  return /^(热|温|冰|鲜|五谷|原味|低糖)?(豆浆|豆奶|牛奶|酸奶|羊奶|椰奶|燕麦奶|花生奶|米汤|米浆|芝麻糊|核桃露|杏仁露|热可可|可可|奶茶|柠檬水|酸梅汤|可乐|雪碧|汽水|气泡水|矿泉水|纯净水|温开水|凉白开|开水|咖啡|拿铁|美式|红茶|绿茶|花茶|乌龙茶|蜂蜜水|姜茶|藕粉|奶昔|龟苓膏)$|奶茶|柠檬水|酸梅汤|可乐|雪碧|汽水|气泡|咖啡|拿铁|豆浆|牛奶|酸奶|豆奶|椰汁|椰奶|米汤|可可|芝麻糊|藕粉|奶昔|蜂蜜水|姜茶/.test(nm)
    || /(茶|咖啡|奶|汁|饮|水|露|糊|浆)$/.test(nm);
}

// 水果饮品识别：果汁/果茶/水果茶及含具体水果名的饮品类，必须突出具体水果品类
// 命中后在提示词中强制「以真实水果实体为主体」，避免笼统一杯有色液体
function looksLikeFruitDrink(name, dish) {
  const nm = (name || '').replace(/\s/g, '');
  if (!nm) return false;
  // 明确水果品类词：橙/柚/莓/桃/梨/苹果/葡萄/芒果/西瓜/柠檬/百香果/荔枝/火龙果/猕猴桃/草莓/菠萝/木瓜/石榴/香蕉/椰子(椰汁已算饮)/杨桃/山楂/蓝莓/树莓
  return /(橙|柚|莓|桃|梨|苹果|葡萄|芒果|西瓜|柠檬|百香果|荔枝|火龙果|猕猴桃|草莓|菠萝|木瓜|石榴|香蕉|杨桃|山楂|蓝莓|树莓|果茶|水果茶|果汁|鲜榨|果蔬)/.test(nm)
    || /(汁|茶)$/.test(nm) && /(果|莓|橙|桃|梨|葡萄|芒果|西瓜|柠檬|椰)/.test(nm);
}

// 冰饮识别：仅名称含「冰」或明确冷饮（冰镇/冰饮）才允许画冰块；其余默认常温/热饮禁冰块
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

// 类别专属修正子句（2026-09-07）：针对「带头诡异 / 蛋带壳」两类人工标记。
// 按菜名识别：蛋品须去壳或切开呈可食形态；蛙/虾蟹类水产禁止活体/连头带须生猛观感。
// dish.notes 为调用方传入的人工修正要求（可选），拼在最前，优先级最高。
function buildSpecClause(name, dish) {
  const nm = String(name || '').replace(/\s/g, '');
  const parts = [];
  const notes = (dish && dish.notes) ? String(dish.notes).trim() : '';
  if (notes) parts.push(notes);
  // 通用正向硬约束：凡含动物性食材，一律明确为「去头去内脏、斩件装盘的成品菜」，只拍盘中菜
  if (/(牛蛙|田鸡|蛙|鸽|鸡|鸭|鹅|鹌鹑|鱼|鳝|泥鳅|虾|蟹|兔|驴|牛|羊|猪|排骨|肉)/.test(nm)) {
    parts.push('这张图拍的是已经烹调完成的成品菜：食材已去头去内脏、处理成可夹食的块/件/段并装盘，画面中绝对不能出现动物头部、眼睛、喙、爪、皮毛或完整体型，也绝不能是活体或未熟的生鲜原料');
  }
  if (/牛蛙/.test(nm)) parts.push('牛蛙肉为去头斩块、去皮的白肉块盛盘清蒸，画面无蛙头、无整只蛙形');
  if (/蛙腿/.test(nm)) parts.push('画面主体仅为去皮的蛙腿肉（净腿段）码盘，严禁出现蛙头、蛙躯干或整只蛙');
  if (/田鸡/.test(nm)) parts.push('注意：田鸡即虎纹蛙（绝非牛蛙、绝非青蛙/黑斑蛙），食材是去皮后斩成小块的白净蛙肉，与豆腐同炖；严禁画成体型肥大的牛蛙，也严禁带黑斑绿皮的青蛙样、整只蛙或任何活蛙');
  if (/(鸽|鸡|鸭|鹅|鹌鹑)/.test(nm)) parts.push('禽肉已斩成小块码入盘中（或面条/汤中），画面看不到头颈、爪和完整禽形');
  if (/蛋/.test(nm)) {
    if (/(咸鸭蛋|咸蛋|皮蛋|茶叶蛋|卤蛋|酱蛋|水煮蛋|煮蛋|溏心蛋)/.test(nm)) {
      parts.push('整颗蛋以剥壳或切开装盘呈现，可见蛋体与油润/溏心蛋黄，仅允许以完整蛋壳点缀说明，画面主体不得被蛋壳包裹遮掩');
    } else {
      parts.push('蛋品必须是已去壳的可食用形态（去壳白煮蛋、炒/蒸/炖/卤/糖水蛋中的蛋块），画面严禁出现整颗带壳蛋、生蛋或散落的蛋壳');
    }
  }
  return parts.join('，');
}

// 结构化约束提示词（与 env1 getDishImage 同款，确保风格统一）
// 分支：汤羹 / 饮品（热饮·常温·冰饮）/ 清蒸 / 普通菜
function buildImagePrompt(name, dish) {
  const dishName = name && name.length ? name : '美食';
  const neg = '禁止生成文字、Logo、水印、二维码；禁止插画、简笔画、卡通、3D 渲染风格；禁止出现人手或多只餐具；禁止杂乱背景与过度饱和滤镜；禁止在热饮、汤羹、热食中出现冰块；禁止用笼统纯色液体替代具体水果，水果饮品必须呈现真实水果实体';
  const specClause = buildSpecClause(name, dish);
  // 修正要求前置到菜名之后（模型对开头指令更敏感；2026-09-07 第三轮，解决蛙/鸽仍画成带头活体）
  const dishLead = dishName + (specClause ? '。' + specClause.replace(/[。；;]+$/, '') : '');
  // 完全自定义 prompt（2026-09-07 第四轮）：调用方传 event.prompt 时整段采用，绕开模型对「田鸡/蛙」等词
  // 画成整只活物的强先验；仍附加通用独幅/负向约束。
  if (dish && dish.prompt && String(dish.prompt).trim()) {
    return [
      String(dish.prompt).replace(/[。；;]+$/, ''),
      '写实摄影风格，高清美食照片，专业食物摄影质感，食材纹理清晰、色泽真实饱满',
      '45 度俯拍或微俯视角近景特写，浅景深，主体居中占画面约 80%，背景大面积留白干净简约',
      '自然柔光，画面明暗对比柔和，高光突出油润与热气感，氛围温暖有食欲',
      '画面中只呈现菜名对应的这一道菜，禁止一盘内杂糅多道菜、禁止背景出现其它菜品',
      neg
    ].join('，');
  }
  if (looksLikeSoup(name, dish)) {
    return [
      dishLead + '，盛在浅口汤碗或陶瓷汤盅中、完整单碗摆盘，碗下垫纯色盘或木质/亚麻桌面、无杂物',
      '写实摄影风格，高清美食照片，专业食物摄影质感，汤体色泽清透真实、食材纹理清晰',
      '45 度俯拍或微俯视角，浅景深特写，主体居中占画面约 70%，清晰呈现汤面油花、食材与升腾热气，背景大面积留白干净简约',
      '自然侧光柔光，画面明暗对比柔和，高光突出汤面油润与热气感，氛围温暖有食欲',
      '汤品必须用碗/盅盛装，严禁用玻璃杯或马克杯装盛，严禁添加冰块',
      neg
    ].join('，');
  }
  if (looksLikeDrink(name, dish)) {
    if (looksLikePlainTea(name, dish)) {
      return [
        dishLead + '，一杯泡好的热茶汤：盛在通透玻璃茶杯或素雅陶瓷茶盏中，杯中盛满澄澈茶汤、可见舒展的茶叶或杯畔点缀几片真实茶叶，杯下垫纯色茶托或木质桌面、无杂物',
        '写实摄影风格，高清美食照片，专业茶饮摄影质感，茶汤色泽清亮真实（绿茶清浅、红茶琥珀、花茶微黄），杯壁可见袅袅热气',
        '平视或微俯视角，浅景深特写，主体居中占画面约 70%，清晰呈现茶汤通透质感与杯中茶叶，背景大面积留白干净简约',
        '自然柔光，画面明暗对比柔和，高光突出茶汤温润色泽与杯壁热气感，氛围清雅有食欲',
        '必须呈现一杯可饮的泡好茶汤，禁止将干茶叶散落在盘面画成茶叶堆、禁止画成空杯或茶叶原料',
        neg
      ].join('，');
    }
    if (looksLikeFruitDrink(name, dish)) {
      const fruitDesc = looksLikeIcedDrink(name, dish)
        ? '盛在通透玻璃杯中，杯中可见真实果肉块、杯沿点缀新鲜水果切片，可加冰块'
        : '盛在素雅玻璃杯或陶瓷杯中，杯中可见真实果肉块、杯沿点缀新鲜水果切片，严禁添加冰块';
      return [
        dishLead + '，' + fruitDesc + '，完整单杯摆盘，杯下垫纯色杯垫或木质/亚麻桌面、无杂物',
        '写实摄影风格，高清美食照片，专业饮品摄影质感',
        '平视或微俯视角，浅景深特写，主体居中占画面约 70%，画面以该水果品类的真实实体（整果/切片/果肉）为视觉主体，清晰呈现水果的真实色泽、纹理与新鲜质感，背景大面积留白干净简约',
        '自然柔光，画面明暗对比柔和，高光突出水果鲜活色泽与杯壁水珠/热气感，氛围清爽有食欲',
        '必须以具体水果品类为主体，禁止笼统一杯有色液体、禁止用色素感纯色替代真实水果',
        neg
      ].join('，');
    }
    if (looksLikeIcedDrink(name, dish)) {
      return [
        dishLead + '，盛在通透玻璃杯或素雅陶瓷杯中、完整单杯摆盘，杯下垫纯色杯垫或木质/亚麻桌面、无杂物',
        '写实摄影风格，高清美食照片，专业饮品摄影质感，液体色泽清透真实、食材纹理清晰',
        '平视或微俯视角，浅景深特写，主体居中占画面约 70%，清晰呈现液面、冰块、果肉或杯壁水珠等真实细节，背景大面积留白干净简约',
        '自然柔光，画面明暗对比柔和，高光突出饮品清透色泽与杯壁水珠感，氛围清爽有食欲',
        neg
      ].join('，');
    }
    return [
      dishLead + '，盛在素雅陶瓷杯、玻璃杯或保温杯中、完整单杯摆盘，杯下垫纯色杯垫或木质/亚麻桌面、无杂物',
      '写实摄影风格，高清美食照片，专业饮品摄影质感，液体色泽真实、食材纹理清晰',
      '平视或微俯视角，浅景深特写，主体居中占画面约 70%，清晰呈现液面、果肉、杯壁水珠或升腾热气等真实细节，背景大面积留白干净简约',
      '自然柔光，画面明暗对比柔和，高光突出饮品色泽与杯壁水珠/热气感，氛围温润清爽有食欲',
      '热饮与常温饮品严禁添加冰块，可呈现杯壁水珠或袅袅热气',
      neg
    ].join('，');
  }
  if (looksLikeSteam(name, dish)) {
    return [
      dishLead + '，清蒸做法的成熟成品，单盘完整摆盘：盛在浅色白瓷盘或垫有荷叶/蒸垫的蒸盘中，桌面纯色无杂物',
      '写实摄影风格，高清美食照片，专业食物摄影质感，表面透出轻微水汽与油亮、肉质细嫩湿润、色泽自然真实（无重酱色、无干炸金黄、无红油辣椒堆叠）',
      '45 度俯拍或微俯视角，浅景深特写，主体居中占画面约 75%，背景大面积留白干净简约',
      '自然柔光，画面明暗对比柔和，氛围清爽本味、有食欲',
      '必须是清蒸/白蒸的成熟菜成品相，禁止出现红烧、油炸、爆炒、干锅、麻辣等其它做法的观感',
      (specClause ? specClause + '，' : '') + neg
    ].join('，');
  }
  return [
    dishLead + '，盛在浅色陶瓷盘中、完整单份摆盘，桌面为纯色木质或亚麻质感、无杂物',
    '写实摄影风格，高清美食照片，专业食物摄影质感，食材纹理清晰、色泽真实饱满',
    '45 度俯拍视角，浅景深特写，主体居中占画面约 70%，背景大面积留白干净简约',
    '自然侧光柔光，画面明暗对比柔和，高光突出食物表面油润与热气感，氛围温暖有食欲',
    '画面中只呈现菜名对应的这一道菜的完整摆盘，禁止一盘内杂糅多道菜、禁止背景出现一桌其它菜品或配菜碟',
    (specClause ? specClause + '，' : '') + neg
  ].join('，');
}

// ── hy3 自评打分（五件套齐全后触发，<70 分标记 rejected）─────────────────────
async function selfEvaluateIfReady(docId, name) {
  try {
    const res = await db.collection('dish_mirror').doc(docId).get();
    const d = res.data;
    if (!d) return;
    if (!d.profile || !d.nutrition || !d.guide || !d.imageUrl) return;
    if (d.evalScore !== undefined) return;
    const evalResult = await selfEvaluateDish(d);
    if (evalResult.score < 70) {
      await db.collection('dish_mirror').doc(docId).update({
        data: { status: 'rejected', evalScore: evalResult.score, evalReason: evalResult.reason }
      });
      console.log('[自评] 丢弃低质量菜：' + name + ' score=' + evalResult.score);
    } else {
      await db.collection('dish_mirror').doc(docId).update({
        data: { evalScore: evalResult.score, evalReason: evalResult.reason }
      });
      console.log('[自评] 通过：' + name + ' score=' + evalResult.score);
    }
  } catch (e) {
    console.warn('[自评] 失败 name=' + name + '：', e && e.message);
  }
}

async function selfEvaluateDish(dish) {
  const prompt = [
    '你是美食质量评审员。对以下菜品打分（0-100），只输出 JSON：{"score":数字,"reason":"简评"}',
    '评分维度：菜名合理性(25分) / 食材常见性(25分) / 做法可行性(25分) / 营养合理性(25分)',
    '<70 分说明质量不佳应丢弃',
    '菜品：' + JSON.stringify({
      name: dish.name,
      cuisine: dish.cuisine,
      profile: dish.profile,
      nutrition: dish.nutrition,
      guide: dish.guide,
    }),
  ].join('\n');
  try {
    const textModel = ai.createModel('cloudbase');
    const resp = await textModel.generateText({
      model: 'hy3',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      maxTokens: 128,
    });
    const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
    const m = String(text).match(/\{[^}]+\}/);
    if (!m) return { score: 60, reason: '自评解析失败' };
    const obj = jsonParseRepair(m[0]);
    return obj || { score: 60, reason: '自评解析失败' };
  } catch (e) {
    return { score: 60, reason: '自评失败' };
  }
}


// 2026-09-12：hy3 偶发吐畸形 JSON（实锤 "amount"::"3瓣" 双冒号，temp 0.3 下 100% 复现）
// 解析失败走三级修复梯（同 bypassConsistencyRepair v3-jsonfix / parseKit.repairJson）
function jsonParseRepair(s) {
  try { return JSON.parse(s); } catch (e) { /* 修复梯 */ }
  let r = String(s).replace(/,(s*[}]])/g, '$1');   // ① 收尾逗号
  try { return JSON.parse(r); } catch (e) { /* 下一级 */ }
  r = r.replace(/"s*:s*:/g, '":');                 // ② 键值完成后多余冒号
  try { return JSON.parse(r); } catch (e) { /* 下一级 */ }
  r = r.replace(/""s*:s*"/g, '"');                 // ③ 空串值后紧跟新值
  try { return JSON.parse(r); } catch (e) { return null; }
}
async function logTask(task, openid, status, errMsg) {
  try {
    await db.collection('bypass_log').add({ data: { task, _openid: openid || null, status, errMsg: errMsg || '', computedAt: Date.now() } });
  } catch (e) { /* 日志失败不影响 */ }
}