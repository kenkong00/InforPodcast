<script setup>
/**
 * AI 精选 —— 把爬取来的原始信息交给大模型二次加工，
 * 产出「精选轮播」和「双人对话」两种可以直接听的节目。
 *
 * 生成走的是异步任务：点了「生成一期」立刻返回，这里轮询进度，
 * 阶段依次为 读候选 → 去重去垃圾 → 打分 → 写稿 → 完成。
 */
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import Icon from './Icon.vue';
import { api, timeAgo } from '../api.js';
import { player, playDigest, autoPairVoices } from '../player/engine.js';

const emit = defineEmits(['toast', 'play', 'prompts']);
const props = defineProps({ stats: { type: Object, default: () => ({}) } });

const KINDS = [
  { id: 'newsreel', name: '精选轮播', icon: 'radio', hint: '融合成 20 条最值得播报的，单人播报' },
  { id: 'dialogue', name: '双人对话', icon: 'chat', hint: '主播 + 评论员一问一答，两种音色' }
];

const form = reactive({
  kind: 'newsreel',
  category: '', source: '', site: '', keyword: '',
  hours: 24, topN: 20, minScore: 6, noScore: false,
  scoreProviderId: '', writeProviderId: '',
  dropNoBody: true, minBodyChars: 80, similarity: 0.62,
  hostName: '主播', guestName: '评论员',
  hostVoice: '', guestVoice: '',
  focus: ''
});

const providers = ref([]);
const digests = ref([]);
const busy = ref(false);
const showFilter = ref(false);       // 过滤规则弹窗（原来折叠在面板底部，根本看不到）
const progress = ref(0);
const stageMsg = ref('');
const stage = ref('');
const runningId = ref(0);
const detail = ref(null);
const polling = ref(false);

const isDialogue = computed(() => form.kind === 'dialogue');
const categories = computed(() => (props.stats.byCategory || []).map(c => c.category));
const sources = computed(() => props.stats.bySource || []);
const sites = computed(() => [...new Set((props.stats.bySource || []).map(s => s.site).filter(Boolean))].sort());

const voiceOptions = computed(() => {
  const all = [...player.voices.web, ...player.voices.svr];
  return all.map(v => ({ id: v.id, name: v.label || v.name, group: v.group || '' }));
});
const voiceFamily = id => (String(id || '').startsWith('web:') ? '在线' : '本机');

/* 两个角色必须来自同一套引擎，否则另一路会被静默忽略，听起来还是一个人 */
const voiceMismatch = computed(() =>
  isDialogue.value &&
  !!form.hostVoice && !!form.guestVoice &&
  form.hostVoice !== form.guestVoice &&
  voiceFamily(form.hostVoice) !== voiceFamily(form.guestVoice)
);

let pollTimer = null;

async function loadProviders() {
  try {
    const d = await api.providers();
    providers.value = (d.list || []).filter(p => p.enabled);
    if (providers.value.length) {
      // 默认方案要挑「真的能出结果」的：填了 key 的远程方案，或者内置演示模型。
      // 否则默认落在没填 key 的 DeepSeek 上，一点生成就是 401，很打击人。
      // 「本地 Ollama」这类预设自带占位 key（has_key 为真但服务未必在跑），
      // 所以内置演示模型要额外往前排一位。
      const usable = providers.value.filter(p =>
        p.has_key || String(p.base_url || '').startsWith('internal://')
      );
      const internal = usable.find(p => String(p.base_url || '').startsWith('internal://'));
      const def = usable.find(p => p.is_default)
        || internal
        || usable[0]
        || providers.value.find(p => p.is_default)
        || providers.value[0];
      if (!form.scoreProviderId) form.scoreProviderId = String(def.id);
      if (!form.writeProviderId) form.writeProviderId = String(def.id);
    }
  } catch { /* ignore */ }
}

async function loadDigests() {
  try { digests.value = await api.digests(60); } catch { /* ignore */ }
}

function rePair() {
  const pair = autoPairVoices(player.voice);
  if (pair.host) form.hostVoice = pair.host;
  if (pair.guest) form.guestVoice = pair.guest;
}

function initVoices() {
  rePair();
}

/* 本机语音清单是异步来的（服务端要先拉起 PowerShell 语音引擎，可能要十几秒）。
   页面刚挂载时 svr 往往还是空的，配对只能先拿浏览器在线音色凑合 ——
   等本机语音到位后再补一次，把默认换成能出 MP3 文件的本地双人组合。 */
