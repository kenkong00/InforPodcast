<script setup>
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import { THEMES } from '../theme.js';
import { player, setFullText, setWakeLock, notify } from '../player/engine.js';
import { api } from '../api.js';

const emit = defineEmits(['close', 'theme', 'toast', 'models', 'prompts']);

const props = defineProps({
  theme: { type: String, default: 'midnight' },
  motion: { type: Boolean, default: true }
});

const cache = ref(null);
const engine = ref(null);
const busy = ref(false);

const MODES = [
  { id: 'order', name: '顺序播完停止' },
  { id: 'loop', name: '列表循环' },
  { id: 'single', name: '单条循环' },
  { id: 'shuffle', name: '随机播报' }
];

async function loadCache() {
  try { cache.value = await api.ttsCache(); } catch { /* ignore */ }
}
async function loadEngine() {
  try { engine.value = await api.ttsStatus(); } catch { /* ignore */ }
}
loadCache();
loadEngine();

const cacheMb = computed(() => cache.value ? cache.value.mb : 0);

async function clearCache() {
  busy.value = true;
  try {
    cache.value = await api.ttsClearCache();
    emit('toast', '语音缓存已清空');
  } catch (e) { emit('toast', e.message); }
  finally { busy.value = false; }
}

async function warmup() {
  busy.value = true;
  try {
    const r = await api.ttsWarmup();
    emit('toast', r.ready ? '语音引擎已就绪' : ('启动失败：' + (r.error || '未知原因')));
    await loadEngine();
  } catch (e) { emit('toast', e.message); }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="mask" style="justify-content:flex-end;padding:0" @click.self="emit('close')">
    <div class="drawer" @click.stop>
      <div class="drawer-head">
        <Icon name="palette" :size="17" />
        <span>换装与播报设置</span>
        <span style="flex:1"></span>
        <button class="icon-btn" @click="emit('close')"><Icon name="close" :size="15" /></button>
      </div>

      <div class="drawer-body">
        <div class="sec-title">外观皮肤</div>
        <div class="theme-grid">
          <div
            v-for="t in THEMES"
            :key="t.id"
            class="theme-card"
            :class="{ on: props.theme === t.id }"
            @click="emit('theme', t.id)"
          >
            <div class="sw" :style="{ background: `linear-gradient(135deg, ${t.swatch[0]}, ${t.swatch[1]})` }"></div>
            <div class="nm">{{ t.name }}</div>
            <div class="ht">{{ t.hint }}</div>
          </div>
        </div>

        <div class="sec-title">播报</div>

        <div class="setting-row">
          <div class="lb">
            <div class="n">播报全文</div>
            <div class="d">关闭后只念标题和摘要，抓正文更省流量</div>
          </div>
          <div
            class="switch"
            :class="{ on: player.fullText }"
            @click="setFullText(!player.fullText)"
          ></div>
        </div>

        <div class="setting-row">
          <div class="lb">
            <div class="n">循环方式</div>
            <div class="d">底部播放条左侧按钮也可以切换</div>
          </div>
          <select
            class="field" style="width:132px"
            :value="player.mode"
            @change="e => emit('mode', e.target.value)"
          >
            <option v-for="m in MODES" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
        </div>

        <div class="setting-row">
          <div class="lb">
            <div class="n">屏幕常亮</div>
            <div class="d">运动 / 做家务时字幕不会自动熄屏</div>
          </div>
          <div
            class="switch"
            :class="{ on: player.wakeLockOn }"
            @click="setWakeLock(!player.wakeLockOn)"
          ></div>
        </div>

        <div class="sec-title">AI 加工</div>

        <div class="setting-row">
          <div class="lb">
            <div class="n">大模型方案</div>
            <div class="d">添加本地 Ollama 或各家云端模型，可以给「打分」和「写稿」分别指定</div>
          </div>
          <button class="btn sm" @click="emit('models')">
            <Icon name="cpu" :size="13" /> 管理
          </button>
        </div>

        <div class="setting-row">
          <div class="lb">
            <div class="n">提示词规则</div>
            <div class="d">粗筛打分 / 精选轮播 / 双人对话 三套提示词，全部可改可存，不写死</div>
          </div>
          <button class="btn sm" @click="emit('prompts')">
            <Icon name="text" :size="13" /> 编辑
          </button>
        </div>

        <div class="sec-title">语音引擎</div>

        <div class="setting-row">
          <div class="lb">
            <div class="n">引擎状态</div>
            <div class="d">
              <template v-if="engine">
                {{ engine.ready ? '已就绪' : '未启动' }} ·
                累计合成 {{ engine.synthCount || 0 }} 段 ·
                最近一次 {{ engine.lastSynthMs || 0 }} ms
              </template>
              <template v-else>读取中…</template>
            </div>
          </div>
          <button class="btn sm" :disabled="busy" @click="warmup">预热</button>
        </div>

        <div class="setting-row">
          <div class="lb">
            <div class="n">语音缓存</div>
            <div class="d">
              {{ cache ? `${cache.files} 个文件 · ${cacheMb} MB` : '读取中…' }}
              · 合成过的句子会缓存，重播不再占用引擎
            </div>
          </div>
          <button class="btn sm danger" :disabled="busy" @click="clearCache">清空</button>
        </div>

        <div class="sec-title">提示</div>
        <div class="sm" style="font-size:12px;color:var(--text-3);line-height:1.8">
          · 想要音质最好：音色选「在线 · 神经语音」，需要联网<br />
          · 想要秒开、断网也能用：音色选「本机语音」<br />
          · 手机上还能用锁屏控件切上一条 / 下一条<br />
          · 长按卡片上的 ▶ 不会连续抓正文，边播边抓更省
        </div>
      </div>
    </div>
  </div>
</template>
