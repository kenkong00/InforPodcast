/**
 * 歌词「跟着语音走」的滚动跟随逻辑。
 *
 * 抽成公用模块，是因为播报台和全屏字幕踩过一模一样的两个坑：
 *
 * 坑 1 —— 不能用 scroll 事件判断「用户滚了」。
 *   程序自己调用 scrollTo 同样会触发 scroll，于是每次自动跟随都会把自己
 *   锁上 2.6 秒；句子一短就表现为「当前这句已经跑出屏幕也不回来」。
 *   只能认真实的用户意图：wheel / touchstart / pointerdown / 方向键。
 *
 * 坑 2 —— 滚动条必须长在歌词容器自己身上。
 *   如果祖先元素才是滚动容器（例如 .np 用 overflow:auto 配
 *   align-items:flex-start），子容器就只有内容高度，scrollHeight === clientHeight，
 *   scrollTo 完全无效；而多出来的那截留白会把字幕顶到屏幕外面去。
 *   判断方法：box.scrollHeight > box.clientHeight + 4 才是真的在滚。
 *
 * 用法：
 *   const follower = createLyricFollower(boxRef);
 *   watch(() => player.cueIdx, () => nextTick(() => {
 *     if (follower.shouldFollow()) follower.follow(true);
 *   }));
 *   模板：<div ref="boxRef" @wheel.passive="follower.onUserInteract" ...>
 */

const LOCK_MS = 2600; // 用户动过滚动条之后，让位多久

export function createLyricFollower(boxRef) {
  let lockUntil = 0; // 让位到这个时刻

  /** 把当前句滚到容器正中 */
  function follow(smooth = true) {
    const box = boxRef.value;
    if (!box) return;
    const el = box.querySelector('.lyric-line.active');
    if (!el) return;
    const top = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
    box.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }

  /** 用户自己动手了 → 先别跟他抢滚动条 */
  function onUserInteract() {
    lockUntil = Date.now() + LOCK_MS;
  }

  /** 用户明确挑了某句 / 换了条目 → 立刻恢复跟随 */
  function release() {
    lockUntil = 0;
  }

  /** 现在该不该自动跟随 */
  function shouldFollow() {
    return Date.now() >= lockUntil;
  }

  /** 自检用：容器是不是真的在滚（滚动条长在自己身上） */
  function isScrollable() {
    const box = boxRef.value;
    if (!box) return false;
    return box.scrollHeight > box.clientHeight + 4;
  }

  return { follow, onUserInteract, release, shouldFollow, isScrollable };
}
