// 菜名弱归一真源（D12）
// 与 _shared/normLexName.js 完全一致，本地复制以便独立部署。
function normLexName(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

module.exports = { normLexName };
