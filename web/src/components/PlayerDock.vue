<script setup>
import { computed } from 'vue';
import Icon from './Icon.vue';
import {
  player, current, currentCue, elapsed, duration,
  toggle, jumpTrack, jumpCue, seekRatio, setRate, setVolume, setMode, setVoice
} from '../player/engine.js';
import { coverOf } from '../theme.js';

const emit = defineEmits(['queue', 'settings', 'zen']);

const track = current;
const cue = currentCue;

const cover = computed(() => coverOf(track.value?.site || '波'));
const coverStyle = computed(() => ({
  background: `linear-gradient(135deg, ${cover.value.from}, ${cover.value.to})`
}));

const pct = computed(() => {
  const d = duration.value;
  if (!d) return 0;
  return Math.min(100, (elapsed.value / d) * 100);
});

function fmt(s) {
  const v = Math.max(0, Math.floor(s || 0));
  return Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0');
}

const MODES = [
  { id: 'order', icon: 'list', tip: '顺序播放 · 播完停止' },
  { id: 'loop', icon: 'repeat', tip: '列表循环' },
  { id: 'single', icon: 'repeat', tip: '单条循环' },
  { id: 'shuffle', icon: 'shuffle', tip: '随机播报' }
];
const modeIdx = computed(() => Math.max(0, MODES.findIndex(m => m.id === player.mode)));
const modeIcon = computed(() => MODES[modeIdx.value].icon);
const modeTip = computed(() => MODES[modeIdx.value].tip);

function cycleMode() { setMode(MODES[(modeIdx.value + 1) % MODES.length].id); }

/* ---- 进度条拖动 ---- */
let dragging = false;
function ratioOf(e, el) {
  const r = el.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
}
function onDown(e) {
  if (!track.value) return;
  dragging = true;
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  seekRatio(ratioOf(e, e.currentTarget));
}
function onMove(e) { if (dragging) seekRatio(ratioOf(e, e.currentTarget)); }
function onUp(e) {
  if (!dragging) return;
  dragging = false;
  seekRatio(ratioOf(e, e.currentTarget));
}

const voiceGroups = computed(() => {
  const map = new Map();
  for (const v of [...player.voices.web, ...player.voices.svr]) {
    if (!map.has(v.group)) map.set(v.group, []);
    map.get(v.group).push(v);
  }
  return [...map.entries()];
});
</script>

<template>
  <div class="dock">
    <!-- 封面 + 曲目 -->
    <div class="dock-cover" :style="coverStyle">{{ cover.initial }}</div>
    <div class="dock-info">
      <div class="t">{{ track ? track.title : '挑几条新闻，交给它念' }}</div>
      <div class="s">
        <template v-if="track">
          <span v-if="player.fetchingContent">正在抓正文…</span>
          <span v-else-if="player.buffering">正在合成语音…</span>
          <span v-else-if="cue">{{ cue.text }}</span>
          <span v-else>{{ track.site }}</span>
        </template>
        <template v-else>队列是空的</template>
      </div>
    </div>

    <!-- 控制 -->
    <div class="dock-ctrl">
      <button class="icon-btn skip" title="上一条" @click="jumpTrack(-1)"><Icon name="prev" :size="15" /></button>
      <button class="icon-btn" title="上一句" @click="jumpCue(-1)"><Icon name="rewind" :size="15" /></button>
      <button class="icon-btn big solid" :title="player.playing ? '暂停' : '播放'" @click="toggle()">
        <Icon :name="player.playing ? 'pause' : 'play'" :size="18" />
      </button>
      <button class="icon-btn" title="下一句" @click="jumpCue(1)"><Icon name="forward" :size="15" /></button>
      <button class="icon-btn skip" title="下一条" @click="jumpTrack(1)"><Icon name="next" :size="15" /></button>
    </div>

    <!-- 进度 -->
    <div class="dock-mid">
      <div
        class="bar"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
      >
        <div class="rail"><div class="fill" :style="{ width: pct + '%' }"></div></div>
        <div class="knob" :style="{ left: pct + '%' }"></div>
      </div>
      <div class="bar-time">
        <span>{{ fmt(elapsed) }}</span>
        <span>{{ fmt(duration) }}</span>
      </div>
    </div>

    <!-- 右侧 -->
    <div class="dock-right">
      <button class="icon-btn wide" :title="modeTip + '（点击切换）'" @click="cycleMode">
        <Icon :name="modeIcon" :size="15" />
      </button>

      <select
        class="field wide"
        style="width:104px"
        title="播报音色"
        :value="player.voice"
        @change="e => setVoice(e.target.value)"
      >
        <optgroup v-for="[g, list] in voiceGroups" :key="g" :label="g">
          <option v-for="v in list" :key="v.id" :value="v.id">{{ v.label }}</option>
        </optgroup>
      </select>

      <select
        class="field wide"
        style="width:76px"
        title="语速"
        :value="player.rate"
        @change="e => setRate(Number(e.target.value))"
      >
        <option :value="0.75">0.75×</option>
        <option :value="1">1.0×</option>
        <option :value="1.25">1.25×</option>
        <option :value="1.5">1.5×</option>
        <option :value="1.75">1.75×</option>
        <option :value="2">2.0×</option>
      </select>

      <span class="vol-wrap wide" title="音量">
        <Icon :name="player.volume ? 'volume' : 'mute'" :size="15" />
        <input
          class="rng" type="range" min="0" max="1" step="0.05"
          :value="player.volume"
          @input="e => setVolume(Number(e.target.value))"
        />
      </span>

      <button class="icon-btn" title="播放队列" @click="emit('queue')"><Icon name="queue" :size="15" /></button>
      <button class="icon-btn" title="全屏字幕（运动时用）" @click="emit('zen')"><Icon name="maximize" :size="15" /></button>
      <button class="icon-btn" title="换装与播报设置" @click="emit('settings')"><Icon name="palette" :size="15" /></button>
    </div>
  </div>
</template>
