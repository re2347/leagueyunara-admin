/**
 * 侧栏导航：一个菜单项 = 一个功能页，地址栏 hash 就是当前页，
 * 所以可以直接把 `#/devices` 发给同事，对方打开就在同一页。
 *
 * 菜单项用 `<a href="#/…">` 而不是按钮：右键"在新标签页打开"、复制链接、
 * 浏览器前进后退都是天然能用的，不需要另写一套键盘逻辑。
 *
 * 选中态不是给每一项刷背景色，而是一根独立的"游标"在菜单里移动 —— 参数照抄
 * 客户端侧栏那套双边缘弹簧：前缘快、后缘慢且晚起步，于是药丸在移动途中被拉长、
 * 到位后弹回。用背景色切换做不到这个手感。
 */
const VIEW_ORDER = ["overview", "licenses", "devices", "issue", "orders", "pricing", "notice", "service"];
const VIEW_META = {
  overview: { title: "仪表盘", desc: "欢迎回来。这里是当前授权服务的概览。" },
  licenses: { title: "激活码库存", desc: "生成、查看和维护 LeagueYunara 的授权密钥。" },
  devices: { title: "设备与租约", desc: "一台设备绑定一张卡密；租约是客户端每 30 分钟续一次的短期凭证。" },
  issue: { title: "生成激活码", desc: "新卡密只在生成结果里出现一次，离开这一屏之后无法再读回完整卡密。" },
  orders: { title: "订单与售后", desc: "买家忘密码或被锁时在此兜底；直显激活码会留下审计记录。" },
  pricing: { title: "售卖定价", desc: "改完立即生效：付款页每次刷新都重新取价。" },
  notice: { title: "公告", desc: "客户端标题栏的公告位，保存后所有客户端重新变为未读。" },
  service: { title: "服务与连接", desc: "两条授权线的实际结论、双库对账与连接设置。" },
};
const SIDER_STORAGE = "yunara.admin.sider";

const LEADING_SPRING = { stiffness: 900, damping: 52 };
const TRAILING_SPRING = { stiffness: 520, damping: 40 };
// 0 = 两条边同时起步；1 = 等前缘完全到位后后缘才动。
const TRAILING_START_PROGRESS = 0.44;
const POSITION_REST = 0.05;
const VELOCITY_REST = 0.5;

function stepSpring(edge, target, spring, dt) {
  const acceleration = -spring.stiffness * (edge.value - target) - spring.damping * edge.velocity;
  edge.velocity += acceleration * dt;
  edge.value += edge.velocity * dt;
  return Math.abs(edge.value - target) < POSITION_REST && Math.abs(edge.velocity) < VELOCITY_REST;
}

