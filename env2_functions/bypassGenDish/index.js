// ============================================================================
// bypassGenDish · env2 AI 发明新菜（接入点⑧，方案 v3 §7）
// BUILD_TAG: 2026-09-10.bypass-gen-dish-namecheck-sync
//
// 职责（方案 v3 §7.2 + §11 拆分）：
//   1. hy3 生成 5-10 道候选新菜名（给已有菜库样本 + 季节食材 + 约束）
//   2. 去重检查（name_unique 索引 + hy3 相似菜判定 + 融合错误/违规前缀拦截）
//   3. 写入 dish_mirror 骨架（仅 name/source/cuisine/mainIngredient/cookingMethod/genAt）
//   4. 菜名确认无误（无重复/无融合错/无违规前缀）后 fire-and-forget 并行触发下游补字段：
//      bypassAiEnrich(画像)/bypassNutritionEst(营养)/bypassText(做法·点评·难度·贴士)/
//      bypassGenImage(图·只需菜名)/bypassGenIngredients(食材)/bypassGenSteps(步骤)/
//      bypassGenTips/bypassGenGuide —— 全部 Promise.all 并行起跑，各自 rateLimiter 自适应控速
//
// 纪律：
//   - 下游并行：菜名确认后即 Promise.all 并行触发，总耗时≈最慢函数；旧"串行流水线"已弃用
//   - 防限流靠各下游函数内部 rateLimiter 自适应令牌桶（遇429降速、连成提速、windowCap防击穿）
//   - 质量控制（§7.4）：菜名黑名单+长度2~12+中文；画像/营养/做法/图各步校验
//   - hy3 直配 'hy3'；生图用 hunyuan-image（HY-Image-3.0-Plus-4090-Tob-v1.0）
//   - 失败静默记 bypass_log
// ============================================================================

const BUILD_TAG = '2026-09-10.bypass-gen-dish-namecheck-sync';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// ── 跨账号访问 env1（用于拉取 env1 驳回菜名 + 可选回写）────────────────────
const ENV1_APPID = 'wx0000000000000000';
const ENV1_ENV_ID = process.env.ENV1_ENV_ID || '';
let env1Inst = null, c1 = null;
async function getEnv1() {
  if (!ENV1_ENV_ID) return null;
  if (!env1Inst) {
    try {
      env1Inst = new cloud.Cloud({ resourceAppid: ENV1_APPID, resourceEnv: ENV1_ENV_ID });
      await env1Inst.init();
      c1 = env1Inst.database();
    } catch (e) {
      console.warn('[bypassGenDish] 跨账号访问 env1 失败：', e && e.message);
      return null;
    }
  }
  return c1;
}

// ── 从 env2 本地 rejected_names 集合读取驳回菜名（不依赖跨账号）───────────
async function fetchRejectedFromEnv1() {
  // 改为读 env2 本地集合，由 env1 驳回时同步过来（同 appid 跨环境写入或手动同步）
  try {
    const names = new Set();
    for (let off = 0; ; off += 100) {
      const r = await db.collection('rejected_names').field({ name: true }).skip(off).limit(100).get();
      const batch = r.data || [];
      batch.forEach(d => { if (d.name) names.add(d.name); });
      if (batch.length < 100) break;
    }
    return Array.from(names);
  } catch (e) {
    console.warn('[bypassGenDish] 读 rejected_names 失败（非致命）：', e && e.message);
    return [];
  }
}

const tcb = require('@cloudbase/node-sdk');
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-2';

const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();
const imageModelObj = ai.createImageModel('hunyuan-image');

const IMAGE_MODEL = 'HY-Image-3.0-Plus-4090-Tob-v1.0';


const GEN_N = 12;          // 每次生成候选菜数量
const MIN_GENERATED = 8;    // 单轮（含本轮内重试补充）至少入库的菜数阈值
const MAX_RETRY = 2;        // 单轮内最大补充重试次数（达 MIN_GENERATED 即提前结束）
// 菜系轮换表：每次生成重点覆盖 3 个菜系，长期均衡覆盖所有菜系
const CUISINE_ROTATION = [
  ['川菜', '湘菜', '粤菜'],
  ['鲁菜', '浙菜', '东北菜'],
  ['西餐', '东南亚', '烘焙'],
  ['家常菜', '川菜', '粤菜'],
  ['湘菜', '鲁菜', '家常菜'],
  ['浙菜', '东北菜', '西餐'],
  ['日料', '韩餐', '东南亚'],
  ['川菜', '浙菜', '烘焙'],
];
const MIN_LEN = 18;        // 做法 min 汉字
const BAD_WORDS = ['狗肉', '蛇肉', '猫肉', '烟', '酒', 'hei', '果子狸', '穿山甲', '蝙蝠', '野生'];
const NAME_BLACKLIST = ['狗肉', '蛇肉', '猫肉', '果子狸', '穿山甲', '蝙蝠', '野生动物', '保护动物'];

// 菜系名 / 风味流派前缀黑名单（菜名严禁以这些开头，菜系由 cuisine 字段承载）
const CUISINE_PREFIX_BLACKLIST = [
  '鲁菜', '川菜', '粤菜', '苏菜', '浙菜', '闽菜', '湘菜', '徽菜', '东北菜', '西北菜', '家常菜',
  '鲁味', '川味', '粤味', '湘味', '苏味', '浙味', '京味', '沪味', '港味', '台味', '日式', '日料', '韩式', '韩餐', '西式', '西餐', '东南亚', '泰式', '意式', '法式',
];

// 烹饪动词前缀黑名单（仅禁**单字烹饪动词**开头，如 炖豆腐白菜/炒莴笋猪肉 这类"动词+食材"动宾结构）
// 注意：**双字做法词（清炒/红烧/白灼/清蒸/油焖/干煸/凉拌等）允许**，如 清炒油麦菜/红烧肉/白灼虾 合法——
// 因为这些词以形容词/修饰字开头（清/红/白），startsWith 单字动词不会误命中，且符合中文菜名习惯。
const COOK_VERB_PREFIX_BLACKLIST = [
  '炒', '炖', '蒸', '煮', '炸', '煎', '烧', '焖', '卤', '烤', '拌', '熬', '煲', '煨', '烩',
  '熘', '煸', '灼', '涮', '炝', '爆', '焙', '熏', '腌', '酱', '糟', '醉', '汆',
];

// 「动词+成品名」固定菜名豁免白名单（合法小吃/成品，非"动词+食材"动宾结构）
// 命中即放行，不受 COOK_VERB_PREFIX_BLACKLIST 的 startsWith 拦截
const COOK_VERB_OK_PREFIX = [
  '炸春卷', '炸酱面', '炸糕', '炸馒头', '炸薯条', '炸鸡', '炸串', '炸豆腐', '炸茄盒',
  '煎饺', '煎饼', '煎蛋', '煎包', '煎馒头', '煎馄饨',
  '蒸饺', '蒸蛋', '蒸糕', '蒸馍', '蒸薯', '蒸芋',
  '煮汤圆', '煮饺子', '煮面', '煮粥', '煮花生', '煮毛豆',
  '烧麦', '烧饼', '烧烤', '烧鸡', '烧鹅',
  '烤红薯', '烤冷面', '烤串', '烤鸭', '烤鱼', '烤肠', '烤饼', '烤箱', '烤馒头',
  '卤蛋', '卤鸡', '卤肉', '卤味', '卤豆腐',
  '拌黄瓜', '拌面', '拌粉', '拌菜', '拌海带', '拌木耳',
  '炖蛋', '炖肉', '炖排骨', '炖鸡', '炖牛肉',
  '爆米花', '爆肚',
  '熏鱼', '熏肉', '熏肠',
  '炒饭', '炒面', '炒粉', '炒糕', '炒年糕', '炒花生', '炒瓜子',
  '烩面', '烩饼', '烩菜',
  '煲仔饭', '煲汤',
  // 2026-09-10 补（同步 bypassAutoInvent v7）：模板产出的「单字动词+成品名」固定菜名（R-Name-02 允许固定菜名豁免）
  '煎豆腐', '煎鲈鱼', '煎鳕鱼', '煎带鱼', '煎杏鲍菇', '煎西葫芦饼',
  '蒸红薯', '酱香饼', '爆炒鱿鱼',
];

// —— 成品/包装饮料与纯净水黑名单（2026-08-25 新增）——
// 这些无需做法、只作为采购清单"X 1瓶"出现的成品，严禁进入「需要七件套做法」的菜品库。
// 区分：冲泡/现做的饮品（茶/果汁/豆浆/奶昔/咖啡/糖水，以及 DRINK_TMPL 里的 绿茶/红茶/乌龙茶
// 等具体茶汤）属于合法「饮品」类目，保留；此处只挡"开瓶即饮、无做法"的包装成品与纯净水。
const PACKAGED_DRINK_BLACKLIST = [
  '纯净水', '矿泉水', '苏打水', '气泡水', '雪碧', '可乐', '芬达', '美年达', '七喜',
  '脉动', '红牛', '尖叫', '宝矿力', '王老吉', '加多宝', '冰红茶', '绿茶饮料', '凉茶',
  '百岁山', '农夫山泉', '怡宝', '娃哈哈', '康师傅', '统一', '汇源', '味全',
  '听装', '罐装', '瓶装',
];
// 成品饮料后缀（带这些后缀的"菜名"一律判非菜，挡在菜品库外，仅采购清单侧保留）
const PACKAGED_DRINK_SUFFIX = ['饮料', '饮品', '瓶装', '罐装', '听装'];

// ============================================================================
// 查表组合提名（方案B）：本地从 蛋白×蔬菜×做法 组合生成候选，
// 提名时即全库去重（O(1)），候选天然不与已有库重复，AI 仅兜底补齐不足数量。
// ============================================================================

