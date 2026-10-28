<script setup>
/**
 * 大模型方案管理
 *
 * 可以并存任意多个方案：本地 Ollama、DeepSeek、公司网关……
 * 「本地」和「API 服务商」在底层是同一套 OpenAI 兼容协议，区别只有地址。
 */
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import Icon from './Icon.vue';
import { api } from '../api.js';

const emit = defineEmits(['close', 'toast']);

const list = ref([]);
const presets = ref([]);
const usage = ref(null);
const cur = ref(null);
const testing = ref(false);
const dirty = ref(false);
const loading = ref(false);

const form = reactive({
  id: 0, name: '', base_url: '', model: '', api_key: '',
  temperature: 0.3, max_tokens: 4096, json_mode: 1, enabled: 1,
  notes: '', price_in: 0, price_out: 0, headers: '{}'
});

async function load() {
  try {
    const d = await api.providers();
    list.value = d.list || [];
    presets.value = d.presets || [];
    if (!cur.value && list.value.length) select(list.value[0]);
  } catch (e) { emit('toast', e.message); }
}

async function loadUsage() {
  try { usage.value = await api.aiUsage(20); } catch { /* ignore */ }
}

onMounted(() => { load(); loadUsage(); });

let poll = null;
onUnmounted(() => { if (poll) clearInterval(poll); });

function select(p) {
  cur.value = p;
  Object.assign(form, {
    id: p.id, name: p.name, base_url: p.base_url, model: p.model,
    api_key: '', temperature: p.temperature, max_tokens: p.max_tokens,
    json_mode: p.json_mode ? 1 : 0, enabled: p.enabled ? 1 : 0,
    notes: p.notes, price_in: p.price_in, price_out: p.price_out,
    headers: typeof p.headers === 'string' ? p.headers : JSON.stringify(p.headers || {})
  });
  dirty.value = false;
}

function newProvider(preset) {
  cur.value = null;
  Object.assign(form, {
    id: 0,
    name: preset ? preset.name : '新方案',
    base_url: preset ? preset.base_url : '',
    model: preset ? preset.model : '',
    api_key: preset && preset.api_key ? preset.api_key : '',
    temperature: 0.3, max_tokens: 4096, json_mode: 1, enabled: 1,
    notes: preset ? preset.notes : '',
    price_in: preset ? preset.price_in : 0,
    price_out: preset ? preset.price_out : 0,
    headers: '{}'
  });
  dirty.value = true;
}

async function save() {
  loading.value = true;
  try {
    if (!form.name.trim()) return emit('toast', '请填方案名称');
    if (!form.base_url.trim()) return emit('toast', '请填 base_url');
    if (!form.model.trim()) return emit('toast', '请填模型名');
    const body = { ...form };
    if (!cur.value) body.is_default = false;
    const saved = form.id
      ? await api.updateProvider(form.id, body)
      : await api.addProvider(body);
    await load();
    select(list.value.find(p => p.id === saved.id) || saved);
    emit('toast', '已保存：' + saved.name);
  } catch (e) { emit('toast', e.message); }
  finally { loading.value = false; }
}

async function test() {
  if (!form.id) return emit('toast', '先保存再测试');
  testing.value = true;
  try {
    const r = await api.testProvider(form.id);
    if (r.ok) emit('toast', `连接成功 ${r.latencyMs}ms，模型回复：${r.reply}`);
    else emit('toast', '连接失败：' + r.message);
    await load();
    const still = list.value.find(p => p.id === form.id);
    if (still) cur.value = still;
  } catch (e) { emit('toast', e.message); }
  finally { testing.value = false; }
}

async function remove() {
  if (!form.id) return;
  try {
    await api.deleteProvider(form.id);
    cur.value = null;
    form.id = 0;
    await load();
    emit('toast', '已删除');
  } catch (e) { emit('toast', e.message); }
}

async function makeDefault() {
  if (!form.id) return;
  try {
    await api.defaultProvider(form.id);
    await load();
    emit('toast', '已设为默认方案');
  } catch (e) { emit('toast', e.message); }
}

const keyHint = computed(() => {
  const p = cur.value;
  if (!p) return '留空也可以（本地 Ollama / LM Studio 不需要真 key）';
  return p.has_key ? `已保存：${p.api_key_masked}（不改动就别填，填了会覆盖）` : '还没填 key';
});

