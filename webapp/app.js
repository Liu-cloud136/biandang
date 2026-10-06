// 诶呀妈呀 今天吃啥呀 —— Web 版前端（参赛 MVP）
// 后端：env1 云接入 /webApi（游客 guestToken 身份，见 cloudfunctions/webApi）
const API = 'https://your-env-id-1.service.tcloudbase.com/webApi';

// ---------- 游客身份 ----------
function getGuestToken() {
  let t = localStorage.getItem('guestToken');
  if (!t) {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    t = Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('guestToken', t);
  }
  return t;
}
async function api(action, extra) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action, guestToken: getGuestToken() }, extra || {}))
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// ---------- 状态 ----------
let scene = localStorage.getItem('scene') || '早餐';
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMOJIS = ['🥘', '🍲', '🥗', '🍜', '🍛', '🥟', '🍤', '🍗', '🥘', '🌽'];

const LOADING_TEXTS = [
  '正在翻菜谱…', '问一下冰箱的意见…', '在 4600 道菜里抽签…',
  '考虑一下今天是几号…', '让主食和菜拉个群…', '挑个最有食欲的…'
];

// ---------- 初始化 ----------
(async function init() {
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.scene === scene));
  try { await api('init'); } catch (e) { /* 静默：游客建档失败不影响浏览（次数由 webApi 常驻补满，Web 端不限次） */
  }
}());

// ---------- 场景切换 ----------
$('scenes').addEventListener('click', e => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  scene = btn.dataset.scene;
  localStorage.setItem('scene', scene);
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === btn));
});

// ---------- 出推荐 ----------
const loadingTimer = setInterval(() => {
  if (!$('loading').hidden) {
    const cur = $('loadingText').textContent;
    const i = LOADING_TEXTS.indexOf(cur);
    $('loadingText').textContent = LOADING_TEXTS[(i + 1) % LOADING_TEXTS.length];
  }
}, 1800);

$('decideBtn').addEventListener('click', decide);
async function decide() {
  $('error').hidden = true;
  $('results').innerHTML = '';
  $('loading').hidden = false;
  $('decideBtn').disabled = true;
  $('loadingText').textContent = LOADING_TEXTS[0];
  try {
    const r = await api('recommend', { scene });
    if (r.code !== 200) throw new Error(r.msg || '出错了，再试一次');
    renderRecommend(r.data);
  } catch (e) {
    $('error').textContent = '出文通道繁忙：' + e.message;
    $('error').hidden = false;
  } finally {
    $('loading').hidden = true;
    $('decideBtn').disabled = false;
  }
}

function renderRecommend(data) {
  const recs = (data && data.recommendations) || [];
  const wrap = $('results');
  let html = '';
  recs.forEach((rec, gi) => {
    html += cardGroup('推荐菜品', rec.dishes || [], gi);
    html += cardGroup('主食搭配', rec.staples || [], gi, 20);
  });
  wrap.innerHTML = html;
  bindCards();
  wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // 自动出图：错峰请求，避免瞬时打满上游出图槽
  let seq = 0;
  wrap.querySelectorAll('.card').forEach(card => {
    const delay = (seq++) * 1200;
    setTimeout(() => loadImg(card), delay);
  });
}

function cardGroup(title, dishes, gi, emojiBase) {
  if (!dishes.length) return '';
  let html = '<div class="group-title">' + title + ' <span style="opacity:.5">· ' + scene + '</span></div><div class="cards">';
  dishes.forEach((d, di) => {
    const emoji = EMOJIS[(gi * 7 + di + (emojiBase || 0)) % EMOJIS.length];
    html += '<div class="card" data-dish="' + esc(d.name) + '" data-cuisine="' + esc(d.cuisine || '') + '">'
      + '<div class="card-img" data-role="img" data-loaded="0">' + emoji + '</div>'
      + '<div class="card-body">'
      + '<div class="card-name">' + esc(d.name) + '</div>'
      + (d.reason ? '<div class="card-reason">「' + esc(d.reason) + '」</div>' : '')
      + (d.calories ? '<div class="card-cal">' + esc(d.calories) + (d.protein ? ' · 蛋白质 ' + esc(d.protein) : '') + '</div>' : '')
      + '<div class="card-ops">'
      + '<button class="primary" data-role="guide">做法</button>'
      + '<button data-role="fav">收藏</button>'
      + '<button data-role="avoid">不想吃</button>'
      + '</div></div></div>';
  });
  return html + '</div>';
}

