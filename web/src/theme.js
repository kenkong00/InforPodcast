/**
 * 皮肤注册表 —— 新增一套皮肤只要在这里加一项 + theme.css 里加一段变量
 */
export const THEMES = [
  { id: 'midnight',  name: '午夜霓虹', tone: 'dark',  swatch: ['#8b6cff', '#22d3ee'], hint: '默认 · 沉浸' },
  { id: 'aurora',    name: '极光',     tone: 'dark',  swatch: ['#34d399', '#60a5fa'], hint: '清透 · 冷静' },
  { id: 'sunset',    name: '落日大道', tone: 'dark',  swatch: ['#ff6b6b', '#ffb86c'], hint: '温暖 · 傍晚' },
  { id: 'cyber',     name: '赛博荧光', tone: 'dark',  swatch: ['#ccff00', '#00ff9d'], hint: '高对比 · 夜间运动' },
  { id: 'ocean',     name: '深海',     tone: 'dark',  swatch: ['#38bdf8', '#818cf8'], hint: '沉稳 · 通勤' },
  { id: 'mocha',     name: '摩卡',     tone: 'dark',  swatch: ['#f5a623', '#e8967a'], hint: '暖棕 · 护眼' },
  { id: 'porcelain', name: '瓷白',     tone: 'light', swatch: ['#4f46e5', '#0891b2'], hint: '浅色 · 办公' },
  { id: 'sakura',    name: '樱雪',     tone: 'light', swatch: ['#ec4899', '#a855f7'], hint: '浅色 · 柔和' }
];

const KEY_THEME = 'wavecast.theme';
const KEY_MOTION = 'wavecast.motion';

export function loadTheme() {
  let id = 'midnight';
  try { id = localStorage.getItem(KEY_THEME) || 'midnight'; } catch { /* ignore */ }
  if (!THEMES.some(t => t.id === id)) id = 'midnight';
  return id;
}

export function saveTheme(id) {
  try { localStorage.setItem(KEY_THEME, id); } catch { /* ignore */ }
}

export function loadMotion() {
  try { return localStorage.getItem(KEY_MOTION) !== 'off'; } catch { return true; }
}

export function saveMotion(on) {
  try { localStorage.setItem(KEY_MOTION, on ? 'on' : 'off'); } catch { /* ignore */ }
}

/** 给来源站点生成稳定的封面渐变（同一站点每次进来颜色一致） */
const PALETTES = [
  ['#8b6cff', '#22d3ee'], ['#ff6b6b', '#ffb86c'], ['#34d399', '#60a5fa'],
  ['#f472b6', '#a855f7'], ['#fbbf24', '#f97316'], ['#38bdf8', '#6366f1'],
  ['#4ade80', '#14b8a6'], ['#fb7185', '#f59e0b'], ['#a78bfa', '#38bdf8'],
  ['#2dd4bf', '#818cf8']
];

export function coverOf(seed = '') {
  const s = String(seed || '?');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const [a, b] = PALETTES[h % PALETTES.length];

  // 中文来源取前两个字（"IT之家"→"之家"、"澎湃新闻"→"澎湃"），
  // 纯英文取前两个字母（"GitHub"→"Gi"）；单字太单薄，两个字更像专辑封面。
  const zh = s.match(/[\u4e00-\u9fa5]/g) || [];
  const alnum = s.replace(/[^A-Za-z0-9]/g, '');
  const initial = zh.length >= 2
    ? zh.slice(0, 2).join('')
    : (zh[0] || alnum.slice(0, 2) || '#');

  return { from: a, to: b, initial };
}