// 蛋白 → 精美组合（蔬菜+做法+菜名模板），人工精选保证命名自然、做法与食材匹配
const PRO_TMPL = {
  '猪肉': [
    { veg: '蒜薹', method: '炒', name: v => v + '炒猪肉' },
    { veg: '茄子', method: '烧', name: v => '猪肉烧' + v },
    { veg: '香菇', method: '烧', name: v => v + '烧猪肉' },
    { veg: '木耳', method: '炒', name: v => v + '炒猪肉' },
    { veg: '冬瓜', method: '焖', name: v => v + '焖猪肉' },
    { veg: '四季豆', method: '炒', name: v => v + '炒猪肉' },
    { veg: '茭白', method: '炒', name: v => v + '炒猪肉' },
    { veg: '苦瓜', method: '炒', name: v => v + '炒猪肉' },
  ],
  '牛肉': [
    { veg: '芥蓝', method: '炒', name: v => v + '炒牛肉' },
    { veg: '南瓜', method: '焖', name: v => v + '焖牛肉' },
    { veg: '豆芽', method: '炒', name: v => v + '炒牛肉' },
    { veg: '豆腐', method: '烧', name: v => '牛肉烧' + v },
    { veg: '洋葱', method: '炒', name: v => v + '炒牛肉' },
    { veg: '芹菜', method: '炒', name: v => v + '炒牛肉' },
    { veg: '青椒', method: '炒', name: v => v + '炒牛肉' },
    { veg: '番茄', method: '炒', name: v => v + '炒牛肉' },
  ],
  '鸡肉': [
    { veg: '西兰花', method: '炒', name: v => v + '炒鸡肉' },
    { veg: '腰果', method: '炒', name: v => '腰果炒鸡丁' },
    { veg: '板栗', method: '烧', name: v => '板栗烧鸡' },
    { veg: '胡萝卜', method: '炒', name: v => v + '炒鸡肉' },
    { veg: '南瓜', method: '蒸', name: v => v + '蒸鸡肉' },
    { veg: '洋葱', method: '炒', name: v => v + '炒鸡肉' },
    { veg: '香菇', method: '炒', name: v => v + '炒鸡肉' },
  ],
  '鸭肉': [
    { veg: '魔芋', method: '烧', name: v => v + '烧鸭肉' },
    { veg: '啤酒', method: '烧', name: v => v + '烧鸭' },
    { veg: '酸萝卜', method: '炖', name: v => '老鸭炖' + v },
    { veg: '冬瓜', method: '焖', name: v => v + '焖鸭肉' },
  ],
  '鸡蛋': [
    { veg: '韭菜', method: '炒', name: v => v + '炒鸡蛋' },
    { veg: '西葫芦', method: '炒', name: v => v + '炒鸡蛋' },
    { veg: '苦瓜', method: '炒', name: v => v + '炒鸡蛋' },
    { veg: '木耳', method: '炒', name: v => v + '炒鸡蛋' },
    { veg: '菠菜', method: '炒', name: v => v + '炒鸡蛋' },
    { veg: '虾仁', method: '炒', name: v => v + '炒鸡蛋' },
  ],
  '鲈鱼': [
    { veg: '柠檬', method: '蒸', name: v => v + '蒸鲈鱼' },
    { veg: '', method: '煎', name: () => '煎鲈鱼' },
    { veg: '蒜香', method: '蒸', name: v => v + '鲈鱼' },
    { veg: '豉汁', method: '蒸', name: v => v + '蒸鲈鱼' },
    { veg: '冬瓜', method: '炖', name: v => '鲈鱼炖' + v },
  ],
  '草鱼': [
    { veg: '酸菜', method: '煮', name: v => v + '草鱼' },
    { veg: '豆腐', method: '炖', name: v => '草鱼炖' + v },
    { veg: '', method: '蒸', name: () => '清蒸草鱼' },
    { veg: '番茄', method: '烧', name: v => v + '烧草鱼' },
    { veg: '蒜香', method: '烤', name: v => v + '烤草鱼' },
  ],
  '鲫鱼': [
    { veg: '豆腐', method: '炖', name: v => '鲫鱼炖' + v },
    { veg: '萝卜', method: '炖', name: v => v + '鲫鱼汤' },
    { veg: '', method: '蒸', name: () => '清蒸鲫鱼' },
    { veg: '剁椒', method: '蒸', name: v => v + '蒸鲫鱼' },
  ],
  '鳕鱼': [
    { veg: '', method: '煎', name: () => '煎鳕鱼' },
    { veg: '番茄', method: '烧', name: v => v + '烧鳕鱼' },
    { veg: '', method: '蒸', name: () => '清蒸鳕鱼' },
    { veg: '蒜香', method: '烤', name: v => v + '烤鳕鱼' },
  ],
  '带鱼': [
    { veg: '', method: '煎', name: () => '煎带鱼' },
    { veg: '番茄', method: '烧', name: v => v + '烧带鱼' },
    { veg: '糖醋', method: '烧', name: v => '糖醋带鱼' },
    { veg: '干烧', method: '烧', name: v => '干烧带鱼' },
  ],
  '大虾': [
    { veg: '蒜蓉', method: '炒', name: v => v + '炒大虾' },
    { veg: '西芹', method: '炒', name: v => v + '炒大虾' },
    { veg: '葱油', method: '灼', name: v => v + '大虾' },
    { veg: '柠檬', method: '烤', name: v => v + '烤大虾' },
    { veg: '蒜香', method: '烤', name: v => v + '烤大虾' },
  ],
  '基围虾': [
    { veg: '', method: '灼', name: () => '白灼基围虾' },
    { veg: '椒盐', method: '炸', name: v => v + '基围虾' },
    { veg: '蒜蓉', method: '蒸', name: v => v + '蒸基围虾' },
    { veg: '油焖', method: '焖', name: v => v + '基围虾' },
  ],
  '鱿鱼': [
    { veg: '', method: '炒', name: () => '爆炒鱿鱼' },
    { veg: '椒盐', method: '炸', name: v => v + '鱿鱼' },
    { veg: '铁板', method: '烤', name: v => v + '鱿鱼' },
    { veg: '洋葱', method: '炒', name: v => v + '炒鱿鱼' },
  ],
  '蛤蜊': [
    { veg: '豆腐', method: '炖', name: v => v + '炖蛤蜊' },
    { veg: '酒蒸', method: '蒸', name: v => v + '蛤蜊' },
    { veg: '辣炒', method: '炒', name: v => v + '蛤蜊' },
  ],
  '排骨': [
    { veg: '莲藕', method: '炖', name: v => v + '炖排骨' },
    { veg: '南瓜', method: '蒸', name: v => v + '蒸排骨' },
    { veg: '玉米', method: '炖', name: v => v + '炖排骨' },
    { veg: '蒜蓉', method: '蒸', name: v => v + '蒸排骨' },
    { veg: '山药', method: '炖', name: v => v + '炖排骨' },
    { veg: '豆豉', method: '蒸', name: v => v + '蒸排骨' },
  ],
  '牛腩': [
    { veg: '萝卜', method: '炖', name: v => '牛腩炖' + v },
    { veg: '番茄', method: '炖', name: v => '牛腩炖' + v },
    { veg: '土豆', method: '焖', name: v => '牛腩焖' + v },
    { veg: '菌菇', method: '炖', name: v => '牛腩炖' + v },
  ],
  '羊肉': [
    { veg: '萝卜', method: '炖', name: v => '羊肉炖' + v },
    { veg: '胡萝卜', method: '炖', name: v => '羊肉炖' + v },
    { veg: '冬瓜', method: '炖', name: v => '羊肉炖' + v },
    { veg: '山药', method: '炖', name: v => '羊肉炖' + v },
    { veg: '葱爆', method: '炒', name: v => v + '羊肉' },
  ],
  '豆腐': [
    { veg: '肉末', method: '烧', name: v => v + '烧豆腐' },
    { veg: '', method: '煎', name: () => '煎豆腐' },
    { veg: '番茄', method: '烧', name: v => v + '烧豆腐' },
    { veg: '韭菜', method: '炒', name: v => v + '炒豆腐' },
    { veg: '菌菇', method: '炖', name: v => v + '炖豆腐' },
    { veg: '鱼香', method: '烧', name: v => '鱼香豆腐' },
    { veg: '虾仁', method: '烧', name: v => v + '烧豆腐' },
  ],
  '大米': [
    { veg: '蛋炒', method: '炒', name: () => '蛋炒饭' },
    { veg: '咖喱', method: '焖', name: () => '咖喱饭' },
    { veg: '腊味', method: '焖', name: () => '腊味煲仔饭' },
  ],
  '面条': [
    { veg: '葱油', method: '拌', name: () => '葱油拌面' },
    { veg: '番茄', method: '炒', name: v => v + '炒面' },
    { veg: '麻酱', method: '拌', name: () => '麻酱拌面' },
    { veg: '雪菜', method: '炒', name: v => v + '炒面' },
  ],
  '粥': [
    { veg: '皮蛋瘦肉', method: '煮', name: () => '皮蛋瘦肉粥' },
    { veg: '南瓜', method: '煮', name: v => v + '粥' },
    { veg: '红豆', method: '煮', name: v => v + '粥' },
    { veg: '山药', method: '煮', name: v => v + '粥' },
  ],
  '兔肉': [
    { veg: '', method: '拌', name: () => '冷吃兔' },
    { veg: '双椒', method: '炒', name: v => v + '兔丁' },
    { veg: '土豆', method: '炖', name: v => '兔肉炖' + v },
  ],
  '牛蛙': [
    { veg: '干锅', method: '烧', name: v => v + '牛蛙' },
    { veg: '泡椒', method: '炒', name: v => v + '牛蛙' },
    { veg: '豆腐', method: '炖', name: v => '牛蛙炖' + v },
  ],
  '腊肉': [
    { veg: '蒜薹', method: '炒', name: v => v + '炒腊肉' },
    { veg: '笋干', method: '炒', name: v => v + '炒腊肉' },
    { veg: '大米', method: '炒', name: () => '腊肉炒饭' },
  ],
  '包菜': [
    { veg: '', method: '炒', name: () => '手撕包菜' },
    { veg: '猪肉', method: '炒', name: v => v + '炒包菜' },
    { veg: '粉丝', method: '炒', name: v => v + '炒包菜' },
  ],
  '莴笋': [
    { veg: '猪肉', method: '炒', name: v => v + '炒莴笋' },
    { veg: '', method: '拌', name: () => '凉拌莴笋' },
    { veg: '鸡肉', method: '炒', name: v => v + '炒莴笋' },
  ],
  '花菜': [
    { veg: '干锅', method: '烧', name: v => v + '花菜' },
    { veg: '猪肉', method: '炒', name: v => v + '炒花菜' },
    { veg: '番茄', method: '炒', name: v => v + '炒花菜' },
  ],
  '油麦菜': [
    { veg: '蒜蓉', method: '炒', name: v => v + '油麦菜' },
    { veg: '', method: '炒', name: () => '清炒油麦菜' },
    { veg: '豆豉', method: '炒', name: v => v + '油麦菜' },
  ],
  '空心菜': [
    { veg: '蒜蓉', method: '炒', name: v => v + '空心菜' },
    { veg: '', method: '炒', name: () => '清炒空心菜' },
  ],
  '豆角': [
    { veg: '干煸', method: '炒', name: () => '干煸豆角' },
    { veg: '猪肉', method: '炒', name: v => v + '炒豆角' },
    { veg: '土豆', method: '炖', name: v => v + '炖豆角' },
  ],
  '藕': [
    { veg: '酸辣', method: '炒', name: v => v + '藕丁' },
    { veg: '排骨', method: '炖', name: v => v + '炖藕' },
    { veg: '', method: '拌', name: () => '凉拌藕片' },
  ],
  '汤羹': [
    { veg: '番茄蛋花', method: '煮', name: () => '番茄蛋花汤' },
    { veg: '紫菜蛋花', method: '煮', name: () => '紫菜蛋花汤' },
    { veg: '酸辣', method: '煮', name: () => '酸辣汤' },
    { veg: '玉米', method: '煮', name: v => v + '排骨汤' },
  ],
  '小吃': [
    { veg: '煎饺', method: '煎', name: () => '煎饺' },
    { veg: '春卷', method: '炸', name: () => '炸春卷' },
    { veg: '烧麦', method: '蒸', name: () => '烧麦' },
    { veg: '葱油饼', method: '煎', name: () => '葱油饼' },
  ],
  // —— 菌菇类 ——
  '香菇': [
    { veg: '猪肉', method: '炒', name: v => v + '炒香菇' },
    { veg: '鸡肉', method: '炖', name: v => '香菇炖' + v },
    { veg: '蚝油', method: '烧', name: () => '蚝油香菇' },
    { veg: '肉末', method: '蒸', name: () => '香菇酿肉' },
    { veg: '青菜', method: '炒', name: v => v + '炒香菇' },
  ],
  '金针菇': [
    { veg: '肥牛', method: '煮', name: () => '金针菇肥牛' },
    { veg: '蒜蓉', method: '蒸', name: v => v + '蒸金针菇' },
    { veg: '', method: '拌', name: () => '凉拌金针菇' },
    { veg: '豆腐', method: '煮', name: v => v + '煮金针菇' },
  ],
  '杏鲍菇': [
    { veg: '蚝油', method: '烧', name: () => '蚝油杏鲍菇' },
    { veg: '黑椒', method: '炒', name: () => '黑椒杏鲍菇' },
    { veg: '猪肉', method: '炒', name: v => v + '炒杏鲍菇' },
    { veg: '', method: '煎', name: () => '煎杏鲍菇' },
  ],
  '茶树菇': [
    { veg: '腊肉', method: '炒', name: v => v + '炒茶树菇' },
    { veg: '干锅', method: '烧', name: v => v + '茶树菇' },
    { veg: '鸡肉', method: '炖', name: v => '茶树菇炖' + v },
  ],
  '平菇': [
    { veg: '猪肉', method: '炒', name: v => v + '炒平菇' },
    { veg: '椒盐', method: '炸', name: v => v + '平菇' },
    { veg: '豆腐', method: '煮', name: v => v + '平菇汤' },
  ],
  // —— 海鲜类 ——
  '扇贝': [
    { veg: '蒜蓉', method: '蒸', name: v => v + '蒸扇贝' },
    { veg: '粉丝', method: '蒸', name: v => v + '蒸扇贝' },
    { veg: '豉汁', method: '蒸', name: v => v + '蒸扇贝' },
  ],
  '生蚝': [
    { veg: '蒜蓉', method: '烤', name: v => v + '烤生蚝' },
    { veg: '', method: '蒸', name: () => '清蒸生蚝' },
    { veg: '鸡蛋', method: '煎', name: () => '生蚝煎蛋' },
  ],
  '螃蟹': [
    { veg: '', method: '蒸', name: () => '清蒸螃蟹' },
    { veg: '香辣', method: '炒', name: v => v + '螃蟹' },
    { veg: '姜葱', method: '炒', name: v => v + '炒螃蟹' },
    { veg: '咖喱', method: '炒', name: v => v + '螃蟹' },
  ],
  '蛏子': [
    { veg: '葱油', method: '炒', name: v => v + '蛏子' },
    { veg: '辣炒', method: '炒', name: v => v + '蛏子' },
    { veg: '', method: '蒸', name: () => '清蒸蛏子' },
  ],
  // —— 面点类 ——
  '包子': [
    { veg: '猪肉大葱', method: '蒸', name: () => '猪肉大葱包' },
    { veg: '香菇青菜', method: '蒸', name: () => '香菇青菜包' },
    { veg: '豆沙', method: '蒸', name: () => '豆沙包' },
    { veg: '韭菜鸡蛋', method: '蒸', name: () => '韭菜鸡蛋包' },
  ],
  '饺子': [
    { veg: '猪肉', method: '煮', name: () => '猪肉饺子' },
    { veg: '韭菜鸡蛋', method: '煮', name: () => '韭菜鸡蛋饺' },
    { veg: '虾仁', method: '煮', name: () => '虾仁饺子' },
    { veg: '白菜猪肉', method: '煮', name: () => '白菜猪肉饺' },
  ],
  '馄饨': [
    { veg: '鲜肉', method: '煮', name: () => '鲜肉馄饨' },
    { veg: '虾仁', method: '煮', name: () => '虾仁馄饨' },
    { veg: '荠菜猪肉', method: '煮', name: () => '荠菜猪肉馄饨' },
  ],
  '烙饼': [
    { veg: '葱油', method: '煎', name: () => '葱油饼' },
    { veg: '鸡蛋', method: '煎', name: () => '鸡蛋灌饼' },
    { veg: '酱香', method: '煎', name: () => '酱香饼' },
  ],
};
// 菜系 → 偏好蛋白（提名组合用，保证菜系轮换落地）
const CUISINE_MAP = {
  '川菜': ['牛肉', '猪肉', '鸡蛋', '草鱼', '豆腐', '兔肉', '牛蛙', '豆角', '茶树菇', '杏鲍菇'],
  '湘菜': ['猪肉', '牛肉', '鸡肉', '鲫鱼', '豆腐', '腊肉', '包菜', '剁椒', '茶树菇'],
  '粤菜': ['鲈鱼', '大虾', '排骨', '基围虾', '蛤蜊', '油麦菜', '扇贝', '生蚝', '香菇'],
  '鲁菜': ['猪肉', '牛肉', '带鱼', '大虾', '排骨', '藕', '花菜', '螃蟹', '蛏子'],
  '浙菜': ['鲈鱼', '猪肉', '鸡蛋', '草鱼', '面条', '莴笋', '生蚝', '馄饨'],
  '东北菜': ['排骨', '牛肉', '猪肉', '鸡肉', '豆腐', '包菜', '豆角', '饺子', '包子'],
  '家常菜': ['猪肉', '鸡蛋', '鸡肉', '豆腐', '面条', '包菜', '花菜', '汤羹', '香菇', '烙饼'],
  '西餐': ['牛肉', '大虾', '鳕鱼', '面条', '排骨', '小吃', '杏鲍菇', '生蚝'],
  '东南亚': ['大虾', '鸡肉', '鱿鱼', '蛤蜊', '大米', '空心菜', '螃蟹', '蛏子'],
  '烘焙': ['鸡蛋', '大米', '小吃', '包子', '烙饼'],
  '日料': ['鳕鱼', '大虾', '鱿鱼', '鸡蛋', '汤羹', '扇贝', '生蚝', '馄饨'],
  '韩餐': ['牛肉', '猪肉', '大虾', '豆腐', '包菜', '饺子', '螃蟹'],
};
// 做法 → 四字短评（提名菜本地生成 reason，免 AI）
const METHOD_REASON = {
  '炒': '咸鲜下饭', '炖': '浓香入味', '蒸': '原汁原味', '烧': '汁浓味醇',
  '焖': '软糯入味', '煎': '外酥里嫩', '烤': '焦香四溢', '炸': '酥脆可口',
  '卤': '醇香浓厚', '煮': '清淡温润', '拌': '清爽开胃',
};

// —— 饮品模板池（确定性提名，保证饮品稳定占比，不依赖 AI 自由发挥）——
// 名称直接用饮品本名（不加"饮品"后缀，符合命名规范 1l/1t）；
// category 固定 '饮品'，mealTime 固定 ['小吃','下午茶']。
const DRINK_REASON = ['温润甘淡', '清冽爽口', '清香回甘', '醇厚绵长', '爽口解渴', '清甜润喉'];
const DRINK_TMPL = [
  // 茶饮 —— 纯茶（明确为「X茶」，避免被当成干茶叶）
  { name: '茉莉花茶', cuisine: '家常', mainIngredient: '茉莉花', cookingMethod: '泡', reason: '清香回甘' },
  { name: '铁观音茶', cuisine: '家常', mainIngredient: '铁观音茶叶', cookingMethod: '泡', reason: '醇厚绵长' },
  { name: '龙井茶', cuisine: '家常', mainIngredient: '龙井茶叶', cookingMethod: '泡', reason: '清冽爽口' },
  { name: '普洱茶', cuisine: '家常', mainIngredient: '普洱茶叶', cookingMethod: '泡', reason: '醇厚绵长' },
  { name: '红茶', cuisine: '家常', mainIngredient: '红茶茶叶', cookingMethod: '泡', reason: '醇厚绵长' },
  { name: '绿茶', cuisine: '家常', mainIngredient: '绿茶茶叶', cookingMethod: '泡', reason: '清冽爽口' },
  { name: '乌龙茶', cuisine: '家常', mainIngredient: '乌龙茶叶', cookingMethod: '泡', reason: '清香回甘' },
  { name: '白茶', cuisine: '家常', mainIngredient: '白茶茶叶', cookingMethod: '泡', reason: '清冽爽口' },
  // 花茶 —— 名称显式带「用的花」，扩充种类与生成占比
  { name: '桂花茶', cuisine: '家常', mainIngredient: '桂花', cookingMethod: '泡', reason: '甜香清润' },
  { name: '玫瑰花茶', cuisine: '家常', mainIngredient: '玫瑰花', cookingMethod: '泡', reason: '香气温润' },
  { name: '菊花茶', cuisine: '家常', mainIngredient: '菊花', cookingMethod: '煮', reason: '温润甘淡' },
  { name: '洛神花茶', cuisine: '家常', mainIngredient: '洛神花', cookingMethod: '煮', reason: '酸甜清爽' },
  { name: '金银花茶', cuisine: '家常', mainIngredient: '金银花', cookingMethod: '泡', reason: '清润降火' },
  { name: '百合花茶', cuisine: '家常', mainIngredient: '百合花', cookingMethod: '泡', reason: '清润安神' },
  { name: '桃花茶', cuisine: '家常', mainIngredient: '桃花', cookingMethod: '泡', reason: '清香淡雅' },
  { name: '荷花茶', cuisine: '家常', mainIngredient: '荷花', cookingMethod: '泡', reason: '清雅回甘' },
  { name: '桂花乌龙', cuisine: '家常', mainIngredient: '乌龙茶', cookingMethod: '泡', reason: '清香回甘' },
  { name: '菊花枸杞茶', cuisine: '家常', mainIngredient: '菊花', cookingMethod: '煮', reason: '温润甘淡' },
  { name: '玫瑰花桂圆茶', cuisine: '家常', mainIngredient: '玫瑰花', cookingMethod: '煮', reason: '香气温补' },
  // 调味茶 / 复合茶
  { name: '柠檬红茶', cuisine: '西餐', mainIngredient: '红茶', cookingMethod: '泡', reason: '爽口解渴' },
  { name: '姜枣茶', cuisine: '家常', mainIngredient: '生姜', cookingMethod: '煮', reason: '温润甘淡' },
  { name: '苹果肉桂茶', cuisine: '西餐', mainIngredient: '苹果', cookingMethod: '煮', reason: '温甜馥郁' },
  // 果汁 / 豆浆
  { name: '鲜榨橙汁', cuisine: '家常', mainIngredient: '橙子', cookingMethod: '榨', reason: '清甜润喉' },
  { name: '鲜榨西瓜汁', cuisine: '家常', mainIngredient: '西瓜', cookingMethod: '榨', reason: '清冽爽口' },
  { name: '鲜榨苹果汁', cuisine: '家常', mainIngredient: '苹果', cookingMethod: '榨', reason: '清甜润喉' },
  { name: '黄豆浆', cuisine: '家常', mainIngredient: '黄豆', cookingMethod: '煮', reason: '温润甘淡' },
  { name: '黑豆浆', cuisine: '家常', mainIngredient: '黑豆', cookingMethod: '煮', reason: '温润甘淡' },
  { name: '五谷豆浆', cuisine: '家常', mainIngredient: '杂粮', cookingMethod: '煮', reason: '温润甘淡' },
  { name: '椰汁', cuisine: '东南亚', mainIngredient: '椰子', cookingMethod: '榨', reason: '清甜润喉' },
  // 奶昔 / 酸奶
  { name: '芒果奶昔', cuisine: '西餐', mainIngredient: '芒果', cookingMethod: '打', reason: '清甜润喉' },
  { name: '香蕉奶昔', cuisine: '西餐', mainIngredient: '香蕉', cookingMethod: '打', reason: '温润甘淡' },
  { name: '草莓酸奶', cuisine: '西餐', mainIngredient: '草莓', cookingMethod: '发酵', reason: '清甜润喉' },
  { name: '蓝莓酸奶', cuisine: '西餐', mainIngredient: '蓝莓', cookingMethod: '发酵', reason: '清甜润喉' },
  // 咖啡
  { name: '美式咖啡', cuisine: '西餐', mainIngredient: '咖啡豆', cookingMethod: '萃取', reason: '醇厚绵长' },
  { name: '燕麦拿铁', cuisine: '西餐', mainIngredient: '咖啡豆', cookingMethod: '萃取', reason: '醇厚绵长' },
  { name: '生椰拿铁', cuisine: '西餐', mainIngredient: '咖啡豆', cookingMethod: '萃取', reason: '醇厚绵长' },
  // 中式糖水 / 其他
  { name: '酸梅汤', cuisine: '家常', mainIngredient: '乌梅', cookingMethod: '煮', reason: '爽口解渴' },
  { name: '绿豆沙', cuisine: '家常', mainIngredient: '绿豆', cookingMethod: '煮', reason: '清冽爽口' },
  { name: '红豆沙', cuisine: '家常', mainIngredient: '红豆', cookingMethod: '煮', reason: '温润甘淡' },
  { name: '杨枝甘露', cuisine: '东南亚', mainIngredient: '芒果', cookingMethod: '煮', reason: '清甜润喉' },
  { name: '姜枣茶', cuisine: '家常', mainIngredient: '生姜', cookingMethod: '煮', reason: '温润甘淡' },
  { name: '柠檬蜂蜜水', cuisine: '西餐', mainIngredient: '柠檬', cookingMethod: '泡', reason: '爽口解渴' },
];
function buildDrinkNominations(K, dedupPool) {
  const out = [];
  const seen = new Set();
  const poolNorm = new Set((dedupPool || []).map(n => normalizeDishName(n)));
  const tryAdd = (d) => {
    if (out.length >= K) return true;
    if (!d || !validateDishName(d.name)) return false;
    const norm = normalizeDishName(d.name);
    if (seen.has(norm) || ALL_NORM_SET.has(norm) || poolNorm.has(norm)) return false;
    seen.add(norm);
    out.push({ ...d, category: '饮品', mealTime: ['小吃', '下午茶'], season: ['spring', 'summer', 'autumn', 'winter'] });
    return out.length >= K;
  };
  for (const d of shuffle([...DRINK_TMPL])) {
    if (out.length >= K) break;
    tryAdd(d);
  }
  return out;
}

