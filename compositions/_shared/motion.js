/**
 * Shared motion library — call from any scene's <script data-scene>.
 *
 * The library is inlined into the parent template by the compiler, so
 * every scene gets `window.LF` for free without an import.
 *
 * Every function takes `(tl, el, opts)`:
 *   - tl   = the scene's GSAP timeline (paused)
 *   - el   = the DOM element to animate (may be null → no-op)
 *   - opts = { delay, duration, ease, ... } per function
 *
 * All functions return `tl` so calls chain. Designed to look like a DSL:
 *
 *   LF.fadeUp(tl, root.querySelector(".title"), { delay: 0 });
 *   LF.scalePop(tl, root.querySelector(".hero"), { delay: 0.25 });
 *   LF.counter(tl, root.querySelector(".value"), { to: 48, delay: 0.6 });
 */

window.LF = (function () {
  // Brand easing curves (mirror tokens.css). GSAP doesn't read CSS vars so
  // these are duplicated here intentionally.
  var EASE_OUT = "power3.out";
  var EASE_SPRING = "back.out(1.4)";
  var EASE_SLOW = "power2.out";

  // ===== Entrance primitives =====

  function fadeUp(tl, el, opts) {
    if (!el) return tl;
    var o = Object.assign(
      { delay: 0, distance: 18, duration: 0.55, ease: EASE_OUT, blur: 0 },
      opts || {}
    );
    tl.fromTo(
      el,
      {
        opacity: 0,
        y: o.distance,
        filter: o.blur ? "blur(" + o.blur + "px)" : "none",
      },
      {
        opacity: 1,
        y: 0,
        filter: "blur(0px)",
        duration: o.duration,
        ease: o.ease,
      },
      o.delay
    );
    return tl;
  }

  function fadeIn(tl, el, opts) {
    return fadeUp(tl, el, Object.assign({ distance: 0 }, opts || {}));
  }

  function scalePop(tl, el, opts) {
    if (!el) return tl;
    var o = Object.assign(
      { delay: 0, from: 0.86, distance: 12, duration: 0.65, ease: EASE_SPRING },
      opts || {}
    );
    tl.fromTo(
      el,
      { opacity: 0, scale: o.from, y: o.distance },
      { opacity: 1, scale: 1, y: 0, duration: o.duration, ease: o.ease },
      o.delay
    );
    return tl;
  }

  function blurIn(tl, el, opts) {
    if (!el) return tl;
    var o = Object.assign(
      { delay: 0, blur: 8, distance: 14, duration: 0.55, ease: EASE_SLOW },
      opts || {}
    );
    tl.fromTo(
      el,
      { opacity: 0, y: o.distance, filter: "blur(" + o.blur + "px)" },
      {
        opacity: 1,
        y: 0,
        filter: "blur(0px)",
        duration: o.duration,
        ease: o.ease,
      },
      o.delay
    );
    return tl;
  }

  function slideIn(tl, el, opts) {
    if (!el) return tl;
    var o = Object.assign(
      { delay: 0, x: 0, y: 0, rotate: 0, duration: 0.55, ease: EASE_OUT },
      opts || {}
    );
    tl.fromTo(
      el,
      { opacity: 0, x: o.x, y: o.y, rotation: o.rotate },
      {
        opacity: 1,
        x: 0,
        y: 0,
        rotation: 0,
        duration: o.duration,
        ease: o.ease,
      },
      o.delay
    );
    return tl;
  }

  // ===== Specialty effects =====

  function drawSvg(tl, pathEl, opts) {
    if (!pathEl || typeof pathEl.getTotalLength !== "function") return tl;
    var o = Object.assign(
      { delay: 0, duration: 1.2, ease: EASE_SLOW },
      opts || {}
    );
    var len = pathEl.getTotalLength();
    pathEl.style.strokeDasharray = String(len);
    pathEl.style.strokeDashoffset = String(len);
    tl.to(
      pathEl,
      { strokeDashoffset: 0, duration: o.duration, ease: o.ease },
      o.delay
    );
    return tl;
  }

  function counter(tl, el, opts) {
    if (!el) return tl;
    var o = Object.assign(
      {
        delay: 0,
        from: 0,
        to: 0,
        decimals: 0,
        duration: 1.4,
        ease: EASE_SLOW,
        format: null,
      },
      opts || {}
    );
    var state = { n: o.from };
    var formatter =
      o.format ||
      function (n) {
        return n.toFixed(o.decimals);
      };
    tl.to(
      state,
      {
        n: o.to,
        duration: o.duration,
        ease: o.ease,
        onUpdate: function () {
          el.textContent = formatter(state.n);
        },
        onComplete: function () {
          el.textContent = formatter(o.to);
        },
      },
      o.delay
    );
    return tl;
  }

  /**
   * Slot-machine roll: each digit position scrolls vertically into place.
   * Renders the target number with stacked digit reels, each ending on
   * the correct digit. Non-digit characters render static.
   */
  function slotRoll(tl, el, opts) {
    if (!el) return tl;
    var o = Object.assign(
      {
        delay: 0,
        to: 0,
        duration: 1.4,
        digitGap: 0.08,
        ease: "power3.out",
      },
      opts || {}
    );
    var text = String(Math.round(Number(o.to) || 0));
    el.innerHTML = "";
    el.style.display = "inline-flex";
    el.style.lineHeight = "1";
    var reels = [];
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (!/\d/.test(ch)) {
        var s = document.createElement("span");
        s.textContent = ch;
        s.style.display = "inline-block";
        el.appendChild(s);
        continue;
      }
      var reel = document.createElement("span");
      reel.style.display = "inline-block";
      reel.style.overflow = "hidden";
      reel.style.height = "1em";
      reel.style.verticalAlign = "top";
      var strip = document.createElement("span");
      strip.style.display = "block";
      strip.style.transform = "translateY(0)";
      var str = "";
      // 2 full rolls (0..9 twice) then final digit
      for (var k = 0; k < 2; k++) {
        for (var d = 0; d < 10; d++) str += d + "\n";
      }
      str += ch + "\n";
      strip.innerText = str;
      reel.appendChild(strip);
      el.appendChild(reel);
      reels.push({ strip: strip, finalDigit: Number(ch) });
    }
    reels.forEach(function (r, idx) {
      var finalY = -(20 + r.finalDigit); // in em
      tl.fromTo(
        r.strip,
        { y: "0em" },
        { y: finalY + "em", duration: o.duration, ease: o.ease },
        o.delay + idx * o.digitGap
      );
    });
    return tl;
  }

  function typeOn(tl, el, text, opts) {
    if (!el) return tl;
    var o = Object.assign(
      { delay: 0, charsPerSec: 38, cursor: false, ease: "none" },
      opts || {}
    );
    var src = text != null ? String(text) : el.textContent;
    el.textContent = "";
    var duration = Math.max(0.3, src.length / o.charsPerSec);
    var state = { i: 0 };
    tl.to(
      state,
      {
        i: src.length,
        duration: duration,
        ease: o.ease,
        onUpdate: function () {
          var n = Math.floor(state.i);
          el.textContent =
            src.slice(0, n) + (o.cursor && n < src.length ? "▎" : "");
        },
        onComplete: function () {
          el.textContent = src;
        },
      },
      o.delay
    );
    return tl;
  }

  function shimmer(tl, el, opts) {
    if (!el) return tl;
    var o = Object.assign(
      { delay: 0, duration: 0.9, range: 220, ease: "power2.inOut" },
      opts || {}
    );
    el.style.setProperty("--shimmer-x", "-60%");
    var state = { p: 0 };
    tl.to(
      state,
      {
        p: 1,
        duration: o.duration,
        ease: o.ease,
        onUpdate: function () {
          el.style.setProperty("--shimmer-x", -60 + o.range * state.p + "%");
        },
      },
      o.delay
    );
    return tl;
  }

  function pulseGlow(tl, el, opts) {
    if (!el) return tl;
    var o = Object.assign(
      { delay: 0, scale: 1.06, duration: 0.7, repeat: 1, ease: "sine.inOut" },
      opts || {}
    );
    tl.to(
      el,
      {
        scale: o.scale,
        duration: o.duration,
        ease: o.ease,
        yoyo: true,
        repeat: o.repeat,
      },
      o.delay
    );
    return tl;
  }

  function letterSettle(tl, el, opts) {
    if (!el) return tl;
    var o = Object.assign(
      { delay: 0, fromSpacing: "0.4em", duration: 0.75, ease: EASE_OUT },
      opts || {}
    );
    tl.fromTo(
      el,
      { opacity: 0, letterSpacing: o.fromSpacing },
      {
        opacity: 1,
        letterSpacing: "normal",
        duration: o.duration,
        ease: o.ease,
      },
      o.delay
    );
    return tl;
  }

  function ambientDrift(tl, els, opts) {
    if (!els || !els.length) return tl;
    var o = Object.assign(
      { delay: 0, distance: 16, duration: 4.5, ease: "sine.inOut" },
      opts || {}
    );
    els.forEach(function (el, i) {
      // Deterministic per-element drift vectors keyed by index — keeps
      // rendering reproducible across runs.
      var dx = (i % 2 === 0 ? -1 : 1) * o.distance * (0.6 + ((i * 0.13) % 0.8));
      var dy = (i % 3 === 0 ? -1 : 1) * o.distance * 0.6;
      tl.to(
        el,
        {
          x: dx,
          y: dy,
          duration: o.duration,
          ease: o.ease,
          yoyo: true,
          repeat: -1,
        },
        o.delay + i * 0.1
      );
    });
    return tl;
  }

  function underlineDraw(tl, el, opts) {
    if (!el) return tl;
    var o = Object.assign(
      { delay: 0, duration: 0.6, ease: EASE_OUT },
      opts || {}
    );
    el.style.transformOrigin = "left center";
    tl.fromTo(
      el,
      { scaleX: 0 },
      { scaleX: 1, duration: o.duration, ease: o.ease },
      o.delay
    );
    return tl;
  }

  function magneticOscillate(tl, el, opts) {
    if (!el) return tl;
    var o = Object.assign(
      { delay: 0, distance: 4, duration: 0.45, repeat: 3, ease: "sine.inOut" },
      opts || {}
    );
    tl.to(
      el,
      {
        x: -o.distance,
        duration: o.duration,
        ease: o.ease,
        yoyo: true,
        repeat: o.repeat,
      },
      o.delay
    );
    return tl;
  }

  return {
    fadeUp: fadeUp,
    fadeIn: fadeIn,
    scalePop: scalePop,
    blurIn: blurIn,
    slideIn: slideIn,
    drawSvg: drawSvg,
    counter: counter,
    slotRoll: slotRoll,
    typeOn: typeOn,
    shimmer: shimmer,
    pulseGlow: pulseGlow,
    letterSettle: letterSettle,
    ambientDrift: ambientDrift,
    underlineDraw: underlineDraw,
    magneticOscillate: magneticOscillate,
  };
})();
