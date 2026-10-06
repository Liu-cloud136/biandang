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
  constructor(opts = {}) {
    this.rate = opts.rateInit || 5;
    this.rateMax = opts.rateMax || 8;
    this.rateMin = opts.rateMin || 0.5;
    this.burst = opts.burst || this.rateMax;
    this.windowCap = opts.windowCap || 200;
    this.successK = opts.successK || 10;
    this.backoffBase = opts.backoffBase || 2000;
    this.backoffMax = opts.backoffMax || 8000;

    this._tokens = this.burst;
    this._last = Date.now();
    this._successStreak = 0;
    this._windowCount = 0;
    this._windowStart = Date.now();
    this._backoffUntil = 0;
    this._limitCount = 0;
  }

  async _refill() {
    const now = Date.now();
    const dt = (now - this._last) / 1000;
    this._last = now;
    this._tokens = Math.min(this.burst, this._tokens + dt * this.rate);
  }

  async acquire() {
    const now = Date.now();
    if (now < this._backoffUntil) {
      await new Promise(r => setTimeout(r, this._backoffUntil - now));
    }

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

    while (true) {
      await this._refill();
      if (this._tokens >= 1) {
        this._tokens -= 1;
        this._windowCount += 1;
        return;
      }
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
    this.rate = Math.max(this.rate * 0.6, this.rateMin);
    this._successStreak = 0;
    this._limitCount += 1;
    this._backoffStep = (this._backoffStep || 0) + 1;
    const backoff = Math.min(this.backoffBase * this._backoffStep, this.backoffMax);
    this._backoffUntil = Date.now() + backoff;
  }

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

  monitorMsg() {
    const d = this.getDebug();
    return `rate=${d.rate} rateMax=${d.rateMax} rateMin=${d.rateMin} windowCount=${d.windowCount} rateLimit429=${d.limitCount}`;
  }
}

module.exports = { RateLimiter };
