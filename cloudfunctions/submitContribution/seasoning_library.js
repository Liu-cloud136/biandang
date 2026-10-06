// 调味料风味参考库（与云端 seasoning_library 集合同源）
// 用途：
//   1) AI 出菜参考：getRecommendation 注入提示词，提供风味控制清单（不进用户偏好/推荐 HIER）。
//   2) 社区贡献去重：submitContribution/mergeContributions 走云端 seasoning_library 集合比对，重复拒绝、不重复入库。
// 注意：前端偏好选择页（setup 第7步）不渲染"调味干货"，仅作贡献提交时的内部归类。
//
// 字段：
//   name   标准名（唯一，云端 name 唯一索引）
//   alias  别名数组（提交时归一比对，命中即视为重复）
//   group  风味大类（参考用，不影响去重）
const SEASONING_LIBRARY = [
  // 咸鲜基础
  { name: '盐', alias: ['食用盐', '精盐', '海盐', '加碘盐'], group: '咸味' },
  { name: '生抽', alias: ['酱油', '味极鲜', '鲜味生抽', '生抽酱油'], group: '咸鲜' },
  { name: '老抽', alias: ['酱油（上色）', '红烧酱油'], group: '上色' },
  { name: '蚝油', alias: ['牡蛎油'], group: '咸鲜' },
  { name: '鸡精', alias: ['鸡粉', '味精（复合）'], group: '增鲜' },
  { name: '味精', alias: ['味素', '谷氨酸钠'], group: '增鲜' },
  { name: '鱼露', alias: ['虾油', '味露'], group: '咸鲜' },
  { name: '虾皮', alias: ['虾米（调味）', '海米（调味）'], group: '咸鲜', dual: true },
  { name: '豆豉', alias: ['豆鼓'], group: '咸鲜' },
  { name: '豆瓣酱', alias: ['郫县豆瓣', '辣豆瓣'], group: '酱类' },
  { name: '甜面酱', alias: ['面酱', '京酱'], group: '酱类' },
  { name: '黄豆酱', alias: ['豆酱', '大酱'], group: '酱类' },
  { name: '柱候酱', alias: [], group: '酱类' },
  { name: '腐乳', alias: ['南乳', '红腐乳', '白腐乳', '豆腐乳'], group: '酱类' },
  { name: '芝士粉', alias: ['奶酪粉', '帕玛森粉'], group: '增鲜' },
  { name: '海鲜酱', alias: ['海鲜酱（粤式）'], group: '酱类' },
  { name: '沙茶酱', alias: ['沙爹酱', '沙茶'], group: '酱类' },
  { name: 'xo酱', alias: ['XO酱'], group: '酱类' },
  { name: '辣椒酱', alias: ['辣椒醬', '蒜蓉辣椒酱'], group: '酱类' },
  { name: '韭菜花酱', alias: ['韭菜花'], group: '酱类' },
  { name: '麻辣鲜', alias: ['麻辣鲜（调味料）'], group: '复合香料' },

  // 酸味
  { name: '醋', alias: ['香醋', '陈醋', '米醋', '白醋', '果醋', '苹果醋', '保宁醋', '镇江香醋'], group: '酸味' },
  { name: '柠檬汁', alias: ['青柠汁', '柠檬'], group: '酸味' },
  { name: '番茄酱', alias: ['番茄沙司', 'ketchup', '茄酱', '蕃茄酱'], group: '酸甜味' },
  { name: '酸豆角', alias: [], group: '酸味' },
  { name: '话梅', alias: ['酸梅', '乌梅'], group: '酸甜味' },

  // 甜味
  { name: '白糖', alias: ['白砂糖', '砂糖', '绵白糖'], group: '甜味' },
  { name: '冰糖', alias: ['冰砂糖'], group: '甜味' },
  { name: '红糖', alias: ['黑糖', '赤砂糖'], group: '甜味' },
  { name: '蜂蜜', alias: ['蜜'], group: '甜味' },
  { name: '麦芽糖', alias: ['饴糖'], group: '甜味' },
  { name: '椰糖', alias: ['椰棕糖', '棕榈糖'], group: '甜味' },

  // 酒类去腥
  { name: '料酒', alias: ['黄酒', '绍兴酒', '米酒（烹饪）', '烹调用酒'], group: '去腥' },
  { name: '白酒', alias: ['高粱酒（烹饪）'], group: '去腥' },
  { name: '啤酒', alias: ['烹饪啤酒'], group: '去腥' },
  { name: '味淋', alias: ['味醂', '日式料酒'], group: '去腥' },
  { name: '清酒', alias: ['日式清酒（烹饪）'], group: '去腥' },

  // 香辛料（麻/辣/香）
  { name: '花椒', alias: ['麻椒', '藤椒', '青花椒', '红花椒'], group: '麻香' },
  { name: '干辣椒', alias: ['辣椒干', '干椒', '辣椒段'], group: '辣香' },
  { name: '小米辣', alias: ['小米椒', '朝天椒'], group: '辣香' },
  { name: '辣椒粉', alias: ['辣椒面', '辣粉'], group: '辣香' },
  { name: '辣椒油', alias: ['红油', '辣油'], group: '辣香' },
  { name: '花椒粉', alias: ['麻椒粉'], group: '麻香' },
  { name: '八角', alias: ['大料', '大茴'], group: '香料' },
  { name: '桂皮', alias: ['肉桂', '桂皮段'], group: '香料' },
  { name: '香叶', alias: ['月桂叶'], group: '香料' },
  { name: '小茴香', alias: ['茴香（籽）'], group: '香料' },
  { name: '孜然', alias: ['孜然粉', '安息茴香'], group: '香料' },
  { name: '丁香', alias: [], group: '香料' },
  { name: '草果', alias: [], group: '香料' },
  { name: '白芷', alias: [], group: '香料' },
  { name: '砂仁', alias: [], group: '香料' },
  { name: '良姜', alias: ['高良姜'], group: '香料' },
  { name: '陈皮', alias: ['橘皮', '橙皮'], group: '香料' },
  { name: '甘草', alias: ['甘草片'], group: '香料' },
  { name: '山奈', alias: ['沙姜', '三奈'], group: '香料' },
  { name: '荜拨', alias: ['荜茇'], group: '香料' },
  { name: '罗汉果', alias: ['罗汉果（调味）'], group: '香料' },
  { name: '姜黄', alias: ['姜黄粉', '黄姜粉'], group: '香料' },
  { name: '芫荽籽', alias: ['香菜籽', '胡荽籽'], group: '香料' },
  { name: '千里香', alias: [], group: '香料' },
  { name: '香茅', alias: ['柠檬草', '柠檬香茅'], group: '香料' },
  { name: '五香粉', alias: ['五香面'], group: '复合香料' },
  { name: '十三香', alias: [], group: '复合香料' },
  { name: '咖喱粉', alias: ['咖喱', '咖喱酱', '咖喱块'], group: '复合香料' },
  { name: '卤料包', alias: ['卤包', '炖肉料包'], group: '复合香料' },
  // 注：姜/蒜/葱/香菜/洋葱/紫苏/迷迭香/百里香/罗勒/小米辣 属"小料回归菜类"（config.js:77），
  //     已作食材偏好处理，不归入调味料库，避免与食材通道重复。

  // 油脂
  { name: '香油', alias: ['芝麻油', '麻油'], group: '油脂' },
  { name: '花椒油', alias: ['麻椒油'], group: '油脂' },
  { name: '藤椒油', alias: ['青花椒油'], group: '油脂' },
  { name: '葱油', alias: ['红葱头油', '油葱酥（油）'], group: '油脂' },
  { name: '红葱油', alias: ['红葱头油（潮汕）'], group: '油脂' },
  { name: '橄榄油', alias: [], group: '油脂' },
  { name: '花生油', alias: ['花生 oil', '花生油'], group: '油脂' },
  { name: '菜籽油', alias: ['菜油'], group: '油脂' },
  { name: '猪油', alias: ['荤油', '大油'], group: '油脂' },
  { name: '牛油', alias: ['牛油（烹饪）'], group: '油脂' },
  { name: '辣椒红油', alias: ['油泼辣子', '辣子油'], group: '油脂' },

  // 其他风味
  { name: '芝麻', alias: ['白芝麻', '黑芝麻', '芝麻粒'], group: '增香', dual: true },
  { name: '花生', alias: ['花生米', '花生碎', '花生仁'], group: '增香', dual: true },
  { name: '椰浆', alias: ['椰奶', '椰汁（烹饪）'], group: '增香', dual: true },
  { name: '沙拉酱', alias: ['蛋黄酱', 'mayo'], group: '凉拌' },
  { name: '芝麻酱', alias: ['麻酱'], group: '凉拌' },
  { name: '芥末', alias: ['芥末酱', 'wasabi', '芥辣'], group: '辛辣' },
  { name: '黑胡椒', alias: ['黑胡椒粉', '黑胡椒粒'], group: '辛辣' },
  { name: '白胡椒', alias: ['白胡椒粉', '白胡椒粒'], group: '辛辣' },
  { name: '泡椒', alias: ['泡小米辣'], group: '酸辣' },
  { name: '虾酱', alias: ['虾膏'], group: '咸鲜' },
  { name: '味噌', alias: ['面豉', '味噌酱'], group: '咸鲜' },
  { name: '照烧汁', alias: ['照烧酱', 'teriyaki'], group: '酱类' },
  { name: '冬阴功酱', alias: ['冬阴功汤料', 'tom yum'], group: '酸辣' },
  { name: '韩式辣酱', alias: ['韩式辣酱（调味）', 'gochujang'], group: '辣香' },
  { name: '沙拉醋', alias: ['油醋汁'], group: '凉拌' },
  { name: '蚝油（素）', alias: ['素蚝油'], group: '咸鲜' },
  { name: '香菇粉', alias: ['蘑菇粉', '素味精'], group: '增鲜' },
  { name: '海苔碎', alias: ['紫菜碎', '味岛香苗'], group: '增香', dual: true },
  { name: '木鱼花', alias: ['鲣鱼花', '柴鱼片'], group: '增鲜', dual: true },
  { name: '味素（台式）', alias: ['台式味素'], group: '增鲜' }
];

// 别名 → 标准名 反查表（运行时构建，供提交归一）
const SEASONING_ALIAS_MAP = (() => {
  const m = {};
  for (const it of SEASONING_LIBRARY) {
    m[it.name] = it.name;
    for (const a of (it.alias || [])) m[a] = it.name;
  }
  return m;
})();

module.exports = { SEASONING_LIBRARY, SEASONING_ALIAS_MAP };