// ── 花茶 AI 兜底通道 ───────────────────────────────────────────────────────
// 仅当模板池（DRINK_TMPL）已抽空 / 全部撞库（即 buildDrinkNominations 不足 K 道）时，
// 才由 AI 自由生成带「具体花名」的花茶补满配额，避免模板池 22 道 6 轮后断供。
// 带「花名」约束 + 全库去重，保证不重复、且生图能识别（一杯花茶而非干花）。
async function genFlowerTeaCandidates(K, dedupPool) {
  const poolNorm = new Set((dedupPool || []).map(n => normalizeDishName(n)));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages: [{
          role: 'user',
          content: [
            '你是花茶创作助手。请生成 ' + K + ' 道花茶饮品，要求：',
            '1. 茶名必须显式包含所用花卉名（如茉莉花茶、桂花茶、玫瑰花茶、菊花茶、洛神花茶、金银花茶、百合花茶、桃花茶、荷花茶、洋甘菊花茶、紫罗兰花茶、樱花茶等），严禁只写"花茶"笼统名',
            '2. 必须是泡好/煮好的茶饮（一杯花茶），严禁写成干花原料（"茉莉花"错误，应"茉莉花茶"）',
            '3. 可复合（玫瑰花桂圆茶、菊花枸杞茶），但主花名必出现',
            '4. 菜名 2~8 字，不加"饮品"后缀',
            '5. reason：文言文体四字短评（温润甘淡/清香回甘/甜香清润/清雅回甘等），契合花茶风味',
            '6. 以下为已有饮品（严禁重复）：' + Array.from(poolNorm).join('、'),
            '输出 JSON 数组：[{"name":"花茶名","mainIngredient":"主要花卉","cookingMethod":"泡|煮","reason":"四字文言短评"}]',
          ].join('\n'),
        }],
        temperature: 0.9,
        maxTokens: 400,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const arr = parseJsonArray(text);
      if (!arr || !arr.length) { if (attempt < 2) { await new Promise(r => setTimeout(r, 800 * (attempt + 1))); continue; } return []; }
      const out = [];
      const seen = new Set();
      for (const d of arr) {
        if (out.length >= K) break;
        if (!d || !d.name || !validateDishName(d.name)) continue;
        const norm = normalizeDishName(d.name);
        if (seen.has(norm) || ALL_NORM_SET.has(norm) || poolNorm.has(norm)) continue;
        // 2026-09-01：去形容词前缀后命中视为重复（源头拦截）
        const stripped = stripAdjPrefix(norm);
        if (stripped && stripped !== norm && (ALL_NORM_SET.has(stripped) || poolNorm.has(stripped))) continue;
        seen.add(norm);
        out.push({
          name: d.name,
          category: '饮品',
          mealTime: ['小吃', '下午茶'],
          cuisine: '家常',
          mainIngredient: d.mainIngredient || '',
          cookingMethod: d.cookingMethod || '泡',
          reason: d.reason || '清香回甘',
          season: ['spring', 'summer', 'autumn', 'winter'],
        });
      }
      return out;
    } catch (e) {
      if (attempt < 2) { await new Promise(r => setTimeout(r, 800 * (attempt + 1))); continue; }
      console.warn('[genFlowerTeaCandidates] AI 生成失败：', e && e.message);
    }
  }
  return [];
}

// —— 菜名归一化（复用 manageShopping SYNONYMS，解决"不同名但同菜"去重缺口）——
const SYNONYMS = [
  [/番茄/g, '西红柿'],
  [/蕃茄/g, '西红柿'],
  [/马铃薯/g, '土豆'],
  [/洋芋/g, '土豆'],
  [/柿子椒/g, '青椒'],
  [/红萝卜/g, '胡萝卜'],
  [/胡罗卜/g, '胡萝卜'],
  [/大葱/g, '葱'],
  [/小葱/g, '葱'],
  [/香葱/g, '葱'],
  [/虾仁/g, '虾'],
  [/鸡蛋/g, '蛋']
];

// —— 烹饪动词归一表（2026-08-25 新增，解决"同菜异动词"去重缺口）——
// 近义烹饪动词 → 规范动词，使"大葱炒猪肉"与"大葱爆猪肉"归一为同一菜名而被判重。
// 仅合并语义高度重合、指向同一道菜表达的动词；差异显著的（如 蒸/烤/卤）保持独立。
const COOK_VERB_CANON = [
  [/爆炒/g, '炒'], [/煸炒/g, '炒'], [/干煸/g, '炒'], [/煸/g, '炒'], [/炝炒/g, '炒'], [/炝/g, '炒'], [/清炒/g, '炒'], [/翻炒/g, '炒'], [/颠炒/g, '炒'], [/爆/g, '炒'],
  [/红烧/g, '烧'], [/油焖/g, '烧'], [/干烧/g, '烧'], [/烩/g, '烧'], [/烧/g, '烧'],
  [/炖焖/g, '炖'], [/焖炖/g, '炖'], [/焖/g, '炖'], [/煨/g, '炖'], [/笃/g, '炖'], [/砂锅/g, '炖'], [/煲/g, '炖'], [/炖/g, '炖'],
  [/香煎/g, '煎'], [/煎制/g, '煎'], [/煎烙/g, '煎'], [/烙/g, '煎'], [/煎/g, '煎'],
  [/清炸/g, '炸'], [/酥炸/g, '炸'], [/软炸/g, '炸'], [/炸制/g, '炸'], [/炸/g, '炸'],
  [/白灼/g, '灼'], [/灼/g, '灼'], [/汆/g, '煮'], [/涮煮/g, '煮'], [/水煮/g, '煮'], [/煮/g, '煮'],
  [/烤箱/g, '烤'], [/焗烤/g, '烤'], [/烤制/g, '烤'], [/焗/g, '烤'], [/烤/g, '烤'],
  [/凉拌/g, '拌'], [/拌制/g, '拌'], [/拌/g, '拌'],
  [/卤制/g, '卤'], [/酱卤/g, '卤'], [/卤/g, '卤'],
  [/清蒸/g, '蒸'], [/蒸制/g, '蒸'], [/粉蒸/g, '蒸'], [/蒸/g, '蒸'],
];
function normalizeDishName(name) {
  let n = String(name || '');
  n = n.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
  n = n.replace(/\s+/g, '');
  for (const [re, rep] of SYNONYMS) n = n.replace(re, rep);
  for (const [re, rep] of COOK_VERB_CANON) n = n.replace(re, rep);
  return n;
}

// 2026-09-01：菜名形容词前缀黑名单（秘制/招牌/爽口/自制…）。
// 用户反馈 env2 生成器把主库已有菜加这类前缀重复生成（秘制花甲vs花甲、爽口泡菜vs泡菜）进审核池。
// 归一化后先去前缀再查重，命中即视为重复（零 AI、确定性强）。
const ADJ_PREFIX_LIST = [
  '秘制', '招牌', '爽口', '正宗', '特制', '风味', '特色', '美味', '经典', '香辣', '麻辣',
  '传统', '古法', '私房', '私厨', '宫廷', '老字号', '网红', '爆款', '人气', '必点',
  '自制', '快手', '懒人', '简单', '零失败', '绝味', '飘香', '鲜香', '下饭', '开胃',
  '暖胃', '养胃', '滋补', '养生', '营养', '健康', '低脂', '减脂', '祖传', '外婆', '奶奶', '妈妈',
  '秘方', '饭店', '酒楼', '餐厅', '大厨', '豪华', '顶级', '至尊', '金牌',
];
// 去除全部连续形容词前缀（秘制爽口花甲 → 花甲），剩余须 ≥2 字才认为剥离成功
function stripAdjPrefix(name) {
  let n = String(name || '').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of ADJ_PREFIX_LIST) {
      if (n.startsWith(p) && n.length > p.length + 1) {
        n = n.slice(p.length);
        changed = true;
        break;
      }
    }
  }
  return n;
}

// —— 别名食材归一表（主食材别名 → 归一主食材，用于"别名食材同类菜"去重）——
// 覆盖同一食材的不同叫法：如 马铃薯/洋芋/薯仔→土豆、牛腩/牛瘦肉→牛肉、猪瘦肉/五花肉→猪肉
const INGREDIENT_SYNONYMS = [
  [/马铃薯/g, '土豆'], [/洋芋/g, '土豆'], [/薯仔/g, '土豆'], [/土豆/g, '土豆'],
  [/西红柿/g, '番茄'], [/蕃茄/g, '番茄'], [/番茄/g, '番茄'],
  [/牛腩/g, '牛肉'], [/牛瘦肉/g, '牛肉'], [/牛里脊/g, '牛肉'], [/牛腿肉/g, '牛肉'], [/牛肉/g, '牛肉'],
  [/猪瘦肉/g, '猪肉'], [/五花肉/g, '猪肉'], [/猪里脊/g, '猪肉'], [/猪肉/g, '猪肉'], [/豚肉/g, '猪肉'],
  [/鸡胸肉/g, '鸡肉'], [/鸡腿肉/g, '鸡肉'], [/鸡翅/g, '鸡肉'], [/鸡肉/g, '鸡肉'],
  [/虾/g, '虾'], [/鲜虾/g, '虾'],
  [/鸡蛋/g, '蛋'], [/土鸡蛋/g, '蛋'], [/鸭蛋/g, '蛋'],
  [/青椒/g, '青椒'], [/柿子椒/g, '青椒'],
  [/胡萝卜/g, '胡萝卜'], [/红萝卜/g, '胡萝卜'],
  [/葱/g, '葱'], [/大葱/g, '葱'], [/小葱/g, '葱'], [/香葱/g, '葱'],
  // 常见易词序互换组合食材（补入以支持 checkOrderSwapDup 提取主食材）
  [/青瓜/g, '黄瓜'], [/黄瓜/g, '黄瓜'],
  [/松花蛋/g, '皮蛋'], [/变蛋/g, '皮蛋'], [/皮蛋/g, '皮蛋', ],
  [/嫩豆腐/g, '豆腐'], [/老豆腐/g, '豆腐'], [/北豆腐/g, '豆腐'], [/南豆腐/g, '豆腐'], [/豆腐/g, '豆腐'],
  [/黑木耳/g, '木耳'], [/云耳/g, '木耳'], [/木耳/g, '木耳'],
  [/大白菜/g, '白菜'], [/黄芽白/g, '白菜'], [/白菜/g, '白菜'],
  [/东瓜/g, '冬瓜'], [/冬瓜/g, '冬瓜'],
  [/紫茄/g, '茄子'], [/青茄/g, '茄子'], [/茄子/g, '茄子'],
  [/黄豆芽/g, '豆芽'], [/绿豆芽/g, '豆芽'], [/豆芽/g, '豆芽'],
  [/金针菜/g, '金针菇'], [/金针菇/g, '金针菇'],
  [/冬菇/g, '香菇'], [/香蕈/g, '香菇'], [/香菇/g, '香菇'],
  [/小白菜/g, '青菜'], [/鸡毛菜/g, '青菜'], [/青菜/g, '青菜'],
];
function normalizeIngredient(word) {
  let w = String(word || '');
  for (const [re, rep] of INGREDIENT_SYNONYMS) w = w.replace(re, rep);
  return w;
}
// 从菜名提取归一主食材：依次用所有别名词（归一后）匹配菜名，取首个命中
function extractMainIngredient(name) {
  const normName = normalizeDishName(name); // 先把菜名里的别名也归一（马铃薯→土豆）
  const seen = new Set();
  for (const [re] of INGREDIENT_SYNONYMS) {
    const m = normName.match(re);
    if (m) {
      const ing = normalizeIngredient(m[0]);
      if (!seen.has(ing)) { seen.add(ing); return ing; }
    }
  }
  return '';
}

// 主食材索引：归一主食材 → Set(归一菜名)。懒加载（首次调用 checkAliasDup 时构建），避免模块加载期同步重活触发 SCF 145
let MAIN_ING_INDEX = null;
function ensureMainIngIndex() {
  if (MAIN_ING_INDEX) return MAIN_ING_INDEX;
  const idx = {};
  for (const n of (COOK_REF_NAMES || [])) {
    const ing = extractMainIngredient(n);
    if (!ing) continue;
    if (!idx[ing]) idx[ing] = new Set();
    idx[ing].add(normalizeDishName(n));
  }
  MAIN_ING_INDEX = idx;
  return idx;
}

