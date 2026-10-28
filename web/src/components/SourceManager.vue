<template>
  <div class="mask" @click.self="$emit('close')">
    <div class="modal" style="max-width:1080px">
      <div class="modal-head">
        <Icon name="database" :size="17" />
        <span>数据源管理</span>
        <div style="display:flex;gap:6px;align-items:center;margin-left:auto">
          <button class="btn sm" @click="addRow"><Icon name="plus" :size="13" /> 新增</button>
          <button class="btn sm" @click="restoreDefault"><Icon name="refresh" :size="13" /> 恢复默认源</button>
          <button class="icon-btn" @click="$emit('close')"><Icon name="close" :size="15" /></button>
        </div>
      </div>

      <div style="padding:7px 12px;border-bottom:1px solid var(--border);display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--text-2)">网络代理</span>
        <select v-model="proxy.mode" style="width:76px">
          <option value="auto">自动</option>
          <option value="on">强制</option>
          <option value="off">关闭</option>
        </select>
        <input v-model="proxy.url" placeholder="http://127.0.0.1:端口" style="flex:1;min-width:130px;font-size:12px" />
        <button class="btn sm" @click="saveProxy">保存</button>
        <span style="font-size:11px;color:var(--muted)">自动＝先直连，失败后自动走代理（国外站点需要）</span>
      </div>

      <div class="modal-body" style="padding:0;overflow-x:auto">
        <table class="tbl" style="min-width:980px">
          <thead>
            <tr>
              <th style="width:34px">启</th>
              <th style="width:130px">名称</th>
              <th>网址 / 接口</th>
              <th style="width:88px">类型</th>
              <th style="width:96px">解析器</th>
              <th style="width:80px">分类</th>
              <th style="width:58px" title="视频/音频站点：不抓正文，播报只读标题与简介">无正文</th>
              <th style="width:52px">条数</th>
              <th style="width:96px">状态</th>
              <th style="width:110px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in list" :key="s.id">
              <td><input type="checkbox" v-model="s.enabled" @change="save(s)" /></td>
              <td><input v-model="s.name" @change="save(s)" /></td>
              <td><input v-model="s.url" @change="save(s)" style="font-size:11px" /></td>
              <td>
                <select v-model="s.type" @change="save(s)">
                  <option value="auto">auto</option>
                  <option value="rss">rss</option>
                  <option value="json">json</option>
                  <option value="html">html</option>
                </select>
              </td>
              <td>
                <select v-model="s.parser" @change="save(s)">
                  <option value="">(通用)</option>
                  <option value="weibo">weibo</option>
                  <option value="baidu">baidu</option>
                  <option value="toutiao">toutiao</option>
                  <option value="bilibili">bilibili</option>
                  <option value="v2ex">v2ex</option>
                  <option value="zhihu">zhihu</option>
                  <option value="juejin">juejin</option>
                  <option value="github">github</option>
                  <option value="vvhan">vvhan</option>
                </select>
              </td>
              <td><input v-model="s.category" @change="save(s)" /></td>
              <td style="text-align:center">
                <input type="checkbox" v-model="s.no_body" @change="save(s)" title="勾选＝视频/音频站点，不抓正文" />
              </td>
              <td><input v-model.number="s.limit_count" type="number" @change="save(s)" /></td>
              <td>
                <span class="badge" :class="s.last_status === 'ok' ? 'ok' : (s.last_status === 'fail' ? 'danger' : '')">
                  {{ s.last_status || '未爬取' }}
                </span>
                <div style="font-size:11px;color:var(--muted);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" :title="s.last_message">
                  {{ s.last_message }}
                </div>
              </td>
              <td>
                <button class="btn sm" @click="crawlOne(s)">爬取</button>
                <button class="btn sm danger" @click="remove(s)">删</button>
              </td>
            </tr>
            <tr v-if="!list.length">
              <td colspan="10" style="text-align:center;color:var(--muted);padding:16px">暂无数据源</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="modal-foot">
        <span style="flex:1;font-size:11px;color:var(--muted);text-align:left">
          类型说明：rss=RSS/Atom 源；json=接口（通用需填 config）；html=网页（通用需填选择器）；解析器优先于类型。
        </span>
        <button class="btn" @click="$emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';
import Icon from './Icon.vue';

const emit = defineEmits(['close', 'changed', 'toast']);
const list = ref([]);
const proxy = ref({ mode: 'auto', url: '' });

onMounted(async () => {
  list.value = (await api.sources()).map(s => ({ ...s, enabled: !!s.enabled }));
  try { proxy.value = await api.settings(); } catch { /* ignore */ }
});

async function saveProxy() {
  await api.updateSettings({ proxy_mode: proxy.value.mode, proxy_url: proxy.value.url });
  emit('toast', '代理设置已保存，下次爬取生效');
}

async function save(s) {
  try {
    await api.updateSource(s.id, { ...s, enabled: !!s.enabled });
  } catch (e) {
    emit('toast', e.message);
  }
  emit('changed');
}

async function addRow() {
  const s = await api.addSource({
    name: '新数据源',
    url: 'https://example.com/feed.xml',
    type: 'rss',
    category: '综合',
    limit_count: 30
  });
  list.value.push({ ...s, enabled: !!s.enabled });
  emit('changed');
}

async function remove(s) {
  if (!confirm('删除数据源「' + s.name + '」及其信息？')) return;
  await api.deleteSource(s.id);
  list.value = list.value.filter(x => x.id !== s.id);
  emit('changed');
}

async function crawlOne(s) {
  const r = await api.crawlSource(s.id);
  emit('toast', r.ok ? `${s.name}：${r.message}` : `${s.name} 失败：${r.message}`);
  list.value = (await api.sources()).map(x => ({ ...x, enabled: !!x.enabled }));
  emit('changed');
}

async function restoreDefault() {
  const r = await api.resetSources();
  emit('toast', '已补回 ' + r.added + ' 个默认源');
  list.value = (await api.sources()).map(x => ({ ...x, enabled: !!x.enabled }));
  emit('changed');
}
</script>