// ---------- 卡片交互（事件委托） ----------
function bindCards() {
  $('results').onclick = async e => {
    const btn = e.target.closest('button');
    const card = e.target.closest('.card');
    if (!card) return;
    const dish = card.dataset.dish;
    const role = btn ? btn.dataset.role : (e.target.closest('.card-img') ? 'img' : '');
    if (role === 'guide') return openGuide(card, dish);
    if (role === 'loadimg' || role === 'img') return loadImg(card);
    if (role === 'fav') return doFav(card, btn, dish);
    if (role === 'avoid') return doAvoid(card, dish);
  };
}

// 图片懒加载（点击触发；新图上游生成约 10~20s）
async function loadImg(card) {
  const box = card.querySelector('.card-img');
  if (box.dataset.loaded !== '0') return;
  box.dataset.loaded = '1';
  box.innerHTML = '<div class="img-spin">出图中…</div>';
  try {
    const r = await api('dishImage', { name: card.dataset.dish, cuisine: card.dataset.cuisine });
    const url = r && r.data && r.data.imageUrl;
    if (url) { box.innerHTML = '<img src="' + esc(url) + '" alt="' + esc(card.dataset.dish) + '" loading="lazy">'; box.dataset.loaded = '2'; }
    else { box.dataset.loaded = '0'; box.innerHTML = '🍽️<button class="img-btn" data-role="loadimg">重试</button>'; }
  } catch (e) {
    box.dataset.loaded = '0';
    box.innerHTML = '🍽️<button class="img-btn" data-role="loadimg">重试</button>';
  }
}

// 做法弹层
async function openGuide(card, dish) {
  $('guideModal').hidden = false;
  $('guideContent').innerHTML = '<div class="g-loading">翻菜谱中…</div>';
  try {
    const r = await api('cookGuide', { dish });
    const d = r && r.data;
    if (r.ok !== true && r.code !== 200) throw new Error((r && r.msg) || '做法没找到');
    const ings = d.ingredients || [];
    const steps = d.steps || [];
    $('guideContent').innerHTML =
      '<div class="g-title">' + esc(dish) + '</div>'
      + (d.review ? '<div class="g-review">「' + esc(d.review) + '」</div>' : '')
      + (d.difficulty ? '<div class="g-diff">难度：' + esc(d.difficulty) + '</div>' : '')
      + (ings.length ? '<div class="g-sec"><h3>🧺 需要食材</h3><div class="g-ing">' + ings.map(x => '<span>' + esc(x) + '</span>').join('') + '</div></div>' : '')
      + (steps.length ? '<div class="g-sec"><h3>👨‍🍳 做法步骤</h3><ol class="g-steps">' + steps.map(x => '<li>' + esc(x) + '</li>').join('') + '</ol></div>' : '')
      + (d.tips ? '<div class="g-sec"><h3>💡 小贴士</h3><div class="g-tips">' + esc(d.tips) + '</div></div>' : '');
  } catch (e) {
    $('guideContent').innerHTML = '<div class="g-loading">😭 ' + esc(e.message) + '<br><small>（库里的菜谱还在补全中，换个菜试试）</small></div>';
  }
}
$('guideClose').addEventListener('click', () => { $('guideModal').hidden = true; });
$('guideMask').addEventListener('click', () => { $('guideModal').hidden = true; });

// 收藏
async function doFav(card, btn, dish) {
  const faved = btn.classList.contains('faved');
  try {
    if (faved) {
      await api('favRemove', { dish });
      btn.classList.remove('faved');
      btn.textContent = '收藏';
    } else {
      await api('favAdd', { dish, scene, imageUrl: '' });
      btn.classList.add('faved');
      btn.textContent = '已收藏';
    }
  } catch (e) { /* 忽略 */ }
}

// 不想吃（计入规避清单，卡片淡出）
async function doAvoid(card, dish) {
  try { await api('avoidAdd', { dish }); } catch (e) { /* 忽略 */ }
  card.style.transition = 'opacity .4s, transform .4s';
  card.style.opacity = '.3';
  card.style.transform = 'scale(.95)';
  setTimeout(() => card.remove(), 400);
}