// —— 别名食材同类去重（第四层，AI 校验）——
// 提取候选菜归一主食材 → 命中 MAIN_ING_INDEX → 取同主食材库内菜名列表 → hy3 判是否同一道菜（仅别名/做法措辞差异）
// 主食材不同直接放行（零 AI）。返回 {isDup, similar, reason}
async function checkAliasDup(name, allNames) {
  const normName = normalizeDishName(name);
  // 归一化已精确命中则不再走本层（checkSimilar 第0层已处理）
  const mainIng = extractMainIngredient(name);
  if (!mainIng) return { isDup: false, similar: '', reason: 'no_main_ing' };
  // 运行时补充：把 allNames（dish_mirror 当前）也并入索引
  const idx = ensureMainIngIndex();
  for (const n of allNames) addAliasIndex(n);
  const pool = idx[mainIng];
  if (!pool || !pool.size) return { isDup: false, similar: '', reason: 'no_pool' };
  // 同主食材且归一菜名不同（否则是精确同名，checkSimilar 已拦）
  const candidates = [...pool].filter(n => n !== normName);
  if (!candidates.length) return { isDup: false, similar: '', reason: 'no_candidate' };

  const prompt = [
    '你是菜名相似度判定器。判断候选菜名是否与目标菜是同一道菜（仅食材别名/做法措辞不同，本质同一道）。',
    '只输出 JSON：{"similar":"","isDup":false}',
    'similar=相似菜名（空串表示无重复），isDup=true 表示是重复菜。',
    '判定标准：',
    '  - 同主食材 + 仅别名/做法词不同 → 同菜：土豆炖牛肉≈马铃薯烧牛肉、番茄炒蛋≈西红柿炒蛋。',
    '  - 同主食材 + 近义烹饪动词不同（本质同一道菜的两种叫法）→ 同菜：大葱炒猪肉≈大葱爆猪肉、土豆炖牛肉≈土豆焖牛肉、青椒煎蛋≈青椒烙蛋、红烧肉≈油焖肉（炒/爆、炖/焖/煨、烧/烩/油焖、煎/烙、炸/酥炸、白灼/灼、煮/汆/涮、烤/焗、拌/凉拌、卤/酱卤、蒸/粉蒸 等近义动词视为等同）。',
    '  - 同主食材 + 明显不同做法/不同辅料 → 不同菜（应放行）：番茄炒蛋≠番茄炖牛腩、土豆烧牛肉≠土豆炖豆腐。',
    '  - 主食材不同 → 不同菜（本层不判，直接放行）。',
    '重要：只有"本质同一道菜，仅叫法/做法措辞差异"才判 isDup=true；不同做法的同类菜应判 isDup=false。',
    '目标菜：' + name + '（主食材：' + mainIng + '）',
    '候选：' + candidates.join('、'),
  ].join('\n');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        maxTokens: 128,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const m = String(text).match(/\{[\s\S]*\}/);
      if (!m) throw new Error('非 JSON');
      const obj = JSON.parse(m[0]);
      return { isDup: obj.isDup === true, similar: String(obj.similar || '').trim(), reason: 'hy3' };
    } catch (e) {
      if (attempt < 1) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { isDup: false, similar: '', reason: 'hy3_fail' };
}
function addAliasIndex(name) {
  const idx = ensureMainIngIndex();
  const normName = normalizeDishName(name);
  const ing = extractMainIngredient(name);
  if (!ing) return;
  if (!idx[ing]) idx[ing] = new Set();
  idx[ing].add(normName);
}

// —— 词序互换同类去重（独立函数，接在出菜名之后）——
// 根因：extractMainIngredient 只取"首个"主食材，导致「皮蛋黄瓜汤」vs「黄瓜皮蛋汤」
// 主食材分桶不同（前者=皮蛋 后者=黄瓜），checkAliasDup 永不比较 → 漏判。
// 修复：提取菜名中"所有"归一主食材，排序成 set 签名；签名相同且归一名不同的两菜，
// 视为可能词序互换同类，交 hy3 判是否本质同菜。
let _mirrorNormNamesCache = null; // 模块级缓存：dish_mirror 现有归一菜名集合
async function loadMirrorNormNames() {
  if (_mirrorNormNamesCache) return _mirrorNormNamesCache;
  const set = new Set();
  try {
    // 不分页全量拉（dish_mirror 体量可控），仅取 name 字段
    const MAX = 2000;
    let skip = 0;
    while (skip < MAX) {
      const q = await db.collection('dish_mirror').field({ name: true }).skip(skip).limit(200).get();
      const list = (q && q.data) || [];
      for (const r of list) if (r.name) set.add(normalizeDishName(r.name));
      if (list.length < 200) break;
      skip += 200;
    }
  } catch (e) { /* 查询失败不阻断，仅用参考库池 */ }
  _mirrorNormNamesCache = set;
  return set;
}
// 菜名词 token 集合签名：归一菜名拆成单字集合（去重排序）。
// 用于"前后词序交换"重复判定——番茄皮蛋汤/皮蛋番茄汤 字符集相同 → 同签名；
// 而 番茄牛肉面/番茄牛肉汤 字符集不同（面≠汤）→ 不同签名，避免把不同形态菜误判重复。
function buildNameTokenSig(name) {
  const normName = normalizeDishName(name);
  const set = new Set([...normName]);
  return [...set].sort().join('');
}
// 提取菜名"所有"归一主食材 → 排序签名（如 黄瓜皮蛋汤/皮蛋黄瓜汤 均得 "黄瓜|皮蛋"）
function buildIngSig(name) {
  const normName = normalizeDishName(name);
  const ings = new Set();
  for (const [re] of INGREDIENT_SYNONYMS) {
    const m = normName.match(re);
    if (m) {
      const ing = normalizeIngredient(m[0]);
      if (ing) ings.add(ing);
    }
  }
  return [...ings].sort().join('|');
}
async function checkOrderSwapDup(name) {
  const sigA = buildIngSig(name);
  if (!sigA) return { isDup: false, reason: 'no_ing_sig' }; // 无主食材 → 不参与此层
  const normName = normalizeDishName(name);
  const mirrorNames = await loadMirrorNormNames();
  // 比较池：运行时 dish_mirror 现名 ∪ env1 参考库归一名
  const pool = new Set([...mirrorNames, ...COOK_REF_NORM_SET]);
  const cand = [];
  for (const bn of pool) {
    if (bn === normName) continue;          // 精确同名由 checkSimilar 第0层负责
    if (buildIngSig(bn) === sigA) cand.push(bn); // 同主食材签名且词序可能互换
  }
  if (cand.length === 0) return { isDup: false, reason: 'no_swap_cand' };
  // 交 hy3：是否本质同菜（仅词序/别名措辞不同）
  const prompt = [
    '判断两道菜是否"本质同一道菜"（仅食材词序颠倒、别名称呼不同、或近义烹饪动词不同，如 黄瓜皮蛋汤 vs 皮蛋黄瓜汤、番茄炒蛋 vs 西红柿炒蛋、大葱炒猪肉 vs 大葱爆猪肉、土豆炖牛肉 vs 土豆焖牛肉）。',
    '近义烹饪动词视为等同（炒/爆、炖/焖/煨、烧/烩/油焖、煎/烙、炸/酥炸、白灼/灼、煮/汆/涮、烤/焗、拌/凉拌、卤/酱卤、蒸/粉蒸）。',
    '若主料辅料与做法本质相同只是叫法/顺序/动词不同 → isDup:true；若明显不同做法/辅料 → isDup:false。',
    `候选菜A：${name}`,
    `库中疑似同菜：${cand.join('、')}`,
    '仅输出 JSON：{"isDup":true|false,"reason":"简短说明"}',
  ].join('\n');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        maxTokens: 128,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const m = String(text).match(/\{[\s\S]*\}/);
      if (!m) throw new Error('非 JSON');
      const obj = JSON.parse(m[0]);
      return { isDup: obj.isDup === true, similar: cand.join('、'), reason: 'hy3' };
    } catch (e) {
      if (attempt < 1) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { isDup: false, reason: 'hy3_fail' };
}

// 模块级 Fisher-Yates 洗牌，供 buildNominations / buildDrinkNominations 共用（避免作用域缺失导致 ReferenceError）
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// —— env1 cookbook_ref 完整食材库（1786 道菜：菜名→食材数组，用于去重 + 查表命中免调 AI）——
let COOK_REF = {};
try { COOK_REF = require('./cookbook_ref.json') || {}; } catch (e) { COOK_REF = {}; }
const COOK_REF_NAMES = Object.keys(COOK_REF);
// 预归一化索引，O(1) 查重
const COOK_REF_NORM_SET = new Set(COOK_REF_NAMES.map(n => normalizeDishName(n)));
// 归一化→原菜名 索引（用于 lookupCookRef 回退匹配）
const COOK_REF_NORM_INDEX = (() => {
  const m = {};
  for (const k of COOK_REF_NAMES) {
    const nk = normalizeDishName(k);
    if (nk && !m[nk]) m[nk] = k;
  }
  return m;
})();
// 查表：先精确匹配，再走归一化回退；命中返回参考食材数组，未命中返回 null
function lookupCookRef(dish) {
  if (!dish) return null;
  if (COOK_REF[dish]) return COOK_REF[dish];
  const nk = normalizeDishName(dish);
  if (nk && COOK_REF_NORM_INDEX[nk]) return COOK_REF[COOK_REF_NORM_INDEX[nk]];
  return null;
}

// —— env1 引导页食材主库（719 种，用于 prompt 引导 + 食材校验）——
let ING_MASTER = [];
try { ING_MASTER = require('./ingredient_master_names.json') || []; } catch (e) { ING_MASTER = []; }
const ING_MASTER_SET = new Set(ING_MASTER);
// 归一化后的主库索引（处理别名：番茄→西红柿 等）
const ING_MASTER_NORM_SET = new Set(ING_MASTER.map(n => normalizeDishName(n)));

// —— env1 VEG_ALIAS 同物异名别名（147 条，比 SYNONYMS 12 条更全面，含大蒜→蒜 等）——
let VEG_ALIAS = {};
try { VEG_ALIAS = require('./veg_alias.json') || {}; } catch (e) { VEG_ALIAS = {}; }
function normalizeIngredient(name) {
  if (!name || typeof name !== 'string') return name || '';
  let n = name;
  if (VEG_ALIAS[n]) n = VEG_ALIAS[n];
  for (const [re, rep] of SYNONYMS) n = n.replace(re, rep);
  return n;
}

