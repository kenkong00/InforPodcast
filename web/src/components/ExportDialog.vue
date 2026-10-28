<template>
  <div class="mask" @click.self="$emit('close')">
    <div class="modal export-modal">
      <div class="modal-head">
        <span style="font-size:15px">导出离线语音 MP3</span>
        <button class="btn sm" @click="$emit('close')">✕ 关闭</button>
      </div>

      <div class="modal-body">
        <div class="exp-article">
          <span class="badge accent">{{ doc.site || '文章' }}</span>
          <strong>{{ doc.title || '网页正文' }}</strong>
          <span class="badge">{{ wordCount }} 字将合成</span>
        </div>

        <div class="exp-row">
          <label>语音</label>
          <select v-model="voice" :disabled="loading || working">
            <option v-for="v in voices" :key="v.id" :value="v.id">{{ v.label || v.name }}（{{ v.note || v.gender || '本机离线' }}）</option>
          </select>
        </div>

        <div class="exp-row">
          <label>语速</label>
          <select v-model.number="rate" :disabled="loading || working">
            <option v-for="o in rateOpts" :key="o.v" :value="o.v">{{ o.label }}</option>
          </select>
        </div>

        <div class="exp-row">
          <label>保存目录</label>
          <div class="exp-dir">
            <input v-model="exportDir" :disabled="working" placeholder="例如 D:\语音导出" @keyup.enter="saveDir" />
            <button class="btn sm" :disabled="working" @click="saveDir">保存</button>
          </div>
        </div>
        <div class="exp-hint">
          目录保存在本机数据库，下次自动复用。留空则默认存到程序目录下的
          <code>server\data\tts-export</code>。
        </div>

        <div class="exp-actions">
          <button class="btn primary" :disabled="!canExport || working" @click="doExport">
            {{ working ? '生成中…（长文会分多段）' : '生成 MP3' }}
          </button>
          <span v-if="!canExport" class="exp-hint">这篇文章没有可合成的文本</span>
        </div>

        <div v-if="status === 'error'" class="reader-note warn">⚠ {{ errMsg }}</div>

        <div v-if="status === 'done' && result" class="exp-result">
          <div class="reader-note ok">✅ 已生成（{{ result.chunks }} 段合并，{{ (result.bytes/1024).toFixed(0) }} KB）</div>
          <audio :src="result.url" controls style="width:100%;margin:8px 0"></audio>
          <div class="exp-path">
            <span class="exp-path-text" :title="result.path">{{ result.path }}</span>
            <button class="btn sm" @click="copyPath">复制路径</button>
          </div>
          <div class="exp-hint">
            文件已写入上面的目录，可随时用任意播放器离线收听（不再依赖网络与浏览器语音）。
          </div>
        </div>

        <div class="exp-note">
          说明：离线 MP3 使用本机 Windows 语音（{{ voices.map(v=>v.label).join(' / ') || '慧慧/瑶瑶/康康' }}）。
          晓晓/云扬等"在线自然语音"在本机没有离线合成接口，无法离线导出；需要它们的音质可改用浏览器在线播报。
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api.js';

const props = defineProps({ doc: { type: Object, required: true } });
defineEmits(['close']);

const voices = ref([]);
const voice = ref('');
const rate = ref(0);
const exportDir = ref('');
const loading = ref(false);
const working = ref(false);
const status = ref('');            // '' | 'working' | 'done' | 'error'
const errMsg = ref('');
const result = ref(null);

const rateOpts = [
  { v: -50, label: '0.5× 慢' }, { v: -30, label: '0.7×' }, { v: 0, label: '1.0× 正常' },
  { v: 30, label: '1.3×' }, { v: 50, label: '1.5× 快' }
];

const text = computed(() => {
  const d = props.doc || {};
  const body = (d.content && String(d.content).trim()) ? d.content : (d.summary || '');
  const head = d.title ? d.title + '。\n\n' : '';
  return (head + body).trim();
});

const wordCount = computed(() => text.value.replace(/\s/g, '').length);
const canExport = computed(() => text.value.length > 0 && voice.value);

onMounted(async () => {
  loading.value = true;
  try {
    const [v, d] = await Promise.all([api.ttsVoices(), api.ttsExportDir()]);
    voices.value = (v && v.voices) || [];
    if (!voices.value.length) voices.value = [{ id: 'Microsoft Huihui', label: '慧慧', note: '女声' }];
    voice.value = voices.value[0].id;
    exportDir.value = (d && d.dir) || '';
  } catch (e) {
    errMsg.value = e.message || '加载失败';
  } finally {
    loading.value = false;
  }
});

async function saveDir() {
  try {
    const r = await api.ttsSetExportDir(exportDir.value);
    exportDir.value = r.dir;
    status.value = '';
  } catch (e) {
    errMsg.value = e.message;
    status.value = 'error';
  }
}

async function doExport() {
  if (!canExport.value || working.value) return;
  working.value = true;
  status.value = 'working';
  errMsg.value = '';
  result.value = null;
  try {
    const r = await api.ttsExport({
      text: text.value,
      voice: voice.value,
      rate: rate.value,
      fileName: props.doc.title || 'article'
    });
    result.value = r;
    status.value = 'done';
  } catch (e) {
    errMsg.value = e.message || '导出失败';
    status.value = 'error';
  } finally {
    working.value = false;
  }
}

function copyPath() {
  if (!result.value) return;
  navigator.clipboard.writeText(result.value.path)
    .then(() => { /* ok */ })
    .catch(() => { /* ignore */ });
}
</script>

<style scoped>
.export-modal { width: 520px; max-width: 94vw; }
.exp-article { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.exp-article strong { font-size: 14.5px; }
.exp-row { display: flex; align-items: center; gap: 10px; margin: 10px 0; }
.exp-row > label { width: 64px; color: var(--text-2); font-size: 13.5px; flex: none; }
.exp-row select { flex: 1; padding: 7px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font-size: 14px; }
.exp-dir { display: flex; gap: 6px; flex: 1; }
.exp-dir input { flex: 1; padding: 7px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font-size: 13.5px; }
.exp-hint { font-size: 12.5px; color: var(--text-2); line-height: 1.6; }
.exp-actions { display: flex; align-items: center; gap: 10px; margin: 14px 0 4px; }
.exp-result { margin-top: 8px; }
.reader-note.ok { background: #eafaf0; color: #1c7a3e; }
.exp-path { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.exp-path-text { flex: 1; font-size: 12.5px; color: var(--text-2); background: var(--border-soft); padding: 6px 8px; border-radius: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.exp-note { margin-top: 16px; font-size: 12.5px; color: var(--text-2); line-height: 1.7; background: var(--border-soft); padding: 10px 12px; border-radius: 8px; }
code { background: #e9edf3; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
