<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue';
import Icon from './Icon.vue';
import { api, timeAgo } from '../api.js';
import { player, current, playFrom, pause, notify } from '../player/engine.js';
import { coverOf } from '../theme.js';

const props = defineProps({
  scope: { type: Object, required: true },
  sites: { type: Array, default: () => [] }
});
const emit = defineEmits(['list', 'toast', 'open', 'crawl', 'play']);

const list = ref([]);
const total = ref(0);
const loading = ref(false);
const page = ref(1);
const PAGE_SIZE = 60;
const feedEl = ref(null);

const crawl = reactive({ running: false, done: 0, totalCount: 0, newTotal: 0 });
let pollTimer = null;

function buildParams() {
  const s = props.scope;
  const p = { page: page.value, pageSize: PAGE_SIZE, sort: s.sort || 'new' };
  if (s.category) p.category = s.category;
  if (s.source) p.source = s.source;
  if (s.site) p.site = s.site;
  if (s.keyword) p.q = s.keyword;
  if (s.view === 'unread') p.unread = '1';
  if (s.view === 'star') p.starred = '1';
  return p;
}

async function load(append = false) {
  if (props.scope.view === 'pages') return;
  loading.value = true;
  try {
    const d = await api.articles(buildParams());
    total.value = d.total;
    list.value = append ? list.value.concat(d.list) : d.list;
    emit('list', list.value);
  } catch (e) {
    emit('toast', e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function reload() {
  page.value = 1;
  load(false);
  if (feedEl.value) feedEl.value.scrollTop = 0;
}

function onScroll(e) {
  const el = e.target;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) loadMore();
}

function loadMore() {
  if (loading.value || list.value.length >= total.value) return;
  page.value++;
  load(true);
}

watch(() => ({ ...props.scope }), () => reload(), { deep: true });
onMounted(() => reload());
onUnmounted(() => stopPoll());

/* ---------- 一键爬取 ---------- */
async function doCrawl() {
  if (crawl.running) return;
  const s = props.scope;
  const params = {};
  if (s.source) params.sourceId = s.source;
  else if (s.category) params.category = s.category;
  else if (s.site) params.site = s.site;
  try {
    const r = await api.crawlAll(params);
    if (r && r.started === false) return emit('toast', r.message || '无法启动');
    crawl.running = true;
    crawl.done = 0;
    crawl.totalCount = r.total || 0;
    emit('toast', `开始爬取，共 ${r.total || 0} 个源…`);
    startPoll();
  } catch (e) {
    emit('toast', e.message || '启动失败');
  }
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(async () => {
    try {
      const s = await api.crawlStatus();
      crawl.done = s.done;
      crawl.totalCount = s.total;
      crawl.newTotal = s.newTotal;
      if (!s.running) {
        stopPoll();
        crawl.running = false;
        emit('toast', s.message || `完成，新增 ${s.newTotal} 条`);
        emit('crawl');
        reload();
      }
    } catch { stopPoll(); crawl.running = false; }
  }, 900);
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/* ---------- 条目操作 ---------- */
function isPlaying(a) { return current.value?.id === a.id; }

function play(a) {
  if (isPlaying(a) && player.playing) { pause(); return; }
  emit('play');                    // 让 App 切到播报台，字幕就在那儿
  playFrom(list.value, a.id);
}

async function toggleStar(a) {
  const r = await api.patchArticle(a.id, { is_starred: a.is_starred ? 0 : 1 });
  a.is_starred = r.is_starred;
}

async function toggleRead(a) {
  const r = await api.patchArticle(a.id, { is_read: a.is_read ? 0 : 1 });
  a.is_read = r.is_read;
}

async function del(a) {
  await api.deleteArticle(a.id);
  list.value = list.value.filter(x => x.id !== a.id);
  total.value--;
  emit('list', list.value);
}

function openArticle(a) {
  if (!a.is_read) { a.is_read = 1; api.patchArticle(a.id, { is_read: 1 }).catch(() => {}); }
  emit('open', a);
}

const scopeLabel = computed(() => {
  const s = props.scope;
  if (s.sourceName) return s.sourceName;
  if (s.category) return s.category;
  if (s.site) return s.site;
  if (s.view === 'star') return '我的收藏';
  if (s.view === 'unread') return '未读';
  return '全部信息';
});
</script>

<template>
  <div class="browse">
    <div class="browse-tools">
      <button class="btn primary" :disabled="crawl.running" @click="doCrawl">
        <Icon name="zap" :size="14" />
        {{ crawl.running ? `爬取中 ${crawl.done}/${crawl.totalCount}` : `拉取：${scopeLabel}` }}
      </button>

      <span class="chip" style="height:32px">{{ total }} 条</span>

      <select class="field" style="width:130px" :value="scope.site" @change="emit('scope', { site: $event.target.value })">
        <option value="">全部站点</option>
        <option v-for="s in sites" :key="s" :value="s">{{ s }}</option>
      </select>

      <select class="field" style="width:104px" :value="scope.sort" @change="emit('scope', { sort: $event.target.value })">
        <option value="new">按时间</option>
        <option value="rank">按排名</option>
      </select>

      <span style="flex:1"></span>

      <button class="icon-btn" title="刷新" @click="reload"><Icon name="refresh" :size="15" /></button>
      <button class="btn sm" @click="emit('playall')"><Icon name="play" :size="12" /> 从第一条开始播</button>
    </div>

    <div class="feed" ref="feedEl" @scroll.passive="onScroll">
      <div v-if="!list.length && !loading" class="empty">
        <div class="big">这里还没有内容</div>
        <div class="sm">
          点左上角「拉取」从 {{ scopeLabel }} 抓一批最新的头条进来<br />
          抓到之后点卡片右上角 ▶，它就会一条接一条念给你听
        </div>
      </div>

      <div v-else class="feed-grid">
        <article
          v-for="a in list"
          :key="a.id"
          class="ncard"
          :class="{ 'is-read': a.is_read, playing: isPlaying(a) }"
          @click="openArticle(a)"
        >
          <div class="ctop">
            <div class="cover" :style="{ background: `linear-gradient(135deg, ${coverOf(a.site).from}, ${coverOf(a.site).to})` }">
              {{ coverOf(a.site).initial }}
            </div>
            <div class="src">
              <div class="n">{{ a.site || a.source_name }}</div>
              <div class="m">{{ a.category }} · {{ timeAgo(a.published_at || a.crawled_at) }}</div>
            </div>
            <span v-if="a.hot_value" class="chip warn" style="height:20px">热 {{ a.hot_value }}</span>
          </div>

          <h3 class="ttl">{{ a.title }}</h3>
          <p v-if="a.summary" class="sum">{{ a.summary }}</p>

          <div class="cfoot">
            <span v-if="a.word_count > 200" class="chip">正文 {{ a.word_count }} 字</span>
            <span v-else-if="a.no_body" class="chip">视频 · 无正文</span>
            <span v-else class="chip" style="opacity:.7">未抓正文</span>
            <span v-if="isPlaying(a)" class="chip accent">
              <span class="eq" :class="{ paused: !player.playing }"><i></i><i></i><i></i><i></i></span>
              播报中
            </span>
            <span class="ops">
              <button class="nop" :class="{ on: a.is_starred }" title="收藏" @click.stop="toggleStar(a)">
                <Icon name="star" :size="14" />
              </button>
              <button class="nop" :title="a.is_read ? '标为未读' : '标为已读'" @click.stop="toggleRead(a)">
                <Icon :name="a.is_read ? 'eyeoff' : 'eye'" :size="14" />
              </button>
              <a v-if="a.url" class="nop" :href="a.url" target="_blank" rel="noreferrer" title="打开原网页" @click.stop>
                <Icon name="link" :size="14" />
              </a>
              <button class="nop del" title="删除" @click.stop="del(a)"><Icon name="trash" :size="14" /></button>
            </span>
          </div>

          <button
            class="play-fab"
            :class="{ on: isPlaying(a) }"
            :title="isPlaying(a) ? '暂停' : '播报这条'"
            @click.stop="play(a)"
          >
            <Icon :name="isPlaying(a) && player.playing ? 'pause' : 'play'" :size="15" />
          </button>
        </article>
      </div>

      <div v-if="loading" class="empty" style="padding:22px">加载中…</div>
      <div v-else-if="list.length && list.length < total" class="empty" style="padding:22px">继续下滑加载更多</div>
    </div>
  </div>
</template>
