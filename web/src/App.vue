<script setup>
import { ref, reactive, computed, onMounted, watch, nextTick } from 'vue';
import Icon from './components/Icon.vue';
import NowPlaying from './components/NowPlaying.vue';
import BrowseView from './components/BrowseView.vue';
import QueuePanel from './components/QueuePanel.vue';
import PagesView from './components/PagesView.vue';
import PlayerDock from './components/PlayerDock.vue';
import SettingsDrawer from './components/SettingsDrawer.vue';
import ZenOverlay from './components/ZenOverlay.vue';
import SourceManager from './components/SourceManager.vue';
import PageViewer from './components/PageViewer.vue';
import LogDialog from './components/LogDialog.vue';
import ExportDialog from './components/ExportDialog.vue';
import DigestView from './components/DigestView.vue';
import ModelManager from './components/ModelManager.vue';
import PromptManager from './components/PromptManager.vue';
import BootOverlay from './components/BootOverlay.vue';

import { api } from './api.js';
import { THEMES, loadTheme, saveTheme, loadMotion, saveMotion } from './theme.js';
import {
  player, current, initPlayer, setQueue, playDoc, playTrackIndex,
  stopAll, toggle, pause, jumpTrack, setMode
} from './player/engine.js';

/* ---------------- 主题 ---------------- */
const theme = ref(loadTheme());
const motion = ref(loadMotion());

function applyTheme(id) {
  theme.value = id;
  saveTheme(id);
}

/* 毛玻璃图层换色时，某些浏览器合成器会留下上一次的颜色残留。
   这里监听 data-theme 的变化，瞬间摘掉 backdrop-filter 两帧逼它重建 ——
   不管主题是被按钮改的、还是被脚本改的，都能兜住。 */
if (typeof MutationObserver !== 'undefined') {
  const root = document.documentElement;
  new MutationObserver(() => {
    root.classList.add('theme-swap');
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-swap')));
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
}
function applyMotion(on) {
  motion.value = on;
  saveMotion(on);
}
watch([theme, motion], () => {
  const el = document.documentElement;
  el.setAttribute('data-theme', theme.value);
  el.setAttribute('data-motion', motion.value ? 'on' : 'off');
}, { immediate: true });

/* ---------------- 视图 ---------------- */
const view = ref('now');            // now | discover | queue | pages
const navOpen = ref(window.innerWidth > 960);
const showSources = ref(false);
const showLogs = ref(false);
const showSettings = ref(false);
const showModels = ref(false);
const showPrompts = ref(false);
const promptsInitial = ref('newsreel');
const zen = ref(false);

const VIEWS = [
  { id: 'now', name: '正在播报', icon: 'radio' },
  { id: 'digest', name: 'AI 精选', icon: 'sparkles' },
  { id: 'discover', name: '发现', icon: 'compass' },
  { id: 'queue', name: '播放队列', icon: 'queue' },
  { id: 'pages', name: '网页抓取', icon: 'globe' }
];

/* ---------------- 数据 ---------------- */
const stats = reactive({
  total: 0, todayCount: 0, sources: 0, enabledSources: 0, pages: 0,
  byCategory: [], bySource: []
});
const sites = ref([]);
const keyword = ref('');

/* 发现页的筛选范围 */
const scope = reactive({
  view: 'all',      // all | star | unread
  category: '',
  source: '',
  sourceName: '',
  site: '',
  keyword: '',
  sort: 'new'
});

const categories = computed(() => stats.byCategory || []);
const groupedSources = computed(() => {
  const map = new Map();
  for (const s of stats.bySource || []) {
    if (!map.has(s.category)) map.set(s.category, []);
    map.get(s.category).push(s);
  }
  return [...map.entries()];
});

async function loadStats() {
  try {
    const d = await api.stats();
    Object.assign(stats, d);
    sites.value = [...new Set((d.bySource || []).map(s => s.site).filter(Boolean))].sort();
  } catch { /* ignore */ }
}

/* ---------------- toast ---------------- */
const toastMsg = ref('');
let toastTimer = null;
function toast(msg) {
  toastMsg.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (toastMsg.value === msg) toastMsg.value = ''; }, 2800);
}

/* ---------------- 导航动作 ---------------- */
function go(id) {
  view.value = id;
  if (window.innerWidth <= 960) navOpen.value = false;
}

function resetScope(keep = 'all') {
  scope.view = keep;
  scope.category = '';
  scope.source = '';
  scope.sourceName = '';
  scope.site = '';
}