watch(() => player.voices.svr.length, (n, prev) => {
  if (n < 2 || prev >= 2) return;
  if (voiceFamily(form.hostVoice) === '在线' || voiceFamily(form.guestVoice) === '在线') rePair();
});

onMounted(() => {
  loadProviders();
  loadDigests();
  initVoices();
  // 进来时如果服务端已经在跑某期，接上它的进度
  api.digestCurrent().then(r => {
    if (r && r.running && r.id) track(r.id);
  }).catch(() => {});
});

onUnmounted(() => { stopPoll(); });

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  polling.value = false;
}

function track(id) {
  stopPoll();
  runningId.value = id;
  busy.value = true;
  polling.value = true;
  const tick = async () => {
    try {
      const p = await api.digestStatus(id);
      if (!p) return finishPoll();
      progress.value = p.progress || 0;
      stageMsg.value = p.stage_msg || '';
      stage.value = p.stage || '';
      if (p.status === 'done') {
        stageMsg.value = '生成完成';
        emit('toast', '一期已生成：' + (p.title || '未命名'));
        return finishPoll();
      }
      if (p.status === 'failed') {
        emit('toast', '生成失败：' + (p.error || '未知原因'));
        stageMsg.value = '失败：' + (p.error || '');
        return finishPoll();
      }
    } catch { return finishPoll(); }
  };
  tick();
  pollTimer = setInterval(tick, 1500);
}

function finishPoll() {
  stopPoll();
  busy.value = false;
  runningId.value = 0;
  loadDigests();
}

const STAGES = [
  ['fetch', '读候选'], ['filter', '去重去垃圾'], ['score', '打分'], ['write', '写稿'], ['done', '完成']
];
const stageIndex = computed(() => {
  const i = STAGES.findIndex(s => s[0] === stage.value);
  return i < 0 ? 0 : i;
});

async function generate() {
  if (busy.value) return emit('toast', '上一次还没跑完');
  if (!providers.value.length) return emit('toast', '先在设置里添加一个可用的大模型方案');
  busy.value = true;
  detail.value = null;
  try {
    const body = {
      kind: form.kind,
      topN: Number(form.topN),
      minScore: Number(form.minScore),
      noScore: !!form.noScore,
      scoreProviderId: Number(form.scoreProviderId) || undefined,
      writeProviderId: Number(form.writeProviderId) || undefined,
      focus: form.focus,
      hostName: form.hostName,
      guestName: form.guestName,
      scope: {
        category: form.category,
        source: form.source ? Number(form.source) : '',
        site: form.site,
        keyword: form.keyword,
        hours: Number(form.hours)
      },
      filter: {
        dropNoBody: !!form.dropNoBody,
        minBodyChars: Number(form.minBodyChars),
        similarity: Number(form.similarity)
      }
    };
    const r = await api.generateDigest(body);
    emit('toast', '已开始生成，可以边等边做别的');
    track(r.id);
  } catch (e) {
    busy.value = false;
    emit('toast', e.message);
  }
}

/** 把一期节目丢进播放队列并开播 */
async function playRow(d) {
  try {
    const full = await api.digest(d.id);
    const voices = buildVoices(full.script || {});
    playDigest(full, { voices });
    emit('play');
  } catch (e) { emit('toast', e.message); }
}

function buildVoices(script) {
  // 保持带前缀的完整 id（web: / svr:），播放引擎靠它判定每个角色走哪套引擎
  if (script.kind === 'dialogue') {
    return { host: form.hostVoice, guest: form.guestVoice, narrator: form.hostVoice };
  }
  // 单人播报沿用播放条当前选的那把嗓子，不套对话面板里选的主播音色
  return { narrator: player.voice || form.hostVoice };
}

async function openDetail(d) {
  try {
    detail.value = await api.digest(d.id);
  } catch (e) { emit('toast', e.message); }
}

async function remove(d) {
  try {
    await api.deleteDigest(d.id);
    if (detail.value && detail.value.id === d.id) detail.value = null;
    await loadDigests();
    emit('toast', '已删除');
  } catch (e) { emit('toast', e.message); }
}

const providerName = id => (providers.value.find(p => String(p.id) === String(id)) || { name: '' }).name;