// 校验食材项是否在主库中（提取名称部分，去掉数量，走 VEG_ALIAS 归一化）
function ingredientInMaster(item) {
  if (!item || typeof item !== 'string') return false;
  const name = item.replace(/\s*\d.*$/, '').replace(/[（(].*$/, '').trim();
  if (!name) return false;
  if (ING_MASTER_SET.has(name)) return true;
  const norm = normalizeIngredient(name);
  if (ING_MASTER_SET.has(norm)) return true;
  if (ING_MASTER_NORM_SET.has(norm)) return true;
  for (const m of ING_MASTER) {
    if (m.includes(name) || name.includes(m)) return true;
    if (m.includes(norm) || norm.includes(m)) return true;
  }
  return false;
}

// —— env1 dishes.json 菜名清单（923 道，599 道不在 cookbook_ref，补入去重池）——
let DISH_NAMES = [];
try { const d = require('./dishes.json'); DISH_NAMES = (d && d.all) || []; } catch (e) { DISH_NAMES = []; }
const DISH_NORM_SET = new Set(DISH_NAMES.map(n => normalizeDishName(n)));
// 全库归一化索引（cookbook_ref 1786 + dishes.json 923），O(1) 精确查重，零 AI 调用
const ALL_NORM_SET = new Set([...COOK_REF_NORM_SET, ...DISH_NORM_SET]);

// 静态去重名单：明确永不生成的菜名（已存在于正式库、需从源头杜绝重复生成）。
// 例：红烧冬瓜/菠菜馒头 已在 dish_lexicon，加入此处作为确定性兜底（即使 dish_lexicon 读取失败也不会再生）。
// 注意：dishes.json 已损坏不可编辑，故此处单独立常量管理。
const STATIC_DEDUP_NAMES = ['红烧冬瓜', '菠菜馒头'];

// —— env1 pairing_rules.json 蛋白↔蔬菜共现统计（荤素搭配参考）——
let PAIRING = {};
try { PAIRING = require('./pairing_rules.json') || {}; } catch (e) { PAIRING = {}; }
// 取前 N 个蛋白食材的搭配摘要，用于 prompt 参考
function getPairingSample(maxProteins) {
  const pv = PAIRING.proteinVeg || {};
  const proteins = Object.keys(pv).slice(0, maxProteins || 10);
  const lines = [];
  for (const p of proteins) {
    const vegs = (pv[p] || []).slice(0, 4).map(v => v.name).join('/');
    if (vegs) lines.push(p + '→' + vegs);
  }
  return lines.join('，');
}

// —— env1 seasoning_library 调味料库（97 条，用于精确过滤调味料）——
let SEASONING = [];
try { SEASONING = require('./seasoning_library.json') || []; } catch (e) { SEASONING = []; }
const SEASONING_NAMES = new Set(SEASONING.map(s => s.name || ''));
const SEASONING_ALIASES = new Set();
for (const s of SEASONING) { for (const a of (s.alias || [])) SEASONING_ALIASES.add(a); }
function isSeasoning(itemName) {
  if (!itemName) return false;
  const name = itemName.replace(/\s*\d.*$/, '').replace(/[（(].*$/, '').trim();
  if (SEASONING_NAMES.has(name)) return true;
  if (SEASONING_ALIASES.has(name)) return true;
  const norm = normalizeIngredient(name);
  if (SEASONING_NAMES.has(norm)) return true;
  return false;
}

// —— env1 ALLERGEN 过敏原 + ING_CATEGORIES 食材大类 ——
let ALLERGEN = { INVALID: [], WHITE: [] };
try { const a = require('./allergen.json'); ALLERGEN = a.ALLERGEN || ALLERGEN; } catch (e) { /* */ }
const ALLERGEN_SET = new Set([...(ALLERGEN.WHITE || []), ...(ALLERGEN.INVALID || [])]);
function hasAllergen(itemName) {
  if (!itemName) return false;
  const name = itemName.replace(/\s*\d.*$/, '').replace(/[（(].*$/, '').trim();
  if (ALLERGEN_SET.has(name)) return true;
  const norm = normalizeIngredient(name);
  if (ALLERGEN_SET.has(norm)) return true;
  return false;
}

// 季节食材映射（按月份）
const SEASONAL = {
  spring: ['韭菜', '荠菜', '春笋', '香椿', '豌豆', '蚕豆', '蒜苗', '莴笋'],
  summer: ['番茄', '黄瓜', '茄子', '苦瓜', '丝瓜', '冬瓜', '豆角', '玉米'],
  autumn: ['南瓜', '红薯', '莲藕', '山药', '板栗', '蘑菇', '白菜', '萝卜'],
  winter: ['大白菜', '白萝卜', '土豆', '胡萝卜', '菠菜', '芹菜', '洋葱', '腊肉'],
};

// 返回中国时区（UTC+8）的 Date，避免云函数运行在 UTC 时区导致 getHours/getMonth 判断错乱
function chinaDate() {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + 8 * 3600000);
}

exports.main = async (event) => {
  console.log('[build] bypassGenDish BUILD_TAG=' + BUILD_TAG);
  const { task, N, dishName } = event || {};

  if (task === 'health') {
    return { ok: true, build: BUILD_TAG, mode: 'gen-dish', env: TCB_ENV };
  }

  // 全局生成开关：默认停用（GEN_DISABLED 未显式置 'false' 即停），彻底停止生成/补齐
  if (process.env.GEN_DISABLED !== 'false') {
    console.log('[bypassGenDish] GEN_DISABLED 已开启，跳过执行');
    return { ok: false, disabled: true, reason: 'gen_disabled' };
  }

  // 单菜入口：重生成某道菜的菜名（env2 重生成链路 name target 调用）
  if (dishName) {
    try {
      const r = await regenDishName(dishName);
      return Object.assign({ ok: true }, r);
    } catch (e) {
      return { ok: false, err: (e && e.message) || String(e) };
    }
  }

  // 一次性清理：删除 dish_mirror 中"家常"开头的菜（连带清一批），并写入 rejected_names 黑名单防重生
  if (task === 'cleanHomestyle') {
    await ensureCollections();
    const removed = [];
    const blacklisted = [];
    try {
      let deleted = 0;
      for (let off = 0; ; off += 100) {
        const r = await db.collection('dish_mirror').where({ name: db.RegExp({ regexp: '^家常' }) }).skip(off).limit(100).get();
        const batch = (r && r.data) || [];
        for (const doc of batch) {
          try {
            await db.collection('dish_mirror').doc(doc._id).remove();
            removed.push(doc.name);
            deleted++;
            // 写 rejected_names 黑名单（自定义 _id 防重复写入）
            const rid = 'rej_' + doc.name;
            try {
              await db.collection('rejected_names').add({ data: { _id: rid, name: doc.name, reason: 'homestyle_prefix', ts: Date.now() } });
              blacklisted.push(doc.name);
            } catch (e) { /* 已存在则忽略 */ }
          } catch (e) {
            console.warn('[bypassGenDish] 删除失败：' + doc.name + ' ' + (e && e.message));
          }
        }
        if (batch.length < 100) break;
      }
      console.log('[bypassGenDish] cleanHomestyle 删除 ' + deleted + ' 道家常菜');
    } catch (e) {
      console.warn('[bypassGenDish] cleanHomestyle 失败：', e && e.message);
      return { ok: false, err: (e && e.message) || String(e), removed, blacklisted };
    }
    return { ok: true, removed, blacklisted, count: removed.length };
  }

  // 扫描 dish_mirror 中"前后食材交换"的重复菜（同 ingSig 不同名，如 黄瓜皮蛋汤 vs 皮蛋黄瓜汤）
  // 返回分组；cleanSwapDupes 在其基础上保留 _id 升序（≈创建时间最早）第一个、删其余。
  async function scanSwapDupGroups() {
    const all = [];
    try {
      for (let off = 0; ; off += 200) {
        const r = await db.collection('dish_mirror').field({ name: true, createTime: true }).skip(off).limit(200).get();
        const list = (r && r.data) || [];
        for (const d of list) {
          if (!d.name) continue;
          all.push({
            _id: d._id, name: d.name,
            ingSig: buildIngSig(d.name),
            tokenSig: buildNameTokenSig(d.name),
            createTime: d.createTime || null
          });
        }
        if (list.length < 200) break;
      }
    } catch (e) {
      throw new Error('scan_dish_mirror_failed: ' + (e && e.message));
    }
    // 分组依据 = 菜名词 token 集合签名（词序无关）。仅当两菜名由完全相同字符构成、仅顺序不同时
    // 才判为"前后交换"重复（如 黄瓜皮蛋汤/皮蛋黄瓜汤）；同食材不同形态（番茄牛肉面/汤/饭）字符集不同→不合并。
    // 单字签名（length<2）不可能是词序交换，排除。
    const byTok = {};
    for (const it of all) {
      if (!it.tokenSig || it.tokenSig.length < 2) continue;
      (byTok[it.tokenSig] = byTok[it.tokenSig] || []).push(it);
    }
    const groups = [];
    for (const sig of Object.keys(byTok)) {
      const arr = byTok[sig];
      if (arr.length > 1) groups.push({ ingSig: arr[0].ingSig, tokenSig: sig, members: arr.sort((a, b) => String(a._id).localeCompare(String(b._id))) });
    }
    return groups;
  }
  if (task === 'findSwapDupes') {
    await ensureCollections();
    try {
      const groups = await scanSwapDupGroups();
      const dupCount = groups.reduce((s, g) => s + g.members.length - 1, 0);
      console.log('[bypassGenDish] findSwapDupes 发现 ' + groups.length + ' 组重复，待删 ' + dupCount + ' 道');
      return { ok: true, groups, willRemoveCount: dupCount };
    } catch (e) {
      return { ok: false, err: (e && e.message) || String(e) };
    }
  }
  if (task === 'cleanSwapDupes') {
    await ensureCollections();
    const removed = [];
    try {
      const groups = await scanSwapDupGroups();
      for (const g of groups) {
        const keep = g.members[0];           // _id 升序首条 ≈ 时间序列最早
        for (let i = 1; i < g.members.length; i++) {
          try {
            await db.collection('dish_mirror').doc(g.members[i]._id).remove();
            removed.push({ name: g.members[i].name, _id: g.members[i]._id, removedBecauseKeep: keep.name });
          } catch (e) {
            console.warn('[bypassGenDish] 删除失败 ' + g.members[i].name + ' ' + (e && e.message));
          }
        }
      }
      console.log('[bypassGenDish] cleanSwapDupes 删除 ' + removed.length + ' 道重复菜');
      return { ok: true, removed, count: removed.length };
    } catch (e) {
      return { ok: false, err: (e && e.message) || String(e), removed };
    }
  }

  // 饭点规则已去除：不再做高峰硬跳/软跳，任何时段生成均走自适应限流（rateLimiter 按 429 实时退避）。
  // 保留机制：菜系轮换（CUISINE_ROTATION）、AI 润色、花茶 AI 兜底通道、自适应令牌桶限速不变。

  await ensureCollections();

  const results = [];          // 本轮所有成功入库的菜（含补充轮）
  let totalCandidates = 0;     // 累计各轮候选总数（含补充轮）
  const roundTimings = [];     // 记录每轮（含补充重试）的耗时，用于评估重试次数
  try {

  const genN = Math.min(Math.max(Number(N) || GEN_N, 1), 18);

  // 1) 取已有菜名列表（用于去重 + prompt 参考），合并 cookbook_ref 参考库
  let existingNames = [];
  try {
    const res = await db.collection('dish_mirror').field({ name: true }).limit(500).get();
    existingNames = (res.data || []).map(d => d.name || d.dishName).filter(Boolean);
  } catch (e) {
    console.warn('[bypassGenDish] 读 dish_mirror 失败：', e && e.message);
    return { ok: false, err: 'read_mirror_failed' };
  }
  // 1b) 读 env2 dish_lexicon 集合（env1 syncLexiconToEnv2 同步过来的 env1 全量菜名），扩大去重池
  let lexiconNames = [...STATIC_DEDUP_NAMES]; // 并入静态去重名单（确定性兜底）
  try {
    for (let off = 0; ; off += 100) {
      const r = await db.collection('dish_lexicon').field({ name: true }).skip(off).limit(100).get();
      const batch = r.data || [];
      batch.forEach(d => { if (d.name) lexiconNames.push(d.name); });
      if (batch.length < 100) break;
    }
    lexiconNames.forEach(n => ALL_NORM_SET.add(normalizeDishName(n)));
    console.log('[bypassGenDish] dish_lexicon 同步菜名：' + lexiconNames.length + ' 道');
  } catch (e) {
    console.warn('[bypassGenDish] 读 dish_lexicon 失败（非致命）：', e && e.message);
  }
  // 1c) 拉取 env1 驳回菜名（dish_lexicon_pending status='rejected'），加入去重池，避免 env2 重新生成被驳回的菜
  let rejectedNames = [];
  try {
    // 跨账号查询可能较慢，加 5 秒超时，超时则跳过（非致命）
    const fetchPromise = fetchRejectedFromEnv1();
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve([]), 5000));
    rejectedNames = await Promise.race([fetchPromise, timeoutPromise]);
    if (rejectedNames.length) {
      rejectedNames.forEach(n => ALL_NORM_SET.add(normalizeDishName(n)));
      console.log('[bypassGenDish] env1 驳回菜名：' + rejectedNames.length + ' 道（已加入去重池）');
    }
  } catch (e) {
    console.warn('[bypassGenDish] 拉取 env1 驳回菜名失败（非致命）：', e && e.message);
  }
  // 合并 env1 cookbook_ref 菜名（1786 道）+ dishes.json 菜名（923 道）+ dish_lexicon（env1 全量）+ env1 驳回菜名，扩大去重覆盖面
  const dedupPool = existingNames
    .concat(lexiconNames.filter(n => !existingNames.includes(n)))
    .concat(COOK_REF_NAMES.filter(n => !existingNames.includes(n) && !lexiconNames.includes(n)))
    .concat(DISH_NAMES.filter(n => !existingNames.includes(n) && !COOK_REF_NAMES.includes(n) && !lexiconNames.includes(n)))
    .concat(rejectedNames.filter(n => !existingNames.includes(n) && !lexiconNames.includes(n) && !COOK_REF_NAMES.includes(n) && !DISH_NAMES.includes(n)));
  console.log('[bypassGenDish] 去重池大小：mirror=' + existingNames.length + ' + lexicon=' + lexiconNames.length + ' + cookbook_ref=' + COOK_REF_NAMES.length + ' + dishes=' + DISH_NAMES.length + ' = ' + dedupPool.length);

  // 2) 候选生成 + 入库：AI 当主力 + 查表降级为参考/兜底（方案C）
  //    单轮内若实际入库数 < MIN_GENERATED，则在本轮内重试补充（重新采样去重池+重新生成），
  //    避免依赖下一个 10 分钟才补，保证每轮产出稳定。重试次数上限 MAX_RETRY。
  // 菜系轮换：根据 dish_mirror 当前数量推算 cursor，长期均衡覆盖所有菜系（自适应保留）
  const cuisineCursor = existingNames.length % CUISINE_ROTATION.length;
  const focusCuisines = CUISINE_ROTATION[cuisineCursor];
  const seasonalIng = [].concat(SEASONAL.spring, SEASONAL.summer, SEASONAL.autumn, SEASONAL.winter);

  let recentModes = {};    // 模式去重计数（每轮重新采样最近 20 道）

  async function runOneGenRound(roundIdx) {
    const t0 = Date.now();
    // 每轮重新采样去重池（含本轮已成功入库的新名），让 AI 避开已生成
    const dedupSample = sampleDedupPool(dedupPool, 600);
    // AI 生成先启动（异步不等待），同时本地查表仅取少量作参考/兜底
    const aiPromise = genCandidates(genN, dedupSample, seasonalIng, focusCuisines);
    const nomCandidates = buildNominations(Math.min(2, genN), focusCuisines, dedupPool);
    // 确定性饮品提名：每轮先抽 4 道模板池（不依赖 AI 自由发挥），
    // 若模板池已抽空/全撞库（<4 道），再用 AI 花茶通道兜底补满，避免饮品断供。
    let drinkCandidates = buildDrinkNominations(4, dedupPool);
    if (drinkCandidates.length < 4) {
      const fill = await genFlowerTeaCandidates(4 - drinkCandidates.length, dedupPool);
      drinkCandidates = drinkCandidates.concat(fill);
      console.log('[bypassGenDish][R' + roundIdx + '] 饮品提名 ' + drinkCandidates.length + ' 道（模板 ' + (drinkCandidates.length - fill.length) + ' + AI花茶 ' + fill.length + '）');
    } else {
      console.log('[bypassGenDish][R' + roundIdx + '] 查表提名 ' + nomCandidates.length + ' 道 + 饮品 ' + drinkCandidates.length + ' 道（重点菜系：' + focusCuisines.join('、') + '）');
    }
    let aiCandidates = [];
    try {
      aiCandidates = await aiPromise;
      console.log('[bypassGenDish][R' + roundIdx + '] AI 生成 ' + aiCandidates.length + ' 道');
    } catch (e) {
      console.warn('[bypassGenDish][R' + roundIdx + '] AI 生成失败（仅用查表提名）：', e && e.message);
    }
    let candidates = nomCandidates.concat(drinkCandidates, aiCandidates);
    totalCandidates += candidates.length;
    // AI 润色所有候选菜：补精准 reason + 改错
    if (candidates.length) {
      try {
        const polished = await aiPolishNominations(candidates);
        if (polished && polished.length) {
          const changed = polished.filter((p, i) => p.reason !== (candidates[i] || {}).reason || p.name !== (candidates[i] || {}).name);
          candidates = polished;
          console.log('[bypassGenDish][R' + roundIdx + '] AI 润色 ' + polished.length + ' 道候选菜（变更 ' + changed.length + ' 道）');
        }
      } catch (e) {
        console.warn('[bypassGenDish][R' + roundIdx + '] AI 润色失败（用原始候选）：', e && e.message);
      }
    }
    if (!candidates.length) {
      console.log('[bypassGenDish][R' + roundIdx + '] 无候选菜生成');
      return 0;
    }
    console.log('[bypassGenDish][R' + roundIdx + '] 生成候选 ' + candidates.length + ' 道菜：' + candidates.map(c => c.name).join('、'));
    // 模式去重：重新采样最近 20 道（每轮刷新，避免补充轮重复同模式）
    recentModes = {};
    try {
      const recent = await db.collection('dish_mirror').field({ mainIngredient: true, cookingMethod: true }).orderBy('genAt', 'desc').limit(20).get();
      for (const d of (recent.data || [])) {
        const sig = modeSignature(d);
        if (sig) recentModes[sig] = (recentModes[sig] || 0) + 1;
      }
    } catch (e) { /* */ }
    // 逐菜写骨架
    let roundGen = 0;
    for (const dish of candidates) {
      if (!validateDishName(dish.name)) {
        console.warn('[bypassGenDish] 菜名不合规：' + dish.name);
        await logTask('bypassGenDish', null, 'fail', 'invalid_name:' + dish.name);
        continue;
      }
      // 饭类命名硬校验（2026-09-03）：带菜料的饭严禁"菜料+米饭"裸名（存量 40 个已整改），须按做法限定
      const stapleIssue = checkStapleNameIssue(dish.name);
      if (stapleIssue) {
        console.warn('[bypassGenDish] 饭类菜名缺做法限定，拦截：' + dish.name + '（' + stapleIssue + '）');
        await logTask('bypassGenDish', null, 'fail', 'staple_name:' + dish.name);
        continue;
      }
      // 第三层（新增）：词序互换同类去重（如 皮蛋黄瓜汤 vs 黄瓜皮蛋汤），接在出菜名之后
      const swap = await checkOrderSwapDup(dish.name);
      if (swap.isDup) {
        console.log('[bypassGenDish] 词序互换同类重复跳过：' + dish.name + ' ≈ ' + swap.similar);
        await logTask('bypassGenDish', null, 'ok', 'swap-dup:' + dish.name + '≈' + swap.similar);
        addAliasIndex(dish.name);
        continue;
      }
      const dup = await checkSimilar(dish.name, dedupPool);
      if (dup.isDup) {
        console.log('[bypassGenDish] 重复菜跳过：' + dish.name + ' ≈ ' + dup.similar);
        await logTask('bypassGenDish', null, 'ok', 'dup:' + dish.name + '≈' + dup.similar);
        continue;
      }
      // 第四层：别名食材同类去重（AI 校验，仅主食材命中才调 hy3）
      const alias = await checkAliasDup(dish.name, dedupPool);
      if (alias.isDup) {
        console.log('[bypassGenDish] 别名同类重复跳过：' + dish.name + ' ≈ ' + alias.similar);
        await logTask('bypassGenDish', null, 'ok', 'alias-dup:' + dish.name + '≈' + alias.similar);
        addAliasIndex(dish.name); // 仍并入索引，避免后续漏判
        continue;
      }
      addAliasIndex(dish.name);
      const sig = modeSignature(dish);
      if (sig && recentModes[sig] >= 3) {
        console.log('[bypassGenDish] 模式重复跳过：' + dish.name + ' sig=' + sig + ' count=' + recentModes[sig]);
        await logTask('bypassGenDish', null, 'ok', 'mode-dup:' + dish.name + '=' + sig);
        continue;
      }
      try {
        const docRes = await db.collection('dish_mirror').add({
          data: {
            name: dish.name,
            source: 'ai-generated',
            isNew: true,
            aiExposure: 0,
            category: dish.category || '菜',
            mealTime: Array.isArray(dish.mealTime) && dish.mealTime.length ? dish.mealTime : (dish.category === '小吃' ? ['小吃'] : dish.category === '饮品' ? ['小吃', '下午茶'] : ['午餐', '晚餐']),
            cuisine: dish.cuisine || '家常',
            mainIngredient: dish.mainIngredient || '',
            cookingMethod: dish.cookingMethod || '',
            reason: dish.reason || '',
            season: Array.isArray(dish.season) ? dish.season : ['spring', 'summer', 'autumn', 'winter'],
            genAt: Date.now(),
          },
        });
        existingNames.push(dish.name);
        dedupPool.push(dish.name);
        ALL_NORM_SET.add(normalizeDishName(dish.name));
        results.push({ name: dish.name, id: docRes._id, ok: true });
        roundGen++;
        console.log('[bypassGenDish] 新菜骨架入库：' + dish.name + '（已加入去重池）');
      } catch (e) {
        const msg = (e && e.message) || String(e);
        if (msg.includes('duplicate key') || msg.includes('E11000')) {
          console.log('[bypassGenDish] 重复菜名跳过（唯一索引）：' + dish.name);
          await logTask('bypassGenDish', null, 'ok', 'dup-index:' + dish.name);
        } else {
          console.error('[bypassGenDish] 新菜失败：' + dish.name + '：', msg);
          await logTask('bypassGenDish', null, 'fail', 'dish [' + dish.name + '] ' + msg);
        }
      }
    }
    const cost = Date.now() - t0;
    roundTimings.push({ round: roundIdx, gen: roundGen, costMs: cost });
    console.log('[bypassGenDish][R' + roundIdx + '] 本轮入库 ' + roundGen + ' 道，耗时 ' + cost + 'ms');
    return roundGen;
  }

  // 首轮 + 本轮内补充重试（直到达标或达上限）
  let totalGen = 0;
  for (let r = 0; r <= MAX_RETRY; r++) {
    const g = await runOneGenRound(r);
    totalGen += g;
    if (totalGen >= MIN_GENERATED) {
      console.log('[bypassGenDish] 本轮累计入库 ' + totalGen + ' 道 ≥ 阈值 ' + MIN_GENERATED + '，提前结束补充');
      break;
    }
    if (r < MAX_RETRY) {
      console.log('[bypassGenDish] 本轮累计入库 ' + totalGen + ' 道 < 阈值 ' + MIN_GENERATED + '，启动第 ' + (r + 1) + ' 次补充重试...');
    }
  }
  console.log('[bypassGenDish] 本轮耗时分布：' + JSON.stringify(roundTimings) + '，总入库 ' + totalGen + ' 道');

  if (totalGen === 0) {
    await logTask('bypassGenDish', null, 'ok', 'no_candidates');
    return { ok: true, generated: 0, reason: 'no_candidates' };
  }
  await logTask('bypassGenDish', null, 'ok', 'generated:' + totalGen + '/rounds:' + roundTimings.length);

  // 4) 菜名确认无误（无重复/无融合错/无违规前缀）后，fire-and-forget 并行触发下游补字段函数：
  //    全部 Promise.all 并行起跑（不再串行排队），每个下游内部自带 rateLimiter 自适应令牌桶控速，
  //    防打满上游并发；且每个下游内部已是「循环补齐」（一次调用补完所有积压缺字段菜），
  //    因此触发一次即可把之前缺的字段一并补上，不用堆到下轮 timer。
  //    生图(bypassGenImage)只需菜名，与画像/营养/做法等并行；无依赖顺序要求。
  if (results.length > 0) {
    const downstream = ['bypassAiEnrich', 'bypassNutritionEst', 'bypassGenImage', 'bypassGenIngredients', 'bypassGenSteps', 'bypassText', 'bypassGenTips', 'bypassGenGuide'];
    console.log('[bypassGenDish] 并行(Promise.all)触发 ' + downstream.length + ' 个下游补字段函数（循环补齐模式）...');
    const tasks = downstream.map(fn =>
      cloud.callFunction({ name: fn, data: { task: 'incremental' } })
        .then(res => console.log('[bypassGenDish] ' + fn + ' 后台触发完成：', JSON.stringify(res && res.result)))
        .catch(e => console.warn('[bypassGenDish] ' + fn + ' 后台触发失败（可能仍在执行）：', e && e.message))
    );
    Promise.all(tasks).catch(() => {}); // fire-and-forget，不阻塞主链返回
    await new Promise(r => setTimeout(r, 200));
  }
  } finally {
    return { ok: true, generated: results.length, candidates: totalCandidates, rounds: roundTimings.length, results };
  }
};