function pickCategory(c) {
  const next = scope.category === c ? '' : c;
  resetScope('all');
  scope.category = next;
  go('discover');
}

function pickSource(s) {
  const next = scope.source === s.id ? '' : s.id;
  resetScope('all');
  scope.source = next;
  scope.sourceName = next ? s.name : '';
  go('discover');
}

function pickView(v) {
  resetScope(v);
  go('discover');
}

function onSearch() {
  scope.keyword = keyword.value;
  if (view.value !== 'discover') go('discover');
}

watch(() => player.message, m => { if (m) toast(m); });

/* ---------------- 启动引导 ----------------
 * 双击 启动.bat 之后 Node 要一两秒才开始监听端口。如果浏览器抢在这之前打开，
 * 用户看到的就是「localhost 拒绝连接」——所以页面自己接管：先铺一层加载进度，
 * 一边自动重试探测服务，一边把首屏要用的数据提前灌进来。 */
const boot = reactive({
  active: true, done: false, pct: 0, msg: '正在连接本地服务…', detail: '', attempt: 0, error: ''
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 探服务并一次性取回首屏数据；服务没起来就一直等，不让用户看到白屏 */
async function waitForServer() {
  const MAX = 40;              // 40 × 600ms ≈ 24 秒，足够 Node 冷启动
  for (let i = 0; i < MAX; i++) {
    boot.attempt = i;
    if (i === 0) {
      boot.msg = '正在连接本地服务…'; boot.pct = 6; boot.detail = '';
    } else {
      boot.msg = '本地服务正在启动，稍等一下…';
      boot.pct = Math.min(16, 4 + i * 1.2);
      boot.detail = `已等待 ${(i * 0.6).toFixed(1)} 秒`;
    }
    try { return await api.boot(); } catch { await sleep(600); }
  }
  return null;
}

async function bootstrap() {
  boot.active = true; boot.done = false; boot.error = '';
  const d = await waitForServer();

  if (!d) {
    boot.error = '连不上本地服务（127.0.0.1:5199）';
    boot.detail = '请确认 启动.bat 的窗口还开着，然后点下面的重试。';
    boot.pct = 100;
    return;
  }

  boot.pct = 40; boot.msg = '正在载入信息库…';
  await nextTick();
  Object.assign(stats, d.stats);
  sites.value = [...new Set((d.stats.bySource || []).map(s => s.site).filter(Boolean))].sort();

  boot.pct = 62; boot.msg = '正在准备播放引擎…';
  boot.detail = '本机语音引擎首次启动会慢一些';
  try { await initPlayer(); } catch { /* 播放引擎起不来不该挡住整个界面 */ }

  boot.pct = 88; boot.msg = '马上就好…'; boot.detail = '';
  await sleep(140);
  boot.pct = 100; boot.msg = '就绪';
  boot.done = true;
  setTimeout(() => { boot.active = false; }, 380);
}

/* 发现页加载完 / 变化时同步进播放队列（尽量停在原来那条上） */
function onList(list) {
  setQueue(list, { keepPosition: true });
}

function playAll() {
  if (!player.queue.length) return toast('队列还是空的');
  stopAll();
  playTrackIndex(0);
  go('now');
}

function openUrl(u) { if (u) window.open(u, '_blank', 'noopener'); }

async function toggleSource(s) {
  try {
    await api.toggleSource(s.id);
    toast((s.enabled ? '已停用：' : '已启用：') + s.name);
    loadStats();
  } catch (e) { toast(e.message); }
}

/* ---------------- 详情弹窗 ---------------- */
const doc = ref(null);

async function openArticle(a) {
  if (a.no_body) {
    doc.value = {
      articleId: a.id, title: a.title, site: a.site, url: a.url,
      content: a.summary || '', word_count: 0, crawled_at: a.crawled_at,
      loading: false, noBody: true,
      error: '这是视频/音频站点，没有文字正文。点「原网页」直接观看。'
    };
    return;
  }
  if (a.content) {
    doc.value = {
      articleId: a.id, title: a.title, site: a.site, url: a.url,
      content: a.content, word_count: a.word_count, crawled_at: a.crawled_at,
      loading: false, error: ''
    };
    return;
  }
  doc.value = {
    articleId: a.id, title: a.title, site: a.site, url: a.url,
    content: a.summary || '', word_count: 0, crawled_at: a.crawled_at,
    loading: true, error: ''
  };
  try {
    const r = await api.articleContent(a.id);
    a.content = r.content;
    a.word_count = r.word_count;
    if (doc.value && doc.value.articleId === a.id) {
      doc.value = {
        articleId: a.id, title: r.title || a.title, site: a.site, url: a.url,
        content: r.content, word_count: r.word_count, crawled_at: a.crawled_at,
        loading: false, error: ''
      };
    }
  } catch (e) {
    if (doc.value && doc.value.articleId === a.id) {
      doc.value = {
        ...doc.value, loading: false,
        error: '正文抓取失败：' + (e.message || '未知原因') + (a.url ? '，可点「原网页」查看。' : '')
      };
    }
  }
}

/* 弹窗里的「播报本篇」：走逐句引擎，字幕同步 */
const exportState = ref(null);

function speakDoc(d) {
  stopAll();
  playDoc(d);
  doc.value = { ...d, __speaking: true };
  go('now');
}

function openExport(d) { exportState.value = d; }

/* ---------------- 快捷键：空格播放/暂停，Alt+←/→ 切上一条下一条 ---------------- */
function onKey(e) {
  const tag = (e.target && e.target.tagName) || '';
  if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (e.code === 'ArrowRight' && e.altKey) { e.preventDefault(); jumpTrack(1); }
  else if (e.code === 'ArrowLeft' && e.altKey) { e.preventDefault(); jumpTrack(-1); }
  else if (e.key === 'Escape' && zen.value) zen.value = false;
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', () => {
    if (window.innerWidth > 960) navOpen.value = true;
  });
  bootstrap();
});
</script>

