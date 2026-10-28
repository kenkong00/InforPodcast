/**
 * 内置数据源（热门网站的热门信息 / 头条 / 排行榜）
 * 均已实测可用；国外站点会自动走系统代理。可在「数据源管理」中自由增删改。
 */
export const SEED_SOURCES = [
  // ===== 热榜 / 排行榜 =====
  {
    name: '微博热搜榜', site: '微博', category: '热榜', limit_count: 50,
    url: 'https://weibo.com/ajax/side/hotSearch', type: 'json', parser: 'weibo',
    config: { headers: { Referer: 'https://weibo.com/' } }, notes: '实时热搜 Top50'
  },
  {
    name: '百度热搜', site: '百度', category: '热榜', limit_count: 30,
    url: 'https://top.baidu.com/api/board?platform=wise&tab=realtime', type: 'json', parser: 'baidu',
    notes: '实时热搜'
  },
  {
    name: '今日头条热榜', site: '今日头条', category: '热榜', limit_count: 50,
    url: 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', type: 'json', parser: 'toutiao',
    notes: '头条热榜 Top50'
  },
  {
    name: '知乎热搜', site: '知乎', category: '热榜', limit_count: 30,
    url: 'https://www.zhihu.com/api/v4/search/top_search', type: 'json', parser: 'zhihu', notes: '热搜词'
  },
  {
    name: 'B站热门视频', site: '哔哩哔哩', category: '热榜', limit_count: 50, no_body: 1,
    url: 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', type: 'json', parser: 'bilibili',
    notes: '全站排行；视频站点，没有文字正文，播报时只读标题与简介'
  },

  // ===== 科技 =====
  { name: 'IT之家', site: 'ithome', category: '科技', limit_count: 30, url: 'https://www.ithome.com/rss/', type: 'rss' },
  { name: '新浪科技', site: '新浪科技', category: '科技', limit_count: 30, url: 'https://rss.sina.com.cn/tech/rollnews.xml', type: 'rss' },
  {
    name: '网易科技', site: '网易科技', category: '科技', limit_count: 30,
    url: 'https://tech.163.com/special/00097UHL/tech_datalist.js', type: 'json',
    config: { title: 'title', url: 'docurl', published: 'time' }, notes: 'JSONP 接口'
  },
  { name: 'Solidot 奇客', site: 'Solidot', category: '科技', limit_count: 30, url: 'https://www.solidot.org/index.rss', type: 'rss' },
  { name: '少数派', site: 'sspai', category: '科技', limit_count: 30, url: 'https://sspai.com/feed', type: 'rss' },
  { name: '爱范儿', site: 'ifanr', category: '科技', limit_count: 30, url: 'https://www.ifanr.com/feed', type: 'rss' },
  { name: '钛媒体', site: 'TMTPost', category: '科技', limit_count: 30, url: 'https://www.tmtpost.com/rss.xml', type: 'rss' },

  // ===== 新闻 =====
  { name: '新浪新闻焦点', site: '新浪', category: '新闻', limit_count: 30, url: 'https://rss.sina.com.cn/news/china/focus15.xml', type: 'rss' },
  {
    name: 'BBC 中文', site: 'BBC', category: '新闻', limit_count: 30, enabled: 0,
    url: 'https://www.bbc.com/zhongwen/simp/index.xml', type: 'rss', notes: '国外站点，需可用代理后手动启用'
  },
  { name: '联合早报', site: 'zaobao', category: '新闻', limit_count: 20, url: 'https://plink.anyfeeder.com/zaobao/realtime/china', type: 'rss' },

  // ===== 财经 =====
  { name: '新浪财经滚动', site: '新浪财经', category: '财经', limit_count: 30, url: 'https://rss.sina.com.cn/finance/rollnews.xml', type: 'rss' },

  // ===== 开发 =====
  {
    name: 'Hacker News', site: 'Hacker News', category: '开发', limit_count: 30, enabled: 0,
    url: 'https://news.ycombinator.com/rss', type: 'rss', notes: '国外站点，需可用代理后手动启用'
  },
  { name: 'GitHub Trending', site: 'GitHub', category: '开发', limit_count: 50, url: 'https://github.com/trending?since=daily', type: 'html', parser: 'github', notes: '每日 Trending' },
  {
    name: 'V2EX 热门主题', site: 'V2EX', category: '开发', limit_count: 50, enabled: 0,
    url: 'https://www.v2ex.com/api/topics/hot.json', type: 'json', parser: 'v2ex', notes: '国外站点，需可用代理后手动启用'
  },
  { name: '掘金热榜', site: '掘金', category: '开发', limit_count: 50, url: 'https://api.juejin.cn/content_api/v1/content/article_rank?category_id=1&type=hot', type: 'json', parser: 'juejin', notes: '前端热榜' },
  { name: 'InfoQ 中国', site: 'InfoQ', category: '开发', limit_count: 20, url: 'https://www.infoq.cn/feed', type: 'rss' },
  { name: '开源中国', site: 'OSCHINA', category: '开发', limit_count: 30, url: 'https://www.oschina.net/news/rss', type: 'rss' },
  { name: '阮一峰的网络日志', site: 'ruanyifeng', category: '开发', limit_count: 20, url: 'http://www.ruanyifeng.com/blog/atom.xml', type: 'rss' }
];