// ---------- 收藏 / 口味偏好面板 ----------
// 与小程序偏好引导（pages/setup）同源的全量选项
const PREF_SECTIONS = [
  { key: 'taste', label: '😋 口味', options: ['麻辣', '香辣', '清淡', '酸甜', '咸鲜', '酱香', '蒜香', '葱香', '姜香', '咖喱', '奶香', '甜口', '黑椒', '藤椒', '泡椒', '孜然', '烟熏', '五香', '芥末', '鲜辣', '酸辣', '苦鲜'] },
  { key: 'spicy', label: '🌶️ 辣度', single: true, options: ['不辣', '微辣', '中辣', '重辣'] },
  { key: 'cuisine', label: '🍜 菜系', options: ['川菜', '湘菜', '粤菜', '鲁菜', '闽菜', '徽菜', '江浙菜', '楚菜(湖北)', '滇菜(云南)', '黔菜(贵州)', '东北菜', '西北菜', '新疆菜', '西藏菜', '家常菜', '日料', '韩餐', '泰餐', '越南菜', '印度菜', '意大利菜', '法餐', '墨西哥菜', '希腊菜', '土耳其菜'] },
  { key: 'type', label: '🍚 主食', options: ['米饭', '面条', '炒饭', '盖浇饭', '饺子', '馄饨', '包子', '馅饼', '煲仔饭', '粥品', '米线', '米粉', '意面', '乌冬面', '螺蛳粉', '馒头', '烧麦', '三明治', '寿司', '披萨', '汉堡', '卷饼', '肉夹馍', '凉皮', '饭团', '煎饼', '面包甜点', '沙拉'] },
  { key: 'meat', label: '🥩 肉类', options: ['猪肉', '牛肉', '羊肉', '鸡肉', '鸭肉', '兔肉', '牛蛙', '田鸡', '鹅', '鸽肉', '黄鳝', '驴肉', '甲鱼', '泥鳅', '淡水鱼', '鹌鹑', '海鲜', '鸡蛋', '鸽子蛋', '鹌鹑蛋', '特色禽类'] },
  { key: 'veg', label: '🥬 蔬菜/菜类', options: ['绿叶菜', '白菜类', '瓜茄类', '根茎类', '花菜类', '菌菇类', '豆制品', '葱蒜类', '其他时蔬'] },
  { key: 'cookMethod', label: '🍳 做法', options: ['炒', '炖', '蒸', '煮', '煎', '炸', '凉拌', '烤', '煲', '焖', '烩', '生食'] },
  { key: 'drink', label: '🥤 配饮（小吃场景）', options: ['豆浆', '酸梅汤', '奶茶', '柠檬水', '可乐', '雪碧', '啤酒', '果汁', '咖啡', '清茶', '绿豆汤', '酸奶', '水'] }
];

function openPanel(kind) {
  $('panelModal').hidden = false;
  $('panelTitle').textContent = kind === 'fav' ? '❤️ 我的收藏' : '⚙️ 口味偏好';
  $('panelBody').innerHTML = '<div class="pv-empty">加载中…</div>';
  if (kind === 'fav') renderFav();
  else renderPref();
}

function renderFav() {
  api('favList').then(r => {
    const items = r.data || [];
    if (!items.length) { $('panelBody').innerHTML = '<div class="pv-empty">还没有收藏，看到想吃的点「收藏」就到这里～</div>'; return; }
    $('panelBody').innerHTML = '<div class="pv-list">' + items.map(it =>
      '<div class="pv-item" data-dish="' + esc(it.dish) + '">'
      + '<div class="pv-emoji">🍽️</div>'
      + '<div class="pv-name">' + esc(it.dish) + '</div>'
      + '<button data-act="guide">做法</button>'
      + '<button data-act="unfav">取消</button>'
      + '</div>').join('') + '</div>';
    // 错峰自动出图
    const box = $('panelBody');
    let seq = 0;
    box.querySelectorAll('.pv-item').forEach(item => {
      const dish = item.dataset.dish;
      setTimeout(() => {
        api('dishImage', { name: dish }).then(r2 => {
          const url = r2 && r2.data && r2.data.imageUrl;
          if (url) { const em = item.querySelector('.pv-emoji'); if (em) em.outerHTML = '<img src="' + esc(url) + '" alt="">'; }
        }).catch(() => {});
      }, (seq++) * 900);
    });
    box.onclick = async e => {
      const btn = e.target.closest('button');
      const item = e.target.closest('.pv-item');
      if (!btn || !item) return;
      const dish = item.dataset.dish;
      if (btn.dataset.act === 'guide') { $('panelModal').hidden = true; openGuide(item, dish); }
      else if (btn.dataset.act === 'unfav') {
        await api('favRemove', { dish }).catch(() => {});
        item.remove();
        if (!box.querySelector('.pv-item')) $('panelBody').innerHTML = '<div class="pv-empty">已全部取消</div>';
      }
    };
  }).catch(() => { $('panelBody').innerHTML = '<div class="pv-empty">加载失败</div>'; });
}

