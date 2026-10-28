<template>
  <div class="mask" @click.self="$emit('close')">
    <div class="modal" style="max-width:720px">
      <div class="modal-head">
        <Icon name="clock" :size="17" />
        <span>爬取日志（最近 100 条）</span>
        <span style="flex:1"></span>
        <button class="icon-btn" @click="$emit('close')"><Icon name="close" :size="15" /></button>
      </div>
      <div class="modal-body" style="padding:0">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width:90px">时间</th>
              <th>数据源</th>
              <th style="width:60px">状态</th>
              <th style="width:52px">新增</th>
              <th style="width:52px">总数</th>
              <th style="width:56px">耗时</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in logs" :key="l.id">
              <td>{{ l.started_at ? l.started_at.slice(5, 19).replace('T', ' ') : '' }}</td>
              <td>{{ l.source_name }}</td>
              <td>
                <span class="badge" :class="l.status === 'ok' ? 'ok' : (l.status === 'fail' ? 'danger' : '')">{{ l.status }}</span>
              </td>
              <td>{{ l.new_count }}</td>
              <td>{{ l.total_count }}</td>
              <td>{{ l.duration_ms }}ms</td>
              <td style="color:var(--muted)">{{ l.message }}</td>
            </tr>
            <tr v-if="!logs.length"><td colspan="7" style="text-align:center;color:var(--muted);padding:16px">暂无日志</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';
import Icon from './Icon.vue';

const logs = ref([]);
onMounted(async () => {
  try { logs.value = await api.logs(); } catch { logs.value = []; }
});
</script>
