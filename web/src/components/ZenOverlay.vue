<script setup>
/**
 * 全屏字幕模式 —— 运动时、做家务时，把字号拉到最大，
 * 一眼就能看到现在在念什么，点任意一行可以跳过去。
 */
import { ref, watch, nextTick } from 'vue';
import Icon from './Icon.vue';
import {
  player, current, currentCues, elapsed, duration,
  toggle, jumpCue, jumpTrack, seekCue, seekRatio, setRate
} from '../player/engine.js';
import { createLyricFollower } from '../player/lyricScroll.js';

const emit = defineEmits(['close']);
const boxEl = ref(null);
const follower = createLyricFollower(boxEl);

const track = current;
const cues = currentCues;

watch([() => player.cueIdx, () => player.idx], () => {
  nextTick(() => { if (follower.shouldFollow()) follower.follow(true); });
});

function onCueClick(i) {
  follower.release();
  seekCue(i);
}

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
function cycleRate() {
  const i = RATES.indexOf(player.rate);
  setRate(RATES[(i + 1) % RATES.length]);
}
</script>

<template>
  <div class="zen">
    <div class="zen-head">
      <button class="icon-btn" title="退出全屏" @click="emit('close')"><Icon name="minimize" :size="17" /></button>
      <div style="min-width:0">
        <div style="font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          {{ track ? track.title : '没有在播的内容' }}
        </div>
        <div style="font-size:11.5px;color:var(--text-3)">
          {{ track ? track.site + ' · ' + track.category : '去发现里挑几条' }}
        </div>
      </div>
      <span style="flex:1"></span>
      <button class="btn sm" @click="cycleRate">{{ player.rate }}×</button>
    </div>

    <div
      class="zen-lyric"
      ref="boxEl"
      @wheel.passive="follower.onUserInteract"
      @touchstart.passive="follower.onUserInteract"
      @pointerdown="follower.onUserInteract"
    >
      <button
        v-for="(c, i) in cues"
        :key="i"
        class="lyric-line"
        :class="{ active: i === player.cueIdx, done: player.cueIdx > i, ['kind-' + c.kind]: true }"
        @click="onCueClick(i)"
      >{{ c.text }}</button>
    </div>

    <div class="zen-foot">
      <div class="bar" style="margin-bottom:14px" @pointerdown="e => {
        const r = e.currentTarget.getBoundingClientRect();
        seekRatio(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
      }">
        <div class="rail">
          <div class="fill" :style="{ width: (duration ? (elapsed / duration) * 100 : 0) + '%' }"></div>
        </div>
      </div>
      <div style="display:flex;align-items:center;justify-content:center;gap:20px">
        <button class="icon-btn" title="上一条" @click="jumpTrack(-1)"><Icon name="prev" :size="18" /></button>
        <button class="icon-btn" title="上一句" @click="jumpCue(-1)"><Icon name="rewind" :size="18" /></button>
        <button class="icon-btn huge solid" @click="toggle()">
          <Icon :name="player.playing ? 'pause' : 'play'" :size="26" />
        </button>
        <button class="icon-btn" title="下一句" @click="jumpCue(1)"><Icon name="forward" :size="18" /></button>
        <button class="icon-btn" title="下一条" @click="jumpTrack(1)"><Icon name="next" :size="18" /></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.zen-lyric { position: relative; }
</style>