// ── 步骤0（方案B）：查表组合提名候选菜名（本地组合，零 AI）──────────────
// 核心：从 PRO_TMPL 精美组合 + 菜系轮换 生成候选，提名时即对全库做 O(1)
//       归一化去重（ALL_NORM_SET + 运行时去重池），候选天然不与已有库重复。
// 返回 N 个候选（不足 N 个时由主流程再用 hy3 兜底补齐）。
function buildNominations(N, focusCuisines, dedupPool) {
  const results = [];
  const seen = new Set();
  const poolNorm = new Set((dedupPool || []).map(n => normalizeDishName(n)));

  const tryAdd = (dish) => {
    if (results.length >= N) return true;
    if (!dish || !validateDishName(dish.name)) return false;
    const norm = normalizeDishName(dish.name);
    if (seen.has(norm)) return false;
    if (ALL_NORM_SET.has(norm)) return false;  // 全库归一化 O(1) 命中
    if (poolNorm.has(norm)) return false;      // 运行时去重池命中
    // 2026-09-01：去形容词前缀后命中视为重复（秘制花甲≈花甲），源头拦截不生成
    const stripped = stripAdjPrefix(norm);
    if (stripped && stripped !== norm && (ALL_NORM_SET.has(stripped) || poolNorm.has(stripped))) return false;
    seen.add(norm);
    results.push(dish);
    return results.length >= N;
  };

  // 随机打乱菜系、蛋白、模板顺序，每次覆盖不同组合，避免集中
  for (const cuisine of shuffle([...focusCuisines])) {
    if (results.length >= N) break;
    for (const protein of shuffle([...(CUISINE_MAP[cuisine] || [])])) {
      if (results.length >= N) break;
      const tmpls = PRO_TMPL[protein];
      if (!tmpls) continue;
      for (const t of shuffle([...tmpls])) {
        if (results.length >= N) break;
        tryAdd({
          name: t.name(t.veg || ''),
          category: t.method === '炖' ? '汤羹' : '菜',
          mealTime: ['午餐', '晚餐'],
          cuisine,
          mainIngredient: protein,
          cookingMethod: t.method,
          reason: METHOD_REASON[t.method] || '鲜香味美',
          season: ['spring', 'summer', 'autumn', 'winter'],
        });
      }
    }
  }

  return results;
}

// ── AI 润色查表提名的菜（补精准 reason + 改错）──────────────────────────────
// 批量调一次 hy3，为组合菜生成契合风味的四字文言 reason，并检查菜名/搭配是否合理
// 失败时降级返回原始菜品（reason 保留机械映射值）
async function aiPolishNominations(dishes) {
  if (!Array.isArray(dishes) || !dishes.length) return dishes;
  const input = dishes.map(d => ({
    name: d.name,
    mainIngredient: d.mainIngredient || '',
    cookingMethod: d.cookingMethod || '',
    cuisine: d.cuisine || '',
  }));
  const prompt = [
    '你是菜品润色助手。请为以下菜品生成精准的四字文言推荐理由（reason），并检查菜名是否合理。',
    '要求：',
    '1. reason 严格恰好 4 个中文字符，文言文体，须契合该菜自身风味（辣菜勿写清甜，油炸勿写清淡，蒸菜勿写浓香）',
    '2. 禁止风味方向词直接作主语（"咸鲜佐饭"错误），禁止现代口语套话',
    '3. 如菜名有明显错误（食材搭配不当、命名不规范、做法与食材矛盾），请修正菜名',
    '4. 如菜名无误，原样返回',
    '5. 只输出 JSON 数组，不要任何解释',
    '',
    '输入菜品：' + JSON.stringify(input),
    '',
    '输出格式：[{"name":"菜名","reason":"四字文言短评"}, ...]',
  ].join('\n');

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        maxTokens: 512,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const arr = parseJsonArray(text);
      if (arr && arr.length) {
        const result = [];
        for (let i = 0; i < dishes.length; i++) {
          const p = arr[i] || {};
          const dish = Object.assign({}, dishes[i]);
          if (p.name && validateDishName(p.name)) dish.name = p.name;
          if (p.reason && /^[\u4e00-\u9fa5]{4}$/.test(p.reason)) dish.reason = p.reason;
          result.push(dish);
        }
        return result;
      }
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else console.warn('[aiPolishNominations] hy3 失败：', e && e.message);
    }
  }
  return dishes;
}

// ── 重生成单道菜的菜名（env2 重生成链路 name target 调用）────────────────────
async function regenDishName(oldName) {
  const norm = normalizeDishName(oldName);
  if (!norm) return { skip: true, reason: '空菜名' };

  // 找该菜在 dish_mirror 的记录（按归一化名匹配）
  let doc = null;
  try {
    const res = await db.collection('dish_mirror').where({ name: oldName }).limit(1).get();
    doc = (res && res.data && res.data[0]) || null;
    if (!doc) {
      const res2 = await db.collection('dish_mirror').where({ name: norm }).limit(1).get();
      doc = (res2 && res2.data && res2.data[0]) || null;
    }
  } catch (e) { /* */ }
  if (!doc) return { skip: true, reason: 'dish_mirror 无此菜: ' + oldName };

  // 取该菜已有元数据，构造去重池（避免新名撞已存在菜）
  const existingNames = [];
  try {
    // 去掉 limit，确保读到全量菜名，避免漏掉"莴笋炒猪肉"这类中间菜名
    const r = await db.collection('dish_mirror').field({ name: true }).get();
    (r.data || []).forEach(d => { if (d.name && d.name !== oldName) existingNames.push(d.name); });
  } catch (e) { /* */ }

  const seasonalIng = [].concat(SEASONAL.spring, SEASONAL.summer, SEASONAL.autumn, SEASONAL.winter);
  const focusCuisines = doc.cuisine ? [doc.cuisine] : ['家常菜'];

  // 生成 1 个新候选名，并 AI 润色，最多重试 3 次避免重复/不合规
  let candidates = [];
  let polished = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      candidates = await genCandidates(1, existingNames, seasonalIng, focusCuisines);
    } catch (e) { console.warn('[regenDishName] genCandidates 失败：', e && e.message); }
    if (!candidates.length) return { skip: true, reason: '无新候选' };

    polished = candidates;
    try {
      const p = await aiPolishNominations(candidates);
      if (p && p.length) polished = p;
    } catch (e) { /* 用原始候选 */ }

    const newDish = polished[0];
    if (!newDish || !newDish.name || !validateDishName(newDish.name)) {
      return { skip: true, reason: '新菜名不合规: ' + (newDish && newDish.name) };
    }

    // 菜名严禁以"家常"前缀开头，自动 stripping
    let finalName = newDish.name.replace(/^家常/, '');

    // 饭类命名硬校验：带菜料的饭严禁"菜料+米饭"裸名（与主生成循环同一规则，2026-09-03）
    const stapleIssue = checkStapleNameIssue(finalName);
    if (stapleIssue) {
      console.warn('[regenDishName] 饭类菜名缺做法限定，重试: ' + finalName + '（' + stapleIssue + '）');
      continue;
    }

    // 归一化查重：新名不得撞现有菜（dish_mirror + 全库索引）
    const finalNorm = normalizeDishName(finalName);
    if (existingNames.some(n => normalizeDishName(n) === finalNorm) || ALL_NORM_SET.has(finalNorm)) {
      console.warn('[regenDishName] 新菜名冲突，重试: ' + finalName);
      continue; // 重试生成
    }

    // 写回：更新菜名，清掉下游字段让其重新生成（profile/guide/steps/ingredients/nutrition/imageUrl）
    try {
      await db.collection('dish_mirror').doc(doc._id).update({
        data: {
          name: finalName,
          cuisine: newDish.cuisine || doc.cuisine || '家常菜',
          reason: newDish.reason || doc.reason || '',
          profile: _.remove(),
          guide: _.remove(),
          steps: _.remove(),
          ingredients: _.remove(),
          nutrition: _.remove(),
          imageUrl: _.remove(),
          guideUpdatedAt: Date.now(),
        },
      });
    } catch (e) {
      return { ok: false, err: '写回失败: ' + ((e && e.message) || e) };
    }
    console.log('[regenDishName] 重生成菜名 ' + oldName + ' → ' + finalName);
    return { ok: true, oldName, newName: finalName };
  }

  return { skip: true, reason: '重试3次仍冲突' };
}