<template>
  <div class="app">
    <div class="aurora"><i></i></div>

    <!-- 顶栏 -->
    <header class="topbar">
      <button class="icon-btn" @click="navOpen = !navOpen"><Icon name="menu" :size="17" /></button>

      <div class="logo">
        <span class="mark"><Icon name="radio" :size="16" /></span>
        <span>
          声波播报台
          <div class="sub">WAVECAST</div>
        </span>
      </div>

      <div style="flex:1;display:flex;justify-content:center;min-width:0">
        <div style="display:flex;align-items:center;gap:6px;width:100%;max-width:420px">
          <input
            class="field"
            style="width:100%"
            v-model="keyword"
            placeholder="搜索标题 / 摘要 / 正文…"
            @keyup.enter="onSearch"
          />
          <button class="icon-btn" title="搜索" @click="onSearch"><Icon name="search" :size="15" /></button>
        </div>
      </div>

      <span v-if="stats.total" class="chip hide-sm" style="height:30px">共 {{ stats.total }} 条</span>

      <!-- 系统三件套的快捷入口（原来藏在左下角，每次都要先展开侧栏） -->
      <button class="icon-btn" title="AI 模型管理" @click="showModels = true">
        <Icon name="cpu" :size="16" />
      </button>
      <button class="icon-btn" title="爬取日志" @click="showLogs = true">
        <Icon name="clock" :size="16" />
      </button>
      <button
        class="icon-btn"
        :title="`数据源管理（已启用 ${stats.enabledSources}/${stats.sources}）`"
        @click="showSources = true"
      >
        <Icon name="database" :size="16" />
      </button>
      <button class="icon-btn" title="换装与设置" @click="showSettings = true">
        <Icon name="palette" :size="16" />
      </button>
    </header>

    <div class="shell">
      <!-- 侧栏 -->
      <nav class="sidenav" :class="{ open: navOpen }">
        <div class="nav-item" v-for="v in VIEWS" :key="v.id" :class="{ active: view === v.id }" @click="go(v.id)">
          <Icon :name="v.icon" :size="16" />
          <span class="lbl">{{ v.name }}</span>
          <span v-if="v.id === 'queue' && player.queue.length" class="cnt">{{ player.queue.length }}</span>
        </div>

        <div class="sec-title">视图</div>
        <div class="nav-item" :class="{ active: view === 'discover' && scope.view === 'all' && !scope.category && !scope.source }" @click="pickView('all')">
          <Icon name="list" :size="16" /><span class="lbl">全部信息</span><span class="cnt">{{ stats.total }}</span>
        </div>
        <div class="nav-item" :class="{ active: view === 'discover' && scope.view === 'star' }" @click="pickView('star')">
          <Icon name="star" :size="16" /><span class="lbl">我的收藏</span>
        </div>
        <div class="nav-item" :class="{ active: view === 'discover' && scope.view === 'unread' }" @click="pickView('unread')">
          <Icon name="eye" :size="16" /><span class="lbl">未读</span>
        </div>

        <div class="sec-title">分类</div>
        <div
          class="nav-item"
          v-for="c in categories"
          :key="c.category"
          :class="{ active: scope.category === c.category }"
          @click="pickCategory(c.category)"
        >
          <span class="lbl">{{ c.category }}</span><span class="cnt">{{ c.c }}</span>
        </div>

        <div class="sec-title">数据源</div>
        <template v-for="[cat, list] in groupedSources" :key="cat">
          <div style="padding:7px 11px 3px;font-size:10.5px;color:var(--text-3);letter-spacing:.8px">{{ cat }}</div>
          <div
            class="nav-item"
            v-for="s in list"
            :key="s.id"
            :class="{ active: scope.source === s.id }"
            @click="pickSource(s)"
          >
            <i class="dot" :class="s.last_status === 'ok' ? 'ok' : (s.last_status === 'fail' ? 'fail' : '')"></i>
            <span class="lbl" :title="s.last_message || '未爬取'">{{ s.name }}</span>
            <span class="cnt">{{ s.c }}</span>
            <button
              class="nop"
              style="width:20px;height:20px"
              :title="s.enabled ? '点击停用' : '点击启用'"
              @click.stop="toggleSource(s)"
            >
              <Icon :name="s.enabled ? 'eye' : 'eyeoff'" :size="12" />
            </button>
          </div>
        </template>

        <div class="sec-title">系统</div>
        <div class="nav-item" @click="showModels = true"><Icon name="cpu" :size="16" /><span class="lbl">AI 模型管理</span></div>
        <div class="nav-item" @click="showLogs = true"><Icon name="clock" :size="16" /><span class="lbl">爬取日志</span></div>
        <div class="nav-item" @click="showSources = true"><Icon name="sliders" :size="16" /><span class="lbl">数据源管理</span></div>
      </nav>

      <!-- 主区 -->
      <main class="stage">
        <NowPlaying
          v-if="view === 'now'"
          @zen="zen = true"
          @browse="go('discover')"
          @openurl="openUrl"
        />
        <DigestView
          v-else-if="view === 'digest'"
          :stats="stats"
          @toast="toast"
          @play="go('now')"
          @prompts="k => { promptsInitial = k || 'newsreel'; showPrompts = true; }"
        />
        <BrowseView
          v-else-if="view === 'discover'"
          :scope="scope"
          :sites="sites"
          @list="onList"
          @toast="toast"
          @open="openArticle"
          @crawl="loadStats"
          @play="go('now')"
          @playall="playAll"
          @scope="p => Object.assign(scope, p)"
        />
        <QueuePanel v-else-if="view === 'queue'" @browse="go('discover')" />
        <PagesView v-else-if="view === 'pages'" @open="doc = $event" @toast="toast" />
      </main>
    </div>

    <!-- 底部播放条 -->
    <PlayerDock
      @queue="go('queue')"
      @settings="showSettings = true"
      @zen="zen = true"
    />

    <!-- 弹层 -->
    <SourceManager
      v-if="showSources"
      @close="showSources = false"
      @changed="loadStats"
      @toast="toast"
    />
    <LogDialog v-if="showLogs" @close="showLogs = false" />
    <PageViewer
      v-if="doc"
      :doc="doc"
      @close="doc = null"
      @speak="speakDoc"
      @stopspeak="stopAll"
      @exportmp3="openExport"
    />
    <ExportDialog v-if="exportState" :doc="exportState" @close="exportState = null" />
    <SettingsDrawer
      v-if="showSettings"
      :theme="theme"
      :motion="motion"
      @close="showSettings = false"
      @theme="applyTheme"
      @mode="setMode"
      @models="showModels = true"
      @prompts="k => { promptsInitial = k || 'newsreel'; showPrompts = true; }"
      @toast="toast"
    />
    <ModelManager
      v-if="showModels"
      @close="showModels = false"
      @toast="toast"
    />
    <PromptManager
      v-if="showPrompts"
      :initial="promptsInitial"
      @close="showPrompts = false"
      @toast="toast"
    />
    <ZenOverlay v-if="zen" @close="zen = false" />

    <BootOverlay
      v-if="boot.active"
      :pct="boot.pct" :msg="boot.msg" :detail="boot.detail"
      :attempt="boot.attempt" :error="boot.error" :done="boot.done"
      @retry="bootstrap"
    />

    <div v-if="toastMsg" class="toast">{{ toastMsg }}</div>
  </div>
</template>

<style>
.sec-title:first-of-type { padding-top: 18px; }
</style>
