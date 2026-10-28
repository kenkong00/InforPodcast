<script setup>
/**
 * 提示词规则管理器
 *
 * 这是用户最关心的一个入口：三套模板（粗筛打分 / 精选轮播 / 双人对话）
 * 全部从这里编辑、保存，绝不强写死在程序里。模板存在后端 prompts 表。
 *
 * 打开方式有两种：
 *   - 设置抽屉 → AI 加工 → 提示词规则（@prompts 不带参，默认停在精选轮播）
 *   - AI 精选页 → 提示词 按钮（@prompts 带当前形态，自动跳到对应标签）
 */
import { ref, reactive, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import { api } from '../api.js';

const props = defineProps({ initial: { type: String, default: 'newsreel' } });
const emit = defineEmits(['close', 'toast']);

const TABS = [
  { key: 'score', name: '粗筛打分', icon: 'filter' },
  { key: 'newsreel', name: '精选轮播', icon: 'radio' },
  { key: 'dialogue', name: '双人对话', icon: 'chat' }
];

const prompts = ref([]);
const active = ref(props.initial || 'newsreel');
const saving = ref(false);
const dirty = reactive({});

const cur = computed(() => prompts.value.find(p => p.key === active.value) || null);

async function load() {
  try { prompts.value = await api.prompts(); }
  catch (e) { emit('toast', e.message); }
}

function touch() { dirty[active.value] = true; }

const varLabel = v => '{{' + v + '}}';

async function save() {
  const p = cur.value;
  if (!p) return;
  saving.value = true;
  try {
    await api.savePrompt(p.key, { system: p.content.system, user: p.content.user, title: p.title, hint: p.hint });
    dirty[p.key] = false;
    emit('toast', '「' + p.title + '」已保存');
  } catch (e) { emit('toast', e.message); }
  finally { saving.value = false; }
}

async function reset() {
  const p = cur.value;
  if (!p) return;
  if (!confirm('确定把「' + p.title + '」恢复成内置默认版本？你改过的内容会被覆盖。')) return;
  try {
    const r = await api.resetPrompt(p.key);
    const idx = prompts.value.findIndex(x => x.key === p.key);
    if (idx >= 0) prompts.value[idx] = r;
    dirty[p.key] = false;
    emit('toast', '已恢复默认');
  } catch (e) { emit('toast', e.message); }
}

onMounted(load);
</script>

<template>
  <div class="mask pm-mask" @click.self="emit('close')">
    <div class="pm">
      <div class="pm-head">
        <Icon name="text" :size="17" />
        <span>提示词规则</span>
        <span class="pm-sub">大模型怎么挑、怎么写，全在这里调，不写死在程序里</span>
        <span style="flex:1"></span>
        <button class="icon-btn" @click="emit('close')"><Icon name="close" :size="15" /></button>
      </div>

      <div class="pm-tabs">
        <button
          v-for="t in TABS" :key="t.key"
          class="pm-tab" :class="{ on: active === t.key }"
          @click="active = t.key"
        >
          <Icon :name="t.icon" :size="14" /> {{ t.name }}
          <span v-if="dirty[t.key]" class="dot-dirty" title="有未保存改动"></span>
        </button>
      </div>

      <div class="pm-body" v-if="cur">
        <div class="pm-hint">
          <Icon name="info" :size="13" />
          <span>{{ cur.hint }}</span>
        </div>

        <div class="pm-vars">
          可用变量：
          <span v-for="v in cur.vars" :key="v" class="vm">{{ varLabel(v) }}</span>
          <span v-if="!cur.vars.length" class="vm muted">（此模板无变量，直接写死指令即可）</span>
        </div>

        <label class="pm-field">
          <span class="pm-lbl">system（角色设定与输出格式要求）</span>
          <textarea
            class="pm-ta" rows="13"
            v-model="cur.content.system"
            @input="touch"
            placeholder="写给大模型看的角色与规则"
          ></textarea>
        </label>

        <label class="pm-field">
          <span class="pm-lbl">user（每次请求时拼上候选数据后发出的指令）</span>
          <textarea
            class="pm-ta" rows="6"
            v-model="cur.content.user"
            @input="touch"
            placeholder="支持 {{变量}} 占位符"
          ></textarea>
        </label>

        <div class="pm-ops">
          <button class="btn primary" :disabled="saving || !dirty[active]" @click="save">
            <Icon name="check" :size="14" /> {{ saving ? '保存中…' : '保存模板' }}
          </button>
          <button class="btn ghost" @click="reset">
            <Icon name="refresh" :size="13" /> 恢复默认
          </button>
          <span v-if="dirty[active]" class="pm-dirty-tip">有改动未保存</span>
        </div>
      </div>

      <div class="pm-foot">
        改完点「保存模板」立即生效，下一次生成就会用新规则。想试不同口味，
        改这里比改代码快得多。
      </div>
    </div>
  </div>
</template>

<style scoped>
.pm-mask { justify-content: center; align-items: center; padding: 24px; }
.pm {
  width: min(720px, 96vw); max-height: 90vh; overflow: hidden;
  display: flex; flex-direction: column;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--r-l); box-shadow: 0 24px 70px rgba(0,0,0,.45);
}
.pm-head {
  display: flex; align-items: center; gap: 9px; padding: 15px 16px;
  border-bottom: 1px solid var(--line); font-size: 15px; font-weight: 700;
}
.pm-sub { font-size: 11.5px; font-weight: 400; color: var(--text-3); }
.pm-tabs { display: flex; gap: 6px; padding: 12px 16px 0; flex-wrap: wrap; }
.pm-tab {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 12px; border-radius: 9px; cursor: pointer; font-size: 12.5px;
  border: 1px solid var(--border); background: var(--btn); color: var(--text-2);
}
.pm-tab.on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.dot-dirty { width: 6px; height: 6px; border-radius: 50%; background: var(--warn, #e0a000); }
.pm-body { padding: 14px 16px; overflow-y: auto; }
.pm-hint {
  display: flex; gap: 7px; align-items: flex-start; font-size: 12px; line-height: 1.6;
  color: var(--text-2); background: var(--accent-soft); border: 1px solid var(--accent-line, var(--border));
  padding: 9px 11px; border-radius: 9px; margin-bottom: 12px;
}
.pm-vars { font-size: 11.5px; color: var(--text-3); margin-bottom: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.vm {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  background: var(--code, rgba(127,127,127,.16)); color: var(--text); padding: 2px 7px; border-radius: 6px;
}
.vm.muted { background: transparent; color: var(--text-3); font-style: italic; }
.pm-field { display: block; margin-bottom: 12px; }
.pm-lbl { display: block; font-size: 11.5px; color: var(--text-2); margin-bottom: 6px; }
.pm-ta {
  width: 100%; resize: vertical; font-size: 12.5px; line-height: 1.7;
  padding: 10px 12px; border-radius: 10px;
  background: var(--input, var(--btn)); color: var(--text);
  border: 1px solid var(--border);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.pm-ta:focus { outline: none; border-color: var(--accent); }
.pm-ops { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
.pm-dirty-tip { font-size: 11.5px; color: var(--warn, #e0a000); }
.pm-foot { padding: 11px 16px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--text-3); line-height: 1.6; }
</style>
