<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import Icon from './Icon.vue';
import { player, current, currentCues, toggle, jumpTrack, seekCue, notify } from '../player/engine.js';
import { coverOf } from '../theme.js';
import { timeAgo } from '../api.js';
import { createLyricFollower } from '../player/lyricScroll.js';

const emit = defineEmits(['zen', 'browse', 'openurl']);

const lyricEl = ref(null);
const follower = createLyricFollower(lyricEl);

const track = current;
const cues = currentCues;

const cover = computed(() => coverOf(track.value?.site || '波'));

const coverStyle = computed(() => ({
  background: `linear-gradient(135deg, ${cover.value.from}, ${cover.value.to})`
}));

/* 双人对话时把「谁在说」标在字幕前，否则听不出来是两个人在聊 */
const showSpeaker = computed(() => track.value?.digestKind === 'dialogue');

const progressText = computed(() => {
  const t = track.value;
  if (!t) return '';
  const total = t.cues.length;
  return total ? `${Math.max(0, player.cueIdx) + 1} / ${total} 句` : '';
});

/* 往上按下 wheel / touchstart / pointerdown 才算用户操作。
   绝不能监听 scroll —— 程序自己滚动也会触发它，会把跟随锁死。 */
watch([() => player.cueIdx, () => player.idx], () => {
  nextTick(() => { if (follower.shouldFollow()) follower.follow(true); });
});

watch(() => track.value?.uid, () => {
  follower.release();
  nextTick(() => follower.follow(false));
});

onMounted(() => nextTick(() => follower.follow(false)));

function onCueClick(i) {
  follower.release();
  seekCue(i);
}
</script>

<template>
  <div class="np">
    <!-- 空状态 -->
    <div v-if="!track" class="empty" style="margin:auto">
      <div class="big">还没有开始播报</div>
      <div class="sm">
        去「发现」挑几条新闻，或者先在左侧选一个分类<br />
        然后点底部的播放键，它会一路念下去
      </div>
      <button class="btn primary lg" style="margin-top:16px" @click="emit('browse')">
        <Icon name="compass" :size="16" /> 去发现
      </button>
    </div>

    <template v-else>
      <!-- 左：唱片 -->
      <div class="np-left">
        <div class="vinyl-wrap" :class="{ live: player.playing }">
          <!-- 只让纹路转：封面标签要是跟着转，字就糊成一团了 -->
          <div class="vinyl" :class="{ spinning: player.playing }" :title="player.playing ? '正在播报' : '已暂停'"></div>
          <div class="label" :style="coverStyle">
            <span class="ini">{{ cover.initial }}</span>
            <i class="pin"></i>
          </div>
        </div>

        <div class="np-meta">
          <h2 class="np-title">{{ track.title }}</h2>
          <div class="np-sub">
            <span class="chip accent">{{ track.site }}</span>
            <span class="chip">{{ track.category }}</span>
            <span v-if="track.publishedAt">{{ timeAgo(track.publishedAt) }}</span>
            <span v-if="player.fetchingContent" class="chip warn">
              <Icon name="refresh" :size="11" /> 抓正文
            </span>
            <span v-else-if="player.buffering" class="chip warn">
              <Icon name="zap" :size="11" /> 合成中
            </span>
          </div>
        </div>

        <div class="np-actions">
          <button class="btn sm skip-lg" @click="jumpTrack(-1)"><Icon name="prev" :size="13" /> 上一条</button>
          <button class="btn sm skip-lg" @click="jumpTrack(1)"><Icon name="next" :size="13" /> 下一条</button>
          <button class="btn sm" @click="emit('zen')"><Icon name="maximize" :size="13" /> 全屏字幕</button>
          <button v-if="track.url" class="btn sm ghost" @click="emit('openurl', track.url)">
            <Icon name="link" :size="13" /> 原文
          </button>
        </div>
      </div>

      <!-- 右：歌词 -->
      <div class="np-right">
        <div class="lyric-head">
          <span class="t">字幕 · 跟着语音走</span>
          <span class="chip">{{ progressText }}</span>
          <span style="flex:1"></span>
          <button class="icon-btn" title="换一条" @click="jumpTrack(1)"><Icon name="forward" :size="15" /></button>
          <button class="btn sm" @click="toggle()">
            <Icon :name="player.playing ? 'pause' : 'play'" :size="13" />
            {{ player.playing ? '暂停' : '播放' }}
          </button>
        </div>

        <div
          class="lyric-scroll"
          ref="lyricEl"
          @wheel.passive="follower.onUserInteract"
          @touchstart.passive="follower.onUserInteract"
          @pointerdown="follower.onUserInteract"
        >
          <button
            v-for="(c, i) in cues"
            :key="i"
            class="lyric-line"
            :class="{
              active: i === player.cueIdx,
              done: player.cueIdx > i,
              ['kind-' + c.kind]: true
            }"
            @click="onCueClick(i)"
          ><span v-if="showSpeaker && c.speakerLabel" class="who">{{ c.speakerLabel }}</span>{{ c.text }}</button>

          <div v-if="!cues.length" class="empty" style="padding:40px 0">
            <div class="sm">这条没有可播报的文字</div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lyric-scroll { position: relative; }
.who {
  display: inline-block; margin-right: 6px; padding: 1px 6px;
  border-radius: 999px; font-size: 10.5px; font-weight: 600;
  color: var(--accent); background: var(--accent-soft); vertical-align: 1px;
}
</style>