function fmtsec(s) {
  const n = Math.max(0, Math.round(Number(s) || 0));
  const m = Math.floor(n / 60);
  return n < 60 ? `${n} 秒` : `${m} 分 ${n % 60} 秒`;
}
</script>

<template>
  <div class="dg">
    <!-- 左：生成面板 -->
    <div class="dg-left">
      <div class="panel dg-card">
        <div class="dg-h"><Icon name="sparkles" :size="16" /> 生成一期节目</div>

        <div class="kinds">
          <div
            v-for="k in KINDS" :key="k.id"
            class="kind" :class="{ on: form.kind === k.id }"
            @click="form.kind = k.id"
          >
            <Icon :name="k.icon" :size="16" />
            <div class="kn">{{ k.name }}</div>
            <div class="kh">{{ k.hint }}</div>
          </div>
        </div>

        <!-- 两个规则入口放在最上面：它们决定「选什么料、怎么写」，是生成前最该看的 -->
        <div class="dg-rules">
          <button class="btn sm ghost" @click="showFilter = true">
            <Icon name="sliders" :size="13" /> 过滤规则
          </button>
          <button
            class="btn sm ghost"
            @click="emit('prompts', form.kind === 'dialogue' ? 'dialogue' : 'newsreel')"
          >
            <Icon name="text" :size="13" /> 提示词规则
          </button>
          <span class="dg-rules-hint">决定挑哪些料、大模型怎么写</span>
        </div>

        <div class="sec-title">取哪批信息</div>
        <div class="form-grid">
          <label>
            <span>分类</span>
            <select class="field" v-model="form.category">
              <option value="">全部分类</option>
              <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
          <label>
            <span>数据源</span>
            <select class="field" v-model="form.source">
              <option value="">全部源</option>
              <option v-for="s in sources" :key="s.id" :value="String(s.id)">{{ s.name }}</option>
            </select>
          </label>
          <label>
            <span>站点</span>
            <select class="field" v-model="form.site">
              <option value="">全部站点</option>
              <option v-for="s in sites" :key="s" :value="s">{{ s }}</option>
            </select>
          </label>
          <label>
            <span>时间窗口</span>
            <select class="field" v-model.number="form.hours">
              <option :value="6">最近 6 小时</option>
              <option :value="12">最近 12 小时</option>
              <option :value="24">最近 24 小时</option>
              <option :value="72">最近 3 天</option>
              <option :value="0">不限时间</option>
            </select>
          </label>
          <label style="grid-column:1/-1">
            <span>关键词（可选）</span>
            <input class="field" v-model="form.keyword" placeholder="留空表示不限，例如：英伟达" />
          </label>
        </div>

        <div class="sec-title">加工偏好</div>
        <div class="form-grid">
          <label>
            <span>{{ isDialogue ? '话题数量' : '精选条数' }}</span>
            <select class="field" v-model.number="form.topN">
              <option :value="8">8</option>
              <option :value="12">12</option>
              <option :value="20">20</option>
              <option :value="30">30</option>
            </select>
          </label>
          <label>
            <span>保留阈值（0-10）</span>
            <select class="field" v-model.number="form.minScore">
              <option :value="8">8 · 只要最好的</option>
              <option :value="6">6 · 均衡</option>
              <option :value="4">4 · 宁滥勿缺</option>
            </select>
          </label>
          <label style="grid-column:1/-1">
            <span>我想重点看什么（会写进提示词）</span>
            <input class="field" v-model="form.focus" placeholder="例如：只挑 AI 和芯片相关的，财经八卦不要" />
          </label>
        </div>

        <div class="sec-title">用哪个模型</div>
        <div class="form-grid">
          <label>
            <span>打分（便宜的就行）</span>
            <select class="field" v-model="form.scoreProviderId">
              <option value="">跳过打分</option>
              <option v-for="p in providers" :key="p.id" :value="String(p.id)">{{ p.name }} · {{ p.model }}</option>
            </select>
          </label>
          <label>
            <span>写稿（用强的）</span>
            <select class="field" v-model="form.writeProviderId">
              <option v-for="p in providers" :key="p.id" :value="String(p.id)">{{ p.name }} · {{ p.model }}</option>
            </select>
          </label>
        </div>
        <div v-if="!providers.length" class="reader-note warn" style="margin-top:8px">
          还没有可用的模型方案。去右上角的换装里点「AI 模型」添加一个 ——
          不想配 key 的话，选「内置演示模型」即可离线生成。
        </div>

        <div v-if="isDialogue" class="form-grid" style="margin-top:6px">
          <label>
            <span>主播音色</span>
            <select class="field" v-model="form.hostVoice">
              <option v-for="v in voiceOptions" :key="v.id + 'h'" :value="v.id">{{ v.name }}</option>
            </select>
          </label>
          <label>
            <span>评论员音色</span>
            <select class="field" v-model="form.guestVoice">
              <option v-for="v in voiceOptions" :key="v.id + 'g'" :value="v.id">{{ v.name }}</option>
            </select>
          </label>
          <label>
            <span>主播名字</span>
            <input class="field" v-model="form.hostName" placeholder="主播" />
          </label>
          <label>
            <span>评论员名字</span>
            <input class="field" v-model="form.guestName" placeholder="评论员" />
          </label>
        </div>
        <div v-if="voiceMismatch" class="reader-note warn" style="margin-top:8px">
          主播用的是{{ voiceFamily(form.hostVoice) }}语音，评论员却选了{{ voiceFamily(form.guestVoice) }}语音。
          两套是不同引擎，混着选只会有一个真正生效 —— 请把两个角色都选成同一类。
        </div>

        <button class="btn primary lg dg-go" :disabled="busy || !providers.length" @click="generate">
          <Icon name="sparkles" :size="16" />
          {{ busy ? '正在生成…' : (isDialogue ? '生成双人对话' : '生成精选轮播') }}
        </button>

        <!-- 进度 -->
        <div v-if="busy || stageMsg" class="dg-prog">
          <div class="progress-line"><i :style="{ width: progress + '%' }"></i></div>
          <div class="dg-stages">
            <span
              v-for="(s, i) in STAGES" :key="s[0]"
              class="st" :class="{ on: i <= stageIndex, cur: i === stageIndex }"
            >{{ s[1] }}</span>
          </div>
          <div class="dg-stmsg">{{ stageMsg || '准备中…' }}</div>
        </div>
      </div>
    </div>

    <!-- 右：历史 -->
    <div class="dg-right">
      <div class="panel dg-card">
        <div class="dg-h">
          <Icon name="headphone" :size="15" /> 已生成的节目
          <span style="flex:1"></span>
          <button class="btn sm ghost" @click="loadDigests"><Icon name="refresh" :size="13" /> 刷新</button>
        </div>

        <div v-if="!digests.length" class="empty" style="padding:34px 0">
          <div class="sm">还没有生成过节目。左边选好范围和形态，点一下生成。</div>
        </div>

        <div v-for="d in digests" :key="d.id" class="drow" :class="{ failing: d.status === 'failed' }">
          <div class="dico">
            <Icon :name="d.kind === 'dialogue' ? 'chat' : 'radio'" :size="15" />
          </div>
          <div class="dbody">
            <div class="dtitle">{{ d.title || '未命名' }}</div>
            <div class="dmeta">
              <span class="badge" :class="d.kind === 'dialogue' ? 'accent' : ''">
                {{ d.kind === 'dialogue' ? '双人对话' : '精选轮播' }}
              </span>
              <span v-if="d.status === 'failed'" class="badge danger">失败</span>
              <span v-else-if="d.status === 'running'" class="badge warn">生成中</span>
              <span v-else>{{ d.item_count }} 条 · {{ d.cue_count }} 句</span>
              <span>·</span>
              <span>{{ d.input_count }} 条原始 → 去重成 {{ d.cluster_count }} → 留 {{ d.keep_count }}</span>
              <span>·</span>
              <span>{{ timeAgo(d.created_at) }}</span>
            </div>
            <div v-if="d.subtitle" class="dsub">{{ d.subtitle }}</div>
            <div v-if="d.error" class="derr">{{ d.error }}</div>
          </div>
          <div class="dops">
            <button v-if="d.status === 'done'" class="btn sm primary" @click="playRow(d)">
              <Icon name="play" :size="13" /> 播放
            </button>
            <button class="btn sm ghost" @click="openDetail(d)"><Icon name="eye" :size="13" /></button>
            <button class="btn sm ghost" @click="remove(d)"><Icon name="trash" :size="13" /></button>
          </div>
        </div>
      </div>

      <!-- 详情 -->
      <div v-if="detail" class="panel dg-card">
        <div class="dg-h">
          <Icon name="file" :size="15" /> {{ detail.title }}
          <span style="flex:1"></span>
          <button class="icon-btn" @click="detail = null"><Icon name="close" :size="14" /></button>
        </div>

        <div class="dstat">
          <span>{{ (detail.script?.items || []).length }} 条内容</span>
          <span>{{ (detail.script?.cues || []).length }} 句播报</span>
          <span>约 {{ fmtsec(detail.duration_est) }}</span>
          <span>输入 {{ detail.tokens_in }} / 输出 {{ detail.tokens_out }} token</span>
          <span>耗时 {{ (detail.duration_ms / 1000).toFixed(1) }}s</span>
        </div>

        <div v-for="it in detail.script?.items || []" :key="it.index" class="ditem">
          <div class="dnum">{{ it.index + 1 }}</div>
          <div class="dtext">
            <div class="dtt">{{ it.title }}</div>
            <div v-if="it.summary" class="dts">{{ it.summary }}</div>
            <div v-if="it.sources && it.sources.length" class="dsrc">
              <span v-for="(s, i) in it.sources" :key="i" class="chip">{{ s.site }}</span>
              <span class="dgx">共 {{ it.sources.length }} 家报道</span>
            </div>
          </div>
        </div>

        <div class="sec-title">完整台词</div>
        <div class="dscript">
          <div
            v-for="(c, i) in detail.script?.cues || []" :key="i"
            class="dline" :class="['spk-' + c.speaker, 'k-' + c.kind]"
          >
            <span class="who">{{ c.speakerLabel }}</span>{{ c.text }}
          </div>
        </div>
      </div>
    </div>

    <!-- 过滤规则：原来折叠在面板最底部，屏幕矮一点就完全看不到，改成弹窗 -->
    <div v-if="showFilter" class="mask" @click.self="showFilter = false">
      <div class="modal" style="max-width:520px">
        <div class="modal-head">
          <Icon name="sliders" :size="16" />
          <span>过滤规则</span>
          <span class="fr-sub">在交给大模型之前，先在本地把稿子筛一遍</span>
          <span style="flex:1"></span>
          <button class="icon-btn" @click="showFilter = false"><Icon name="close" :size="15" /></button>
        </div>
        <div class="modal-body">
          <div class="fr-item">
            <div class="fr-lb">
              <div class="n">相似度阈值</div>
              <div class="d">两家媒体报道同一件事，标题像到什么程度就合并成一条。值越低合并越狠，太高会漏掉重复报道。</div>
            </div>
            <input class="field" style="width:96px" type="number" step="0.02" min="0.4" max="0.9" v-model.number="form.similarity" />
          </div>

          <div class="fr-item">
            <div class="fr-lb">
              <div class="n">正文/摘要最少字数</div>
              <div class="d">不到这个字数的条目当垃圾扔掉，避免「三个字标题」这种没内容的条目混进来。</div>
            </div>
            <input class="field" style="width:96px" type="number" step="10" min="0" v-model.number="form.minBodyChars" />
          </div>

          <div class="fr-item">
            <div class="fr-lb">
              <div class="n">丢掉没有文字正文的视频稿</div>
              <div class="d">视频号、音频站的条目只有标题没有正文，播出来也是干巴巴一句话，默认丢掉。</div>
            </div>
            <div class="switch" :class="{ on: form.dropNoBody }" @click="form.dropNoBody = !form.dropNoBody"></div>
          </div>

          <div class="fr-item last">
            <div class="fr-lb">
              <div class="n">先让大模型打分粗筛一遍</div>
              <div class="d">用便宜的小模型先给每条打 0-10 分、淘汰低价值的，再交给强模型写稿 —— 省下的是写稿的钱。关掉则所有候选直接进写稿环节。</div>
            </div>
            <div class="switch" :class="{ on: !form.noScore }" @click="form.noScore = !form.noScore"></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn primary" @click="showFilter = false">知道了</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 整个面板区可滚动：生成面板字段多，屏幕矮的时候必须能滚到底，
   否则「生成」按钮和进度条会被外层 overflow:hidden 直接裁掉。 */
