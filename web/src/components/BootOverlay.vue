<script setup>
/**
 * 启动遮罩
 *
 * 背景：这个站是本地 Node 服务托管的，双击 启动.bat 之后 Node 要一两秒才开始监听端口。
 * 如果浏览器抢在这之前打开，用户看到的就是一句冷冰冰的「localhost 拒绝连接」，
 * 得手动刷新才行 —— 这是最影响第一印象的体验。
 *
 * 这里改成：页面自己撑起一块加载层，一边按阶段显示进度，一边自动重试探测服务。
 * 服务起来了就继续把首屏数据灌进去，全程用户都能看到「正在跑」，不用刷新、不会白屏。
 */
import Icon from './Icon.vue';

defineProps({
  pct: { type: Number, default: 0 },
  msg: { type: String, default: '正在启动…' },
  detail: { type: String, default: '' },
  attempt: { type: Number, default: 0 },
  error: { type: String, default: '' },
  done: { type: Boolean, default: false }
});
const emit = defineEmits(['retry']);
</script>

<template>
  <div class="boot" :class="{ out: done }">
    <div class="boot-box">
      <div class="boot-logo"><Icon name="radio" :size="26" /></div>
      <div class="boot-name">声波播报台</div>
      <div class="boot-sub">WAVECAST · 把头条念给你听</div>

      <div class="boot-bar">
        <i :style="{ width: Math.max(4, Math.min(100, pct)) + '%' }"></i>
      </div>

      <div class="boot-msg">
        <template v-if="error">
          <Icon name="alert" :size="13" /> {{ error }}
        </template>
        <template v-else>{{ msg }}</template>
      </div>

      <div v-if="detail" class="boot-detail">{{ detail }}</div>

      <button v-if="error" class="btn sm ghost boot-retry" @click="emit('retry')">
        <Icon name="refresh" :size="13" /> 重试
      </button>
      <div v-else-if="attempt > 1" class="boot-detail">服务还在启动中，已重试 {{ attempt }} 次…</div>
    </div>
  </div>
</template>

<style scoped>
.boot {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg, #07080f);
  transition: opacity .36s var(--ease, ease);
}
.boot.out { opacity: 0; pointer-events: none; }

.boot-box {
  width: 320px;
  text-align: center;
  padding: 30px 26px 26px;
  border-radius: var(--r-l, 18px);
  border: 1px solid var(--line);
  background: var(--surface, rgba(255, 255, 255, .04));
  backdrop-filter: blur(18px);
}
.boot-logo {
  width: 56px; height: 56px; margin: 0 auto 14px;
  border-radius: 18px;
  display: flex; align-items: center; justify-content: center;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), var(--accent-2, var(--accent)));
  box-shadow: 0 10px 28px var(--glow, rgba(0, 0, 0, .3));
}
.boot-name { font-size: 19px; font-weight: 700; letter-spacing: .5px; }
.boot-sub { font-size: 11px; color: var(--text-3); margin-top: 5px; letter-spacing: 1.4px; }

.boot-bar {
  height: 4px; margin: 22px 0 12px;
  border-radius: 999px;
  background: var(--surface-2, rgba(255, 255, 255, .08));
  overflow: hidden;
}
.boot-bar i {
  display: block; height: 100%; border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2, var(--accent)));
  transition: width .3s var(--ease, ease);
}
.boot-msg {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  font-size: 12.5px; color: var(--text-2);
}
.boot-detail { font-size: 11px; color: var(--text-3); margin-top: 7px; line-height: 1.6; }
.boot-retry { margin-top: 14px; }
</style>
