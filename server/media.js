/**
 * 视频 / 音频站点识别
 * 这类站点点进去是看视频的，本来就没有文字正文，
 * 因此不参与「预抓正文 / 全文播报」，只播报标题与简介。
 */
const MEDIA_HOSTS = [
  'bilibili.com', 'b23.tv', 'acg.tv',
  'douyin.com', 'iesdouyin.com', 'kuaishou.com', 'ixigua.com', 'huoshan.com',
  'iqiyi.com', 'v.qq.com', 'youku.com', 'mgtv.com', 'letv.com', 'pptv.com',
  'acfun.cn', 'acfun.com',
  'youtube.com', 'youtu.be', 'twitch.tv',
  'ximalaya.com', 'music.163.com', 'kugou.com', 'kuwo.cn'
];

export const MEDIA_TIP = '这是视频/音频站点，本身没有文字正文（点原网页可直接观看）';

/** 判断某个网址是否属于视频/音频站点 */
export function isMediaUrl(url) {
  let host = '';
  try { host = new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return false; }
  if (!host) return false;
  return MEDIA_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

export { MEDIA_HOSTS };
