// ============================================================================
// rateLimiter · env2 自适应速率控制器（单一真源，部署时复制到各函数目录）
// BUILD_TAG: 2026-08-24.rate-limiter-v1
//
// 背景（见 env2限流分时段配置方案.md）：
//   混元出文/出图上游是公共池，被全网其他调用方共用。公共池被抢满时即使没超
//   自己环境 500 QPS 也会 429。本控制器让 env2 自己探测公共池实时余量，自动
//   收敛到"最大不 429 吞吐"：闲时跑满、饭点/全网高峰自动降速避让。
//
// 机制：
//   1) 令牌桶：按动态 rate（令牌/秒）限速，burst = rateMax。
//   2) 自适应调速：遇 429 → rate *= 0.6（降速 40%）；连续成功 K 次 → rate *= 1.1（提速 10%，上限 rateMax）。
//   3) 60s 时间窗硬上限 windowCap：防自适应振荡击穿后一波打满公共池。
//   4) 429 退避：指数退避（base 起，最长 maxBackoff），等公共池恢复。
//
// 接入：在"取出下一个待处理项"处 await limiter.acquire()；请求成功调 onSuccess()；
//       遇 429/限流调 onLimit()。替代原固定 SLOT_N / CONCURRENCY + 手写退避。
// ============================================================================

class RateLimiter {
  /**
   * @param {Object} opts
   *   rateInit   初始速率（令牌/秒），建议：文=5，图=2
   *   rateMax    速率天花板，建议：文=8，图=4
   *   rateMin    速率地板（避免卡死），建议 0.5
   *   burst      令牌桶容量（=允许瞬时并发上限），建议 = rateMax
   *   windowCap  60s 时间窗硬上限调用数，建议：文=200，图=20
   *   successK   连续成功多少次试探提速，建议 10
   *   backoffBase 429 退避基数(ms)，建议：文=2000，图=5000
   *   backoffMax 429 退避上限(ms)，建议：文=8000，图=15000
   */
  constructor(opts = {}) {
    this.rate = opts.rateInit || 5;
    this.rateMax = opts.rateMax || 8;
    this.rateMin = opts.rateMin || 0.5;
    this.burst = opts.burst || this.rateMax;
    this.windowCap = opts.windowCap || 200;
    this.successK = opts.successK || 10;
    this.backoffBase = opts.backoffBase || 2000;
    this.backoffMax = opts.backoffMax || 8000;

    this._tokens = this.burst;        // 当前令牌数
    this._last = Date.now();          // 上次 refill 时间
    this._successStreak = 0;
    this._windowCount = 0;
    this._windowStart = Date.now();
    this._backoffUntil = 0;           // 429 退避截止时间
    this._limitCount = 0;             // 累计触发限流（onLimit）次数，供监控
  }

  async _refill() {
    const now = Date.now();
    const dt = (now - this._last) / 1000; // 秒
    this._last = now;
    this._tokens = Math.min(this.burst, this._tokens + dt * this.rate);
  }

  async acquire() {
    // 1) 429 退避中 → 等到退避截止
    const now = Date.now();
    if (now < this._backoffUntil) {
      await new Promise(r => setTimeout(r, this._backoffUntil - now));
    }

    // 2) 60s 时间窗硬上限
    if (now - this._windowStart >= 60000) {
      this._windowStart = now;
      this._windowCount = 0;
    }
    if (this._windowCount >= this.windowCap) {
      const wait = this._windowStart + 60000 - now;
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this._windowStart = Date.now();
      this._windowCount = 0;
    }

    // 3) 令牌桶限速
    while (true) {
      await this._refill();
      if (this._tokens >= 1) {
        this._tokens -= 1;
        this._windowCount += 1;
        return;
      }
      // 等一个令牌 refill 所需时间（至少 20ms 轮询，避免空转）
      const waitMs = Math.max(20, (1 - this._tokens) / this.rate * 1000);
      await new Promise(r => setTimeout(r, Math.min(waitMs, 500)));
    }
  }

  onSuccess() {
    this._successStreak += 1;
    if (this._successStreak >= this.successK) {
      this.rate = Math.min(this.rate * 1.1, this.rateMax);
      this._successStreak = 0;
    }
  }

  onLimit() {
    // 遇 429 / 限流：降速 40% + 重置成功 streak + 指数退避
    this.rate = Math.max(this.rate * 0.6, this.rateMin);
    this._successStreak = 0;
    this._limitCount += 1;            // 监控：累计限流次数
    // 退避步长按连续失败次数递增（用 streak 反推：简单起见按当前退避队列）
    this._backoffStep = (this._backoffStep || 0) + 1;
    const backoff = Math.min(this.backoffBase * this._backoffStep, this.backoffMax);
    this._backoffUntil = Date.now() + backoff;
  }

  // 重置退避队列（连续成功后调用，避免退避叠加过久）
  _resetBackoff() { this._backoffStep = 0; }

  getDebug() {
    return {
      rate: Number(this.rate.toFixed(2)),
      rateMax: this.rateMax,
      rateMin: this.rateMin,
      windowCount: this._windowCount,
      limitCount: this._limitCount,
      backoffUntil: this._backoffUntil,
    };
  }

  // 监控日志字符串：便于写入 bypass_log errMsg 做可观测
  monitorMsg() {
    const d = this.getDebug();
    return `rate=${d.rate} rateMax=${d.rateMax} rateMin=${d.rateMin} windowCount=${d.windowCount} rateLimit429=${d.limitCount}`;
  }
}

module.exports = { RateLimiter };