function createCursor(rail, node) {
  const edges = {
    top: { value: 0, velocity: 0 },
    bottom: { value: 0, velocity: 0 },
  };
  let goal = { top: 0, bottom: 0 };
  let leading = "bottom";
  let trailingStarted = true;
  let leadingStart = 0;
  let leadingGoal = 0;
  let frame = 0;
  let last = 0;

  const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

  function write() {
    const top = Math.min(edges.top.value, edges.bottom.value);
    const height = Math.abs(edges.bottom.value - edges.top.value);
    node.style.setProperty("top", `${top.toFixed(2)}px`);
    node.style.setProperty("height", `${Math.max(0, height).toFixed(2)}px`);
  }

  function tick(now) {
    frame = 0;
    // 切到后台再回来时 dt 会是几十秒，弹簧会直接炸开，所以夹住步长。
    const dt = Math.min(0.034, Math.max(0.001, (now - last) / 1000)) || 0.016;
    last = now;
    const leadingEdge = edges[leading];
    const trailingEdge = edges[leading === "top" ? "bottom" : "top"];
    const span = Math.abs(leadingGoal - leadingStart) || 1;
    const progress = Math.abs(leadingEdge.value - leadingStart) / span;
    if (!trailingStarted && progress >= TRAILING_START_PROGRESS) trailingStarted = true;

    const leadingRest = stepSpring(leadingEdge, leadingGoal, LEADING_SPRING, dt);
    const trailingRest = trailingStarted
      ? stepSpring(trailingEdge, leading === "top" ? goal.bottom : goal.top, TRAILING_SPRING, dt)
      : false;
    write();
    if (leadingRest && trailingRest) {
      edges.top.value = goal.top;
      edges.bottom.value = goal.bottom;
      edges.top.velocity = 0;
      edges.bottom.velocity = 0;
      write();
      return;
    }
    frame = requestAnimationFrame(tick);
  }

  return {
    place(item) {
      const next = { top: item.offsetTop, bottom: item.offsetTop + item.offsetHeight };
      const first = goal.top === goal.bottom && goal.bottom === 0;
      goal = next;
      if (first || reducedMotion() || !item.offsetHeight) {
        edges.top.value = next.top;
        edges.bottom.value = next.bottom;
        edges.top.velocity = 0;
        edges.bottom.velocity = 0;
        trailingStarted = true;
        cancelAnimationFrame(frame);
        write();
        return;
      }
      // 往下走是下边缘领先，往上走是上边缘领先；后缘等前缘走完 44% 才起步。
      leading = next.top > edges.top.value ? "bottom" : "top";
      leadingStart = edges[leading].value;
      leadingGoal = leading === "bottom" ? next.bottom : next.top;
      edges[leading].velocity = 0;
      trailingStarted = false;
      cancelAnimationFrame(frame);
      last = performance.now();
      frame = requestAnimationFrame(tick);
    },
    snap(item) {
      goal = { top: item.offsetTop, bottom: item.offsetTop + item.offsetHeight };
      edges.top.value = goal.top;
      edges.bottom.value = goal.bottom;
      edges.top.velocity = 0;
      edges.bottom.velocity = 0;
      cancelAnimationFrame(frame);
      write();
    },
    cancel() {
      cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

export function initView({ onNavigate } = {}) {
  const items = Array.from(document.querySelectorAll(".menu-item[data-view]"));
  const views = Array.from(document.querySelectorAll(".view[data-view]"));
  const rail = document.querySelector(".sider__menu");
  const cursorNode = document.querySelector(".menu-cursor");
  const crumb = document.getElementById("crumb-view");
  const title = document.getElementById("page-title");
  const desc = document.getElementById("page-desc");
  const sidebar = document.getElementById("sidebar");
  const toggle = document.getElementById("sidebar-toggle");
  const collapse = document.getElementById("sider-collapse");
  const cursor = rail && cursorNode ? createCursor(rail, cursorNode) : null;
  let userNavigated = false;

  const currentView = () => {
    const raw = String(location.hash || "").replace(/^#\/?/, "").split("?")[0];
    return VIEW_ORDER.includes(raw) ? raw : "overview";
  };

  const closeDrawer = () => {
    if (!sidebar) return;
    sidebar.classList.remove("is-open");
    toggle?.setAttribute("aria-expanded", "false");
  };

  function apply() {
    const view = currentView();
    const meta = VIEW_META[view];
    for (const section of views) {
      const active = section.dataset.view === view;
      section.hidden = !active;
      if (active && userNavigated) {
        // 换页后把焦点交给这一页本身：否则键盘用户按 Tab 会跳回页面最顶部重新数一遍菜单。
        if (!section.hasAttribute("tabindex")) section.tabIndex = -1;
        section.focus({ preventScroll: true });
      }
    }
    let activeItem = null;
    for (const item of items) {
      const active = item.dataset.view === view;
      item.classList.toggle("is-active", active);
      if (active) {
        activeItem = item;
        item.setAttribute("aria-current", "page");
      } else {
        item.removeAttribute("aria-current");
      }
    }
    if (activeItem) {
      if (sidebar?.classList.contains("is-open") || document.documentElement.dataset.sider === "collapsed") {
        // 抽屉刚展开、或侧栏在折叠态时量到的位置和落点不一致，直接吸附，别从旧位置弹过来。
        cursor?.snap(activeItem);
      } else {
        cursor?.place(activeItem);
      }
    }
    if (crumb) crumb.textContent = meta.title;
    if (title) title.textContent = meta.title;
    if (desc) desc.textContent = meta.desc;
    document.title = `${meta.title} · LeagueYunara 控制台`;
    closeDrawer();
    onNavigate?.(view);
  }

  function setCollapsed(collapsed, remember = true) {
    if (collapsed) document.documentElement.dataset.sider = "collapsed";
    else delete document.documentElement.dataset.sider;
    collapse?.setAttribute("aria-pressed", String(collapsed));
    collapse?.setAttribute("aria-label", collapsed ? "展开菜单" : "收起菜单");
    if (remember) {
      try {
        if (collapsed) localStorage.setItem(SIDER_STORAGE, "1");
        else localStorage.removeItem(SIDER_STORAGE);
      } catch { /* 存不下，但这一屏该收还是得收 */ }
    }
  }

  window.addEventListener("hashchange", () => {
    userNavigated = true;
    apply();
    window.scrollTo({ top: 0, behavior: "auto" });
  });

  toggle?.addEventListener("click", () => {
    const open = sidebar.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      // 抽屉是从左边滑进来的，游标必须跟着吸附到位，否则会在旧位置闪一下。
      const active = items.find((item) => item.classList.contains("is-active"));
      if (active) requestAnimationFrame(() => cursor?.snap(active));
    }
  });

  collapse?.addEventListener("click", () => {
    setCollapsed(document.documentElement.dataset.sider !== "collapsed");
    const active = items.find((item) => item.classList.contains("is-active"));
    // 折叠改变了每一项的高度与偏移，游标直接吸附。
    if (active) requestAnimationFrame(() => cursor?.snap(active));
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sidebar?.classList.contains("is-open")) {
      closeDrawer();
      toggle?.focus();
    }
  });

  // 点空白处收起抽屉：抽屉是覆盖在内容上的，不收起会挡住刚想看的那一页。
  document.addEventListener("click", (event) => {
    if (!sidebar?.classList.contains("is-open")) return;
    if (sidebar.contains(event.target) || toggle?.contains(event.target)) return;
    closeDrawer();
  });

  let resizeFrame;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      const active = items.find((item) => item.classList.contains("is-active"));
      if (active) cursor?.snap(active);
    });
  });

  let storedCollapsed = false;
  try {
    storedCollapsed = localStorage.getItem(SIDER_STORAGE) === "1";
  } catch { /* 读不到就按展开 */ }
  setCollapsed(storedCollapsed, false);
  apply();

  return { currentView, refresh: apply };
}