.dg {
  display: grid;
  grid-template-columns: 372px 1fr;
  gap: 14px;
  align-items: start;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 6px;
}
.dg-left, .dg-right { min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.dg-card { padding: 14px; }
.dg-h { display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 600; margin-bottom: 12px; }

.kinds { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 4px; }
.kind {
  border: 1px solid var(--line); border-radius: var(--r-m); padding: 10px;
  cursor: pointer; transition: border-color .16s, background .16s;
}
.kind:hover { border-color: var(--border-soft); }
.kind.on { border-color: var(--accent); background: var(--accent-soft); }
.kind .kn { font-size: 13px; font-weight: 600; margin: 5px 0 3px; }
.kind .kh { font-size: 11px; color: var(--text-3); line-height: 1.5; }

/* 表单：两列等宽、label 纵向排（标签在上、控件在下）。
   注意不能直接沿用全局的 .form-grid —— 那是 88px + 1fr 的「左标签右控件」布局，
   套进这里会把每个 label 压成 88px 宽，出现文字换行、控件错位。 */
.dg-left .form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 12px;
  align-items: end;
}
.dg-left .form-grid > label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  font-size: 12px;
  color: var(--text-2);
}
.dg-left .form-grid > label > span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dg-left .form-grid .field { width: 100%; min-width: 0; }