// ── 步骤1：hy3 生成候选新菜名 ────────────────────────────────────────────────
async function genCandidates(N, existingNames, seasonalIng, focusCuisines) {
  // 从主库取季节相关食材子集（避免 719 个全放 prompt 太长）
  const ingSample = ING_MASTER.slice(0, 80).join('、');
  const pairingSample = getPairingSample(8);
  const prompt = [
    '你是菜品创作助手。请生成 ' + N + ' 道菜品，覆盖以下大类、餐次和菜系：',
    '大类：菜(荤/素)、主食、小吃、汤羹、饮品、甜品',
    '餐次：早餐、午餐、晚餐、夜宵',
    'category-mealTime 搭配规则（重要，必须遵守）：',
    '  菜类 → mealTime: 午餐/晚餐（可加夜宵）',
    '  主食类 → mealTime: 早餐/午餐/晚餐',
    '  小吃类 → mealTime: ["小吃"]（小吃是独立场景，不标正餐餐次）',
    '  汤羹类 → mealTime: 午餐/晚餐',
    '  饮品类 → mealTime: ["小吃","下午茶"]（饮品是配饮，只在小吃/下午茶场景出现）',
    '  甜品类 → mealTime: 任意餐次',
    '菜系：家常菜、川菜、粤菜、鲁菜、西餐、日料、韩餐、东南亚、意面、烘焙等，每次尽量覆盖不同菜系',
    focusCuisines && focusCuisines.length ? '本次重点菜系：' + focusCuisines.join('、') + '（确保至少一半菜属于这些菜系）' : '',
    '比例参考：菜3 + 主食3 + 小吃3 + 汤羹3 + 饮品3 + 甜品3（饮品务必保证 ≥3 道，茶饮/果汁/豆浆/奶昔/咖啡/糖水均可，名称不加"饮品"后缀）',
    '1. 菜名 2~12 字，含关键食材或做法',
    '1a. 菜名末尾不加类别词后缀：甜品不加"甜品"（"蒸红薯"非"蒸红薯甜品"），饮品不加"饮品"（"泰式椰汁"非"泰式椰汁饮品"），小吃不加"小吃"（"炸春卷"非"炸春卷小吃"）',
    '1b. "香"是形容词不是做法，不要做菜名前缀（如"煎萝卜饼"不要写成"香煎萝卜饼"）',
    '1c. 风味形容词（酸甜/咸鲜/香辣/麻辣/奶香/蒜香/孜然/咖喱/五香等）严禁做菜名前缀（"奶香炖猪蹄"→"炖猪蹄"，"蒜香烤排骨"→"烤排骨"，风味由 reason 体现）',
    '1d. 味型前缀（黑椒/椒盐/糖醋/鱼香/咖喱等）已含做法倾向，菜名为「味型+主料」（"黑椒牛里脊""糖醋排骨""鱼香肉丝"正确），严禁再叠加做法动词（"黑椒炒牛里脊""咖喱炖牛肉"错误）',
    '1t. 菜名严禁以菜系名/风味流派前缀开头（"鲁菜""川菜""粤菜""鲁味""川味""湘味""家常菜"等严禁做菜名前缀，如"鲁菜红烧肉""鲁味腊味炒饭"均错误）；菜系由 cuisine 字段承载，菜名只写菜品本身（"红烧肉""腊味炒饭"正确）。**严禁把菜系字/地域字错误拼进食材名**（如把"鲁"塞进"葱"造出"鲁葱牛肉卷饼""鲁葱小麦面条"等错误菜名——"鲁葱"不是任何真实食材，正确应为"葱"或"大葱"）；"鲁/川/粤/湘"等字只能出现在 cuisine 字段，绝不可与食材拼接',
    '1u. 菜名严禁以**单字烹饪动词**开头（炒/炖/蒸/煮/炸/煎/烧/焖/卤/烤/拌等）——"炖豆腐白菜""炒莴笋猪肉""蒸蛋羹"这类"动词+食材"动宾结构一律错误，应改为「食材+做法」名词形式：「豆腐白菜炖肉」「莴笋炒猪肉」「肉末蒸蛋」；但**双字做法词允许**（清炒油麦菜/红烧肉/白灼虾/油焖笋 等合法，符合中文菜名习惯），仅禁单字动词直接开头',
    '1v. 同一道菜只许用一种做法动词表达，严禁用近义烹饪动词造"同菜异名"变体（如"大葱炒猪肉"与"大葱爆猪肉"、"土豆炖牛肉"与"土豆焖牛肉"、"青椒煎蛋"与"青椒烙蛋"本质同一道菜，只可生成其中一种，不得两种都给）；若候选中出现了仅烹饪动词不同、食材完全相同的两道，只保留其一',
    '1e. 食材必须写完整，严禁截断单字（详见 1o）',
    '1f. 带馅类（馄饨/饺子/包子/烧麦/汤圆/馅饼）必须写明馅料（"猪肉馄饨""韭菜鸡蛋饺子"正确，"馄饨""包子"错误），"鲜肉"须展开为具体肉（猪肉/牛肉/鸡肉）',
    '1g. 笼统食材要具体："清蒸鱼"→"清蒸鲈鱼"，"红烧肉"→"红烧排骨"或"红烧五花肉"，"炒菇"→"炒香菇"',
    '1h. 做法词必须规范：炒/煎/炖/煮/蒸/炸/凉拌/烤/焖/烧/卤/拌/炝/烩/爆/白灼/油焖，禁止"温拌""冷炒""热蒸"等伪做法前缀',
    '1i. 所有输出（菜名/reason/做法等）一律简体中文，严禁繁体或异体字（如餃→饺、麵→面、湯→汤、醬→酱、魚→鱼、蔥→葱），若想到繁体自动转简体',
    '1j. 菜名必须完整自成一词，严禁以连接词（配/和/加/与/搭等）收尾或吊半截（"煎鸡蛋配""红烧肉和"错误，应补全如"煎鸡蛋配番茄""红烧肉炖土豆"）；同一道菜只一个主食材组合，严禁把两道独立菜直接拼成一名无连接词（"煎鸡蛋上海青"错误，应为"煎鸡蛋炒上海青"）',
    '1k. 肉类"大类+小类"不冗余拼合（猪肉+里脊肉→只取"里脊肉"或"猪肉"）；香菜/葱/蒜/姜/辣椒等调味小料不得作主食材硬接菜名末尾（"炒青菜香菜"错误）',
    '1l. 饮品类：菜名直接用饮品本名，不附加"饮品"等类别后缀；茶类必须用「X茶」命名以表示泡好的茶汤饮品，如"龙井茶""铁观音茶""普洱茶""茉莉花茶""乌龙茶""红茶"，严禁只写茶叶名（"龙井""铁观音""普洱"会被误认为干茶叶原料而非茶饮，错误）；果汁/豆浆等同理（"鲜榨橙汁"非"橙汁饮品"）',
    '1p. 严禁生成「开瓶即饮、无做法」的成品/包装饮料与纯净水作为菜品（如 纯净水/矿泉水/雪碧/可乐/芬达/美年达/七喜/脉动/红牛/王老吉/加多宝/冰红茶/凉茶/苏打水/气泡水，以及任何带"饮料/饮品/瓶装/罐装/听装"后缀的名称）；这些只作为采购清单"X 1瓶"出现，不属于需要做法的菜品。可生成的饮品仅限需冲泡/现做的（茶/果汁/豆浆/奶昔/咖啡/糖水等具体茶汤或饮品）',
    '1m. 经典/固定菜名（如西湖醋鱼、宫保鸡丁、鱼香肉丝、糖醋里脊、红烧肉、麻婆豆腐等）本身已含完整做法，严禁再叠加做法动词前缀（"清蒸西湖醋鱼""炒宫保鸡丁""炖红烧肉"均错误，直接写"西湖醋鱼"）；若确为自创新做法，用差异化命名而非在原菜名前硬加做法',
    '1n. 做法词不得与菜名中已隐含的做法重复/矛盾：已有"醋/糖醋/红烧/麻辣"等味型或固定做法的菜，不要再加"清蒸/煮/炒"等泛做法前缀（"清蒸西湖醋鱼"属做法冲突，错误）',
    '1o. 食材名须完整、严禁截断单字：蘑菇不写"蘑"、茄子不写"茄"、豆腐不写"腐"、鸡蛋不写"蛋"、萝卜不写"卜"、青椒不写"椒"、黄瓜不写"瓜"、木耳不写"耳"、虾不写"虾"类单字（"肉片烧茄""小鸡炖蘑""炒鸡蛋瓜"均错误）',
    '1p. 主食命名规范：①"菜+米饭"形态（如"牛肉萝卜米饭""番茄鸡蛋米饭"）必须统一命名为「XX盖浇饭」；**带做法词的饭（盖浇饭/焖饭/炒饭/煲仔饭/拌饭/蒸饭等）必须以浇头或配料命名**（青椒肉丝盖浇饭/腊肉豌豆焖饭/玉米排骨焖饭/蛋炒饭/腊味煲仔饭 正确），**米种词（五常大米/东北大米/丝苗米/丝苗/泰国香米/香米/大米等）严禁做做法饭名的前缀**——"五常大米盖浇饭""丝苗盖浇饭""泰国香米盖浇饭""大米炒饭"均错误（米种只是煮饭用的米，不是菜，菜名应体现浇头/配菜）；②米种本身含"大米"二字（五常大米/丝苗大米等）做纯米饭时直接「米种+饭」（五常大米饭），严禁"五常大米米饭"这类大米+米饭叠床架屋；米种为小米/糙米/糯米等不含"大米"者直接「小米饭/糙米饭/糯米饭」；③多种米/杂粮混煮时 name 用「主米+杂粮饭/杂粮粥」（糙米杂粮饭/藜麦杂粮粥），严禁把每种米逐一罗列成超长名（"三色糙米藜麦黑米小米饭"错误），也不许笼统只写"杂粮饭"丢失主米；④馒头是实心无馅主食，严禁在"馒头"前冠馅料名（"豆沙馒头""羊肉胡萝卜馒头"错误，应改"豆沙包""羊肉胡萝卜包子"）',
    '1q. 以"鱼/肉/虾/蟹/贝/菇/菌/菜"为笼统对象的菜，必须写明具体品种：清蒸鱼→清蒸鲈鱼、红烧肉→红烧排骨/红烧五花肉、炒菇→炒香菇/炒平菇、炒青菜→炒上海青/炒油麦菜；"鲜肉"必须展开为具体肉（猪肉/牛肉/鸡肉/羊肉），不得只写"鲜肉馄饨""鲜肉包子"',
    '1r. 面食带"卤"字（打卤面/拌卤面）必须写明是什么卤（西红柿打卤面/黄花菜木耳打卤面），严禁只写"打卤面"',
    '1s. 卷类（千张肉卷等）/肉丸/肉饼等含肉但未指明肉种的菜名，须展开为具体肉（千张猪肉卷/牛肉丸/猪肉饼），凡名称只写"肉"而未说哪种肉的一律展开',
    '2. 食材常见易得，可参考食材库但不限于其中',
    '3. 做法简单（家庭厨房能做）',
    '4. 本任务目标是为已有菜库**补充其缺失的菜式**，而非重复常见菜。以下为已有菜样本（部分），生成时严禁与之重复：' + existingNames.join('、'),
    '4a. 尤其避免生成极常见的国民家常菜（如番茄炒鸡蛋、酸辣土豆丝、鱼香肉丝、麻婆豆腐、宫保鸡丁、西红柿炒蛋等），这些极大概率已在库内；优先生成更细分、更有特色或地域性强的菜式',
    '5. 四季食材可参考但不限于：' + seasonalIng.join('、'),
    '6. 食材库参考（可选）：' + ingSample,
    '7. 荤素搭配参考（蛋白→常配蔬菜）：' + pairingSample,
    '8. 早餐：粥/豆浆/鸡蛋饼/包子/三明治/沙拉/酸奶/松饼；午晚餐：炒菜/炖菜/主食搭配/意面/沙拉/咖喱饭；夜宵：烧烤/炒粉/甜品/关东煮/拉面',
    '9. reason：用文言文体写一句推荐短评，严格恰好 4 个中文字符（只数汉字、不含标点，须写满 4 字，如"鲜香味美""肥而不腻""入口即化""清鲜爽口""温润甘淡""粒粒喷香"），须契合该菜自身风味（辣菜勿写清甜，油炸勿写清淡，炖菜勿写爽脆）；禁止风味方向词直接作主语（"咸鲜佐饭"错误）；禁止现代口语套话；禁止复述菜名或指向本批其他菜',
    '9a. 主食（米饭/面食/粥等）reason 须描述自身口感/质地/香气（"粒粒喷香""温润软糯""筋道爽滑"），严禁出现"佐饭/下饭/配饭/伴饭"等自指矛盾词；清淡/低脂/粥汤/蒸煮类严禁用"肥而不腻""香浓""油润""浓郁"等油腻向评语，应写清鲜/温润/爽口类（"清鲜爽口""温润甘淡"）；饮品 reason 只写自身风味温度（"温润甘淡""清冽爽口"），严禁"解腻""暖胃""清爽搭配"等指向其他菜的表述',
    '10. season：标明该菜适合的季节，数组可多选["spring","summer","autumn","winter"]。如火锅→["winter"]，凉拌黄瓜→["summer"]，春笋炒肉→["spring"]，桂花糯米藕→["autumn"]。不限季节的菜填全部四季',
    '',
    '输出 JSON 数组：[{"name":"菜名","category":"菜|主食|小吃|汤羹|饮品|甜品","mealTime":["午餐","晚餐"],"cuisine":"菜系","mainIngredient":"主要食材","cookingMethod":"做法","reason":"四字文言短评","season":["spring","summer","autumn","winter"]}]',
  ].join('\n');

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.8,
        maxTokens: 512,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const arr = parseJsonArray(text);
      if (arr && arr.length) return arr.filter(c => c && c.name).slice(0, N);
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else console.warn('[genCandidates] hy3 失败：', e && e.message);
    }
  }
  return [];
}

// ── 步骤2：全库三层去重（归一化O(1) → 编辑距离预筛 → hy3只判可疑候选）─────────
async function checkSimilar(name, allNames) {
  const normName = normalizeDishName(name);

  // 第0层：归一化精确查重（O(1)，零 AI 调用）
  //   0a. 全库归一化 Set（cookbook_ref 1786 + dishes.json 923）
  if (ALL_NORM_SET.has(normName)) {
    return { isDup: true, similar: '[全库归一化]', reason: 'norm_exact' };
  }
  //   0b. dish_mirror 归一化（运行时合并的）
  for (const n of allNames) {
    if (n !== name && normalizeDishName(n) === normName) {
      return { isDup: true, similar: n, reason: 'mirror_norm' };
    }
  }
  //   0c. 去形容词前缀后精确查重（秘制花甲→花甲、爽口泡菜→泡菜，零 AI）
  const stripped = stripAdjPrefix(normName);
  if (stripped && stripped !== normName) {
    if (ALL_NORM_SET.has(stripped)) {
      return { isDup: true, similar: '[去前缀]' + stripped, reason: 'adj_prefix' };
    }
    for (const n of allNames) {
      if (normalizeDishName(n) === stripped) {
        return { isDup: true, similar: n, reason: 'adj_prefix' };
      }
    }
  }

  // 第1层：本地模糊预筛（编辑距离 ≤2 + 包含关系，零 AI 调用）
  const suspects = localSimilarCandidates(name, allNames, normName);
  if (!suspects.length) return { isDup: false, similar: '' };
  // 注意：包含关系（score=1 substring）不再直接判重——补库场景需要保留"不同做法的同类菜"
  // （如 菌菇炖豆腐 vs 炖豆腐 是两道不同菜，应入库）。substring 候选仍进入第2层由 hy3 语义精判。

  // 第2层：hy3 语义精判（1 次 AI 调用，仅对 ≤10 个可疑候选）
  const prompt = [
    '你是菜名相似度判定器。判断以下候选菜名是否与目标菜同菜/近似（同一道菜的不同叫法/冗余前缀）。',
    '只输出 JSON：{"similar":"","isDup":false}',
    'similar=相似菜名（空串表示无重复），isDup=true 表示是重复菜。',
    '判定标准：蒜香韭菜≈蒜香拌韭菜（同菜）、番茄炒蛋≈西红柿炒蛋（同菜）、宫保鸡丁≈宫爆鸡丁（同菜）；但 番茄炒蛋≠番茄炖牛腩（不同菜）。',
    '重要：名称包含关系不算重复。如 菌菇炖豆腐 与 炖豆腐、猪肉炒豆角 与 炒豆角 是不同做法的不同菜，应判 isDup=false。只有当两菜本质就是同一道（仅别名/冗余前缀差异）才判 isDup=true。',
    '目标菜：' + name,
    '候选：' + suspects.map(s => s.name).join('、'),
  ].join('\n');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        maxTokens: 128,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const m = String(text).match(/\{[\s\S]*\}/);
      if (!m) throw new Error('非 JSON');
      const obj = JSON.parse(m[0]);
      return { isDup: obj.isDup === true, similar: String(obj.similar || '').trim() };
    } catch (e) {
      if (attempt < 1) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { isDup: false, similar: '' };
}


// ── 画像生成（复用 bypassAiEnrich 逻辑）─────────────────────────────────────
async function genDishProfile(name) {
  const prompt = [
    '你是美食特征分析器。为给定菜品输出结构化画像 JSON，必须只输出 JSON，不要任何解释。',
    '字段：spicy(0=不辣 1=微辣 2=中辣 3=特辣)，flavors(1~4个：咸/甜/酸/辣/麻/鲜/香/清淡/浓郁/酱香/蒜香/椒麻/酸甜/咸鲜)，cuisine(1个，川菜/湘菜/粤菜/鲁菜/东北菜/家常菜/甜点/汤羹…没有则"家常")，type(荤菜/素菜/汤/主食/甜品/饮品)，main(主要蛋白质食材，素菜为null)，isVeg，isSoup',
    '示例：{"spicy":2,"flavors":["香","麻","辣"],"cuisine":"川菜","type":"荤菜","main":"鸡肉","isVeg":false,"isSoup":false}',
    '菜品：' + name
  ].join('\n');

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        maxTokens: 256,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const p = parseProfile(text);
      if (p) return p;
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

function parseProfile(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1));
    const profile = {
      spicy: clampInt(o.spicy, 0, 3, 0),
      flavors: toArr(o.flavors),
      cuisine: pickStr(o.cuisine, 8),
      type: pickStr(o.type, 8),
      main: pickStr(o.main, 12),
      isVeg: !!o.isVeg,
      isSoup: !!o.isSoup,
    };
    return validateDishProfile(profile);
  } catch (e) { return null; }
}

// ── 营养估算（复用 bypassNutritionEst 逻辑）─────────────────────────────────
async function estNutrition(name, profile) {
  const prompt = [
    '你是营养估算器。为给定家常菜估算每份（一人份家常量）的营养，只输出 JSON，不要解释。',
    '字段：calories(热量kcal整数), protein(蛋白g), carbs(碳水g), fat(脂肪g)',
    '参考：番茄炒蛋≈{calories:180,protein:9,carbs:10,fat:12}，清炒时蔬≈{calories:120,protein:3,carbs:8,fat:8}，红烧肉≈{calories:480,protein:18,carbs:10,fat:42}',
    '菜品：' + name
  ].join('\n');

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        maxTokens: 128,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const n = parseNutrition(text, profile);
      if (n) return n;
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

// 营养合理性校验（零 AI 调用，纯规则校验，与 bypassNutritionEst 同逻辑）
function validateNutrition(nutri, profile) {
  if (!Array.isArray(nutri) || nutri.length < 4) return nutri;
  let [cal, pro, carb, fat] = nutri;
  if (profile && profile.isSoup && cal > 400) cal = Math.round(cal * 0.6);
  if (profile && profile.type === '凉菜' && cal > 300) cal = Math.round(cal * 0.7);
  return [cal, pro, carb, fat];
}

function parseNutrition(text, profile) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1));
    const cal = clampNum(o.calories || o.kcal, 20, 2000, 280);
    const pro = clampNum(o.protein, 0, 100, 15);
    const carb = clampNum(o.carbs || o.carbohydrate, 0, 200, 20);
    const fat = clampNum(o.fat, 0, 150, 12);
    const result = [Math.round(cal), Math.round(pro), Math.round(carb), Math.round(fat)];
    if (result.every(v => v === 0)) return null;
    return validateNutrition(result, profile);
  } catch (e) { return null; }
}

// ── 做法生成（复用 bypassText 逻辑）─────────────────────────────────────────
async function genGuide(name) {
  const messages = [
    { role: 'system', content: '你是家常菜烹饪助手。用简短流畅的 1~2 句话，写出这道菜的家常做法要点，适合写进菜谱卡片。只输出菜谱文本，不要任何 JSON 或前缀。' },
    { role: 'user', content: '菜品：' + name }
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages,
        temperature: 0.6,
        maxTokens: 200,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const t = String(text).replace(/^\s+|\s+$/g, '').slice(0, 200);
      if (!t) throw new Error('空正文');
      for (const w of BAD_WORDS) { if (t.includes(w)) return ''; }
      return t;
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return '';
}

// ── 食材列表生成（查表命中优先，未命中调 hy3）───────────────────────────────
// 食材后处理：过滤调味料 + 标注过敏原 + 标注不在主库
function postProcessIngredients(name, items) {
  if (!Array.isArray(items)) return [];
  let filtered = items.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, 20)).slice(0, 12);
  // 过滤调味料（seasoning_library 精确识别）
  const seasonings = filtered.filter(x => isSeasoning(x));
  if (seasonings.length) {
    console.log('[genIngredients] 过滤调味料：' + name + ' → ' + seasonings.join('、'));
    filtered = filtered.filter(x => !isSeasoning(x));
  }
  // 标注含过敏原的食材
  const allergens = filtered.filter(x => hasAllergen(x));
  if (allergens.length) console.log('[genIngredients] 含过敏原：' + name + ' → ' + allergens.join('、'));
  // 标注不在主库的食材
  const offMaster = filtered.filter(x => !ingredientInMaster(x));
  if (offMaster.length) console.log('[genIngredients] 不在主库：' + name + ' → ' + offMaster.join('、'));
  return filtered;
}

