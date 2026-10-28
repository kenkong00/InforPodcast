<script setup>
import { ref, onMounted } from 'vue';
import Icon from './Icon.vue';
import { api, timeAgo } from '../api.js';
import { coverOf } from '../theme.js';

const emit = defineEmits(['open', 'toast']);
const list = ref([]);
const loading = ref(false);
const url = ref('');
const fetching = ref(false);

async function load() {
  loading.value = true;
  try { list.value = await api.pages(); } catch (e) { emit('toast', e.message); }
  finally { loading.value = false; }
}

async function doFetch() {
  const u = url.value.trim();
  if (!u) return emit('toast', '先粘贴一个网址');
  fetching.value = true;
  try {
    const p = await api.fetchUrl(u, '网页抓取');
    url.value = '';
    emit('toast', '抓取成功：' + (p.title || p.url));
    emit('open', p);
    load();
  } catch (e) {
    emit('toast', e.message || '抓取失败');
  } finally { fetching.value = false; }
}

async function del(p) {
  await api.deletePage(p.id);
  list.value = list.value.filter(x => x.id !== p.id);
}

defineExpose({ load });
onMounted(load);
</script>

<template>
  <div class="browse">
    <div class="browse-tools">
      <input
        class="field"
        style="flex:1;min-width:180px;max-width:520px"
        v-model="url"
        placeholder="粘贴网址 → 扒成纯文字，然后可以整篇播报"
        @keyup.enter="doFetch"
      />
      <button class="btn primary" :disabled="fetching" @click="doFetch">
        <Icon name="download" :size="14" /> {{ fetching ? '抓取中…' : '扒取' }}
      </button>
      <span style="flex:1"></span>
      <span class="chip" style="height:32px">{{ list.length }} 条</span>
      <button class="icon-btn" title="刷新" @click="load"><Icon name="refresh" :size="15" /></button>
    </div>

    <div class="feed">
      <div v-if="!list.length && !loading" class="empty">
        <div class="big">还没有抓取记录</div>
        <div class="sm">
          在上方粘贴任意网址，它会扒掉广告和导航，只留下正文<br />
          之后可以整篇播报，也可以导出成 MP3 离线听
        </div>
      </div>

      <div v-else class="feed-grid">
        <article v-for="p in list" :key="p.id" class="ncard" @click="emit('open', p)">
          <div class="ctop">
            <div class="cover" :style="{ background: `linear-gradient(135deg, ${coverOf(p.site).from}, ${coverOf(p.site).to})` }">
              {{ coverOf(p.site).initial }}
            </div>
            <div class="src">
              <div class="n">{{ p.site || '网页' }}</div>
              <div class="m">{{ p.category }} · {{ timeAgo(p.crawled_at) }}</div>
            </div>
          </div>
          <h3 class="ttl">{{ p.title || p.url }}</h3>
          <div class="cfoot">
            <span class="chip">{{ p.word_count }} 字</span>
            <span class="ops">
              <a class="nop" :href="p.url" target="_blank" rel="noreferrer" title="打开原网页" @click.stop>
                <Icon name="link" :size="14" />
              </a>
              <button class="nop del" title="删除" @click.stop="del(p)"><Icon name="trash" :size="14" /></button>
            </span>
          </div>
        </article>
      </div>
    </div>
  </div>
</template>