/* 规则入口 */
.dg-rules { display: flex; align-items: center; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
.dg-rules-hint { font-size: 10.5px; color: var(--text-3); }

.dg-go { width: 100%; margin-top: 14px; justify-content: center; }

.dg-prog { margin-top: 12px; }
.dg-stages { display: flex; gap: 10px; margin-top: 8px; font-size: 11px; color: var(--text-3); flex-wrap: wrap; }
.dg-stages .st.on { color: var(--accent); }
.dg-stages .st.cur { font-weight: 700; }
.dg-stmsg { margin-top: 6px; font-size: 11.5px; color: var(--text-2); line-height: 1.6; }

/* 过滤规则弹窗 */
.fr-sub { font-size: 11.5px; font-weight: 400; color: var(--text-3); }
.fr-item {
  display: flex; align-items: center; gap: 14px;
  padding: 13px 0; border-bottom: 1px solid var(--line);
}
.fr-item.last { border-bottom: 0; }
.fr-lb { flex: 1; min-width: 0; }
.fr-lb .n { font-size: 13px; font-weight: 600; }
.fr-lb .d { font-size: 11.5px; color: var(--text-3); line-height: 1.65; margin-top: 3px; }

.drow { display: flex; gap: 10px; padding: 11px 0; border-bottom: 1px solid var(--line); align-items: flex-start; }
.drow:last-child { border-bottom: 0; }
.drow.failing { opacity: .82; }
.dico {
  width: 32px; height: 32px; flex: none; border-radius: 9px;
  background: var(--accent-soft); color: var(--accent);
  display: flex; align-items: center; justify-content: center;
}
.dbody { flex: 1; min-width: 0; }
.dtitle { font-size: 13.5px; font-weight: 600; line-height: 1.45; }
.dmeta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11.5px; color: var(--text-3); margin-top: 5px; }
.dsub { font-size: 11.5px; color: var(--text-3); margin-top: 4px; }
.derr { font-size: 11.5px; color: var(--text-2); margin-top: 5px; word-break: break-all; }
.dops { display: flex; gap: 6px; flex: none; }

.dstat { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11.5px; color: var(--text-3); margin-bottom: 10px; }
.ditem { display: flex; gap: 10px; padding: 8px 0; border-top: 1px solid var(--line); }
.dnum { width: 20px; flex: none; font-size: 12px; color: var(--text-3); font-weight: 700; }
.dtext { min-width: 0; }
.dtt { font-size: 12.5px; line-height: 1.6; }
.dts { font-size: 11.5px; color: var(--text-3); line-height: 1.6; margin-top: 2px; }
.dsrc { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; align-items: center; }
.dgx { font-size: 10.5px; color: var(--text-3); }
.dscript { max-height: 340px; overflow-y: auto; }
.dline { font-size: 12.5px; line-height: 1.9; color: var(--text-2); }
.dline .who {
  display: inline-block; min-width: 46px; margin-right: 6px;
  font-size: 10.5px; color: var(--accent); font-weight: 600;
}
.dline.spk-guest .who { color: var(--accent-2); }
.dline.k-item-title, .dline.k-lead, .dline.k-outro { color: var(--text); font-weight: 600; }

@media (max-width: 1080px) { .dg { grid-template-columns: 1fr; } }
</style>