async function genIngredients(name) {
  // 先查 cookbook_ref 食材库，命中直接返回（免调 AI）
  const cached = lookupCookRef(name);
  if (Array.isArray(cached) && cached.length) {
    console.log('[genIngredients] cookbook_ref 命中：' + name + ' → ' + cached.length + ' 项');
    return postProcessIngredients(name, cached);
  }

  // 未命中库，调 hy3 生成
  const ingRef = ING_MASTER.slice(0, 60).join('、');
  const prompt = [
    '你是厨房食材助手。请列出在家制作「' + name + '」需要采购的主要食材。',
    '要求：',
    '1. 只列需要买的原材料/主料/关键配料，不要列盐、糖、油、酱油等基础调味料；',
    '2. 每项写具体可购买的名称，必须带合适的具体数量，不要写「适量」「少许」——按 1~2 人份估算，如「西红柿 2个」「鸡腿 2只」，控制在 14 字内；',
    '3. 优先使用以下食材库中的食材：' + ingRef,
    '4. 不要列步骤、不要列做法；',
    '只输出 JSON 数组：["食材1","食材2", ...]',
  ].join('\n');

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        maxTokens: 256,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const arr = parseJsonArray(text);
      if (arr && arr.length) {
        return postProcessIngredients(name, arr);
      }
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return [];
}

// ── 生图（复用 bypassGenImage 逻辑）─────────────────────────────────────────
async function genImage(name) {
  const prompt = [
    '一道中国家常菜「' + name + '」的高清俯拍照片，',
    '盛于白色圆盘，木质餐桌背景，自然光，',
    '俯视角度，色彩饱和，细节清晰，无文字水印，无人物，',
    '构图居中，留白适当。',
  ].join('');

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
}

async function uploadImage(key, url, retries = 2) {
  const crypto = require('crypto');
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const buf = await httpsGetBuffer(url);
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


// ── 编辑距离 + 本地模糊预筛（零 AI 调用）─────────────────────────────────────
function levenshtein(a, b) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (!la) return lb;
  if (!lb) return la;
  let prev = new Array(la + 1);
  let curr = new Array(la + 1);
  for (let i = 0; i <= la; i++) prev[i] = i;
  for (let j = 1; j <= lb; j++) {
    curr[0] = j;
    const bj = b.charCodeAt(j - 1);
    for (let i = 1; i <= la; i++) {
      const cost = a.charCodeAt(i - 1) === bj ? 0 : 1;
      curr[i] = Math.min(curr[i - 1] + 1, prev[i] + 1, prev[i - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[la];
}

// 本地模糊预筛：从全库菜名中筛出与 name 可能相似的候选（≤10 个）
// score: 0=归一化精确, 1=包含关系, 2+=编辑距离
function localSimilarCandidates(name, allNames, normName) {
  const nn = normName || normalizeDishName(name);
  const candidates = [];
  for (const n of allNames) {
    if (n === name) continue;
    const normN = normalizeDishName(n);
    // 归一化精确匹配
    if (normN === nn) {
      candidates.push({ name: n, score: 0, reason: 'norm_exact' });
      continue;
    }
    // 包含关系（双向）
    if (normN.length >= 2 && nn.length >= 2 && (normN.includes(nn) || nn.includes(normN))) {
      candidates.push({ name: n, score: 1, reason: 'substring' });
      continue;
    }
    // 编辑距离 ≤2（只对长度差 ≤2 的算，省计算）
    if (Math.abs(normN.length - nn.length) <= 2) {
      const dist = levenshtein(nn, normN);
      if (dist > 0 && dist <= 2) {
        candidates.push({ name: n, score: dist, reason: 'edit_dist' });
      }
    }
  }
  // 按相似度排序，取 top 10
  return candidates.sort((a, b) => a.score - b.score).slice(0, 10);
}

// 从去重池等间距抽样 N 个菜名（比随机抽更稳定，每次覆盖不同位置）
function sampleDedupPool(pool, n) {
  if (!Array.isArray(pool) || pool.length <= n) return pool || [];
  const result = [];
  const step = Math.floor(pool.length / n);
  for (let i = 0; i < pool.length && result.length < n; i += step) {
    result.push(pool[i]);
  }
  return result;
}

// 模式签名：主食材+做法动词，用于检测重复模式（如"猪肉+炒"出现太多）
function modeSignature(dish) {
  const verb = (String(dish.cookingMethod || '') + String(dish.guide || '')).match(/炒|蒸|煮|煎|烤|炖|拌|烧|灼|爆|焖|炸|卤/);
  const main = dish.mainIngredient || (dish.profile && dish.profile.main) || '';
  if (!main || !verb) return '';
  return main + '+' + verb[0];
}

// 画像一致性校验（零 AI 调用，纯规则校验，与 bypassAiEnrich 同逻辑）
function validateDishProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const issues = [];
  const MEATS = ['猪肉', '牛肉', '鸡肉', '鸭肉', '鱼肉', '虾', '羊肉', '排骨', '腊肉', '火腿'];
  if (profile.isVeg && MEATS.some(m => profile.main && profile.main.includes(m))) return null;
  if (profile.isSoup && ['炒菜', '凉菜', '荤菜', '素菜'].includes(profile.type)) return null;
  if (profile.spicy >= 2 && !(profile.flavors || []).includes('辣')) {
    profile.flavors = [...(profile.flavors || []), '辣'];
    issues.push('spicy/flavors不一致已补辣');
  }
  const CUISINE_FLAVOR_MAP = {
    '粤菜': ['清淡', '鲜', '咸鲜', '甜', '香'],
    '川菜': ['辣', '麻', '香', '咸', '鲜'],
    '湘菜': ['辣', '香', '咸', '酸'],
  };
  if (CUISINE_FLAVOR_MAP[profile.cuisine]) {
    const valid = CUISINE_FLAVOR_MAP[profile.cuisine];
    const conflict = (profile.flavors || []).filter(f => !valid.includes(f) && ['酸辣', '椒麻'].includes(f));
    if (conflict.length) { issues.push('菜系/口味矛盾：' + profile.cuisine + ' ' + conflict.join('/')); profile._suspect = true; }
  }
  if (profile.isVeg && profile.type === '荤菜') { profile.type = '素菜'; issues.push('isVeg+荤菜已修正'); }
  profile._issues = issues;
  return profile;
}

// ── 工具 ─────────────────────────────────────────────────────────────────────
function getSeason() {
  const m = chinaDate().getMonth() + 1;
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn';
  return 'winter';
}

function validateDishName(name) {
  if (!name || typeof name !== 'string') return false;
  // 先归一化：去全角空格/零宽字符/同义词，避免 "　炖白菜豆腐" 这类前导全角空格绕过 startsWith 前缀校验
  const n = normalizeDishName(name).trim();
  if (!n) return false;
  if (n.length < 2 || n.length > 12) return false;
  const chineseRegex = /^[\u4e00-\u9fa50-9]+$/;
  if (!chineseRegex.test(n)) return false;
  for (const w of NAME_BLACKLIST) { if (n.includes(w)) return false; }
  // 菜系名 / 风味流派前缀硬校验（菜名不得以菜系/风味前缀开头，菜系由 cuisine 字段承载）
  for (const w of CUISINE_PREFIX_BLACKLIST) { if (n.startsWith(w)) return false; }
  // 禁"家常"修饰前缀：菜名不得以"家常"二字开头（如 家常番茄汤/家常土豆丝）。
  // 注 CUISINE_PREFIX_BLACKLIST 仅含"家常菜"（三字），单"家常"需单独拦截，避免 AI 持续产出家常XXX。
  if (n.startsWith('家常')) return false;
  // 菜系/地域字误用硬校验（2026-08-25 新增）：
  //  仅拦截"融合错误形态"——地域字被错误塞进食材造出非法食材，如"鲁葱牛肉卷饼"中的"鲁葱"、
  //  "湘笋排骨汤"中的"湘笋"、"鲁骨青菜汤"中的"鲁骨"、"湘辣腊肉炒饭"中的"湘辣"。
  //  注意：规范的菜系前缀写法（鲁式/湘式/粤式/湘菜/鲁菜/川味 等 + 真实菜系名菜，如"鲁式酱焖鱼"
  //  "粤式叉烧饭""湘西酸肉饭"）是合法表达，菜品本身即带该菜系标签，不在此拦截。
  if (/[鲁川粤湘苏浙闽徽黔滇秦京沪](葱|蒜|姜|椒|茄|菜|豆|瓜|菇|笋|萝卜|肉|鱼|鸡|鸭|牛|猪|羊|虾|蟹|面|饭|饼|粥|汤|蛋|豆腐|骨|辣)/.test(n)) return false;
  // 成品/包装饮料与纯净水硬校验（2026-08-25 新增）：这些开瓶即饮、无做法的成品
  // 严禁进入「需七件套做法」的菜品库，只应作为采购清单"X 1瓶"出现（由 manageShopping 侧保留）。
  // 注意：冲泡/现做的饮品（茶/果汁/豆浆/咖啡/奶昔/糖水，及 DRINK_TMPL 里的 绿茶/红茶/乌龙茶等
  // 具体茶汤）属合法「饮品」类目，不在此拦截。
  for (const w of PACKAGED_DRINK_BLACKLIST) { if (n === w || n.startsWith(w)) return false; }
  // 后缀拦截：带"饮料/饮品/瓶装/罐装/听装"的名称一律判非菜
  for (const sfx of PACKAGED_DRINK_SUFFIX) { if (n.endsWith(sfx)) return false; }
  // 烹饪动词前缀硬校验（R-Name-02：**仅禁"烹饪动词单字开头"**）
  //   - 单字动词开头（炒X/炖X/蒸X…）→ 拦；"动词+成品名"固定菜名（炸春卷/煎饺/蒸烧麦/烤红薯 等）走白名单豁免。
  //   - **双字做法词开头合法**（清蒸/清炒/红烧/白灼/凉拌/油焖/干煸 等，见生成 prompt 1u），必须放行：
  //     normalizeDishName 里的 COOK_VERB_CANON 会把 清蒸→蒸 / 红烧→烧 / 凉拌→拌，若只看归一后的 n 判定，
  //     会把合法的双字做法词菜名误杀。故加 rawWs（仅去空白/零宽，不做动词归一）二次确认"原文确为单字动词开头"。
  //     （2026-09-10 与 bypassAutoInvent v7 同步；原实现误杀 36 条模板 + AI 同类菜名。）
  const rawWs = String(name).replace(/[\s\u3000\u00a0\u200b-\u200d\ufeff]/g, '');
  const isOkFixed = (s) => COOK_VERB_OK_PREFIX.some(ok => s === ok || s.startsWith(ok));
  for (const w of COOK_VERB_PREFIX_BLACKLIST) {
    if (!n.startsWith(w)) continue;      // 归一化后不是动词开头 → 放行
    if (!rawWs.startsWith(w)) continue;  // 原文非单字动词开头（如 清蒸草鱼→蒸草鱼）→ 双字做法词，放行
    if (isOkFixed(n) || isOkFixed(rawWs)) break; // 命中固定菜名白名单 → 放行
    return false;
  }
  return true;
}

// 饭类命名硬校验（2026-09-03 新增）：仅拦截"菜料+米饭"裸名（如 番茄牛肉米饭/排骨米饭/韭菜鸡蛋米饭）。
// 合法形态放行：①body 含"糯米"（甜品糯米饭：芒果糯米饭/椰浆芒果糯米饭）；②body 以谷物词结尾
// （纯米种饭 五常大米饭/糙米饭/藜麦小米饭 等混煮粗粮饭）；③body 为单一粗粮块茎（红薯米饭/紫薯米饭）。
// 返回 '' 表示合规，否则返回原因。注意：以"饭"而非"米饭"结尾的（XX炒饭/焖饭/蒸饭/盖浇饭/拌饭/煲仔饭/卤肉饭）
// 自带做法限定，天然合规，不在本校验范围。
function checkStapleNameIssue(name) {
  const s = String(name || '').trim();
  // ① 裸"菜料+米饭"（无做法词，如 番茄牛肉米饭/排骨米饭/韭菜鸡蛋米饭）
  if (s.endsWith('米饭')) {
    const body = s.slice(0, -2);
    if (!body) return '';
    if (body.includes('糯米')) return ''; // 甜品糯米饭类（芒果糯米饭）
    const GRAIN_SUFFIX = /(五常大米|东北大米|珍珠米|丝苗米|大米|白米|小米|糯米|糙米|黑米|紫米|红米|黄米|高粱米|大麦米|燕麦米|杂粮米|杂米|金银米|藜麦|玉米|荞麦|麦片|麦仁)$/;
    if (GRAIN_SUFFIX.test(body)) return ''; // 纯米种/粗粮混煮饭（五常大米饭/糙米饭/红薯小米饭）
    const TUBER_FOODS = ['红薯', '紫薯', '南瓜', '芋头', '山药', '土豆'];
    if (TUBER_FOODS.includes(body)) return ''; // 粗粮块茎+米（红薯米饭/紫薯米饭）
    return '裸"菜料+米饭"，须按做法命名（XX炒饭/焖饭/蒸饭/盖浇饭/拌饭/煲仔饭）';
  }
  // ② 米种词 + 做法饭后缀 = 伪饭名（2026-09-03 用户案例）：五常大米盖浇饭/丝苗盖浇饭/泰国香米盖浇饭
  //    米种只是用的米，不是菜；做法饭（盖浇饭/焖饭/炒饭/煲仔饭…）必须以浇头/配料命名
  const SUF = /(盖浇饭|煲仔饭|焖饭|炒饭|烩饭|焗饭|拌饭|蒸饭|泡饭)$/;
  const m = s.match(SUF);
  if (m) {
    const prefix = s.slice(0, -m[0].length);
    if (/^(五常大米|东北大米|珍珠米|丝苗米|丝苗|泰国香米|泰国香|香米|大米|白米|米)$/.test(prefix)) {
      return '米种「' + prefix + '」不能作为做法饭名，应以浇头/配料命名（如 青椒肉丝盖浇饭/腊肉豌豆焖饭/玉米排骨焖饭）';
    }
  }
  return '';
}

function parseJsonArray(text) {
  if (!text) return null;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  const cand = text.slice(start, end + 1);
  try {
    const arr = JSON.parse(cand);
    if (Array.isArray(arr)) return arr;
  } catch (e) { /* 走修复梯 */ }
  // 2026-09-12 三级修复梯（hy3 glitch 实锤："amount"::"3瓣" 双冒号 100% 复现，同 v3-jsonfix）
  let r = cand.replace(/,(\s*[}\]])/g, '$1');
  try { const arr = JSON.parse(r); if (Array.isArray(arr)) return arr; } catch (e) { /* 下一级 */ }
  r = r.replace(/"\s*:\s*:/g, '":');
  try { const arr = JSON.parse(r); if (Array.isArray(arr)) return arr; } catch (e) { /* 下一级 */ }
  r = r.replace(/""\s*:\s*"/g, '"');
  try { const arr = JSON.parse(r); if (Array.isArray(arr)) return arr; } catch (e) { return null; }
  return null;
}

function clampInt(v, min, max, dft) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return dft;
  return Math.min(max, Math.max(min, n));
}

function clampNum(v, min, max, dft) {
  const n = Number.parseFloat(v);
  if (Number.isNaN(n)) return dft;
  return Math.min(max, Math.max(min, n));
}

function pickStr(v, maxLen) {
  return typeof v === 'string' ? v.slice(0, maxLen) : '';
}

function toArr(v) {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean).slice(0, 6);
  if (typeof v === 'string' && v.trim()) return [v.trim().slice(0, 16)];
  return [];
}

async function ensureCollections() {
  await Promise.allSettled([
    db.createCollection('dish_mirror'),
    db.createCollection('bypass_log'),
    db.createCollection('rejected_names'),
  ]);
}

async function logTask(task, openid, status, errMsg) {
  try {
    await db.collection('bypass_log').add({
      data: { task, _openid: openid || null, status, errMsg: errMsg || '', computedAt: Date.now() },
    });
  } catch (e) { /* */ }
}