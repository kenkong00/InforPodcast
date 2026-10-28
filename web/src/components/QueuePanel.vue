<script setup>
import { computed } from 'vue';
import Icon from './Icon.vue';
import { player, current, playTrackIndex, stopAll } from '../player/engine.js';
import { coverOf } from '../theme.js';
import { trackDuration } from '../player/cues.js';

const emit = defineEmits(['browse']);

const tracks = computed(() => player.queue);

function fmt(s) {
  const v = Math.max(0, Math.round(s || 0));
  return Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0');
}

function play(i) {
  if (typeof playTrackIndex === 'function') playTrackIndex(i);
}

const totalTime = computed(() => tracks.value.reduce((s, t) => s + trackDuration(t), 0));
</script>

<template>
  <div class="queue">
    <div class="browse-tools">
      <span class="chip" style="height:32px">{{ tracks.length }} 条待播</span>
      <span class="chip" style="height:32px">约 {{ fmt(totalTime) }}</span>
      <span style="flex:1"></span>
      <button class="btn sm" @click="emit('browse')"><Icon name="compass" :size="13" /> 再去挑几条</button>
    </div>

    <div v-if="!tracks.length" class="empty">
      <div class="big">队列是空的</div>
      <div class="sm">从「发现」里点卡片上的 ▶，就会排进这里</div>
    </div>

    <div v-else class="queue-list">
      <div
        v-for="(t, i) in tracks"
        :key="t.uid"
        class="qrow"
        :class="{ active: i === player.idx }"
        @click="play(i)"
      >
        <span class="idx">
          <span v-if="i === player.idx && player.playing" class="eq"><i></i><i></i><i></i><i></i></span>
          <template v-else>{{ i + 1 }}</template>
        </span>
        <span class="mini" :style="{ background: `linear-gradient(135deg, ${coverOf(t.site).from}, ${coverOf(t.site).to})` }">
          {{ coverOf(t.site).initial }}
        </span>
        <span class="body">
          <span class="t">{{ t.title }}</span>
          <span class="s">{{ t.site }} · {{ t.category }} · {{ t.cues.length }} 句 · {{ fmt(trackDuration(t)) }}</span>
        </span>
        <span v-if="t.cueSource === 'summary'" class="chip" title="播报时会自动抓取正文">摘要</span>
        <button class="nop" title="停止播报" @click.stop="stopAll()"><Icon name="stop" :size="13" /></button>
      </div>
    </div>
  </div>
</template>