const statusChip = computed(() => {
  const p = cur.value;
  if (!p) return { cls: 'chip', t: '未保存' };
  if (p.last_error) return { cls: 'chip warn', t: '上次失败' };
  if (p.last_ok_at) return { cls: 'badge ok', t: `可用 · ${p.latency_ms}ms` };
  return { cls: 'chip', t: '未测试' };
});
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="modal" style="max-width:960px">
      <div class="modal-head">
        <Icon name="cpu" :size="17" />
        <span>大模型方案</span>
        <span class="chip">本地 / API 服务商通用</span>
        <span style="flex:1"></span>
        <button class="icon-btn" @click="emit('close')"><Icon name="close" :size="15" /></button>
      </div>

      <div class="modal-body">
        <div class="mmg">
          <!-- 左：方案列表 -->
          <div class="mm-list">
            <div class="mm-lhead">
              <span class="sec-title" style="padding:0">已保存的方案</span>
              <span style="flex:1"></span>
              <button class="btn sm" @click="newProvider(null)"><Icon name="plus" :size="13" /> 新建</button>
            </div>

            <div
              v-for="p in list"
              :key="p.id"
              class="mm-row"
              :class="{ on: cur && cur.id === p.id, off: !p.enabled }"
              @click="select(p)"
            >
              <Icon name="cpu" :size="14" />
              <span class="n">{{ p.name }}</span>
              <span v-if="p.is_default" class="badge accent">默认</span>
              <span v-if="!p.enabled" class="chip">停用</span>
              <span class="m">{{ p.model }}</span>
            </div>

            <div v-if="!list.length" class="empty sm" style="padding:22px 0">
              一个都还没有，下面挑个预设填 key 就能用
            </div>

            <div class="sec-title" style="padding:16px 0 6px">从预设新建</div>
            <div class="mm-presets">
              <button
                v-for="p in presets"
                :key="p.name"
                class="btn sm ghost"
                @click="newProvider(p)"
              >{{ p.name }}</button>
            </div>
          </div>

          <!-- 右：表单 -->
          <div class="mm-form">
            <div class="form-grid">
              <label style="grid-column:1/-1">
                <span>方案名称</span>
                <input class="field" v-model="form.name" @input="dirty = true" placeholder="例如：家里的 Ollama" />
              </label>

              <label style="grid-column:1/-1">
                <span>Base URL（接口地址）</span>
                <input class="field" v-model="form.base_url" @input="dirty = true" placeholder="https://api.deepseek.com/v1" />
              </label>

              <label style="grid-column:1/-1">
                <span>模型名</span>
                <input class="field" v-model="form.model" @input="dirty = true" placeholder="deepseek-chat" />
              </label>

              <label style="grid-column:1/-1">
                <span>API Key · {{ keyHint }}</span>
                <input
                  class="field"
                  type="password"
                  v-model="form.api_key"
                  @input="dirty = true"
                  :placeholder="cur && cur.has_key ? '留空表示不修改' : 'sk-...'"
                />
              </label>

              <label>
                <span>温度（写稿 0.3 / 对话 0.7）</span>
                <input class="field" type="number" step="0.1" min="0" max="2" v-model="form.temperature" @input="dirty = true" />
              </label>

              <label>
                <span>最大输出 token</span>
                <input class="field" type="number" step="256" min="256" max="32768" v-model="form.max_tokens" @input="dirty = true" />
              </label>

              <label>
                <span>输入单价（元 / 百万 token）</span>
                <input class="field" type="number" step="0.1" v-model="form.price_in" @input="dirty = true" />
              </label>

              <label>
                <span>输出单价（元 / 百万 token）</span>
                <input class="field" type="number" step="0.1" v-model="form.price_out" @input="dirty = true" />
              </label>

              <label style="grid-column:1/-1">
                <span>备注</span>
                <input class="field" v-model="form.notes" @input="dirty = true" placeholder="写点给自己看的说明" />
              </label>
            </div>

            <div class="mm-switches">
              <div class="mm-sw" @click="form.enabled = form.enabled ? 0 : 1; dirty = true">
                <div class="switch" :class="{ on: !!form.enabled }"></div>
                <span>启用这个方案</span>
              </div>
              <div class="mm-sw" @click="form.json_mode = form.json_mode ? 0 : 1; dirty = true">
                <div class="switch" :class="{ on: !!form.json_mode }"></div>
                <span>强制 JSON 输出（网关不支持会自动降级）</span>
              </div>
            </div>

            <div class="reader-note info" style="margin-top:12px">
              全部走 OpenAI 兼容协议，本地 Ollama、LM Studio、vLLM 与各家云端服务在这一层没有任何区别，
              只有地址不同。代理商/代理写法在系统设置里配，这里的请求会自动跟着走。
            </div>

            <div v-if="usage" class="mm-usage">
              今日调用 {{ usage.today.calls }} 次 ·
              成功 {{ usage.today.oks }} ·
              输入 {{ usage.today.prompt_tokens }} token ·
              输出 {{ usage.today.completion_tokens }} token ·
              平均 {{ usage.today.avg_latency_ms }} ms
            </div>
          </div>
        </div>
      </div>

      <div class="modal-foot">
        <span class="chip" :class="statusChip.cls" v-if="cur">{{ statusChip.t }}</span>
        <span v-if="dirty" class="chip warn">有未保存的改动</span>
        <span style="flex:1"></span>
        <button class="btn sm danger" v-if="form.id" @click="remove"><Icon name="trash" :size="13" /> 删除</button>
        <button class="btn sm ghost" v-if="form.id" @click="makeDefault">设为默认</button>
        <button class="btn sm" :disabled="testing" v-if="form.id" @click="test">
          <Icon name="zap" :size="13" /> {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <button class="btn primary sm" :disabled="loading" @click="save"><Icon name="check" :size="13" /> 保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mmg { display: grid; grid-template-columns: 262px 1fr; gap: 18px; }
.mm-list { border-right: 1px solid var(--line); padding-right: 16px; min-width: 0; }
.mm-lhead { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.mm-row {
  display: flex; align-items: center; gap: 7px;
  padding: 9px 10px; border-radius: 9px; cursor: pointer;
  border: 1px solid transparent; margin-bottom: 4px;
}
.mm-row:hover { background: var(--surface-2); }
.mm-row.on { background: var(--accent-soft); border-color: var(--accent-2); }
.mm-row.off { opacity: .5; }
.mm-row .n { font-size: 13px; font-weight: 600; white-space: nowrap; }
.mm-row .m { font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mm-presets { display: flex; flex-wrap: wrap; gap: 6px; }
.mm-form { min-width: 0; }
.mm-switches { display: flex; flex-wrap: wrap; gap: 8px 22px; margin-top: 12px; }
.mm-sw { display: flex; align-items: center; gap: 8px; font-size: 12.5px; cursor: pointer; }
.mm-usage { margin-top: 12px; font-size: 11.5px; color: var(--text-3); }
@media (max-width: 780px) { .mmg { grid-template-columns: 1fr; } .mm-list { border-right: 0; padding-right: 0; } }
</style>