function renderPref() {
  api('prefsGet').then(r => {
    const d = r.data || {};
    const sel = {};
    for (const sec of PREF_SECTIONS) {
      sel[sec.key] = sec.single ? (d[sec.key] ? [String(d[sec.key])] : []) : (Array.isArray(d[sec.key]) ? d[sec.key] : []);
    }
    const avoid = Array.isArray(d.avoidDishes) ? d.avoidDishes : [];
    const chip = (sec) => sec.options.map(t =>
      '<button class="chip' + (sel[sec.key].includes(t) ? ' active' : '') + '" data-k="' + sec.key + '" data-t="' + esc(t) + '">' + esc(t) + '</button>').join('');
    $('panelBody').innerHTML =
      PREF_SECTIONS.map(sec =>
        '<div class="g-sec"><h3>' + sec.label + (sec.single ? '' : '（可多选）') + '</h3><div class="pref-tastes">' + chip(sec) + '</div></div>').join('')
      + '<div class="g-sec"><h3>🚫 不想吃的菜</h3><div class="g-ing" id="avoidBox">'
      + (avoid.length ? avoid.map(x => '<span>' + esc(x) + ' <a data-unavoid="' + esc(x) + '" style="cursor:pointer;color:#b33000;margin-left:4px">✕</a></span>').join('') : '<div class="pref-hint">还没有，点卡片上的「不想吃」或在下面添加</div>')
      + '</div><div class="pref-add"><input id="avoidInput" placeholder="输入菜名，如：香菜炒肉" maxlength="30"><button id="avoidAddBtn">添加</button></div></div>'
      + '<div class="g-sec"><button class="decide" id="prefSaveBtn" style="width:100%;padding:12px 0;font-size:15px">保存偏好</button></div>';

    $('panelBody').querySelectorAll('[data-k]').forEach(b => {
      b.onclick = () => {
        const k = b.dataset.k, t = b.dataset.t;
        const sec = PREF_SECTIONS.find(x => x.key === k);
        if (sec.single) {
          sel[k] = sel[k].includes(t) ? [] : [t];
          $('panelBody').querySelectorAll('[data-k="' + k + '"]').forEach(x => x.classList.toggle('active', x.dataset.t === t && sel[k].includes(t)));
        } else {
          if (sel[k].includes(t)) { sel[k] = sel[k].filter(x => x !== t); b.classList.remove('active'); }
          else { sel[k].push(t); b.classList.add('active'); }
        }
      };
    });
    $('panelBody').querySelectorAll('[data-unavoid]').forEach(a => {
      a.onclick = async () => {
        const dish = a.dataset.unavoid;
        await api('avoidRemove', { dish }).catch(() => {});
        a.parentNode.remove();
      };
    });
    $('avoidAddBtn').onclick = async () => {
      const dish = $('avoidInput').value.trim().slice(0, 30);
      if (!dish) return;
      await api('avoidAdd', { dish }).catch(() => {});
      const box = $('avoidBox');
      if (box.querySelector('.pref-hint')) box.innerHTML = '';
      box.insertAdjacentHTML('beforeend', '<span>' + esc(dish) + ' <a data-unavoid="' + esc(dish) + '" style="cursor:pointer;color:#b33000;margin-left:4px">✕</a></span>');
      $('avoidInput').value = '';
    };
    $('prefSaveBtn').onclick = async () => {
      const full = await api('prefsGet').then(r2 => r2.data || {}).catch(() => ({}));
      const payload = {
        avoid: full.avoid || [], scene: full.scene || [],
        communityIngredients: full.communityIngredients || [], masterIngredients: full.masterIngredients || []
      };
      for (const sec of PREF_SECTIONS) payload[sec.key] = sel[sec.key] || [];
      await api('prefsSave', payload);
      $('prefSaveBtn').textContent = '✅ 已保存，下次推荐生效';
      setTimeout(() => { $('prefSaveBtn').textContent = '保存偏好'; }, 1800);
    };
  }).catch(() => { $('panelBody').innerHTML = '<div class="pv-empty">加载失败</div>'; });
}

$('favBtn').addEventListener('click', () => openPanel('fav'));
$('prefBtn').addEventListener('click', () => openPanel('pref'));
$('panelClose').addEventListener('click', () => { $('panelModal').hidden = true; });
$('panelMask').addEventListener('click', () => { $('panelModal').hidden = true; });
