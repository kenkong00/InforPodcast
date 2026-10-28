<script setup>
/**
 * 站内阅读 —— 保留「边看边听」的老能力，
 * 但「播报本篇」现在走新的逐句引擎，所以这里也能看到字幕同步。
 */
import { ref, computed, watch } from 'vue';
import Icon from './Icon.vue';
import { timeAgo } from '../api.js';

const props = defineProps({ doc: { type: Object, required: true } });
const emit = defineEmits(['close', 'speak', 'stopspeak', 'exportmp3']);

const size = ref(Number(localStorage.getItem('reader_size')) || 17);

const paragraphs = computed(() => String(props.doc.content || '').trim()
  .split(/\n+/).map(s => s.trim()).filter(Boolean));

const isSpeaking = computed(() => props.doc.__speaking === true);

function copy() {
  navigator.clipboard.writeText(props.doc.content || '').catch(() => {});
}

watch(size, v => { try { localStorage.setItem('reader_size', String(v)); } catch { /* ignore */ } });
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <Icon name="file" :size="17" />
        <span>{{ doc.site || '网页正文' }}</span>
        <span style="flex:1"></span>
        <button class="icon-btn" @click="emit('close')"><Icon name="close" :size="15" /></button>
      </div>

      <div class="modal-body">
        <h2 class="reader-title">{{ doc.title || '网页正文' }}</h2>

        <div class="reader-tools">
          <button class="btn primary sm" @click="emit('speak', doc)">
            <Icon :name="isSpeaking ? 'pause' : 'play'" :size="12" />
            {{ isSpeaking ? '暂停播报' : '播报本篇' }}
          </button>
          <button class="btn sm" @click="emit('stopspeak')"><Icon name="stop" :size="12" /> 停止</button>
          <button class="btn sm" @click="emit('exportmp3', doc)" title="用本机离线语音合成 MP3，存到指定目录">
            <Icon name="download" :size="12" /> 导出 MP3
          </button>

          <span style="width:1px;height:18px;background:var(--line)"></span>

          <button class="icon-btn" style="width:28px;height:28px" title="缩小字号" @click="size = Math.max(13, size - 1)">
            <span style="font-size:12px;font-weight:700">A-</span>
          </button>
          <span class="chip">{{ size }}px</span>
          <button class="icon-btn" style="width:28px;height:28px" title="放大字号" @click="size = Math.min(28, size + 1)">
            <span style="font-size:12px;font-weight:700">A+</span>
          </button>

          <button class="btn sm" @click="copy"><Icon name="text" :size="12" /> 复制全文</button>
          <a v-if="doc.url" class="btn sm" :href="doc.url" target="_blank" rel="noreferrer" @click.stop>
            <Icon name="link" :size="12" /> {{ doc.noBody ? '看原视频' : '原网页' }}
          </a>

          <span style="flex:1"></span>
          <span class="chip">{{ doc.word_count || 0 }} 字</span>
          <span class="chip">{{ doc.crawled_at ? timeAgo(doc.crawled_at) : '' }}</span>
        </div>

        <div v-if="doc.loading" class="reader-note">正在抓取正文…（没抓到时下方会显示摘要）</div>
        <div v-else-if="doc.error" class="reader-note warn">{{ doc.error }}</div>
        <div v-else-if="!doc.content" class="reader-note">这条没有正文，只有摘要。</div>
        <div v-if="doc.noBody" class="reader-note info">
          视频/音频站点没有文字正文 —— 播报时只读标题与简介，不会卡在抓正文上。
        </div>

        <div class="reader-body" :style="{ fontSize: size + 'px' }">
          <p v-for="(p, i) in paragraphs" :key="i">{{ p }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
